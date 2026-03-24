import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AutosyncServiceConfig,
  buildLaunchAgentPlist,
  buildLaunchAgentSpec,
  installAutosyncService,
  repairAutosyncServices,
  resolveAutosyncInvocation,
  runGitAutosyncOnce,
  setLaunchctlRunnerForTests,
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
  setLaunchctlRunnerForTests(null);
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
      invocation: ["/Users/test/.ai/.facult/bin/fclt"],
    });
    const plist = buildLaunchAgentPlist(spec);

    expect(spec.label).toBe("com.fclt.autosync.codex");
    expect(plist).toContain(
      "<string>/Users/test/.ai/.facult/bin/fclt</string>"
    );
    expect(plist).toContain("<string>autosync</string>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<string>codex</string>");
    expect(plist).toContain("<string>--service</string>");
    expect(plist).toContain("<string>/Users/test/.ai</string>");
  });

  it("names project-scoped services distinctly and points launchd at the project root", () => {
    const spec = buildLaunchAgentSpec({
      homeDir: "/Users/test",
      serviceName: "codex-facult",
      rootDir: "/Users/test/dev/facult/.ai",
      invocation: ["/Users/test/.ai/.facult/bin/fclt"],
    });
    const plist = buildLaunchAgentPlist(spec);

    expect(spec.label).toBe("com.fclt.autosync.codex-facult");
    expect(plist).toContain("<string>/Users/test/dev/facult/.ai</string>");
  });
});

describe("autosync launch agent migration", () => {
  it("installs the new com.fclt autosync label and removes the legacy plist", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "facult-autosync-home-"));
    tempDirs.push(homeDir);
    const rootDir = join(homeDir, ".ai");
    const legacyPlistPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      "com.facult.autosync.plist"
    );
    const launchctlCalls: string[][] = [];

    await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(legacyPlistPath, "legacy", "utf8");
    setLaunchctlRunnerForTests((args) => {
      launchctlCalls.push(args);
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    });

    await installAutosyncService({
      homeDir,
      rootDir,
      gitEnabled: false,
    });

    await expect(stat(legacyPlistPath)).rejects.toThrow();
    const currentPlistPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      "com.fclt.autosync.plist"
    );
    const currentPlist = await readFile(currentPlistPath, "utf8");
    expect(currentPlist).toContain("com.fclt.autosync");
    expect(launchctlCalls).toEqual(
      expect.arrayContaining([
        ["bootout", expect.stringContaining("com.facult.autosync")],
        ["bootout", expect.stringContaining("com.fclt.autosync")],
        ["bootstrap", expect.stringContaining("gui/"), currentPlistPath],
      ])
    );
  });

  it("doctor repair rewrites legacy autosync plists to the new label", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "facult-autosync-repair-"));
    tempDirs.push(homeDir);
    const rootDir = join(homeDir, ".ai");
    const serviceDir = join(homeDir, ".ai", ".facult", "autosync", "services");
    const currentPlistPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      "com.fclt.autosync.plist"
    );
    const legacyPlistPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      "com.facult.autosync.plist"
    );
    const launchctlCalls: string[][] = [];

    await mkdir(serviceDir, { recursive: true });
    await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(
      join(serviceDir, "all.json"),
      `${JSON.stringify(testConfig(rootDir, "all"), null, 2)}\n`,
      "utf8"
    );
    await writeFile(legacyPlistPath, "legacy", "utf8");
    setLaunchctlRunnerForTests((args) => {
      launchctlCalls.push(args);
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    });

    const changed = await repairAutosyncServices(homeDir, rootDir);

    expect(changed).toBe(true);
    await expect(stat(legacyPlistPath)).rejects.toThrow();
    const currentPlist = await readFile(currentPlistPath, "utf8");
    expect(currentPlist).toContain("com.fclt.autosync");
    expect(launchctlCalls).toEqual(
      expect.arrayContaining([
        ["bootout", expect.stringContaining("com.facult.autosync")],
        ["bootstrap", expect.stringContaining("gui/"), currentPlistPath],
      ])
    );
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

  it("drops rebuildable generated ai state before pull and push", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facult-autosync-generated-"));
    tempDirs.push(dir);
    const remoteDir = join(dir, "remote.git");
    const localDir = join(dir, "local");

    await run(["git", "init", "--bare", "--initial-branch=main", remoteDir]);
    await run(["git", "clone", remoteDir, localDir]);
    await run(["git", "config", "user.email", "test@example.com"], localDir);
    await run(["git", "config", "user.name", "Test User"], localDir);

    await mkdir(join(localDir, ".facult", "ai"), { recursive: true });
    await writeFile(join(localDir, "README.md"), "hello\n", "utf8");
    await writeFile(
      join(localDir, ".facult", "ai", "index.json"),
      '{"version":1,"generatedAt":"initial"}\n',
      "utf8"
    );
    await writeFile(
      join(localDir, ".facult", "ai", "graph.json"),
      '{"version":1,"generatedAt":"initial"}\n',
      "utf8"
    );
    await run(
      [
        "git",
        "add",
        "README.md",
        ".facult/ai/index.json",
        ".facult/ai/graph.json",
      ],
      localDir
    );
    await run(["git", "commit", "-m", "initial"], localDir);
    await run(["git", "push", "origin", "main"], localDir);

    await writeFile(
      join(localDir, ".facult", "ai", "index.json"),
      '{"version":1,"generatedAt":"local-change"}\n',
      "utf8"
    );
    await writeFile(
      join(localDir, ".facult", "ai", "graph.json"),
      '{"version":1,"generatedAt":"local-change"}\n',
      "utf8"
    );

    const outcome = await runGitAutosyncOnce({
      config: testConfig(localDir),
    });

    expect(outcome.blocked).toBe(false);
    expect(outcome.changed).toBe(false);
    const status = await run(["git", "status", "--short"], localDir);
    expect(status).toBe("");
    const indexJson = await Bun.file(
      join(localDir, ".facult", "ai", "index.json")
    ).text();
    expect(indexJson).toContain("initial");
  });
});
