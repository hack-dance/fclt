import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { gitEnvironmentForRepository } from "../src/util/git-environment";
import { runFixtureGit } from "./git-fixture";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function fixture(merge: boolean) {
  const root = await mkdtemp(join(tmpdir(), "fclt-hook-"));
  roots.push(root);
  const repoDir = join(root, "repo");
  const homeDir = join(root, "home");
  const bin = join(root, "bin");
  await mkdir(repoDir);
  await mkdir(bin);
  const git = (...argv: string[]) =>
    runFixtureGit({ repoDir, homeDir, cwd: repoDir, argv });
  await git("init", "-q", "-b", "base");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.invalid");
  await writeFile(join(repoDir, "base.txt"), "base\n");
  await git("add", ".");
  await git("commit", "-qm", "base");
  await writeFile(join(repoDir, "base.txt"), "existing stashed work\n");
  await git("stash", "push", "-qm", "existing work");
  const stash = await git("rev-parse", "refs/stash");
  if (merge) {
    await git("checkout", "-qb", "topic");
    await writeFile(join(repoDir, "topic.txt"), "topic\n");
    await git("add", ".");
    await git("commit", "-qm", "topic");
    await git("checkout", "-q", "base");
    await git("merge", "--no-ff", "--no-commit", "topic");
  } else {
    await writeFile(join(repoDir, "staged.txt"), "staged\n");
    await git("add", ".");
  }
  await mkdir(join(repoDir, "scripts"));
  await writeFile(
    join(repoDir, "scripts", "test-safe.sh"),
    "#!/bin/sh\nexit 0\n"
  );
  await chmod(join(repoDir, "scripts", "test-safe.sh"), 0o755);
  await writeFile(join(bin, "bun"), '#!/bin/sh\nexit "$FORMATTER_EXIT_CODE"\n');
  await chmod(join(bin, "bun"), 0o755);
  async function hook(formatterExitCode = 0) {
    const proc = Bun.spawn({
      cmd: ["sh", join(import.meta.dir, "..", ".husky", "pre-commit")],
      cwd: repoDir,
      env: gitEnvironmentForRepository({
        repoDir,
        isolatedHome: homeDir,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          FORMATTER_EXIT_CODE: String(formatterExitCode),
        },
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }
  return { repoDir, git, stash, hook };
}

test("pre-commit preserves merge parents and existing stashes", async () => {
  const { git, stash, hook } = await fixture(true);
  const mergeHead = await git("rev-parse", "MERGE_HEAD");
  const result = await hook();
  expect(result.code, result.stderr).toBe(0);
  expect(await git("rev-parse", "MERGE_HEAD")).toBe(mergeHead);
  expect(await git("rev-parse", "refs/stash")).toBe(stash);
  await git("commit", "-qm", "merge");
  expect(
    (await git("rev-list", "--parents", "-n", "1", "HEAD")).split(" ")
  ).toHaveLength(3);
});

test("pre-commit refuses to stash unstaged changes during a merge", async () => {
  const { repoDir, git, stash, hook } = await fixture(true);
  const mergeHead = await git("rev-parse", "MERGE_HEAD");
  const index = await git("write-tree");
  await writeFile(join(repoDir, "base.txt"), "unstaged work\n");
  const result = await hook();
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("before committing a merge");
  expect(await git("rev-parse", "MERGE_HEAD")).toBe(mergeHead);
  expect(await git("rev-parse", "refs/stash")).toBe(stash);
  expect(await git("write-tree")).toBe(index);
  expect(await readFile(join(repoDir, "base.txt"), "utf8")).toBe(
    "unstaged work\n"
  );
});

test("pre-commit restores unstaged changes when the formatter fails", async () => {
  const { repoDir, git, stash, hook } = await fixture(false);
  await writeFile(join(repoDir, "base.txt"), "unstaged work\n");
  const result = await hook(7);
  expect(result.code, result.stderr).toBe(7);
  expect(await git("rev-parse", "refs/stash")).toBe(stash);
  expect(await git("diff", "--cached", "--name-only")).toBe("staged.txt");
  expect(await readFile(join(repoDir, "base.txt"), "utf8")).toBe(
    "unstaged work\n"
  );
});
