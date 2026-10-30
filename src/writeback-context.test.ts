import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runFixtureGit } from "../test/git-fixture";
import type { AiProposalRecord, AiWritebackRecord } from "./ai";
import {
  facultAiGraphPath,
  facultAiJournalPath,
  facultAiProposalDir,
  facultAiWritebackQueuePath,
  facultAiWritebackReviewDir,
  facultLocalStateRoot,
} from "./paths";
import {
  applyProjectEnrollment,
  planProjectEnrollment,
  projectCommand,
} from "./projects";

const fixtures: string[] = [];
const origin = "https://example.invalid/team/repo.git";
const ORIGINLESS_TAG_RE = /^project:repo-[a-f0-9]{8}$/;
let savedEnvironment: NodeJS.ProcessEnv;

function cleanEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => !(name.startsWith("FACULT_") || name.startsWith("GIT_"))
    )
  );
}

beforeEach(async () => {
  savedEnvironment = { ...process.env };
  const root = await mkdtemp(join(tmpdir(), "fclt-writeback-case-"));
  fixtures.push(root);
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("FACULT_") || name.startsWith("GIT_")) {
      delete process.env[name];
    }
  }
  for (const [name, directory] of Object.entries({
    HOME: "home",
    FACULT_LOCAL_STATE_DIR: "home/state",
    FACULT_CACHE_DIR: "home/cache/fclt",
    XDG_STATE_HOME: "xdg-state",
    XDG_CONFIG_HOME: "config",
    XDG_DATA_HOME: "data",
    XDG_CACHE_HOME: "cache",
    TMPDIR: "tmp",
    TMP: "tmp",
    TEMP: "tmp",
  })) {
    const path = join(root, directory);
    await mkdir(path, { recursive: true });
    process.env[name] = path;
  }
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL =
    process.platform === "win32" ? "NUL" : "/dev/null";
});

afterEach(async () => {
  for (const path of fixtures.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
  for (const name of Object.keys(process.env)) {
    if (!(name in savedEnvironment)) {
      delete process.env[name];
    }
  }
  Object.assign(process.env, savedEnvironment);
});

async function fixture({
  enroll = true,
  remote = true,
  repositoryDir,
}: {
  enroll?: boolean;
  remote?: boolean;
  repositoryDir?: string;
} = {}) {
  const homeDir = await realpath(process.env.HOME as string);
  const primary = join(repositoryDir ?? homeDir, "repo");
  const linked = join(repositoryDir ?? homeDir, "linked");
  const clone = join(repositoryDir ?? homeDir, "scratch");
  await mkdir(primary);
  const git = (repoDir: string, ...argv: string[]) =>
    runFixtureGit({
      argv: ["-C", repoDir, ...argv],
      repoDir,
      homeDir: join(homeDir, "git-home"),
    });
  await git(primary, "init", "-q");
  await Bun.write(join(primary, "AGENTS.md"), "# Fixture guidance\n");
  await git(primary, "add", "AGENTS.md");
  await git(
    primary,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "init"
  );
  await git(primary, "worktree", "add", "--detach", linked);
  await runFixtureGit({
    argv: ["clone", "--no-hardlinks", primary, clone],
    repoDir: clone,
    homeDir: join(homeDir, "git-home"),
  });
  await git(clone, "remote", "remove", "origin");
  if (remote) {
    await git(primary, "remote", "add", "origin", origin);
    await git(
      clone,
      "remote",
      "add",
      "origin",
      "git@example.invalid:team/repo.git"
    );
  }
  if (enroll) {
    const plan = await planProjectEnrollment({ projectRoot: primary, homeDir });
    await applyProjectEnrollment({
      plan,
      expectedPlanSha256: plan.planSha256,
      homeDir,
    });
  }
  return {
    homeDir,
    primary,
    linked,
    clone,
    git,
    rootDir: join(primary, ".ai"),
  };
}

async function cliResult(args: {
  homeDir: string;
  cwd: string;
  argv: string[];
  environmentRoot?: string;
  environmentScope?: string;
  namespace?: "writeback" | "evolve" | "review";
}) {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "index.ts"),
      "ai",
      args.namespace ?? "writeback",
      ...args.argv,
      "--json",
    ],
    {
      cwd: args.cwd,
      env: {
        ...cleanEnvironment(process.env),
        HOME: args.homeDir,
        XDG_STATE_HOME: join(args.homeDir, "state"),
        XDG_CONFIG_HOME: join(args.homeDir, "config"),
        XDG_DATA_HOME: join(args.homeDir, "data"),
        XDG_CACHE_HOME: join(args.homeDir, "cache"),
        FACULT_LOCAL_STATE_DIR: join(args.homeDir, "state"),
        FACULT_CACHE_DIR: join(args.homeDir, "cache", "fclt"),
        FACULT_ROOT_DIR: args.environmentRoot ?? "",
        FACULT_ROOT_SCOPE: args.environmentScope ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function cli(args: Parameters<typeof cliResult>[0]) {
  const { code, stdout, stderr } = await cliResult(args);
  if (
    code !== 0 ||
    stderr.split("\n").some((line) => line && !line.startsWith("Warning: "))
  ) {
    throw new Error(`CLI failed (${code}): ${stderr}`);
  }
  return stdout;
}

const addArgs = [
  "add",
  "--kind",
  "reusable_pattern",
  "--summary",
  "Fixture learning",
  "--evidence",
  "test:writeback-context",
  "--tag",
  "fixture",
];

it.each([
  "primary",
  "linked",
  "clone",
] as const)("routes %s and nested invocations to the enrolled queue", async (checkout) => {
  const args = await fixture();
  const cwd = join(args[checkout], "nested");
  await mkdir(cwd);
  const before = await readdir(
    join(facultLocalStateRoot(args.homeDir), "projects")
  );
  const record = JSON.parse(
    await cli({
      ...args,
      cwd,
      argv: [...addArgs, "--project", "--asset", "AGENTS.md"],
    })
  ) as AiWritebackRecord;
  expect(record.scope).toBe("project");
  expect(record.projectRoot).toBe(args.primary);
  expect(record.tags).toEqual(["fixture"]);
  expect(record.assetRef).toBe("@project/AGENTS.md");
  expect(
    await readFile(
      facultAiWritebackQueuePath(args.homeDir, args.rootDir),
      "utf8"
    )
  ).toContain(record.summary);
  expect(JSON.parse(await cli({ ...args, cwd, argv: ["list"] }))).toEqual([
    record,
  ]);
  expect(
    await readdir(join(facultLocalStateRoot(args.homeDir), "projects"))
  ).toEqual(before);
  expect(await Bun.file(join(args.clone, ".ai", "config.toml")).exists()).toBe(
    false
  );
});

it.each([
  true,
  false,
])("uses global storage and a project tag for an unenrolled repo (remote=%s)", async (remote) => {
  const args = await fixture({ enroll: false, remote });
  // A copied .ai directory does not establish enrollment.
  await Bun.write(join(args.primary, ".ai", "config.toml"), "version = 1\n");
  for (const scope of [[], ["--project"]]) {
    const record = JSON.parse(
      await cli({
        ...args,
        cwd: args.primary,
        argv: [...addArgs, ...scope],
      })
    ) as AiWritebackRecord;
    expect(record.scope).toBe("global");
    expect(record.projectRoot).toBeUndefined();
    expect(record.tags).toEqual([
      "fixture",
      remote
        ? "project:example.invalid/team/repo"
        : expect.stringMatching(ORIGINLESS_TAG_RE),
    ]);
    expect(record.assetRef).toBeUndefined();
  }
  const globalRoot = join(args.homeDir, ".ai");
  for (const path of [
    facultAiWritebackQueuePath(args.homeDir, globalRoot),
    facultAiJournalPath(args.homeDir, globalRoot),
    facultAiWritebackReviewDir(args.homeDir, globalRoot),
  ]) {
    expect(relative(args.homeDir, path).startsWith("..")).toBe(false);
    expect(
      (await Bun.file(path).exists()) ||
        (await readdir(path).catch(() => [])).length > 0
    ).toBe(true);
  }
  expect(
    await readdir(join(facultLocalStateRoot(args.homeDir), "projects")).catch(
      () => []
    )
  ).toEqual([]);
});

it("does not match shared history, upstream remotes, or similarly named forks", async () => {
  const args = await fixture();
  await args.git(
    args.clone,
    "remote",
    "set-url",
    "origin",
    "https://example.invalid/other/repo.git"
  );
  await args.git(args.clone, "remote", "add", "upstream", origin);
  const record = JSON.parse(
    await cli({ ...args, cwd: args.clone, argv: addArgs })
  ) as AiWritebackRecord;
  expect(record.scope).toBe("global");
  expect(record.tags).toContain("project:example.invalid/other/repo");
});

it("maps linked checkouts without a remote but leaves independent clones global", async () => {
  const args = await fixture({ remote: false });
  for (const checkout of ["linked", "clone"] as const) {
    const record = JSON.parse(
      await cli({ ...args, cwd: args[checkout], argv: addArgs })
    ) as AiWritebackRecord;
    expect(record.scope).toBe(checkout === "linked" ? "project" : "global");
  }
});

it("preserves explicit global, root, and environment selection", async () => {
  const args = await fixture();
  for (const options of [
    { argv: [...addArgs, "--global"] },
    {
      argv: addArgs,
      environmentRoot: join(args.homeDir, ".ai"),
      environmentScope: "global",
    },
    { argv: [...addArgs, "--root", join(args.homeDir, ".ai")] },
  ]) {
    const record = JSON.parse(
      await cli({ ...args, cwd: args.clone, ...options })
    ) as AiWritebackRecord;
    expect(record.scope).toBe("global");
    expect(record.tags).toEqual(["fixture"]);
  }
  const record = JSON.parse(
    await cli({
      ...args,
      cwd: args.linked,
      argv: [...addArgs, "--root", join(args.linked, ".ai")],
    })
  ) as AiWritebackRecord;
  expect(record.projectRoot).toBe(args.primary);
});

it("falls back globally when enrollment is disabled or its checkout is unavailable", async () => {
  const args = await fixture();
  const registryPath = join(
    facultLocalStateRoot(args.homeDir),
    "projects",
    "registry.json"
  );
  const before = await readFile(registryPath, "utf8");
  await projectCommand(["disable", "--project-root", args.primary, "--json"], {
    homeDir: args.homeDir,
  });
  const disabled = JSON.parse(
    await cli({ ...args, cwd: args.clone, argv: addArgs })
  ) as AiWritebackRecord;
  expect(disabled.scope).toBe("global");
  await Bun.write(registryPath, before);
  await rm(args.rootDir, { recursive: true });
  const stale = JSON.parse(
    await cli({ ...args, cwd: args.clone, argv: addArgs })
  ) as AiWritebackRecord;
  expect(stale.scope).toBe("global");
  expect(stale.tags).toContain("project:example.invalid/team/repo");
});

it("requires an explicit destination for ambiguous origins and prefers a shared checkout", async () => {
  const args = await fixture();
  const second = join(args.homeDir, "second-enrolled");
  await runFixtureGit({
    argv: ["clone", "--no-hardlinks", args.primary, second],
    repoDir: second,
    homeDir: join(args.homeDir, "git-home"),
  });
  await args.git(second, "remote", "set-url", "origin", origin);
  const plan = await planProjectEnrollment({
    projectRoot: second,
    homeDir: args.homeDir,
  });
  await applyProjectEnrollment({
    plan,
    expectedPlanSha256: plan.planSha256,
    homeDir: args.homeDir,
  });
  await expect(
    cli({ ...args, cwd: args.clone, argv: addArgs })
  ).rejects.toThrow("Multiple enrolled checkouts match this origin");
  const read = await cliResult({ ...args, cwd: args.clone, argv: ["list"] });
  expect(read.code).toBe(0);
  expect(JSON.parse(read.stdout)).toEqual([]);
  expect(read.stderr).toContain("multiple enrolled checkouts match");
  const record = JSON.parse(
    await cli({ ...args, cwd: args.linked, argv: addArgs })
  ) as AiWritebackRecord;
  expect(record.projectRoot).toBe(args.primary);
  const explicit = JSON.parse(
    await cli({
      ...args,
      cwd: args.clone,
      argv: [...addArgs, "--root", args.rootDir],
    })
  ) as AiWritebackRecord;
  expect(explicit.projectRoot).toBe(args.primary);
});

it("rejects unindexed fallback assets and prevents legacy project refs from reaching global files", async () => {
  const args = await fixture({ enroll: false });
  const globalRoot = join(args.homeDir, ".ai");
  const globalAgents = join(globalRoot, "AGENTS.md");
  await Bun.write(globalAgents, "# Global sentinel\n");
  const rejected = await cliResult({
    ...args,
    cwd: args.primary,
    argv: [...addArgs, "--asset", "AGENTS.md"],
  });
  expect(rejected.code).toBe(1);
  expect(rejected.stderr).toContain("Asset not found in graph");
  const record = JSON.parse(
    await cli({ ...args, cwd: args.primary, argv: addArgs })
  ) as AiWritebackRecord;
  // Preserve compatibility checks for unsafe records captured by the earlier release.
  await Bun.write(
    facultAiWritebackQueuePath(args.homeDir, globalRoot),
    `${JSON.stringify({ ...record, assetRef: "@project/AGENTS.md", suggestedDestination: "@project/AGENTS.md" })}\n`
  );
  const proposed = await cliResult({
    ...args,
    cwd: args.primary,
    namespace: "evolve",
    argv: ["propose"],
  });
  expect(proposed.code).toBe(0);
  expect(JSON.parse(proposed.stdout)).toEqual([]);
  expect(proposed.stderr).toContain(
    "cannot resolve within the current capability root"
  );
  const proposal: AiProposalRecord = {
    id: "EV-00001",
    ts: record.ts,
    scope: "global",
    status: "proposed",
    kind: "update_instruction",
    targets: ["@project/AGENTS.md"],
    sourceWritebacks: [record.id],
    summary: "Legacy unsafe target",
    rationale: "Fixture",
    confidence: "medium",
    reviewRequired: false,
    policyClass: "low-risk",
    draftRefs: [],
  };
  await Bun.write(
    join(facultAiProposalDir(args.homeDir, globalRoot), `${proposal.id}.json`),
    JSON.stringify(proposal)
  );
  await Bun.write(
    facultAiGraphPath(args.homeDir, globalRoot),
    JSON.stringify({
      version: 1,
      generatedAt: record.ts,
      nodes: {
        legacy: {
          id: "legacy",
          kind: "instruction",
          name: "AGENTS",
          sourceKind: "global",
          scope: "global",
          canonicalRef: "@project/AGENTS.md",
          path: globalAgents,
        },
      },
      edges: [],
    })
  );
  const draft = await cliResult({
    ...args,
    cwd: args.primary,
    namespace: "evolve",
    argv: ["draft", proposal.id],
  });
  expect(draft.code).toBe(1);
  expect(draft.stderr).toContain(
    "Could not resolve target within the current capability root"
  );
  await Bun.write(
    join(facultAiProposalDir(args.homeDir, globalRoot), `${proposal.id}.json`),
    JSON.stringify({ ...proposal, targets: ["legacy"] })
  );
  const aliasDraft = await cliResult({
    ...args,
    cwd: args.primary,
    namespace: "evolve",
    argv: ["draft", proposal.id],
  });
  expect(aliasDraft.code).toBe(1);
  expect(aliasDraft.stderr).toContain(
    "Could not resolve target within the current capability root"
  );
  const staleGraphAsset = await cliResult({
    ...args,
    cwd: args.primary,
    argv: [...addArgs, "--asset", "@project/AGENTS.md"],
  });
  expect(staleGraphAsset.code).toBe(1);
  expect(staleGraphAsset.stderr).toContain(
    "Project asset cannot be selected from global scope"
  );
  expect(await readFile(globalAgents, "utf8")).toBe("# Global sentinel\n");
});

it.each([
  "traversal",
  "symlink",
  "dangling-symlink",
  "graph",
])("refuses evolution targets that escape the selected root through %s", async (route) => {
  const args = await fixture({ enroll: false });
  const rootDir = join(args.homeDir, ".ai");
  await mkdir(rootDir, { recursive: true });
  const outside = join(args.homeDir, "outside");
  await Bun.write(join(outside, "SENTINEL.md"), "unchanged\n");
  if (route === "symlink") {
    await symlink(outside, join(rootDir, "linked"), "junction");
  } else if (route === "dangling-symlink") {
    await symlink(
      join(outside, "NEW.md"),
      join(rootDir, "dangling.md"),
      "file"
    );
  }
  const target =
    route === "traversal"
      ? "@ai/../outside/SENTINEL.md"
      : route === "symlink"
        ? "@ai/linked/SENTINEL.md"
        : route === "dangling-symlink"
          ? "@ai/dangling.md"
          : "instruction:escape";
  const record = JSON.parse(
    await cli({
      ...args,
      cwd: args.primary,
      argv: [...addArgs, "--suggested-destination", target],
    })
  ) as AiWritebackRecord;
  if (route === "graph") {
    await Bun.write(
      facultAiGraphPath(args.homeDir, rootDir),
      JSON.stringify({
        version: 1,
        generatedAt: record.ts,
        nodes: {
          "instruction:escape": {
            id: "instruction:escape",
            kind: "instruction",
            name: "escape",
            sourceKind: "global",
            scope: "global",
            path: join(outside, "SENTINEL.md"),
          },
        },
        edges: [],
      })
    );
  }
  const proposals = JSON.parse(
    await cli({
      ...args,
      cwd: args.primary,
      namespace: "evolve",
      argv: ["propose"],
    })
  ) as AiProposalRecord[];
  if (route === "graph") {
    expect(proposals).toHaveLength(1);
    const draft = await cliResult({
      ...args,
      cwd: args.primary,
      namespace: "evolve",
      argv: ["draft", proposals[0]?.id ?? ""],
    });
    expect(draft.code).toBe(1);
    expect(draft.stderr).toContain(
      "Keep this proposal for manual implementation"
    );
  } else {
    expect(proposals).toEqual([]);
  }
  expect(await readFile(join(outside, "SENTINEL.md"), "utf8")).toBe(
    "unchanged\n"
  );
  expect(await Bun.file(join(outside, "NEW.md")).exists()).toBe(false);
});

it.each([
  "linked",
  "clone",
] as const)("uses the same writeback, evolution, and review roots from %s", async (checkout) => {
  const args = await fixture();
  const cwd = args[checkout];
  const record = JSON.parse(
    await cli({ ...args, cwd, argv: [...addArgs, "--asset", "AGENTS.md"] })
  ) as AiWritebackRecord;
  const proposals = JSON.parse(
    await cli({
      ...args,
      cwd,
      namespace: "evolve",
      argv: ["propose", "--project"],
    })
  ) as AiProposalRecord[];
  expect(proposals).toHaveLength(1);
  expect(proposals[0]?.projectRoot).toBe(args.primary);
  expect(proposals[0]?.sourceWritebacks).toEqual([record.id]);
  await cli({
    ...args,
    cwd,
    namespace: "evolve",
    argv: ["draft", proposals[0]?.id ?? ""],
  });
  const status = JSON.parse(
    await cli({ ...args, cwd, namespace: "review", argv: ["status"] })
  ) as { configPath: string };
  expect(status.configPath).toBe(join(args.rootDir, "reconciliation.json"));
});

it("warns when explicit project scope falls back to the global destination", async () => {
  const args = await fixture({ enroll: false });
  const result = await cliResult({
    ...args,
    cwd: args.primary,
    argv: [...addArgs, "--project"],
  });
  expect(result.code).toBe(0);
  expect(result.stderr).toContain(
    `Using global destination ${join(args.homeDir, ".ai")} with tag project:example.invalid/team/repo`
  );
  expect(JSON.parse(result.stdout).scope).toBe("global");
});

it("ignores inherited state overrides and Git discovery variables in CLI children", async () => {
  const args = await fixture();
  const decoy = join(args.homeDir, "decoy");
  await mkdir(decoy);
  process.env.FACULT_LOCAL_STATE_DIR = decoy;
  process.env.FACULT_CACHE_DIR = decoy;
  process.env.FACULT_ROOT_DIR = decoy;
  process.env.FACULT_ROOT_SCOPE = "global";
  process.env.GIT_DIR = join(decoy, "missing.git");
  process.env.GIT_WORK_TREE = decoy;
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "core.worktree";
  process.env.GIT_CONFIG_VALUE_0 = decoy;
  const record = JSON.parse(
    await cli({ ...args, cwd: args.linked, argv: addArgs })
  ) as AiWritebackRecord;
  expect(record.projectRoot).toBe(args.primary);
  expect(await readdir(decoy)).toEqual([]);
});

it("keeps historical project queues accessible by explicit root while new captures and evolution use global", async () => {
  const args = await fixture({ enroll: false });
  await Bun.write(join(args.rootDir, "config.toml"), "version = 1\n");
  const captured = JSON.parse(
    await cli({
      ...args,
      cwd: args.primary,
      argv: [
        ...addArgs,
        "--suggested-destination",
        "@ai/instructions/VERIFY.md",
      ],
    })
  ) as AiWritebackRecord;
  const historical = {
    ...captured,
    id: "WB-00077",
    scope: "project",
    projectRoot: args.primary,
    summary: "Historical project capture",
  };
  const historicalQueue = facultAiWritebackQueuePath(
    args.homeDir,
    args.rootDir
  );
  const bytes = `${JSON.stringify(historical)}\n`;
  await Bun.write(historicalQueue, bytes);
  const listed = JSON.parse(
    await cli({
      ...args,
      cwd: args.primary,
      argv: ["list", "--root", args.rootDir],
    })
  );
  expect(listed).toEqual([historical]);
  const assessment = JSON.parse(
    await cli({
      ...args,
      cwd: args.primary,
      namespace: "evolve",
      argv: ["assess"],
    })
  ) as { scope: string; writebackCount: number };
  expect(assessment.scope).toBe("global");
  expect(assessment.writebackCount).toBe(1);
  expect(await readFile(historicalQueue, "utf8")).toBe(bytes);
});

it("falls back globally for a worktree backed by a bare repository", async () => {
  const args = await fixture();
  const bare = join(args.homeDir, "bare.git");
  const worktree = join(args.homeDir, "bare-linked");
  await runFixtureGit({
    argv: ["clone", "--bare", args.primary, bare],
    repoDir: bare,
    homeDir: args.homeDir,
  });
  await args.git(bare, "remote", "set-url", "origin", origin);
  await args.git(bare, "worktree", "add", "--detach", worktree);
  const record = JSON.parse(
    await cli({ ...args, cwd: worktree, argv: [...addArgs, "--project"] })
  ) as AiWritebackRecord;
  expect(record.scope).toBe("global");
  expect(record.tags).toContain("project:example.invalid/team/repo");
  expect(
    JSON.parse(await cli({ ...args, cwd: worktree, argv: ["show", record.id] }))
  ).toEqual(record);
  expect(
    JSON.parse(await cli({ ...args, cwd: worktree, argv: ["list"] }))
  ).toEqual([record]);
});

it.each([
  "deleted",
  "moved",
])("falls back globally when a separate main checkout is %s", async (change) => {
  const args = await fixture();
  const primary = join(args.homeDir, "separate-primary");
  const metadata = join(args.homeDir, "separate-metadata");
  const linked = join(args.homeDir, "orphaned-linked");
  await runFixtureGit({
    argv: ["clone", "--separate-git-dir", metadata, args.primary, primary],
    repoDir: primary,
    homeDir: args.homeDir,
  });
  await args.git(primary, "config", "core.worktree", primary);
  await args.git(primary, "remote", "set-url", "origin", origin);
  await args.git(primary, "worktree", "add", "--detach", linked);
  if (change === "deleted") {
    await rm(primary, { recursive: true });
  } else {
    await rename(primary, `${primary}-moved`);
  }
  const record = JSON.parse(
    await cli({ ...args, cwd: linked, argv: addArgs })
  ) as AiWritebackRecord;
  expect(record.scope).toBe("global");
  expect(record.tags).toContain("project:example.invalid/team/repo");
  expect(
    JSON.parse(await cli({ ...args, cwd: linked, argv: ["show", record.id] }))
  ).toEqual(record);
});

it("keeps an unenrolled submodule separate from its enrolled superproject", async () => {
  const args = await fixture();
  await args.git(
    args.primary,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    args.clone,
    "module"
  );
  const submodule = join(args.primary, "module");
  await args.git(
    submodule,
    "remote",
    "set-url",
    "origin",
    "https://example.invalid/team/module.git"
  );
  const record = JSON.parse(
    await cli({ ...args, cwd: submodule, argv: addArgs })
  ) as AiWritebackRecord;
  expect(record.scope).toBe("global");
  expect(record.tags).toContain("project:example.invalid/team/module");
  expect(
    await Bun.file(
      facultAiWritebackQueuePath(args.homeDir, args.rootDir)
    ).exists()
  ).toBe(false);
});

it("resolves a symlinked worktree directory to the physical enrolled checkout", async () => {
  const args = await fixture();
  const alias = join(args.homeDir, "linked-alias");
  await symlink(args.linked, alias, "junction");
  const record = JSON.parse(
    await cli({ ...args, cwd: alias, argv: addArgs })
  ) as AiWritebackRecord;
  expect(record.projectRoot).toBe(await realpath(args.primary));
});

it.skipIf(process.platform === "win32")(
  "accepts plain /tmp paths while recording the resolved primary checkout",
  async () => {
    const plainRoot = await mkdtemp("/tmp/fclt-writeback-plain-");
    fixtures.push(plainRoot);
    const args = await fixture({ repositoryDir: plainRoot });
    const record = JSON.parse(
      await cli({ ...args, cwd: join(plainRoot, "linked"), argv: addArgs })
    ) as AiWritebackRecord;
    expect(record.projectRoot).toBe(await realpath(args.primary));
  }
);

it("distinguishes originless repositories that share a directory name", async () => {
  const args = await fixture({ enroll: false, remote: false });
  const second = join(args.homeDir, "other", "repo");
  await mkdir(second, { recursive: true });
  await args.git(second, "init", "-q");
  const firstRecord = JSON.parse(
    await cli({ ...args, cwd: args.primary, argv: addArgs })
  ) as AiWritebackRecord;
  const secondRecord = JSON.parse(
    await cli({ ...args, cwd: second, argv: addArgs })
  ) as AiWritebackRecord;
  expect(firstRecord.tags[1]).toMatch(ORIGINLESS_TAG_RE);
  expect(secondRecord.tags[1]).toMatch(ORIGINLESS_TAG_RE);
  expect(secondRecord.tags[1]).not.toBe(firstRecord.tags[1]);
});
