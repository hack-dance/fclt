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
  autosyncStatus,
  buildLaunchAgentPlist,
  buildLaunchAgentSpec,
  installAutosyncService,
  loadAutosyncConfig,
  repairAutosyncServices,
  resolveAutosyncInvocation,
  runAutosyncService,
  runGitAutosyncOnce,
  setLaunchctlRunnerForTests,
  uninstallAutosyncService,
} from "./autosync";
import {
  LEGACY_MANAGED_MUTATION_ENV,
  LEGACY_MANAGED_MUTATION_FLAG,
} from "./legacy-mutation-policy";
import {
  facultMachineStateDir,
  machineStateProjectKey,
  withFacultRootScope,
} from "./paths";

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

function testPlist(
  homeDir: string,
  rootDir: string,
  serviceName: string
): string {
  return buildLaunchAgentPlist(
    buildLaunchAgentSpec({
      homeDir,
      rootDir,
      serviceName,
      invocation: [join(homeDir, "bin", "fclt")],
    })
  );
}

function launchctlNotFound() {
  return {
    exitCode: 113,
    stdout: "",
    stderr: "Could not find service",
  };
}

function launchctlLoaded(rootDir: string, detail = "loaded") {
  return {
    exitCode: 0,
    stdout: `${detail}\nworking directory = ${rootDir}\n`,
    stderr: "",
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

  it("uses collision-resistant service identities for same-basename projects", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "facult-autosync-identity-"));
    tempDirs.push(homeDir);
    const rootA = join(homeDir, "a", "repo", ".ai");
    const rootB = join(homeDir, "b", "repo", ".ai");
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    setLaunchctlRunnerForTests((args) =>
      Promise.resolve({
        exitCode: args[0] === "print" ? 113 : 0,
        stdout: "",
        stderr: args[0] === "print" ? "Could not find service" : "",
      })
    );

    const configA = await installAutosyncService({
      homeDir,
      rootDir: rootA,
      gitEnabled: false,
      allowLegacyManagedMutation: true,
    });
    const configB = await installAutosyncService({
      homeDir,
      rootDir: rootB,
      gitEnabled: false,
      allowLegacyManagedMutation: true,
    });

    expect(configA.name).not.toBe(configB.name);
    expect(configA.name).toContain("all-repo-");
    expect(configB.name).toContain("all-repo-");
    expect(
      await Bun.file(
        join(
          homeDir,
          "Library",
          "LaunchAgents",
          `com.fclt.autosync.${configA.name}.plist`
        )
      ).exists()
    ).toBe(true);
    expect(
      await Bun.file(
        join(
          homeDir,
          "Library",
          "LaunchAgents",
          `com.fclt.autosync.${configB.name}.plist`
        )
      ).exists()
    ).toBe(true);
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
    await writeFile(
      legacyPlistPath,
      testPlist(homeDir, rootDir, "all"),
      "utf8"
    );
    setLaunchctlRunnerForTests((args) => {
      launchctlCalls.push(args);
      const loadedLegacy =
        args[0] === "print" && args[1]?.includes("com.facult.autosync");
      if (args[0] === "print") {
        return Promise.resolve(
          loadedLegacy ? launchctlLoaded(rootDir) : launchctlNotFound()
        );
      }
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
        ["bootstrap", expect.stringContaining("gui/"), currentPlistPath],
      ])
    );
  });

  it("doctor repair removes background launch agents and preserves one-shot config", async () => {
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
    await writeFile(
      currentPlistPath,
      testPlist(homeDir, rootDir, "all"),
      "utf8"
    );
    await writeFile(
      legacyPlistPath,
      testPlist(homeDir, rootDir, "all"),
      "utf8"
    );
    setLaunchctlRunnerForTests((args) => {
      launchctlCalls.push(args);
      return Promise.resolve(
        args[0] === "print"
          ? launchctlLoaded(rootDir)
          : { exitCode: 0, stdout: "", stderr: "" }
      );
    });

    const changed = await repairAutosyncServices(homeDir, rootDir, {
      allowLegacyManagedMutation: true,
    });

    expect(changed).toBe(true);
    await expect(stat(legacyPlistPath)).rejects.toThrow();
    await expect(stat(currentPlistPath)).rejects.toThrow();
    await expect(stat(join(serviceDir, "all.json"))).rejects.toThrow();
    expect(await loadAutosyncConfig("all", homeDir, rootDir)).toEqual(
      testConfig(rootDir, "all")
    );
    expect(await autosyncStatus({ homeDir, rootDir })).toMatchObject({
      config: testConfig(rootDir, "all"),
      loaded: false,
      plistExists: false,
    });
    expect(launchctlCalls).toEqual(
      expect.arrayContaining([
        ["bootout", expect.stringContaining("com.facult.autosync")],
        ["bootout", expect.stringContaining("com.fclt.autosync")],
      ])
    );
    expect(launchctlCalls.some((args) => args[0] === "bootstrap")).toBe(false);
    expect(launchctlCalls.some((args) => args[0] === "kickstart")).toBe(false);
    setLaunchctlRunnerForTests(() => Promise.resolve(launchctlNotFound()));
    expect(await repairAutosyncServices(homeDir, rootDir)).toBe(false);
    expect(await autosyncStatus({ homeDir, rootDir })).toMatchObject({
      loaded: false,
      plistExists: false,
    });
  });

  it("preserves recovery artifacts when a loaded service cannot be unloaded", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "facult-autosync-unload-"));
    tempDirs.push(homeDir);
    const rootDir = join(homeDir, ".ai");
    const legacyConfigPath = join(
      rootDir,
      ".facult",
      "autosync",
      "services",
      "all.json"
    );
    const plistPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      "com.fclt.autosync.plist"
    );
    await mkdir(dirname(legacyConfigPath), { recursive: true });
    await writeFile(
      legacyConfigPath,
      `${JSON.stringify(testConfig(rootDir, "all"), null, 2)}\n`,
      "utf8"
    );
    await mkdir(dirname(plistPath), { recursive: true });
    await writeFile(plistPath, testPlist(homeDir, rootDir, "all"), "utf8");
    const configBefore = await readFile(legacyConfigPath, "utf8");
    const plistBefore = await readFile(plistPath, "utf8");
    setLaunchctlRunnerForTests((args) =>
      Promise.resolve({
        exitCode:
          args[0] === "bootout" ? 5 : args[1]?.includes("com.fclt") ? 0 : 1,
        stdout:
          args[0] === "print" && args[1]?.includes("com.fclt")
            ? launchctlLoaded(rootDir).stdout
            : "",
        stderr: args[0] === "bootout" ? "still loaded" : "",
      })
    );

    await expect(
      repairAutosyncServices(homeDir, rootDir, {
        allowLegacyManagedMutation: true,
      })
    ).rejects.toThrow("Unable to unload autosync service");
    expect(await readFile(legacyConfigPath, "utf8")).toBe(configBefore);
    expect(await readFile(plistPath, "utf8")).toBe(plistBefore);
    expect(
      await Bun.file(
        join(
          facultMachineStateDir(homeDir, rootDir),
          "autosync",
          "services",
          "all.json"
        )
      ).exists()
    ).toBe(false);
    expect(await autosyncStatus({ homeDir, rootDir })).toMatchObject({
      loaded: true,
      ownershipMismatch: false,
      plistExists: true,
    });
  });

  it("keeps config and plist when explicit uninstall cannot stop the service", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "facult-autosync-uninstall-"));
    tempDirs.push(homeDir);
    const rootDir = join(homeDir, ".ai");
    const configPath = join(
      facultMachineStateDir(homeDir, rootDir),
      "autosync",
      "services",
      "all.json"
    );
    const plistPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      "com.fclt.autosync.plist"
    );
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify(testConfig(rootDir, "all"), null, 2)}\n`,
      "utf8"
    );
    await mkdir(dirname(plistPath), { recursive: true });
    await writeFile(plistPath, testPlist(homeDir, rootDir, "all"), "utf8");
    const configBefore = await readFile(configPath, "utf8");
    const plistBefore = await readFile(plistPath, "utf8");
    setLaunchctlRunnerForTests((args) =>
      Promise.resolve({
        exitCode:
          args[0] === "bootout" ? 9 : args[1]?.includes("com.fclt") ? 0 : 1,
        stdout:
          args[0] === "print" && args[1]?.includes("com.fclt")
            ? launchctlLoaded(rootDir).stdout
            : "",
        stderr: args[0] === "bootout" ? "still loaded" : "",
      })
    );

    await expect(
      uninstallAutosyncService({ homeDir, rootDir })
    ).rejects.toThrow("Unable to unload autosync service");
    expect(await readFile(configPath, "utf8")).toBe(configBefore);
    expect(await readFile(plistPath, "utf8")).toBe(plistBefore);
  });

  it("stages config replacement before unload and preserves the source on destination failure", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "facult-autosync-stage-"));
    tempDirs.push(homeDir);
    const rootDir = join(homeDir, ".ai");
    const legacyConfigPath = join(
      rootDir,
      ".facult",
      "autosync",
      "services",
      "all.json"
    );
    const plistPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      "com.fclt.autosync.plist"
    );
    const blockedParent = join(
      facultMachineStateDir(homeDir, rootDir),
      "autosync"
    );
    await mkdir(dirname(legacyConfigPath), { recursive: true });
    await writeFile(
      legacyConfigPath,
      `${JSON.stringify(testConfig(rootDir, "all"), null, 2)}\n`,
      "utf8"
    );
    await mkdir(dirname(plistPath), { recursive: true });
    await writeFile(plistPath, testPlist(homeDir, rootDir, "all"), "utf8");
    await mkdir(dirname(blockedParent), { recursive: true });
    await writeFile(blockedParent, "not a directory\n", "utf8");
    const configBefore = await readFile(legacyConfigPath, "utf8");
    const plistBefore = await readFile(plistPath, "utf8");
    const launchctlCalls: string[][] = [];
    setLaunchctlRunnerForTests((args) => {
      launchctlCalls.push(args);
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    });

    await expect(
      repairAutosyncServices(homeDir, rootDir, {
        allowLegacyManagedMutation: true,
      })
    ).rejects.toThrow();
    expect(await readFile(legacyConfigPath, "utf8")).toBe(configBefore);
    expect(await readFile(plistPath, "utf8")).toBe(plistBefore);
    expect(launchctlCalls.some((args) => args[0] === "bootout")).toBe(false);
  });

  it("rejects cross-root config and ambiguous same-basename service ownership", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "facult-autosync-scope-"));
    tempDirs.push(homeDir);
    const rootA = join(homeDir, "a", "repo", ".ai");
    const rootB = join(homeDir, "b", "repo", ".ai");
    const serviceName = "all-repo";
    const configAPath = join(
      facultMachineStateDir(homeDir, rootA),
      "autosync",
      "services",
      `${serviceName}.json`
    );
    const plistPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      `com.fclt.autosync.${serviceName}.plist`
    );
    const config = testConfig(rootB, serviceName);
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    await mkdir(dirname(configAPath), { recursive: true });
    await writeFile(
      configAPath,
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8"
    );
    await mkdir(dirname(plistPath), { recursive: true });
    await writeFile(plistPath, testPlist(homeDir, rootB, serviceName), "utf8");
    const configBefore = await readFile(configAPath, "utf8");
    const plistBefore = await readFile(plistPath, "utf8");
    setLaunchctlRunnerForTests((args) =>
      Promise.resolve({
        exitCode: args[1]?.includes("com.fclt") ? 0 : 1,
        stdout: "loaded for root B",
        stderr: "",
      })
    );

    await expect(
      repairAutosyncServices(homeDir, rootA, {
        allowLegacyManagedMutation: true,
      })
    ).rejects.toThrow("without matching root ownership");
    expect(await readFile(configAPath, "utf8")).toBe(configBefore);
    expect(await readFile(plistPath, "utf8")).toBe(plistBefore);
    expect(
      await Bun.file(
        join(
          facultMachineStateDir(homeDir, rootB),
          "autosync",
          "services",
          `${serviceName}.json`
        )
      ).exists()
    ).toBe(false);
    expect(await autosyncStatus({ homeDir, rootDir: rootA })).toMatchObject({
      serviceName,
      loaded: false,
      ownershipMismatch: true,
      plistExists: false,
    });
    await expect(
      runAutosyncService(config, {
        homeDir,
        expectedRootDir: rootA,
        once: true,
        allowLegacyManagedMutation: true,
      })
    ).rejects.toThrow("does not match the selected canonical root");
  });

  it("preserves a shared global config owned by another canonical root", async () => {
    const homeDir = await mkdtemp(
      join(tmpdir(), "facult-autosync-global-owner-")
    );
    tempDirs.push(homeDir);
    const rootA = join(homeDir, "global-a", ".ai");
    const rootB = join(homeDir, "global-b", ".ai");
    const configPath = withFacultRootScope(
      { rootDir: rootB, scope: "global" },
      () =>
        join(
          facultMachineStateDir(homeDir, rootB),
          "autosync",
          "services",
          "all.json"
        )
    );
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify(testConfig(rootB, "all"), null, 2)}\n`,
      "utf8"
    );
    const before = await readFile(configPath, "utf8");
    setLaunchctlRunnerForTests(() => Promise.resolve(launchctlNotFound()));

    expect(
      await withFacultRootScope({ rootDir: rootA, scope: "global" }, async () =>
        autosyncStatus({ homeDir, rootDir: rootA })
      )
    ).toMatchObject({
      config: expect.objectContaining({ rootDir: rootB }),
      ownershipMismatch: true,
    });
    await expect(
      withFacultRootScope({ rootDir: rootA, scope: "global" }, async () =>
        uninstallAutosyncService({ homeDir, rootDir: rootA })
      )
    ).rejects.toThrow("without matching root ownership");
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("unloads a legacy-root service before migrating its recovery config", async () => {
    const homeDir = await mkdtemp(
      join(tmpdir(), "facult-autosync-root-migrate-")
    );
    tempDirs.push(homeDir);
    const sourceRoot = join(homeDir, "agents", ".facult");
    const targetRoot = join(homeDir, ".ai");
    const configPath = join(
      facultMachineStateDir(homeDir, sourceRoot),
      "autosync",
      "services",
      "all.json"
    );
    const plistPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      "com.fclt.autosync.plist"
    );
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(targetRoot, { recursive: true });
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify(testConfig(sourceRoot, "all"), null, 2)}\n`,
      "utf8"
    );
    await mkdir(dirname(plistPath), { recursive: true });
    await writeFile(plistPath, testPlist(homeDir, sourceRoot, "all"), "utf8");
    const launchctlCalls: string[][] = [];
    setLaunchctlRunnerForTests((args) => {
      launchctlCalls.push(args);
      if (args[0] === "print" && args[1]?.endsWith("/com.fclt.autosync")) {
        return Promise.resolve(launchctlLoaded(sourceRoot));
      }
      if (args[0] === "bootout") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }
      return Promise.resolve(launchctlNotFound());
    });

    expect(
      await repairAutosyncServices(homeDir, sourceRoot, {
        allowLegacyManagedMutation: true,
        targetRootDir: targetRoot,
      })
    ).toBe(true);
    expect(launchctlCalls.some((args) => args[0] === "bootout")).toBe(true);
    expect(await Bun.file(plistPath).exists()).toBe(false);
    expect(await loadAutosyncConfig("all", homeDir, targetRoot)).toMatchObject({
      rootDir: targetRoot,
    });
  });

  it("refuses to overwrite a conflicting destination recovery config", async () => {
    const homeDir = await mkdtemp(
      join(tmpdir(), "facult-autosync-destination-")
    );
    tempDirs.push(homeDir);
    const rootA = join(homeDir, "a", "repo-a", ".ai");
    const rootB = join(homeDir, "b", "repo-b", ".ai");
    const serviceName = "migration-test";
    const configAPath = join(
      facultMachineStateDir(homeDir, rootA),
      "autosync",
      "services",
      `${serviceName}.json`
    );
    const configBPath = join(
      facultMachineStateDir(homeDir, rootB),
      "autosync",
      "services",
      `${serviceName}.json`
    );
    const plistPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      `com.fclt.autosync.${serviceName}.plist`
    );
    const configA = testConfig(rootA, serviceName);
    const configB = {
      ...testConfig(rootB, serviceName),
      debounceMs: 999,
    };
    await mkdir(dirname(configAPath), { recursive: true });
    await mkdir(dirname(configBPath), { recursive: true });
    await writeFile(configAPath, `${JSON.stringify(configA, null, 2)}\n`);
    await writeFile(configBPath, `${JSON.stringify(configB, null, 2)}\n`);
    await mkdir(dirname(plistPath), { recursive: true });
    await writeFile(plistPath, testPlist(homeDir, rootA, serviceName));
    const beforeA = await readFile(configAPath, "utf8");
    const beforeB = await readFile(configBPath, "utf8");
    const beforePlist = await readFile(plistPath, "utf8");
    const launchctlCalls: string[][] = [];
    setLaunchctlRunnerForTests((args) => {
      launchctlCalls.push(args);
      return Promise.resolve(launchctlNotFound());
    });

    await expect(
      repairAutosyncServices(homeDir, rootA, {
        allowLegacyManagedMutation: true,
        targetRootDir: rootB,
      })
    ).rejects.toThrow("existing autosync destination config");
    expect(await readFile(configAPath, "utf8")).toBe(beforeA);
    expect(await readFile(configBPath, "utf8")).toBe(beforeB);
    expect(await readFile(plistPath, "utf8")).toBe(beforePlist);
    expect(launchctlCalls.some((args) => args[0] === "bootout")).toBe(false);
  });

  it("preserves recovery artifacts when launchctl inspection is denied", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "facult-autosync-inspect-"));
    tempDirs.push(homeDir);
    const rootDir = join(homeDir, ".ai");
    const configPath = join(
      facultMachineStateDir(homeDir, rootDir),
      "autosync",
      "services",
      "all.json"
    );
    const plistPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      "com.fclt.autosync.plist"
    );
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify(testConfig(rootDir, "all"), null, 2)}\n`
    );
    await mkdir(dirname(plistPath), { recursive: true });
    await writeFile(plistPath, testPlist(homeDir, rootDir, "all"));
    const beforeConfig = await readFile(configPath, "utf8");
    const beforePlist = await readFile(plistPath, "utf8");
    setLaunchctlRunnerForTests(() =>
      Promise.resolve({
        exitCode: 5,
        stdout: "",
        stderr: "permission denied",
      })
    );

    await expect(
      uninstallAutosyncService({ homeDir, rootDir })
    ).rejects.toThrow("Unable to inspect loaded autosync service");
    expect(await readFile(configPath, "utf8")).toBe(beforeConfig);
    expect(await readFile(plistPath, "utf8")).toBe(beforePlist);
  });

  it("refuses a loaded service whose root differs from its on-disk plist", async () => {
    const homeDir = await mkdtemp(
      join(tmpdir(), "facult-autosync-loaded-root-")
    );
    tempDirs.push(homeDir);
    const rootDir = join(homeDir, ".ai");
    const foreignRoot = join(homeDir, "foreign", ".ai");
    const configPath = join(
      facultMachineStateDir(homeDir, rootDir),
      "autosync",
      "services",
      "all.json"
    );
    const plistPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      "com.fclt.autosync.plist"
    );
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify(testConfig(rootDir, "all"), null, 2)}\n`
    );
    await mkdir(dirname(plistPath), { recursive: true });
    await writeFile(plistPath, testPlist(homeDir, rootDir, "all"));
    const beforeConfig = await readFile(configPath, "utf8");
    const beforePlist = await readFile(plistPath, "utf8");
    const launchctlCalls: string[][] = [];
    setLaunchctlRunnerForTests((args) => {
      launchctlCalls.push(args);
      return Promise.resolve(
        args[0] === "print" && args[1]?.endsWith("/com.fclt.autosync")
          ? launchctlLoaded(foreignRoot)
          : launchctlNotFound()
      );
    });

    expect(await autosyncStatus({ homeDir, rootDir })).toMatchObject({
      loaded: false,
      ownershipMismatch: true,
    });
    await expect(
      uninstallAutosyncService({ homeDir, rootDir })
    ).rejects.toThrow("without matching loaded root ownership");
    expect(await readFile(configPath, "utf8")).toBe(beforeConfig);
    expect(await readFile(plistPath, "utf8")).toBe(beforePlist);
    expect(launchctlCalls.some((args) => args[0] === "bootout")).toBe(false);
  });

  it("reports legacy launch agents through the read-only status surface", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "facult-autosync-status-"));
    tempDirs.push(homeDir);
    const rootDir = join(homeDir, ".ai");
    const legacyPlistPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      "com.facult.autosync.plist"
    );
    await mkdir(dirname(legacyPlistPath), { recursive: true });
    await writeFile(
      legacyPlistPath,
      testPlist(homeDir, rootDir, "all"),
      "utf8"
    );
    setLaunchctlRunnerForTests((args) =>
      Promise.resolve({
        exitCode: args.at(-1)?.endsWith("/com.facult.autosync") ? 0 : 1,
        stdout: args.at(-1)?.endsWith("/com.facult.autosync")
          ? launchctlLoaded(rootDir, "legacy loaded").stdout
          : "",
        stderr: "",
      })
    );

    expect(await autosyncStatus({ homeDir, rootDir })).toMatchObject({
      loaded: true,
      launchctlSummary: expect.stringContaining("legacy loaded"),
      plistExists: true,
      plistPath: legacyPlistPath,
    });
  });

  it("keeps custom global service identity and config out of project state", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "facult-autosync-global-"));
    tempDirs.push(homeDir);
    const rootDir = join(homeDir, "shared", ".ai");
    const stateRoot = join(homeDir, "state");
    const configPath = join(
      stateRoot,
      "global",
      "autosync",
      "services",
      "all.json"
    );
    await mkdir(rootDir, { recursive: true });
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify(testConfig(rootDir, "all"), null, 2)}\n`,
      "utf8"
    );
    const env = {
      ...process.env,
      HOME: homeDir,
      FACULT_LOCAL_STATE_DIR: stateRoot,
    };

    const status = Bun.spawn(
      [
        "bun",
        "run",
        "./src/index.ts",
        "autosync",
        "status",
        "--global",
        "--root",
        rootDir,
      ],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const [statusCode, statusOut, statusError] = await Promise.all([
      status.exited,
      new Response(status.stdout).text(),
      new Response(status.stderr).text(),
    ]);
    expect(statusCode).toBe(0);
    expect(statusError).toBe("");
    expect(statusOut).toContain("Service: all\n");
    expect(statusOut).toContain(`Root: ${rootDir}`);
    expect(statusOut).not.toContain("Service: all-shared");
    expect(await Bun.file(join(stateRoot, "projects")).exists()).toBe(false);

    const uninstall = Bun.spawn(
      [
        "bun",
        "run",
        "./src/index.ts",
        "autosync",
        "uninstall",
        "--global",
        "--root",
        rootDir,
      ],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const [uninstallCode, uninstallError] = await Promise.all([
      uninstall.exited,
      new Response(uninstall.stderr).text(),
    ]);
    expect(uninstallCode).toBe(0);
    expect(uninstallError).toBe("");
    expect(await Bun.file(configPath).exists()).toBe(false);
    expect(await Bun.file(join(stateRoot, "projects")).exists()).toBe(false);
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
