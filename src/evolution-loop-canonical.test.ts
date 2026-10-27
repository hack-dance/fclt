import { expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixtureGit } from "../test/git-fixture";
import { enableEvolutionLoop, runEvolutionLoop } from "./evolution-loop";
import {
  evolutionLoopPortfolioStatus,
  parseLoopStaleAfter,
} from "./evolution-loop-portfolio";
import { preflightEvolutionLoop } from "./evolution-preflight";
import {
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

const EPHEMERAL_RE = /^worktree_/;

async function fixture() {
  const homeDir = await mkdtemp(join(tmpdir(), "fclt-canonical-loop-"));
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
  await git("worktree", "add", "--detach", worktree);
  const rootDir = join(primary, ".ai");
  await Bun.write(join(rootDir, "config.toml"), "version = 1\n");
  await Bun.write(
    join(rootDir, "reconciliation.json"),
    JSON.stringify({
      version: 1,
      sources: [{ id: "writebacks", type: "writebacks" }],
    })
  );
  return { homeDir, primary, worktree, rootDir };
}

async function cli(args: {
  homeDir: string;
  worktree: string;
  argv: string[];
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
        FACULT_ROOT_DIR: "",
        FACULT_ROOT_SCOPE: "",
        FACULT_LOCAL_STATE_DIR: "",
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
