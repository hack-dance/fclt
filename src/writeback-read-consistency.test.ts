import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { restoreEnvironmentVariable } from "../test/environment";
import { listWritebacks } from "./ai";
import {
  facultAiStateDir,
  facultAiWritebackQueuePath,
  legacyFacultAiStateDirs,
} from "./paths";
import { reconcileSources } from "./reconciliation";

type Scope = "global" | "project";
const originalEnvironment = {
  HOME: process.env.HOME,
  FACULT_LOCAL_STATE_DIR: process.env.FACULT_LOCAL_STATE_DIR,
};
let fixtureRoot: string | undefined;

async function makeFixture(scope: Scope) {
  fixtureRoot = await mkdtemp(join(tmpdir(), "fclt-writeback-consistency-"));
  const homeDir = join(fixtureRoot, "home");
  process.env.HOME = homeDir;
  process.env.FACULT_LOCAL_STATE_DIR = join(fixtureRoot, "state");
  const rootDir =
    scope === "global"
      ? join(homeDir, ".ai")
      : join(fixtureRoot, "project", ".ai");
  await mkdir(rootDir, { recursive: true });
  await Bun.write(
    join(rootDir, "reconciliation.json"),
    JSON.stringify({
      version: 1,
      sources: [{ id: "writebacks", type: "writebacks" }],
    })
  );
  const legacyDirs = legacyFacultAiStateDirs(homeDir, rootDir);
  if (legacyDirs.length === 0) {
    throw new Error("Migration fixture requires a legacy queue directory");
  }
  const legacyQueue = join(
    legacyDirs.at(-1)!,
    scope,
    "writeback",
    "queue.jsonl"
  );
  const generatedQueue = join(
    facultAiStateDir(homeDir, rootDir),
    scope,
    "writeback",
    "queue.jsonl"
  );
  const currentQueue = facultAiWritebackQueuePath(homeDir, rootDir);
  const queueBytes = new Map<string, string>();
  async function seed(path: string, rows: Record<string, unknown>[]) {
    const content = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, content);
    queueBytes.set(path, content);
  }
  async function queuesUnchanged() {
    for (const [path, content] of queueBytes) {
      if ((await readFile(path, "utf8")) !== content) {
        return false;
      }
    }
    return true;
  }
  const row = {
    id: "WB-00020",
    ts: "2026-07-05T12:00:00.000Z",
    scope,
    sourceRoot: rootDir,
    kind: "weak-verification",
    summary: "Verification needs outcome evidence",
    status: "recorded",
    evidence: [{ type: "session", ref: "migration-consistency" }],
    tags: [],
  };
  return {
    homeDir,
    rootDir,
    scope,
    legacyQueue,
    generatedQueue,
    currentQueue,
    seed,
    row,
    queuesUnchanged,
  };
}

async function readBoth(fixture: Awaited<ReturnType<typeof makeFixture>>) {
  const listed = await listWritebacks(fixture);
  const review = await reconcileSources({
    ...fixture,
    since: "2026-07-03T00:00:00Z",
    until: "2026-07-10T00:00:00Z",
  });
  const logicalStates = listed.map((row) => ({
    sourceRecordId: row.id,
    included: !["resolved", "dismissed", "superseded"].includes(row.status),
  }));
  const reportStates = review.decisions.map(({ sourceRecordId, included }) => ({
    sourceRecordId,
    included,
  }));
  return { listed, review, reportStates, logicalStates };
}

afterEach(async () => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    restoreEnvironmentVariable(name, value);
  }
  if (fixtureRoot) {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
  fixtureRoot = undefined;
});

describe("writeback report/list consistency", () => {
  it.each([
    { scope: "global", expectedStatus: "resolved" },
    { scope: "project", expectedStatus: "recorded" },
  ] as const)("uses the same migration queue precedence: %j", async ({
    scope,
    expectedStatus,
  }) => {
    const fixture = await makeFixture(scope);
    expect(fixture.legacyQueue).not.toBe(fixture.generatedQueue);
    await fixture.seed(fixture.generatedQueue, [fixture.row]);
    await fixture.seed(fixture.legacyQueue, [
      { ...fixture.row, updatedAt: fixture.row.ts, status: "resolved" },
    ]);
    const { listed, review, reportStates, logicalStates } =
      await readBoth(fixture);
    expect(reportStates).toEqual(logicalStates);
    expect(listed[0]?.status).toBe(expectedStatus);
    expect(review.evidence).toHaveLength(expectedStatus === "resolved" ? 0 : 1);
    const retry = await readBoth(fixture);
    expect(retry.review.decisions).toEqual(review.decisions);
    expect(retry.reportStates).toEqual(retry.logicalStates);
    expect(await fixture.queuesUnchanged()).toBe(true);

    await fixture.seed(fixture.currentQueue, [fixture.row]);
    const current = await readBoth(fixture);
    expect(current.reportStates).toEqual(current.logicalStates);
    expect(current.listed[0]?.status).toBe("recorded");
    expect(await fixture.queuesUnchanged()).toBe(true);
  });

  for (const scope of ["global", "project"] as const) {
    for (const mismatch of ["scope", "sourceRoot"] as const) {
      it.each([
        "recorded",
        "resolved",
      ])(`excludes a later ${mismatch} mismatch without reviving legacy ${scope} state: %s`, async (status) => {
        const fixture = await makeFixture(scope);
        await fixture.seed(fixture.legacyQueue, [
          { ...fixture.row, status: "resolved" },
        ]);
        const foreign = {
          ...fixture.row,
          status,
          updatedAt: fixture.row.ts,
          [mismatch]:
            mismatch === "scope"
              ? scope === "project"
                ? "global"
                : "project"
              : join(fixtureRoot!, "other", ".ai"),
        };
        await fixture.seed(fixture.currentQueue, [
          foreign,
          { ...fixture.row, id: "WB-00021" },
        ]);
        const { listed, review, reportStates, logicalStates } =
          await readBoth(fixture);
        expect(reportStates).toEqual(logicalStates);
        expect(listed.map((row) => row.id)).toEqual(["WB-00021"]);
        expect(review.evidence[0]?.sourceRecordIds).toEqual(["WB-00021"]);
        expect(await fixture.queuesUnchanged()).toBe(true);
      });
    }
  }

  it("excludes a mismatched project root even when sourceRoot matches", async () => {
    const fixture = await makeFixture("project");
    await fixture.seed(fixture.legacyQueue, [fixture.row]);
    await fixture.seed(fixture.currentQueue, [
      {
        ...fixture.row,
        projectRoot: join(fixtureRoot!, "other"),
        status: "resolved",
      },
    ]);
    const { listed, review, reportStates, logicalStates } =
      await readBoth(fixture);
    expect(reportStates).toEqual(logicalStates);
    expect(listed).toEqual([]);
    expect(review.decisions).toEqual([]);
    expect(await fixture.queuesUnchanged()).toBe(true);
  });

  it.each([
    "global",
    "project",
  ] as const)("preserves %s legacy rows without scope or root metadata", async (scope) => {
    const fixture = await makeFixture(scope);
    const { scope: _scope, sourceRoot: _root, ...legacyRow } = fixture.row;
    await fixture.seed(fixture.legacyQueue, [legacyRow]);
    const { listed, review, reportStates, logicalStates } =
      await readBoth(fixture);
    expect(reportStates).toEqual(logicalStates);
    expect(listed[0]).toMatchObject({
      id: fixture.row.id,
      scope,
      kind: "weak_verification",
    });
    expect(review.evidence).toHaveLength(1);
    expect(await fixture.queuesUnchanged()).toBe(true);
  });

  it.each([
    "global",
    "project",
  ] as const)("checks explicit roots when a legacy %s row omits scope", async (scope) => {
    const fixture = await makeFixture(scope);
    await fixture.seed(fixture.legacyQueue, [
      {
        ...fixture.row,
        scope: undefined,
        sourceRoot: join(fixtureRoot!, "other", ".ai"),
      },
    ]);
    const { listed, review, reportStates, logicalStates } =
      await readBoth(fixture);
    expect(reportStates).toEqual(logicalStates);
    expect(listed).toEqual([]);
    expect(review.decisions).toEqual([]);
    expect(await fixture.queuesUnchanged()).toBe(true);
  });

  it("keeps an empty legacy projectRoot from matching the current working directory", async () => {
    const fixture = await makeFixture("project");
    await fixture.seed(fixture.currentQueue, [
      {
        ...fixture.row,
        projectRoot: "",
        sourceRoot: join(fixtureRoot!, "other", ".ai"),
      },
    ]);
    const originalCwd = process.cwd();
    process.chdir(dirname(fixture.rootDir));
    try {
      const { listed, review, reportStates, logicalStates } =
        await readBoth(fixture);
      expect(reportStates).toEqual(logicalStates);
      expect(listed).toEqual([]);
      expect(review.decisions).toEqual([]);
      expect(await fixture.queuesUnchanged()).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("preserves canonical project metadata from a moved checkout", async () => {
    const fixture = await makeFixture("project");
    await fixture.seed(fixture.currentQueue, [
      {
        ...fixture.row,
        projectRoot: dirname(fixture.rootDir),
        sourceRoot: join(fixtureRoot!, "old-checkout", ".ai"),
      },
    ]);
    const { listed, review, reportStates, logicalStates } =
      await readBoth(fixture);
    expect(reportStates).toEqual(logicalStates);
    expect(listed).toHaveLength(1);
    expect(review.evidence).toHaveLength(1);
    expect(await fixture.queuesUnchanged()).toBe(true);
  });

  it("applies context filtering to the selected historical state without a future row suppressing it", async () => {
    const fixture = await makeFixture("project");
    await fixture.seed(fixture.currentQueue, [
      { ...fixture.row, status: "resolved" },
      {
        ...fixture.row,
        scope: "global",
        updatedAt: "2026-07-11T12:00:00.000Z",
      },
    ]);
    const listed = await listWritebacks(fixture);
    expect(listed).toEqual([]);
    const historical = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-10",
    });
    expect(historical.decisions).toHaveLength(1);
    expect(historical.decisions[0]?.included).toBe(false);
    const current = await reconcileSources({
      ...fixture,
      since: "2026-07-03",
      until: "2026-07-12",
    });
    expect(current.decisions).toEqual([]);
    expect(await fixture.queuesUnchanged()).toBe(true);
  });
});
