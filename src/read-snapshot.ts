import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { facultBuiltinPackRoot } from "./builtin";
import { resolveCliContextRoot } from "./cli-context";
import type { FacultGraph } from "./graph";
import { buildIndexSnapshot, type FacultIndex } from "./index-builder";
import { type AgentInventory, buildAgentInventory } from "./inventory";
import { dependenciesMatch, InventoryDependencies } from "./inventory-cache";
import { noWriteRequested } from "./no-write";
import {
  canonicalProjectAiRoot,
  facultAiGraphPath,
  facultAiIndexPath,
  facultConfigPath,
  facultMachineStateDir,
  legacyExternalFacultStateDir,
  preferredGlobalAiRoot,
  projectRootFromAiRoot,
  resolvePhysicalPath,
} from "./paths";
import { packageVersion } from "./status";

interface SnapshotContext {
  homeDir: string;
  rootDir: string;
}

interface ReadSnapshot {
  schema: 3;
  packageVersion: string;
  homeDir: string;
  rootDir: string;
  generatedAt: string;
  dependencies: [string, string][];
  inventoryDependencies: [string, string][];
  globalRoot: string;
  index: FacultIndex;
  graph: FacultGraph;
  inventory: AgentInventory;
}

export class ReadSnapshotError extends Error {
  readonly code: "snapshot-stale" | "snapshot-unavailable";
  constructor(code: "snapshot-stale" | "snapshot-unavailable") {
    super(
      `${code}: Run "fclt index" or "fclt sync" for this scope to publish a current read snapshot.`
    );
    this.name = "ReadSnapshotError";
    this.code = code;
  }
}

export function readSnapshotPath(context: SnapshotContext): string {
  return join(
    facultMachineStateDir(context.homeDir, context.rootDir),
    "cache",
    "reads",
    `${createHash("sha256").update(resolvePhysicalPath(context.rootDir)).digest("hex")}.json`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validSnapshot(value: unknown): value is ReadSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as ReadSnapshot;
  return (
    record.schema === 3 &&
    typeof record.generatedAt === "string" &&
    Array.isArray(record.dependencies) &&
    record.dependencies.length > 0 &&
    record.dependencies.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 2 &&
        row.every((part) => typeof part === "string")
    ) &&
    Array.isArray(record.inventoryDependencies) &&
    record.inventoryDependencies.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 2 &&
        row.every((part) => typeof part === "string")
    ) &&
    typeof record.globalRoot === "string" &&
    typeof record.homeDir === "string" &&
    typeof record.rootDir === "string" &&
    typeof record.packageVersion === "string" &&
    record.index?.version === 1 &&
    isRecord(record.index?.skills) &&
    isRecord(record.index?.mcp?.servers) &&
    isRecord(record.graph?.nodes) &&
    Array.isArray(record.graph?.edges) &&
    Array.isArray(record.inventory?.skills) &&
    Array.isArray(record.inventory?.mcpServers) &&
    Array.isArray(record.inventory?.instructions) &&
    Array.isArray(record.inventory?.sources) &&
    isRecord(record.inventory?.summary)
  );
}

/** Validate recorded inputs without repair, writes or recursive discovery. */
export async function loadReadSnapshot(
  context: SnapshotContext & { surface?: "query" | "inventory" }
): Promise<ReadSnapshot> {
  const rootDir = canonicalProjectAiRoot(context.rootDir, context.homeDir);
  const record: unknown = await Bun.file(
    readSnapshotPath({ ...context, rootDir })
  )
    .json()
    .catch(() => null);
  if (
    !validSnapshot(record) ||
    record.rootDir !== rootDir ||
    record.homeDir !== context.homeDir
  ) {
    throw new ReadSnapshotError("snapshot-unavailable");
  }
  if (
    record.packageVersion !== (await packageVersion()) ||
    record.globalRoot !==
      snapshotGlobalRoot({ homeDir: context.homeDir, rootDir }) ||
    !(await dependenciesMatch(record.dependencies)) ||
    (context.surface === "inventory" &&
      !(await dependenciesMatch(record.inventoryDependencies)))
  ) {
    throw new ReadSnapshotError("snapshot-stale");
  }
  return record;
}

function snapshotGlobalRoot(context: SnapshotContext): string {
  return projectRootFromAiRoot(context.rootDir, context.homeDir)
    ? resolveCliContextRoot({ homeDir: context.homeDir, scope: "global" })
    : context.rootDir;
}

/** Explicit writer used after index/render. One atomic file contains all read surfaces. */
export async function refreshReadSnapshot(
  context: SnapshotContext
): Promise<void> {
  if (noWriteRequested()) {
    throw new Error("Read snapshot publication requires writes.");
  }
  const { homeDir } = context;
  const rootDir = canonicalProjectAiRoot(context.rootDir, homeDir);
  const globalRoot = snapshotGlobalRoot({ homeDir, rootDir });
  const path = readSnapshotPath({ homeDir, rootDir });
  for (const root of [rootDir, globalRoot, preferredGlobalAiRoot(homeDir)]) {
    const rel = relative(resolvePhysicalPath(root), resolvePhysicalPath(path));
    if (
      rel === "" ||
      (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
    ) {
      throw new Error(
        "Read snapshot destination must be outside canonical roots."
      );
    }
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await publishReadSnapshot({ homeDir, rootDir, globalRoot, path });
}

/** Rendering is already committed; cache availability must not reverse its result. */
export async function refreshReadSnapshotAfterRender(
  context: SnapshotContext
): Promise<void> {
  try {
    await refreshReadSnapshot(context);
  } catch (error) {
    console.error(
      `Render completed; read snapshot was not published: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function publishReadSnapshot({
  homeDir,
  rootDir,
  globalRoot,
  path,
}: SnapshotContext & { globalRoot: string; path: string }): Promise<void> {
  const dependencies = new InventoryDependencies();
  const projectRoot = projectRootFromAiRoot(rootDir, homeDir);
  await Promise.all(
    [...new Set([rootDir, globalRoot, facultBuiltinPackRoot()])].map((root) =>
      dependencies.captureTree(root)
    )
  );
  for (const source of [
    facultAiIndexPath(homeDir, rootDir),
    facultAiGraphPath(homeDir, rootDir),
    facultConfigPath(homeDir),
    join(legacyExternalFacultStateDir(homeDir), "config.json"),
    join(facultMachineStateDir(homeDir, rootDir), "managed.json"),
  ]) {
    await dependencies.capturePath(source);
  }
  const { index, graph } = await buildIndexSnapshot({ homeDir, rootDir });
  const inventoryDependencies = new InventoryDependencies({
    stableReads: true,
  });
  const inventory = await buildAgentInventory({
    homeDir,
    cwd: projectRoot ?? homeDir,
    sourceMode: projectRoot ? "project" : "global",
    includeConfigFrom: false,
    dependencies: inventoryDependencies,
    refresh: true,
  });
  const recorded = await dependencies.entries();
  const inventoryRecorded = await inventoryDependencies.entries();
  if (
    !(
      (await dependenciesMatch(recorded)) &&
      (await dependenciesMatch(inventoryRecorded))
    )
  ) {
    throw new ReadSnapshotError("snapshot-stale");
  }
  const record: ReadSnapshot = {
    schema: 3,
    packageVersion: await packageVersion(),
    homeDir,
    rootDir,
    generatedAt: new Date().toISOString(),
    dependencies: recorded,
    inventoryDependencies: inventoryRecorded,
    globalRoot,
    index,
    graph,
    inventory,
  };
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    if (
      !(
        (await dependenciesMatch(recorded)) &&
        (await dependenciesMatch(inventoryRecorded))
      )
    ) {
      throw new ReadSnapshotError("snapshot-stale");
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
