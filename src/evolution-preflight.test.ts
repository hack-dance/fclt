import { afterEach, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runFixtureGit } from "../test/git-fixture";
import { enableEvolutionLoop } from "./evolution-loop";
import { preflightEvolutionLoop } from "./evolution-preflight";
import {
  facultAiActivityHistorySegmentDir,
  facultAiDraftDir,
  facultAiEvolutionLoopConfigPath,
  facultAiEvolutionLoopStatePath,
  facultAiEvolutionReviewDir,
  facultAiReconciliationStatePath,
} from "./paths";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function setup(scope: "project" | "global") {
  const homeDir = await mkdtemp(join(tmpdir(), "fclt-preflight-test-"));
  roots.push(homeDir);
  const rootDir =
    scope === "project" ? join(homeDir, "repo", ".ai") : join(homeDir, ".ai");
  await mkdir(rootDir, { recursive: true });
  await Bun.write(
    join(rootDir, "reconciliation.json"),
    JSON.stringify({
      version: 1,
      sources: [{ id: "writebacks", type: "writebacks" }],
    })
  );
  await enableEvolutionLoop({ homeDir, rootDir, scope });
  return { homeDir, rootDir, scope };
}
for (const scope of ["project", "global"] as const) {
  it(`preflights ${scope} writes without creating queue state or leaving probes`, async () => {
    const args = await setup(scope);
    const result = await preflightEvolutionLoop(args);
    expect(result.status).toBe("ready");
    expect(result.loopInvoked).toBe(false);
    expect(
      await Bun.file(
        facultAiEvolutionLoopStatePath(args.homeDir, args.rootDir)
      ).exists()
    ).toBe(false);
    for (const check of result.checks) {
      expect(check.writable).toBe(true);
      expect(
        (await readdir(check.path)).some((name) =>
          name.startsWith(".fclt-preflight-")
        )
      ).toBe(false);
    }
  });
}
it("reports an inaccessible review destination before loop execution", async () => {
  const args = await setup("project");
  const path = facultAiEvolutionReviewDir(args.homeDir, args.rootDir);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, "occupied");
  const result = await preflightEvolutionLoop(args);
  expect(result.status).toBe("blocked");
  expect(result.loopInvoked).toBe(false);
  expect(result.checks).toContainEqual(
    expect.objectContaining({ path, writable: false })
  );
  expect(result.recovery).toContain(path);
  expect(
    await Bun.file(
      facultAiEvolutionLoopStatePath(args.homeDir, args.rootDir)
    ).exists()
  ).toBe(false);
});

it("does not report malformed enabled configuration as ready", async () => {
  const args = await setup("project");
  await Bun.write(
    facultAiEvolutionLoopConfigPath(args.homeDir, args.rootDir),
    JSON.stringify({ enabled: true })
  );
  const result = await preflightEvolutionLoop(args);
  expect(result.status).toBe("blocked");
  expect(result.configError).toContain("schema");
  expect(result.loopInvoked).toBe(false);
});

for (const destination of [
  (home: string, root: string) =>
    dirname(facultAiReconciliationStatePath(home, root)),
  facultAiActivityHistorySegmentDir,
  facultAiDraftDir,
]) {
  it("blocks on an unavailable runtime sibling even when the loop directory is writable", async () => {
    const args = await setup("project");
    const path = destination(args.homeDir, args.rootDir);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, "occupied");
    const result = await preflightEvolutionLoop(args);
    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(
      expect.objectContaining({ path, writable: false })
    );
    expect(result.loopInvoked).toBe(false);
  });
}

for (const scenario of [
  "missing",
  "malformed",
  "empty",
  "selection",
] as const) {
  it(`blocks ${scenario} source configuration before a review attempt`, async () => {
    const args = await setup("project");
    const path = join(args.rootDir, "reconciliation.json");
    if (scenario === "missing") {
      await rm(path);
    }
    if (scenario === "malformed") {
      await Bun.write(path, "{broken");
    }
    if (scenario === "empty") {
      await Bun.write(path, JSON.stringify({ version: 1, sources: [] }));
    }
    if (scenario === "selection") {
      const loopPath = facultAiEvolutionLoopConfigPath(
        args.homeDir,
        args.rootDir
      );
      const config = await Bun.file(loopPath).json();
      config.sourceIds = ["missing-source"];
      await Bun.write(loopPath, JSON.stringify(config));
    }
    const result = await preflightEvolutionLoop(args);
    expect(result.status).toBe("blocked");
    expect(result.configError).toBeTruthy();
    expect(result.loopInvoked).toBe(false);
    expect(result.recovery).toContain("configuration");
    expect(
      await Bun.file(
        facultAiEvolutionLoopStatePath(args.homeDir, args.rootDir)
      ).exists()
    ).toBe(false);
  });
}

it("blocks a generated worktree without loop config and names the primary checkout", async () => {
  const homeDir = await realpath(
    await mkdtemp(join(tmpdir(), "fclt-preflight-wt-"))
  );
  roots.push(homeDir);
  const primary = join(homeDir, "repo");
  await mkdir(join(primary, ".ai"), { recursive: true });
  const git = (cwd: string, ...argv: string[]) =>
    runFixtureGit({
      argv: ["-C", cwd, ...argv],
      repoDir: primary,
      homeDir: join(homeDir, ".git-home"),
    });
  await git(primary, "init", "-q");
  await Bun.write(join(primary, ".gitignore"), ".ai/\n");
  await git(primary, "add", ".gitignore");
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
  await Bun.write(
    join(primary, ".ai", "reconciliation.json"),
    JSON.stringify({
      version: 1,
      sources: [{ id: "writebacks", type: "writebacks" }],
    })
  );
  await enableEvolutionLoop({
    homeDir,
    rootDir: join(primary, ".ai"),
    scope: "project",
  });
  const worktree = join(homeDir, "wt");
  await git(primary, "worktree", "add", "-q", "--detach", worktree);
  const rootDir = join(worktree, ".ai");
  const result = await preflightEvolutionLoop({
    homeDir,
    rootDir,
    scope: "project",
  });
  expect(result.status).toBe("blocked");
  expect(result.blocker).toBe("linked-worktree-without-loop-config");
  expect(result.primaryCheckout).toBe(primary);
  expect(result.loopInvoked).toBe(false);
  expect(result.checks).toEqual([]);
  expect(result.recovery).toContain(primary);
  const primaryResult = await preflightEvolutionLoop({
    homeDir,
    rootDir: join(primary, ".ai"),
    scope: "project",
  });
  expect(primaryResult.status).toBe("ready");
  expect(primaryResult.blocker).toBeNull();
  const previous = {
    dir: process.env.GIT_DIR,
    common: process.env.GIT_COMMON_DIR,
  };
  process.env.GIT_DIR = join(homeDir, "missing-git-dir");
  process.env.GIT_COMMON_DIR = join(homeDir, "missing-common-dir");
  try {
    const inherited = await preflightEvolutionLoop({
      homeDir,
      rootDir,
      scope: "project",
    });
    expect(inherited.blocker).toBe("linked-worktree-without-loop-config");
    expect(inherited.primaryCheckout).toBe(primary);
    expect(inherited.checks).toEqual([]);
  } finally {
    for (const [name, value] of [
      ["GIT_DIR", previous.dir],
      ["GIT_COMMON_DIR", previous.common],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

it("does not report a configured but disabled linked worktree as missing config", async () => {
  const homeDir = await realpath(
    await mkdtemp(join(tmpdir(), "fclt-preflight-wt-"))
  );
  roots.push(homeDir);
  const primary = join(homeDir, "repo");
  await mkdir(primary, { recursive: true });
  const git = (cwd: string, ...argv: string[]) =>
    runFixtureGit({
      argv: ["-C", cwd, ...argv],
      repoDir: primary,
      homeDir: join(homeDir, ".git-home"),
    });
  await git(primary, "init", "-q");
  await git(
    primary,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init"
  );
  const worktree = join(homeDir, "wt");
  await git(primary, "worktree", "add", "-q", "--detach", worktree);
  const rootDir = join(worktree, ".ai");
  await mkdir(rootDir, { recursive: true });
  await Bun.write(
    join(rootDir, "reconciliation.json"),
    JSON.stringify({
      version: 1,
      sources: [{ id: "writebacks", type: "writebacks" }],
    })
  );
  await enableEvolutionLoop({ homeDir, rootDir, scope: "project" });
  const config = JSON.parse(
    await Bun.file(facultAiEvolutionLoopConfigPath(homeDir, rootDir)).text()
  );
  await Bun.write(
    facultAiEvolutionLoopConfigPath(homeDir, rootDir),
    JSON.stringify({ ...config, enabled: false })
  );
  const result = await preflightEvolutionLoop({
    homeDir,
    rootDir,
    scope: "project",
  });
  expect(result.status).toBe("blocked");
  expect(result.blocker).toBe("loop-disabled");
  expect(result.checks.length).toBeGreaterThan(0);
});

it("does not treat a --separate-git-dir checkout as a generated worktree", async () => {
  const homeDir = await realpath(
    await mkdtemp(join(tmpdir(), "fclt-preflight-sep-"))
  );
  roots.push(homeDir);
  const primary = join(homeDir, "repo");
  await mkdir(primary, { recursive: true });
  await runFixtureGit({
    argv: [
      "init",
      "-q",
      "--separate-git-dir",
      join(homeDir, "meta.git"),
      primary,
    ],
    repoDir: primary,
    homeDir: join(homeDir, ".git-home"),
  });
  const result = await preflightEvolutionLoop({
    homeDir,
    rootDir: join(primary, ".ai"),
    scope: "project",
  });
  expect(result.blocker).not.toBe("linked-worktree-without-loop-config");
  expect(result.loopInvoked).toBe(false);
});
