import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runFixtureGit } from "../test/git-fixture";
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
import {
  LEGACY_MANAGED_MUTATION_ENV,
  LEGACY_MANAGED_MUTATION_FLAG,
} from "./legacy-mutation-policy";
import { machineStateProjectKey } from "./paths";

async function run(cmd: string[], cwd?: string) {
  if (cmd[0] !== "git") {
    throw new Error(`Expected a git fixture command, received: ${cmd[0]}`);
  }
  const gitDirArgIndex = cmd.indexOf("--git-dir");
  const explicitGitDir =
    gitDirArgIndex >= 0 ? cmd[gitDirArgIndex + 1] : undefined;
  const explicitTarget = cmd.at(-1);
  let repoDir = cwd;
  if (!repoDir) {
    repoDir = explicitGitDir
      ? resolve(explicitGitDir)
      : resolve(explicitTarget ?? process.cwd());
  }
  return await runFixtureGit({
    argv: cmd.slice(1),
    repoDir,
    homeDir: join(dirname(repoDir), ".git-home"),
    cwd,
  });
}

async function readGitPath(
  repoDir: string,
  gitPath: string
): Promise<string | null> {
  const pathValue = await run(
    ["git", "rev-parse", "--git-path", gitPath],
    repoDir
  );
  const absolutePath = resolve(repoDir, pathValue);
  return await readFile(absolutePath)
    .then((value) => value.toString("base64"))
    .catch(() => null);
}

async function snapshotRepository(
  repoDir: string
): Promise<Record<string, unknown>> {
  const trackedPaths = (await run(["git", "ls-files"], repoDir))
    .split("\n")
    .filter(Boolean);
  const trackedFiles = await Promise.all(
    trackedPaths.map(async (pathValue) => [
      pathValue,
      (await readFile(join(repoDir, pathValue))).toString("base64"),
    ])
  );
  const commonDir = resolve(
    repoDir,
    await run(["git", "rev-parse", "--git-common-dir"], repoDir)
  );

  return {
    head: await run(["git", "rev-parse", "HEAD"], repoDir),
    symbolicHead: await run(["git", "symbolic-ref", "HEAD"], repoDir),
    coreBare: await run(["git", "config", "--get", "core.bare"], repoDir),
    commonConfig: (await readFile(join(commonDir, "config"))).toString(
      "base64"
    ),
    worktreeConfig: await readGitPath(repoDir, "config.worktree"),
    index: await readGitPath(repoDir, "index"),
    refs: await run(
      ["git", "for-each-ref", "--format=%(refname) %(objectname)"],
      repoDir
    ),
    trackedIndex: await run(["git", "ls-files", "--stage"], repoDir),
    trackedFiles,
    status: await run(["git", "status", "--porcelain=v2", "--branch"], repoDir),
    topLevel: await run(["git", "rev-parse", "--show-toplevel"], repoDir),
    gitDir: await run(["git", "rev-parse", "--git-dir"], repoDir),
    commonDir,
    worktrees: await run(["git", "worktree", "list", "--porcelain"], repoDir),
  };
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

  it("loads a project-scoped config for an approved one-shot recovery", async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-autosync-project-run-"));
    tempDirs.push(home);
    const projectRoot = join(home, "example-project");
    const unresolvedRootDir = join(projectRoot, ".ai");
    const stateRoot = join(home, "machine-state");
    await mkdir(join(unresolvedRootDir, "mcp"), { recursive: true });
    const rootDir = await realpath(unresolvedRootDir);
    const projectStateDir = join(
      stateRoot,
      "projects",
      machineStateProjectKey(rootDir, home)
    );
    const serviceName = "cursor-example-project";
    const mcpConfig = join(projectRoot, ".cursor", "mcp.json");

    await writeFile(
      join(rootDir, "mcp", "servers.json"),
      '{"servers":{}}\n',
      "utf8"
    );
    await mkdir(join(projectStateDir, "autosync", "services"), {
      recursive: true,
    });
    await writeFile(
      join(projectStateDir, "managed.json"),
      `${JSON.stringify({
        version: 1,
        tools: {
          cursor: {
            tool: "cursor",
            managedAt: "2026-07-11T00:00:00.000Z",
            mcpConfig,
            toolHome: join(projectRoot, ".cursor"),
            renderedTargets: {},
          },
        },
      })}\n`,
      "utf8"
    );
    await writeFile(
      join(projectStateDir, "autosync", "services", `${serviceName}.json`),
      `${JSON.stringify({
        ...testConfig(rootDir, serviceName),
        tool: "cursor",
        git: {
          ...testConfig(rootDir, serviceName).git,
          enabled: false,
        },
      })}\n`,
      "utf8"
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      FACULT_LOCAL_STATE_DIR: stateRoot,
    };
    delete env[LEGACY_MANAGED_MUTATION_ENV];
    const pathsProc = Bun.spawn(
      [
        "bun",
        "run",
        join(import.meta.dir, "index.ts"),
        "paths",
        "--project",
        "--json",
      ],
      {
        cwd: projectRoot,
        env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [pathsCode, pathsOut, pathsErr] = await Promise.all([
      pathsProc.exited,
      new Response(pathsProc.stdout).text(),
      new Response(pathsProc.stderr).text(),
    ]);
    expect(pathsErr).toBe("");
    expect(pathsCode).toBe(0);
    expect(
      (JSON.parse(pathsOut) as { runtime: { machineStateDir: string } }).runtime
        .machineStateDir
    ).toBe(projectStateDir);

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(import.meta.dir, "index.ts"),
        "autosync",
        "run",
        "--project",
        "--once",
        "--service",
        serviceName,
        LEGACY_MANAGED_MUTATION_FLAG,
      ],
      {
        cwd: projectRoot,
        env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [code, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(
      await Bun.file(
        join(projectStateDir, "autosync", "state", `${serviceName}.json`)
      ).exists()
    ).toBe(true);
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
  it("cannot mutate an ambient linked worktree repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facult-autosync-isolation-"));
    tempDirs.push(dir);
    const callerDir = join(dir, "caller");
    const linkedDir = join(dir, "caller-linked");
    const targetRemoteDir = join(dir, "target-remote.git");
    const targetDir = join(dir, "target");

    await run(["git", "init", "--initial-branch=main", callerDir]);
    await run(["git", "config", "user.email", "test@example.com"], callerDir);
    await run(["git", "config", "user.name", "Test User"], callerDir);
    await writeFile(
      join(callerDir, "README.md"),
      "caller repository\n",
      "utf8"
    );
    await run(["git", "add", "README.md"], callerDir);
    await run(["git", "commit", "-m", "caller initial"], callerDir);
    await run(
      ["git", "config", "extensions.worktreeConfig", "true"],
      callerDir
    );
    await run(
      ["git", "worktree", "add", "-b", "fixture-linked", linkedDir],
      callerDir
    );
    await run(
      ["git", "config", "--worktree", "fixture.identity", "linked"],
      linkedDir
    );

    await run([
      "git",
      "init",
      "--bare",
      "--initial-branch=main",
      targetRemoteDir,
    ]);
    await run(["git", "clone", targetRemoteDir, targetDir]);
    await writeFile(join(targetDir, "README.md"), "target initial\n", "utf8");
    await run(["git", "add", "README.md"], targetDir);
    await run(
      [
        "git",
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test User",
        "commit",
        "-m",
        "target initial",
      ],
      targetDir
    );
    await run(["git", "push", "origin", "main"], targetDir);
    await writeFile(
      join(targetDir, "README.md"),
      "target initial\ntarget change\n",
      "utf8"
    );

    const before = await snapshotRepository(linkedDir);
    const gitDir = await run(["git", "rev-parse", "--git-dir"], linkedDir);
    const commonDir = await run(
      ["git", "rev-parse", "--git-common-dir"],
      linkedDir
    );
    const indexPath = await run(
      ["git", "rev-parse", "--git-path", "index"],
      linkedDir
    );
    const probePath = join(
      import.meta.dir,
      "..",
      "test",
      "fixtures",
      "run-autosync-once.ts"
    );
    const managedGitConfig = join(dir, "managed.gitconfig");
    await writeFile(
      managedGitConfig,
      "[user]\n\tname = Managed User\n\temail = managed@example.com\n",
      "utf8"
    );
    const probe = Bun.spawn({
      cmd: [process.execPath, "run", probePath, targetDir],
      cwd: linkedDir,
      env: {
        ...process.env,
        HOME: join(dir, "probe-home"),
        GIT_DIR: resolve(linkedDir, gitDir),
        GIT_COMMON_DIR: resolve(linkedDir, commonDir),
        GIT_WORK_TREE: linkedDir,
        GIT_INDEX_FILE: resolve(linkedDir, indexPath),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.bare",
        GIT_CONFIG_VALUE_0: "true",
        GIT_CONFIG_GLOBAL: managedGitConfig,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [probeCode, probeOut, probeErr] = await Promise.all([
      probe.exited,
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
    ]);

    expect(probeCode).toBe(0);
    expect(probeErr).toBe("");
    expect(JSON.parse(probeOut)).toEqual({ changed: true, blocked: false });
    expect(await snapshotRepository(linkedDir)).toEqual(before);
    expect(await run(["git", "status", "--short"], targetDir)).toBe("");
  }, 20_000);

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
