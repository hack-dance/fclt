import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runFixtureGit } from "../test/git-fixture";
import { ensureAiGraphPath, ensureAiIndexPath } from "./ai-state";
import { withGeneratedStateLock } from "./generated-state-io";
import { loadGraph } from "./graph-query";
import { buildIndex } from "./index-builder";
import {
  facultAiGraphPath,
  facultAiIndexPath,
  facultAiWritebackQueuePath,
  pathIsPhysicallyInsideOrEqual,
  withFacultRootScope,
} from "./paths";
import { loadIndex } from "./query";

let homeDir: string | undefined;
const originalHome = process.env.HOME;
const originalState = process.env.FACULT_LOCAL_STATE_DIR;

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.FACULT_LOCAL_STATE_DIR = originalState;
  if (homeDir) {
    await rm(homeDir, { recursive: true, force: true });
  }
  homeDir = undefined;
});

async function fixture() {
  homeDir = await mkdtemp(join(tmpdir(), "fclt-generated-state-"));
  process.env.HOME = homeDir;
  process.env.FACULT_LOCAL_STATE_DIR = join(homeDir, "state");
  const rootDir = join(homeDir, ".ai");
  await mkdir(join(rootDir, "skills", "sample"), { recursive: true });
  await Bun.write(join(rootDir, "skills", "sample", "SKILL.md"), "# Sample\n");
  return { homeDir, rootDir };
}

async function legacyFixture(args: { homeDir: string; rootDir: string }) {
  const { homeDir, rootDir } = args;
  const first = await buildIndex(args);
  first.index.skills.sample = {
    ...first.index.skills.sample!,
    enabledFor: ["codex"],
    trusted: true,
    trustedBy: "user",
    trustedAt: "2026-01-01T00:00:00.000Z",
    auditStatus: "flagged",
    lastAuditAt: "2026-01-02T00:00:00.000Z",
  };
  const legacyDir = join(rootDir, ".facult", "ai");
  await mkdir(legacyDir, { recursive: true });
  const index = `${JSON.stringify(first.index)}\n`;
  const graph = `${JSON.stringify(first.graph)}\n`;
  await Bun.write(join(legacyDir, "index.json"), index);
  await Bun.write(join(legacyDir, "graph.json"), graph);
  await rm(dirname(facultAiIndexPath(homeDir, rootDir)), { recursive: true });
  return { legacyDir, index, graph };
}

describe("machine-local global generated state", () => {
  it("migrates tracked legacy state without changing any canonical Git files", async () => {
    const args = await fixture();
    const legacy = await legacyFixture(args);
    await Bun.write(join(args.rootDir, "notes.txt"), "User notes\n");
    const git = (argv: string[]) =>
      runFixtureGit({
        argv,
        repoDir: args.rootDir,
        homeDir: args.homeDir,
        cwd: args.rootDir,
      });
    await git(["init"]);
    await git(["add", "."]);
    const before = await git([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    const old = Date.now() / 1000 - 120;
    await utimes(join(legacy.legacyDir, "index.json"), old, old);
    await Bun.write(
      join(args.rootDir, "skills", "sample", "SKILL.md"),
      "# Sample\n\nUpdated sample\n"
    );
    await git(["add", "."]);
    const canonicalBefore = await git(["diff", "--cached", "--binary"]);

    const repaired = await ensureAiIndexPath({ ...args, repair: true });
    expect(repaired.source).toBe("rebuilt");
    const saved = await loadIndex(args);
    expect(saved.skills.sample?.description).toBe("Updated sample");
    expect(saved.skills.sample?.enabledFor).toEqual(["codex"]);
    expect(saved.skills.sample?.trusted).toBe(true);
    expect(saved.skills.sample?.trustedBy).toBe("user");
    expect(saved.skills.sample?.auditStatus).toBe("flagged");
    expect(saved.skills.sample?.lastAuditAt).toBe("2026-01-02T00:00:00.000Z");
    expect(
      Object.values((await loadGraph(args)).nodes).some(
        (node) => node.name === "sample"
      )
    ).toBe(true);
    expect(pathIsPhysicallyInsideOrEqual(repaired.path, args.rootDir)).toBe(
      false
    );
    expect(await readFile(join(legacy.legacyDir, "index.json"), "utf8")).toBe(
      legacy.index
    );
    expect(await readFile(join(legacy.legacyDir, "graph.json"), "utf8")).toBe(
      legacy.graph
    );
    expect(await readFile(join(args.rootDir, "notes.txt"), "utf8")).toBe(
      "User notes\n"
    );
    expect(await git(["diff", "--cached", "--binary"])).toBe(canonicalBefore);
    expect(await git(["diff", "--binary"])).toBe("");
    expect(
      await git(["status", "--porcelain=v1", "--untracked-files=all"])
    ).toBe(before);
  });

  it("reads legacy files without creating local state, then atomically copies fresh snapshots", async () => {
    const args = await fixture();
    const legacy = await legacyFixture(args);
    expect((await ensureAiIndexPath({ ...args, repair: false })).path).toBe(
      join(legacy.legacyDir, "index.json")
    );
    expect((await ensureAiGraphPath({ ...args, repair: false })).path).toBe(
      join(legacy.legacyDir, "graph.json")
    );
    expect(
      await Bun.file(facultAiIndexPath(args.homeDir, args.rootDir)).exists()
    ).toBe(false);
    const result = await ensureAiIndexPath({ ...args, repair: true });
    expect(result.source).toBe("legacy");
    await ensureAiGraphPath({ ...args, repair: true });
    expect(await Bun.file(result.path).text()).toBe(legacy.index);
    expect(
      await Bun.file(facultAiGraphPath(args.homeDir, args.rootDir)).text()
    ).toBe(legacy.graph);
    expect(await readdir(dirname(result.path))).toEqual(
      expect.arrayContaining(["index.json", "graph.json"])
    );
    expect(
      (await readdir(dirname(result.path))).some(
        (name) => name.endsWith(".tmp") || name === "writer.lock"
      )
    ).toBe(false);
  });

  it("isolates configured global roots and project state without moving runtime queues", async () => {
    const args = await fixture();
    const first = await buildIndex(args);
    const queue = facultAiWritebackQueuePath(args.homeDir, args.rootDir);
    const alternate = join(args.homeDir, "alternate", ".ai");
    await mkdir(join(alternate, "skills", "other"), { recursive: true });
    await Bun.write(
      join(alternate, "skills", "other", "SKILL.md"),
      "# Other\n"
    );
    await withFacultRootScope(
      { rootDir: alternate, scope: "global" },
      async () => {
        const second = await buildIndex({ ...args, rootDir: alternate });
        expect(second.outputPath).not.toBe(first.outputPath);
        expect(second.index.skills.sample).toBeUndefined();
        expect(second.index.skills.other).toBeDefined();
        expect(facultAiWritebackQueuePath(args.homeDir, alternate)).toBe(queue);
      }
    );
    const project = join(args.homeDir, "project", ".ai");
    await mkdir(project, { recursive: true });
    expect(facultAiIndexPath(args.homeDir, project)).not.toBe(first.outputPath);
    expect(await Bun.file(first.outputPath).json()).toEqual(first.index);
  });

  it("does not transfer legacy trust to a matching name from another root", async () => {
    const args = await fixture();
    const legacy = await legacyFixture(args);
    const foreign = JSON.parse(legacy.index);
    foreign.skills.sample.path = join(
      args.homeDir,
      "foreign",
      "skills",
      "sample",
      "SKILL.md"
    );
    foreign.skills.sample.sourceRoot = join(args.homeDir, "foreign");
    await Bun.write(
      join(legacy.legacyDir, "index.json"),
      JSON.stringify(foreign)
    );
    const rebuilt = await buildIndex(args);
    expect(rebuilt.index.skills.sample?.trusted).toBe(false);
    expect(rebuilt.index.skills.sample?.enabledFor).toBeUndefined();
  });

  it("keeps snapshot identity and matching metadata through a canonical-root alias", async () => {
    const args = await fixture();
    const legacy = await legacyFixture(args);
    const alias = join(args.homeDir, "alias");
    await symlink(args.rootDir, alias, "dir");
    const aliased = await buildIndex({ ...args, rootDir: alias });
    expect(aliased.outputPath).toBe(
      facultAiIndexPath(args.homeDir, args.rootDir)
    );
    expect(aliased.index.skills.sample?.trusted).toBe(true);
    expect(await Bun.file(join(legacy.legacyDir, "index.json")).text()).toBe(
      legacy.index
    );
  });

  it("rejects overlapping writers and preserves the prior snapshots", async () => {
    const args = await fixture();
    const first = await buildIndex(args);
    const directory = dirname(first.outputPath);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const writer = withGeneratedStateLock({
      directory,
      operation: async () => {
        entered();
        await gate;
      },
    });
    await acquired;
    try {
      await expect(buildIndex({ ...args, force: true })).rejects.toThrow(
        "writer lock exists"
      );
      expect(await Bun.file(first.outputPath).json()).toEqual(first.index);
      expect(await Bun.file(first.graphPath).json()).toEqual(first.graph);
    } finally {
      release();
      await writer;
    }
    await buildIndex(args);
    expect(await readdir(directory)).not.toContain("writer.lock");
  });

  it.each([
    "index",
    "graph",
  ])("preserves files reached through generated %s symlinks", async (target) => {
    const args = await fixture();
    const first = await buildIndex(args);
    const targetPath = target === "index" ? first.outputPath : first.graphPath;
    const otherPath = target === "index" ? first.graphPath : first.outputPath;
    const otherBefore = await Bun.file(otherPath).text();
    await rm(targetPath);
    const userFile = join(args.homeDir, "user-file.json");
    await Bun.write(userFile, "User data\n");
    await symlink(userFile, targetPath);
    await expect(buildIndex({ ...args, force: true })).rejects.toThrow(
      "non-regular generated state target"
    );
    expect(await Bun.file(userFile).text()).toBe("User data\n");
    expect(await Bun.file(otherPath).text()).toBe(otherBefore);
  });

  it("rejects local-state overrides inside the canonical root", async () => {
    const args = await fixture();
    process.env.FACULT_LOCAL_STATE_DIR = join(args.rootDir, "generated");
    expect(() => facultAiIndexPath(args.homeDir, args.rootDir)).toThrow(
      "outside the canonical root"
    );
    expect(await Bun.file(join(args.rootDir, "generated")).exists()).toBe(
      false
    );
  });
});
