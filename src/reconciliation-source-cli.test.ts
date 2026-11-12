import { afterEach, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { runFixtureGit } from "../test/git-fixture";

const cli = join(import.meta.dir, "index.ts");
let scratch: string | undefined;
afterEach(async () => {
  if (scratch) {
    await rm(scratch, { recursive: true, force: true });
  }
  scratch = undefined;
});

async function treeSnapshot(root: string) {
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  const result: Record<string, string> = {};
  for (const file of files) {
    const path = join(file.parentPath, file.name);
    result[path] = file.isFile()
      ? new Bun.CryptoHasher("sha256")
          .update(await Bun.file(path).arrayBuffer())
          .digest("hex")
      : "directory";
  }
  return result;
}

// The shell shim checks every Git subprocess in the actual CLI, including context resolution.
it.skipIf(process.platform === "win32")(
  "source tools preserve canonical worktree routing using only read-only Git metadata",
  async () => {
    scratch = await mkdtemp(join(tmpdir(), "fclt-source-cli-"));
    const homeDir = join(scratch, "home");
    const repoDir = join(scratch, "primary");
    const linkedDir = join(scratch, "linked");
    const bin = join(scratch, "bin");
    const gitLog = join(scratch, "git-calls.log");
    const actualGit = Bun.which("git");
    expect(actualGit).not.toBeNull();
    const git = (argv: string[]) => runFixtureGit({ argv, repoDir, homeDir });
    await git(["init", "-b", "main", repoDir]);
    await Bun.write(
      join(repoDir, ".ai/reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [
          {
            id: "primary-git",
            type: "git",
            paths: ["docs"],
            defaultBranch: "main",
          },
          { id: "writebacks", type: "writebacks" },
        ],
      })
    );
    await git(["-C", repoDir, "add", ".ai/reconciliation.json"]);
    await git([
      "-C",
      repoDir,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "fixture",
    ]);
    await git([
      "-C",
      repoDir,
      "worktree",
      "add",
      "--detach",
      linkedDir,
      "HEAD",
    ]);
    // A linked checkout's local config must not replace the canonical source selection.
    await Bun.write(
      join(linkedDir, ".ai/reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "wrong-checkout", type: "writebacks" }],
      })
    );
    await mkdir(bin);
    await Bun.write(
      join(bin, "git"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FCLT_SOURCE_GIT_LOG"
if [ "$FCLT_SOURCE_GIT_UNAVAILABLE" = 1 ]; then exit 127; fi
if [ "$1" != -C ]; then exit 73; fi
case "$3" in
  rev-parse) ;;
  config) if [ "$4" != --get ] || [ "$5" != core.worktree ]; then exit 73; fi ;;
  *) exit 73 ;;
esac
exec "$FCLT_SOURCE_REAL_GIT" "$@"
`
    );
    await chmod(join(bin, "git"), 0o755);
    const environment = {
      ...process.env,
      HOME: homeDir,
      FACULT_ROOT_DIR: "",
      FACULT_ROOT_SCOPE: "",
      FACULT_LOCAL_STATE_DIR: join(scratch, "state"),
      FCLT_SOURCE_REAL_GIT: actualGit!,
      FCLT_SOURCE_GIT_LOG: gitLog,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    };
    async function run(command: string, checkout: string, unavailable = false) {
      const proc = Bun.spawn(
        [
          process.execPath,
          cli,
          "ai",
          "review",
          "sources",
          command,
          "--root",
          join(checkout, ".ai"),
          "--project",
          "--json",
        ],
        {
          cwd: checkout,
          env: {
            ...environment,
            FCLT_SOURCE_GIT_UNAVAILABLE: unavailable ? "1" : "0",
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { code, stdout, stderr };
    }
    const before = await treeSnapshot(repoDir);
    const linkedBefore = await treeSnapshot(linkedDir);
    for (const checkout of [repoDir, linkedDir]) {
      for (const command of ["preview", "doctor"]) {
        const result = await run(command, checkout);
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        const output = JSON.parse(result.stdout);
        expect(output).toMatchObject({
          configPath: join(repoDir, ".ai/reconciliation.json"),
          contentScanned: false,
          inputs: [
            {
              sourceId: "primary-git",
              repository: repoDir,
              paths: ["docs"],
              state: "not_checked",
            },
            { sourceId: "writebacks" },
          ],
        });
        if (command === "doctor") {
          expect(output.sources).toMatchObject([
            { sourceId: "primary-git", status: "not_checked" },
            { sourceId: "writebacks", status: "not_checked" },
          ]);
        }
      }
    }
    const calls = await Bun.file(gitLog).text();
    expect(calls).toContain("rev-parse --path-format=absolute");
    expect(
      calls
        .split("\n")
        .filter(Boolean)
        .every(
          (line) =>
            line.includes(" rev-parse ") ||
            line.endsWith(" config --get core.worktree")
        )
    ).toBe(true);
    for (const command of ["preview", "doctor"]) {
      const failed = await run(command, linkedDir, true);
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain("Git metadata is unavailable or invalid");
      expect(failed.stdout).toBe("");
    }
    expect(await treeSnapshot(repoDir)).toEqual(before);
    expect(await treeSnapshot(linkedDir)).toEqual(linkedBefore);
    expect(await Bun.file(join(scratch, "state")).exists()).toBe(false);
  },
  30_000
);
