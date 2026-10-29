import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { addWriteback } from "../src/ai";
import {
  facultAiJournalPath,
  facultAiWritebackQueuePath,
  facultAiWritebackReviewDir,
  facultLocalCacheRoot,
  facultLocalStateRoot,
  facultMachineStateDir,
  facultRootDir,
  pathIsInsideOrEqual,
  preferredGlobalAiRoot,
} from "../src/paths";

const testRoot = process.env.FCLT_TEST_TEMP_ROOT!;
const realHome = process.env.FCLT_TEST_REAL_HOME!;
const realState = process.env.FCLT_TEST_REAL_STATE_ROOT!;
const fixtureProjectAiDir = preferredGlobalAiRoot(join(testRoot, "project"));

// Compare metadata only: never read or report the contents of a real state store.
async function stateFingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(path: string): Promise<void> {
    let info: BigIntStats;
    try {
      info = await lstat(path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      hash.update("missing");
      return;
    }
    hash.update(`${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        hash.update(name);
        await visit(join(path, name));
      }
    }
  }
  await visit(root);
  return hash.digest("hex");
}

test("test preload removes repository-local Git context", () => {
  expect(process.env.GIT_DIR).toBeUndefined();
  expect(process.env.GIT_WORK_TREE).toBeUndefined();
  expect(process.env.GIT_COMMON_DIR).toBeUndefined();
  expect(process.env.GIT_INDEX_FILE).toBeUndefined();
  expect(process.env.GIT_CONFIG_COUNT).toBeUndefined();
  expect(process.env.GIT_CEILING_DIRECTORIES).toBeUndefined();
});

test("preload isolates home, XDG, temporary fixtures, and global/project state", () => {
  expect(Boolean(testRoot && realHome && realState)).toBe(true);
  const paths = [
    homedir(),
    tmpdir(),
    process.env.XDG_STATE_HOME!,
    process.env.XDG_CONFIG_HOME!,
    process.env.XDG_DATA_HOME!,
    process.env.XDG_CACHE_HOME!,
    facultRootDir(),
    facultLocalStateRoot(),
    facultLocalCacheRoot(),
    facultMachineStateDir(),
    facultMachineStateDir(undefined, fixtureProjectAiDir),
  ];
  for (const path of paths) {
    expect(pathIsInsideOrEqual(path, testRoot)).toBe(true);
    expect(pathIsInsideOrEqual(path, realHome)).toBe(false);
    expect(pathIsInsideOrEqual(path, realState)).toBe(false);
  }
  if (process.env.FCLT_TEST_SHELL_ROOT) {
    expect(testRoot).not.toBe(process.env.FCLT_TEST_SHELL_ROOT);
  }
});

test("fixture-specific homes keep their own machine-local state", () => {
  const home = join(testRoot, "fixture-home");
  expect(pathIsInsideOrEqual(facultLocalStateRoot(home), home)).toBe(true);
  expect(pathIsInsideOrEqual(facultLocalCacheRoot(home), home)).toBe(true);
});

test("global and project writebacks stay in the temp root without changing real state", async () => {
  const before = await stateFingerprint(realState);
  for (const rootDir of [facultRootDir(), fixtureProjectAiDir]) {
    const queuePath = facultAiWritebackQueuePath(undefined, rootDir);
    const journalPath = facultAiJournalPath(undefined, rootDir);
    const reviewDir = facultAiWritebackReviewDir(undefined, rootDir);
    for (const path of [queuePath, journalPath, reviewDir]) {
      expect(pathIsInsideOrEqual(path, testRoot)).toBe(true);
      expect(pathIsInsideOrEqual(path, realState)).toBe(false);
    }
    const record = await addWriteback({
      rootDir,
      kind: "reusable_pattern",
      summary: "Test process isolation regression",
      evidence: [{ type: "test", ref: "test/setup.test.ts" }],
    });
    const records = (await readFile(queuePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toContainEqual(record);
    expect(await readFile(journalPath, "utf8")).toContain(record.summary);
    expect((await readdir(reviewDir)).length).toBeGreaterThan(0);
  }
  expect((await stateFingerprint(realState)) === before).toBe(true);
});

test("CLI subprocess writebacks inherit isolation without changing real state", async () => {
  const before = await stateFingerprint(realState);
  const pathsModule = join(import.meta.dir, "..", "src", "paths.ts");
  const aiModule = join(import.meta.dir, "..", "src", "ai.ts");
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--eval",
      `import { addWriteback } from ${JSON.stringify(aiModule)};
       import { facultRootDir, facultAiWritebackQueuePath } from ${JSON.stringify(pathsModule)};
       await addWriteback({ rootDir: facultRootDir(), kind: "reusable_pattern",
         summary: "Subprocess isolation regression", evidence: [{ type: "test", ref: "test/setup.test.ts" }] });
       console.log(facultAiWritebackQueuePath());`,
    ],
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(0);
  const queuePath = stdout.trim();
  expect(pathIsInsideOrEqual(queuePath, testRoot)).toBe(true);
  expect(pathIsInsideOrEqual(queuePath, realState)).toBe(false);
  expect(await readFile(queuePath, "utf8")).toContain(
    "Subprocess isolation regression"
  );
  expect((await stateFingerprint(realState)) === before).toBe(true);
});
