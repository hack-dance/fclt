import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AutosyncServiceConfig,
  buildLaunchAgentPlist,
  buildLaunchAgentSpec,
  resolveAutosyncInvocation,
  runGitAutosyncOnce,
} from "./autosync";

async function run(cmd: string[], cwd?: string) {
  const proc = Bun.spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      [`command failed: ${cmd.join(" ")}`, stdout.trim(), stderr.trim()]
        .filter(Boolean)
        .join("\n")
    );
  }
  return stdout.trim();
}

function testConfig(rootDir: string, service = "codex"): AutosyncServiceConfig {
  return {
    version: 1,
    name: service,
    tool: service,
    rootDir,
    debounceMs: 100,
    git: {
      enabled: true,
      remote: "origin",
      branch: "main",
      intervalMinutes: 60,
      autoCommit: true,
      commitPrefix: "chore(facult-autosync)",
      source: "test-machine",
    },
  };
}

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("autosync invocation", () => {
  it("builds a bun-run invocation for ts entrypoints", () => {
    expect(
      resolveAutosyncInvocation(["/bun", "/tmp/src/index.ts", "autosync"])
    ).toEqual([process.execPath, "run", "/tmp/src/index.ts"]);
  });

  it("builds a launchd plist for a named service", () => {
    const spec = buildLaunchAgentSpec({
      homeDir: "/Users/test",
      serviceName: "codex",
      rootDir: "/Users/test/.ai",
      invocation: ["/Users/test/.facult/bin/facult"],
    });
    const plist = buildLaunchAgentPlist(spec);

    expect(spec.label).toBe("com.facult.autosync.codex");
    expect(plist).toContain("<string>/Users/test/.facult/bin/facult</string>");
    expect(plist).toContain("<string>autosync</string>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<string>codex</string>");
    expect(plist).toContain("<string>--service</string>");
    expect(plist).toContain("<string>/Users/test/.ai</string>");
  });
});

describe("git autosync", () => {
  it("auto-commits dirty canonical changes and pushes them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facult-autosync-"));
    tempDirs.push(dir);
    const remoteDir = join(dir, "remote.git");
    const localDir = join(dir, "local");

    await run(["git", "init", "--bare", "--initial-branch=main", remoteDir]);
    await run(["git", "clone", remoteDir, localDir]);
    await run(["git", "config", "user.email", "test@example.com"], localDir);
    await run(["git", "config", "user.name", "Test User"], localDir);

    await writeFile(join(localDir, "README.md"), "hello\n", "utf8");
    await run(["git", "add", "README.md"], localDir);
    await run(["git", "commit", "-m", "initial"], localDir);
    await run(["git", "push", "origin", "main"], localDir);

    await writeFile(join(localDir, "README.md"), "hello\nworld\n", "utf8");

    const outcome = await runGitAutosyncOnce({
      config: testConfig(localDir),
    });

    expect(outcome.blocked).toBe(false);
    expect(outcome.changed).toBe(true);

    const status = await run(["git", "status", "--short"], localDir);
    expect(status).toBe("");

    const message = await run([
      "git",
      "--git-dir",
      remoteDir,
      "log",
      "--format=%s",
      "-1",
      "main",
    ]);
    expect(message).toContain("chore(facult-autosync)");
    expect(message).toContain("test-machine");
    expect(message).toContain("service:codex");
  });

  it("blocks remote autosync when the repo is on the wrong branch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facult-autosync-branch-"));
    tempDirs.push(dir);
    const remoteDir = join(dir, "remote.git");
    const localDir = join(dir, "local");

    await run(["git", "init", "--bare", "--initial-branch=main", remoteDir]);
    await run(["git", "clone", remoteDir, localDir]);
    await run(["git", "config", "user.email", "test@example.com"], localDir);
    await run(["git", "config", "user.name", "Test User"], localDir);

    await writeFile(join(localDir, "README.md"), "hello\n", "utf8");
    await run(["git", "add", "README.md"], localDir);
    await run(["git", "commit", "-m", "initial"], localDir);
    await run(["git", "push", "origin", "main"], localDir);
    await run(["git", "checkout", "-b", "feature"], localDir);

    const outcome = await runGitAutosyncOnce({
      config: testConfig(localDir),
    });

    expect(outcome.blocked).toBe(true);
    expect(outcome.message).toContain("expects branch main");
  });
});
