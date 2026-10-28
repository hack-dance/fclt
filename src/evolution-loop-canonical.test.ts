import { expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runFixtureGit } from "../test/git-fixture";
import {
  automationStatus,
  disableEvolutionLoop,
  enableEvolutionLoop,
  runEvolutionLoop,
} from "./evolution-loop";
import {
  evolutionLoopPortfolioStatus,
  parseLoopStaleAfter,
} from "./evolution-loop-portfolio";
import { preflightEvolutionLoop } from "./evolution-preflight";
import { buildIndex, buildIndexSnapshot } from "./index-builder";
import {
  executionMachineStateProjectKey,
  facultAiEvolutionLoopLockPath,
  facultAiEvolutionLoopStatePath,
  facultAiReconciliationLockPath,
  facultLocalStateRoot,
  facultMachineStateDir,
  legacyMachineStateProjectKey,
  repositoryMachineStateProjectKey,
} from "./paths";
import {
  applyProjectEnrollment,
  planProjectEnrollment,
  resolveRepositoryExecutionIdentity,
} from "./projects";
import { scaffoldCodexAutomationTemplate } from "./remote";
import { canonicalProjectRoot } from "./repository-identity";

const EPHEMERAL_RE = /^worktree_/;

async function fixture({ linked = true } = {}) {
  const homeDir = await realpath(
    await mkdtemp(join(tmpdir(), "fclt-canonical-loop-"))
  );
  const primary = join(homeDir, "repo");
  const worktree = join(homeDir, "linked");
  await mkdir(primary);
  const git = (...argv: string[]) =>
    runFixtureGit({
      argv: ["-C", primary, ...argv],
      repoDir: primary,
      homeDir: join(homeDir, "git-home"),
    });
  await git("init", "-q");
  await git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "init"
  );
  if (linked) {
    await git("worktree", "add", "--detach", worktree);
  }
  const rootDir = join(primary, ".ai");
  await Bun.write(join(rootDir, "config.toml"), "version = 1\n");
  await Bun.write(
    join(rootDir, "reconciliation.json"),
    JSON.stringify({
      version: 1,
      sources: [{ id: "writebacks", type: "writebacks" }],
    })
  );
  return { homeDir, primary, worktree, rootDir, git };
}

async function cli(args: {
  homeDir: string;
  worktree: string;
  argv: string[];
  environmentRoot?: string;
  environmentScope?: string;
}) {
  const proc = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "index.ts"),
      "ai",
      "loop",
      ...args.argv,
      "--json",
    ],
    {
      cwd: args.worktree,
      env: {
        ...process.env,
        HOME: args.homeDir,
        XDG_STATE_HOME: join(args.homeDir, "state"),
        XDG_CONFIG_HOME: join(args.homeDir, "config"),
        XDG_DATA_HOME: join(args.homeDir, "data"),
        XDG_CACHE_HOME: join(args.homeDir, "cache"),
        FACULT_ROOT_DIR: args.environmentRoot ?? "",
        FACULT_ROOT_SCOPE: args.environmentScope ?? "",
        // Keep subprocess writes aligned with parent assertions on XDG platforms.
        FACULT_LOCAL_STATE_DIR: facultLocalStateRoot(args.homeDir),
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [exitCode, output, error] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0 || error) {
    throw new Error(`CLI failed (${exitCode}): ${error}`);
  }
  return JSON.parse(output);
}

it("keeps an ordinary checkout's repository store stable despite its worktree-prefixed execution identity", async () => {
  const args = await fixture({ linked: false });
  const execution = await resolveRepositoryExecutionIdentity(args.primary);
  expect(execution.id).toMatch(EPHEMERAL_RE);
  expect(canonicalProjectRoot(args.primary)).toBe(args.primary);
  const plan = await planProjectEnrollment({
    projectRoot: args.primary,
    homeDir: args.homeDir,
  });
  expect(plan.projectRoot).toBe(args.primary);
  expect(plan.executionIdentity.id).toBe(execution.id);
  const enrolled = await applyProjectEnrollment({
    plan,
    expectedPlanSha256: plan.planSha256,
    homeDir: args.homeDir,
  });
  const primaryArgs = { ...args, worktree: args.primary };
  const enabled = await cli({ ...primaryArgs, argv: ["enable", "--project"] });
  const store = facultMachineStateDir(args.homeDir, args.rootDir);
  expect(basename(store)).toBe(
    repositoryMachineStateProjectKey(args.rootDir, args.homeDir)
  );
  expect(basename(store)).not.toMatch(EPHEMERAL_RE);
  expect(enabled.config.automationName).toBe(
    `fclt-evolution-${basename(store)}`
  );
  expect(
    (await cli({ ...primaryArgs, argv: ["preflight", "--project"] })).status
  ).toBe("ready");
  await cli({ ...primaryArgs, argv: ["run", "--project", "--scheduled"] });
  const statePath = facultAiEvolutionLoopStatePath(args.homeDir, args.rootDir);
  const state = await readFile(statePath, "utf8");

  await args.git(
    "remote",
    "add",
    "origin",
    "https://example.invalid/team/repo.git"
  );
  await args.git("worktree", "add", "--detach", args.worktree);
  expect((await resolveRepositoryExecutionIdentity(args.primary)).id).toBe(
    execution.id
  );
  expect((await resolveRepositoryExecutionIdentity(args.worktree)).id).not.toBe(
    execution.id
  );
  expect(canonicalProjectRoot(args.primary)).toBe(args.primary);
  expect(canonicalProjectRoot(args.worktree)).toBe(args.primary);
  for (const checkout of [args.primary, args.worktree]) {
    expect(facultMachineStateDir(args.homeDir, join(checkout, ".ai"))).toBe(
      store
    );
    const reenabled = await cli({
      ...args,
      worktree: checkout,
      argv: ["enable", "--project"],
    });
    expect(reenabled.config.automationName).toBe(enabled.config.automationName);
  }
  expect(await readFile(statePath, "utf8")).toBe(state);
  expect(
    (await readdir(join(facultLocalStateRoot(args.homeDir), "projects"))).sort()
  ).toEqual(
    ["coordination", "receipts", "registry.json", basename(store)].sort()
  );
  expect(await readdir(join(args.homeDir, ".codex", "automations"))).toEqual([
    enabled.config.automationName,
  ]);
  expect(
    Object.keys((await Bun.file(enrolled.registryPath).json()).projects)
  ).toEqual([plan.identity.id]);
  const status = await evolutionLoopPortfolioStatus({ homeDir: args.homeDir });
  expect(status.projects).toHaveLength(1);
  expect(status.projects[0]).toMatchObject({
    projectKey: basename(store),
    ephemeral: false,
    stale: false,
    schedulerStatus: "ACTIVE",
  });
});

it("preserves environment-selected loop roots and explicit project precedence from a linked checkout", async () => {
  const args = await fixture();
  const globalArgs = {
    ...args,
    environmentRoot: join(args.homeDir, ".ai"),
    environmentScope: "global",
  };
  const global = await cli({ ...globalArgs, argv: ["enable"] });
  const project = await cli({ ...globalArgs, argv: ["enable", "--project"] });
  expect(global.config.automationName).not.toBe(project.config.automationName);
  await cli({ ...globalArgs, argv: ["disable"] });
  expect(
    (
      await automationStatus({
        homeDir: args.homeDir,
        name: global.config.automationName,
      })
    ).status
  ).toBe("PAUSED");
  expect(
    (
      await automationStatus({
        homeDir: args.homeDir,
        name: project.config.automationName,
      })
    ).status
  ).toBe("ACTIVE");

  const other = await fixture();
  const selected = await cli({
    ...args,
    environmentRoot: join(other.worktree, ".ai"),
    environmentScope: "project",
    argv: ["enable", "--project"],
  });
  expect(selected.configPath).toContain(
    repositoryMachineStateProjectKey(other.rootDir, args.homeDir)
  );
  const explicit = await cli({
    ...globalArgs,
    argv: ["status", "--root", join(args.worktree, ".ai"), "--project"],
  });
  expect(explicit.config.automationName).toBe(project.config.automationName);
});

it("enrolls a linked checkout into the canonical repository store without an execution registration", async () => {
  const args = await fixture();
  const plan = await planProjectEnrollment({
    projectRoot: args.worktree,
    homeDir: args.homeDir,
  });
  expect(plan.projectRoot).toBe(args.primary);
  expect(plan.executionIdentity).toEqual(
    await resolveRepositoryExecutionIdentity(args.primary)
  );
  for (const lockPath of [
    facultAiEvolutionLoopLockPath,
    facultAiReconciliationLockPath,
  ]) {
    expect(lockPath(args.homeDir, join(args.worktree, ".ai"))).toBe(
      lockPath(args.homeDir, args.rootDir)
    );
  }
  const result = await applyProjectEnrollment({
    plan,
    expectedPlanSha256: plan.planSha256,
    homeDir: args.homeDir,
  });
  const registry = await Bun.file(result.registryPath).json();
  expect(Object.keys(registry.projects)).toEqual([plan.identity.id]);
  expect(
    registry.projects[plan.identity.id].locations.map(
      (entry: { path: string }) => entry.path
    )
  ).toEqual([args.primary]);
  expect(facultMachineStateDir(args.homeDir, join(args.worktree, ".ai"))).toBe(
    facultMachineStateDir(args.homeDir, args.rootDir)
  );
  expect(
    await readdir(join(facultLocalStateRoot(args.homeDir), "projects"))
  ).not.toContainEqual(expect.stringMatching(EPHEMERAL_RE));
  expect(
    await Bun.file(join(args.worktree, ".ai", "config.toml")).exists()
  ).toBe(false);
});

it("runs scheduled and manual commands from a linked checkout using one canonical automation and state", async () => {
  const args = await fixture();
  const enabled = await cli({ ...args, argv: ["enable", "--project"] });
  expect(enabled.config.automationName).not.toContain("worktree_");
  const automation = Bun.TOML.parse(
    await readFile(join(enabled.automationPath, "automation.toml"), "utf8")
  ) as Record<string, unknown>;
  expect(automation.cwds).toEqual([args.primary]);
  expect(automation.prompt).toContain(args.rootDir);
  expect(automation.prompt).not.toContain(args.worktree);
  expect(
    (await cli({ ...args, argv: ["preflight", "--project"] })).status
  ).toBe("ready");
  for (const flags of [[], ["--scheduled"]]) {
    const report = await cli({ ...args, argv: ["run", "--project", ...flags] });
    expect(report.projectRoot).toBe(args.primary);
  }
  await mkdir(join(args.primary, "nested"));
  await mkdir(join(args.worktree, "nested"));
  expect(
    (
      await cli({
        ...args,
        worktree: join(args.worktree, "nested"),
        argv: ["preflight", "--project"],
      })
    ).status
  ).toBe("ready");
  const state = await Bun.file(
    facultAiEvolutionLoopStatePath(args.homeDir, args.rootDir)
  ).json();
  expect(state.lastRunAt).toBeString();
  expect(state.lastSuccessfulScheduledRunAt).toBeString();
  expect(await readdir(join(args.homeDir, ".codex", "automations"))).toEqual([
    enabled.config.automationName,
  ]);
  expect(
    await readdir(join(facultLocalStateRoot(args.homeDir), "projects"))
  ).not.toContainEqual(expect.stringMatching(EPHEMERAL_RE));
  const status = await cli({
    ...args,
    argv: ["status", "--all-projects", "--stale-after", "8d"],
  });
  expect(status.projects).toContainEqual(
    expect.objectContaining({
      ephemeral: false,
      stale: false,
      lastRunAt: state.lastRunAt,
    })
  );
});

it("reuses an existing canonical slug store from a linked checkout", async () => {
  const args = await fixture();
  const key = legacyMachineStateProjectKey(args.rootDir, args.homeDir);
  await mkdir(join(facultLocalStateRoot(args.homeDir), "projects", key), {
    recursive: true,
  });
  await Bun.write(
    join(facultLocalStateRoot(args.homeDir), "projects", key, "existing.json"),
    "{}"
  );
  const enabled = await enableEvolutionLoop({
    homeDir: args.homeDir,
    rootDir: join(args.worktree, ".ai"),
    scope: "project",
  });
  expect(enabled.config.automationName).toBe(`fclt-evolution-${key}`);
  expect(enabled.configPath).toContain(`/projects/${key}/`);
  expect(
    (
      await preflightEvolutionLoop({
        homeDir: args.homeDir,
        rootDir: join(args.worktree, ".ai"),
        scope: "project",
      })
    ).status
  ).toBe("ready");
});

it("keeps subprocess loop writes in the parent's selected machine-state root", async () => {
  const args = await fixture();
  const previous = process.env.FACULT_LOCAL_STATE_DIR;
  process.env.FACULT_LOCAL_STATE_DIR = join(args.homeDir, "selected-state");
  try {
    await cli({ ...args, argv: ["enable", "--project"] });
    await cli({ ...args, argv: ["run", "--project", "--scheduled"] });
    const state = await Bun.file(
      facultAiEvolutionLoopStatePath(args.homeDir, args.rootDir)
    ).json();
    expect(state.lastRunAt).toBeString();
    expect(state.lastSuccessfulScheduledRunAt).toBeString();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "FACULT_LOCAL_STATE_DIR");
    } else {
      process.env.FACULT_LOCAL_STATE_DIR = previous;
    }
  }
});

it("fails closed on prior primary-checkout execution state without changing its automation or data", async () => {
  const args = await fixture();
  const enabled = await enableEvolutionLoop(args);
  const repositoryStore = facultMachineStateDir(args.homeDir, args.rootDir);
  const executionStore = join(
    facultLocalStateRoot(args.homeDir),
    "projects",
    executionMachineStateProjectKey(args.rootDir, args.homeDir)
  );
  const preserved = new Map<string, string>();
  for (const relativePath of [
    "ai/project/writebacks/queue.jsonl",
    "ai/project/evolution/proposals/proposal.json",
    "ai/project/evolution/loop/state.json",
    "journal/events.jsonl",
  ]) {
    await Bun.write(join(repositoryStore, relativePath), "preserved history\n");
    preserved.set(join(executionStore, relativePath), "preserved history\n");
  }
  await rename(repositoryStore, executionStore);
  const automationPath = join(enabled.automationPath, "automation.toml");
  const automation = await readFile(automationPath, "utf8");
  const message = "primary-checkout execution state requires reconciliation";
  for (const rootDir of [args.rootDir, join(args.worktree, ".ai")]) {
    expect(() => facultMachineStateDir(args.homeDir, rootDir)).toThrow(message);
    await expect(enableEvolutionLoop({ ...args, rootDir })).rejects.toThrow(
      message
    );
    await expect(disableEvolutionLoop({ ...args, rootDir })).rejects.toThrow(
      message
    );
    await expect(runEvolutionLoop({ ...args, rootDir })).rejects.toThrow(
      message
    );
    await expect(
      planProjectEnrollment({
        projectRoot: dirname(rootDir),
        homeDir: args.homeDir,
      })
    ).rejects.toThrow(message);
  }
  for (const [path, content] of preserved) {
    expect(await readFile(path, "utf8")).toBe(content);
  }
  expect(await readFile(automationPath, "utf8")).toBe(automation);
  expect(await readdir(join(args.homeDir, ".codex", "automations"))).toEqual([
    enabled.config.automationName,
  ]);
  expect(
    await Bun.file(join(repositoryStore, "ai", "index.json")).exists()
  ).toBe(false);
  expect(
    await readdir(join(facultLocalStateRoot(args.homeDir), "projects"))
  ).not.toContain(basename(repositoryStore));
});

it("uses canonical assets for shared indexes and graphs when a linked checkout has divergent assets", async () => {
  const args = await fixture();
  const linkedRoot = join(args.worktree, ".ai");
  for (const [root, name] of [
    [args.rootDir, "canonical-only"],
    [linkedRoot, "linked-only"],
  ] as const) {
    await Bun.write(join(root, "skills", name, "SKILL.md"), `# ${name}\n`);
    await Bun.write(
      join(root, "skills", "shared", "SKILL.md"),
      `# ${name} shared\n`
    );
  }
  const canonical = await buildIndex({
    homeDir: args.homeDir,
    rootDir: args.rootDir,
  });
  for (const force of [false, true]) {
    const linked = await buildIndex({
      homeDir: args.homeDir,
      rootDir: linkedRoot,
      force,
    });
    expect(linked.outputPath).toBe(canonical.outputPath);
    expect(linked.graphPath).toBe(canonical.graphPath);
    expect(linked.index.skills["canonical-only"]).toEqual(
      canonical.index.skills["canonical-only"]
    );
    expect(linked.index.skills.shared).toEqual(canonical.index.skills.shared);
    expect(linked.index.skills["linked-only"]).toBeUndefined();
    expect(JSON.stringify(linked.graph)).not.toContain(linkedRoot);
    expect(await Bun.file(linked.outputPath).json()).toEqual(linked.index);
    expect(await Bun.file(linked.graphPath).json()).toEqual(linked.graph);
  }
  const snapshot = await buildIndexSnapshot({
    homeDir: args.homeDir,
    rootDir: linkedRoot,
  });
  expect(snapshot.index.skills.shared).toEqual(canonical.index.skills.shared);
  expect(snapshot.index.skills["linked-only"]).toBeUndefined();
});

it("refuses unresolved linked repositories and execution-named automation scaffolds", async () => {
  const args = await fixture();
  await expect(
    scaffoldCodexAutomationTemplate({
      homeDir: args.homeDir,
      cwd: args.worktree,
      templateId: "closed-loop-review",
      scope: "project",
      name: "fclt-evolution-worktree_123",
    })
  ).rejects.toThrow("Execution identities");
  await rename(args.primary, join(args.homeDir, "moved"));
  for (const operation of [enableEvolutionLoop, runEvolutionLoop]) {
    await expect(
      operation({
        homeDir: args.homeDir,
        rootDir: join(args.worktree, ".ai"),
        scope: "project",
      })
    ).rejects.toThrow("Cannot safely resolve canonical repository");
  }
  expect(
    (
      await preflightEvolutionLoop({
        homeDir: args.homeDir,
        rootDir: join(args.worktree, ".ai"),
        scope: "project",
      })
    ).status
  ).toBe("blocked");
  expect(
    await Bun.file(join(args.homeDir, ".codex", "automations")).exists()
  ).toBe(false);
});

it("reports paused, missing, stale and ephemeral stores without modifying their files", async () => {
  const args = await fixture();
  const projectsRoot = join(facultLocalStateRoot(args.homeDir), "projects");
  const keys = [
    "old-123456789abc",
    "recent-123456789abc",
    "never-123456789abc",
    `worktree_${"a".repeat(24)}`,
  ];
  const now = new Date("2026-10-27T12:00:00Z");
  const snapshots = new Map<string, string>();
  for (const [index, key] of keys.entries()) {
    const loopDir = join(
      projectsRoot,
      key,
      "ai",
      "project",
      "evolution",
      "loop"
    );
    await mkdir(loopDir, { recursive: true });
    const state = {
      version: 1,
      generation: 1,
      queue: {},
      fingerprints: {},
      ...(index !== 2
        ? {
            lastRunAt:
              index === 1 ? "2026-10-19T12:00:00Z" : "2026-10-01T12:00:00Z",
            lastSuccessfulScheduledRunAt: "2026-09-14T12:00:00Z",
          }
        : {}),
    };
    const statePath = join(loopDir, "state.json");
    await Bun.write(statePath, JSON.stringify(state));
    snapshots.set(statePath, await readFile(statePath, "utf8"));
    if (index < 2) {
      const automationPath = join(
        args.homeDir,
        ".codex",
        "automations",
        `fclt-evolution-${key}`,
        "automation.toml"
      );
      await Bun.write(
        automationPath,
        `version = 1\nid = "fclt-evolution-${key}"\nmanaged_by = "fclt-evolution-loop"\nstatus = "${index === 0 ? "PAUSED" : "ACTIVE"}"\n`
      );
      snapshots.set(automationPath, await readFile(automationPath, "utf8"));
    }
  }
  const report = await evolutionLoopPortfolioStatus({
    homeDir: args.homeDir,
    now,
  });
  expect(report.staleAfterDays).toBe(8);
  expect(report.projects).toHaveLength(4);
  expect(
    report.projects.find((row) => row.projectKey === keys[0])
  ).toMatchObject({
    schedulerStatus: "PAUSED",
    stale: true,
    ephemeral: false,
    lastSuccessfulScheduledRunAt: "2026-09-14T12:00:00Z",
  });
  expect(
    report.projects.find((row) => row.projectKey === keys[1])
  ).toMatchObject({ schedulerStatus: "ACTIVE", stale: false });
  expect(
    report.projects.find((row) => row.projectKey === keys[2])
  ).toMatchObject({ schedulerStatus: "missing", stale: true, lastRunAt: null });
  expect(
    report.projects.find((row) => row.projectKey === keys[3])
  ).toMatchObject({ ephemeral: true, stale: true });
  expect(
    (
      await evolutionLoopPortfolioStatus({
        homeDir: args.homeDir,
        now,
        staleAfter: "7d",
      })
    ).projects.every((row) => row.stale)
  ).toBe(true);
  for (const [path, contents] of snapshots) {
    expect(await readFile(path, "utf8")).toBe(contents);
  }
  expect((await readdir(projectsRoot)).sort()).toEqual(keys.sort());
  for (const invalid of ["0d", "8", "-1d", "1.5d", "NaNd"]) {
    expect(() => parseLoopStaleAfter(invalid)).toThrow("--stale-after");
  }
});

it("includes enrolled projects without runs and flags unsafe stores without following symlinks", async () => {
  const args = await fixture();
  const plan = await planProjectEnrollment({
    projectRoot: args.primary,
    homeDir: args.homeDir,
  });
  await applyProjectEnrollment({
    plan,
    expectedPlanSha256: plan.planSha256,
    homeDir: args.homeDir,
  });
  const projectsRoot = join(facultLocalStateRoot(args.homeDir), "projects");
  await symlink(args.primary, join(projectsRoot, "unsafe-123456789abc"));
  const status = await evolutionLoopPortfolioStatus({ homeDir: args.homeDir });
  expect(status.projects).toContainEqual(
    expect.objectContaining({
      projectKey: repositoryMachineStateProjectKey(args.rootDir, args.homeDir),
      repositoryId: plan.identity.id,
      stale: true,
      lastRunAt: null,
    })
  );
  expect(status.projects).toContainEqual(
    expect.objectContaining({
      projectKey: "unsafe-123456789abc",
      stale: true,
      schedulerStatus: "unknown",
      error: expect.stringContaining("Unsafe loop status path"),
    })
  );
});

it.each([
  "invalid",
  "2027-01-01T00:00:00Z",
])("reports a %s run timestamp as stale", async (lastRunAt) => {
  const homeDir = await mkdtemp(join(tmpdir(), "fclt-staleness-"));
  const statePath = join(
    facultLocalStateRoot(homeDir),
    "projects",
    "invalid-123456789abc",
    "ai",
    "project",
    "evolution",
    "loop",
    "state.json"
  );
  await Bun.write(statePath, JSON.stringify({ version: 1, lastRunAt }));
  const result = await evolutionLoopPortfolioStatus({
    homeDir,
    now: new Date("2026-10-27T12:00:00Z"),
  });
  expect(result.projects[0]?.stale).toBe(true);
});

it("refuses a linked checkout whose common-directory pointer was redirected", async () => {
  const args = await fixture();
  const other = await fixture();
  const gitDir = join(args.primary, ".git", "worktrees", "linked");
  await Bun.write(
    join(gitDir, "commondir"),
    `${join(other.primary, ".git")}\n`
  );
  await expect(
    enableEvolutionLoop({
      homeDir: args.homeDir,
      rootDir: join(args.worktree, ".ai"),
      scope: "project",
    })
  ).rejects.toThrow("not registered in the Git common directory");
  expect(
    await Bun.file(join(args.homeDir, ".codex", "automations")).exists()
  ).toBe(false);
});
