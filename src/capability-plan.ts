import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  capabilityCollisionPath,
  capabilityRoot,
  currentCapability,
  optionalStat,
  pathsOverlap,
  safeCapabilityPath,
  snapshotCapability,
} from "./capability-files";
import {
  type CapabilityEntry,
  capabilityObject,
  hashCapability,
  parseCapabilityRegistry,
  selectCapability,
} from "./capability-registry";

const RECEIPT_HASH = /^sha256:[a-f0-9]{64}$/;

export interface CapabilityContext {
  manifest: string;
  overlays?: string[];
  sourceRoot: string;
  targetRoot: string;
  stateRoot: string;
  host: string;
  platform: string;
}
export interface CapabilityReceipt {
  schemaVersion: 1;
  id: string;
  sourcePath: string;
  targetPath: string;
  sourceHash: string;
  targetHash: string;
  revision: string;
  origin: string;
}
export interface CapabilityPlan {
  schemaVersion: 1;
  planId: string;
  id: string;
  kind: CapabilityEntry["kind"];
  owner: CapabilityEntry["owner"];
  host: string;
  platform: string;
  source: CapabilityEntry["source"];
  sourcePath: string | null;
  targetPath: string | null;
  statePath: string;
  hashes: {
    manifest: string;
    source: string | null;
    current: string | null;
    state: string | null;
  };
  status:
    | "disabled"
    | "independent"
    | "blocked"
    | "conflict"
    | "create"
    | "restore"
    | "adopt"
    | "update"
    | "current";
  reason: string;
  missingReferences: string[];
  targetPresence: "uninspected" | "present" | "absent";
}
export async function loadCapabilityContext(options: CapabilityContext) {
  const sourceRoot = await capabilityRoot(options.sourceRoot);
  const targetRoot = await capabilityRoot(options.targetRoot);
  const stateRoot = await capabilityRoot(options.stateRoot);
  const manifestPath = await capabilityRoot(options.manifest);
  if (pathsOverlap(stateRoot, sourceRoot)) {
    throw new Error(
      "Capability state must be separate from the canonical source root"
    );
  }
  const manifest = await readFile(manifestPath, "utf8");
  const registry = parseCapabilityRegistry(JSON.parse(manifest));
  let entries = registry.entries.map((entry) =>
    selectCapability(entry, options.host, options.platform)
  );
  const manifestInputs = [manifest];
  const registryPaths = [manifestPath];
  for (const overlayPath of options.overlays ?? []) {
    const overlayFile = await capabilityRoot(overlayPath);
    registryPaths.push(overlayFile);
    const raw = await readFile(overlayFile, "utf8");
    manifestInputs.push(raw);
    const overlay = capabilityObject(JSON.parse(raw), [
      "schemaVersion",
      "entries",
    ]);
    if (overlay.schemaVersion !== 1 || !Array.isArray(overlay.entries)) {
      throw new Error("Invalid capability overlay");
    }
    const ids = new Set<string>();
    for (const patchValue of overlay.entries) {
      const patch = capabilityObject(patchValue, [
        "id",
        "enabled",
        "source",
        "target",
        "requires",
      ]);
      if (
        typeof patch.id !== "string" ||
        ids.has(patch.id) ||
        !entries.some((entry) => entry.id === patch.id)
      ) {
        throw new Error("Unknown or duplicate overlay id");
      }
      ids.add(patch.id);
      entries = entries.map((entry) =>
        entry.id === patch.id
          ? parseCapabilityRegistry({
              schemaVersion: 1,
              entries: [{ ...entry, ...patch }],
            }).entries[0]!
          : entry
      );
    }
  }
  const targets = entries
    .filter((entry) => entry.target !== undefined)
    .map((entry) => ({
      path: join(targetRoot, entry.target!),
      owner: entry.owner,
    }));
  for (const target of targets.filter((entry) => entry.owner === "fclt")) {
    if (
      pathsOverlap(target.path, sourceRoot) ||
      registryPaths.some((path) => pathsOverlap(target.path, path)) ||
      pathsOverlap(target.path, stateRoot)
    ) {
      throw new Error("Capability target overlaps source, manifest, or state");
    }
    if (
      targets.some(
        (other) => other !== target && pathsOverlap(target.path, other.path)
      )
    ) {
      throw new Error("Capability targets overlap");
    }
  }
  return {
    ...options,
    sourceRoot,
    targetRoot,
    stateRoot,
    entries,
    manifestHash: hashCapability(JSON.stringify(manifestInputs)),
  };
}
export async function readCapabilityReceipt(
  path: string
): Promise<{ receipt: CapabilityReceipt | null; hash: string | null }> {
  await safeCapabilityPath(path);
  const stat = await optionalStat(path);
  if (!stat) {
    return { receipt: null, hash: null };
  }
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size > 256 * 1024 ||
    // biome-ignore lint/suspicious/noBitwiseOperators: reject writable ownership evidence
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error("Capability ownership receipt is unsafe");
  }
  const raw = await readFile(path, "utf8");
  const value = capabilityObject(JSON.parse(raw), [
    "schemaVersion",
    "id",
    "sourcePath",
    "targetPath",
    "sourceHash",
    "targetHash",
    "revision",
    "origin",
  ]);
  if (
    value.schemaVersion !== 1 ||
    [
      "id",
      "sourcePath",
      "targetPath",
      "sourceHash",
      "targetHash",
      "revision",
      "origin",
    ].some((key) => typeof value[key] !== "string")
  ) {
    throw new Error("Invalid capability receipt");
  }
  if (
    !RECEIPT_HASH.test(String(value.sourceHash)) ||
    value.sourceHash !== value.targetHash
  ) {
    throw new Error("Capability ownership receipt has invalid hashes");
  }
  return {
    receipt: value as unknown as CapabilityReceipt,
    hash: hashCapability(raw),
  };
}
function inspectionReason(error: unknown): string {
  // Our inspection errors contain only fixed descriptions; do not echo JSON or
  // arbitrary filesystem/parser diagnostics into inventory.
  if (error instanceof Error && error.message.startsWith("Capability ")) {
    return error.message;
  }
  return "Capability inspection failed or state is invalid";
}
async function inspectCapability<T>(
  read: () => Promise<T>
): Promise<{ value: T } | { reason: string }> {
  try {
    return { value: await read() };
  } catch (error) {
    return { reason: inspectionReason(error) };
  }
}
export async function buildCapabilityPlan(
  options: CapabilityContext,
  id: string
): Promise<CapabilityPlan> {
  const context = await loadCapabilityContext(options);
  const entry = context.entries.find((item) => item.id === id);
  if (!entry) {
    throw new Error("Unknown capability id");
  }
  const sourcePath = entry.source.path
    ? join(context.sourceRoot, entry.source.path)
    : null;
  const targetPath = entry.target
    ? join(context.targetRoot, entry.target)
    : null;
  const statePath = join(
    context.stateRoot,
    `${hashCapability(targetPath ? capabilityCollisionPath(targetPath) : `native:${entry.id}`).slice(7)}.json`
  );
  const body: Omit<CapabilityPlan, "planId"> = {
    schemaVersion: 1,
    id,
    kind: entry.kind,
    owner: entry.owner,
    host: options.host,
    platform: options.platform,
    source: entry.source,
    sourcePath,
    targetPath,
    statePath,
    hashes: {
      manifest: context.manifestHash,
      source: null,
      current: null,
      state: null,
    },
    status: "blocked",
    reason: "",
    missingReferences: [],
    targetPresence: "uninspected",
  };
  function finish(
    status: CapabilityPlan["status"],
    reason: string
  ): CapabilityPlan {
    const result = { ...body, status, reason };
    return { ...result, planId: hashCapability(JSON.stringify(result)) };
  }
  body.missingReferences = entry.requires.filter(
    (reference) =>
      !(reference.startsWith("env:") && process.env[reference.slice(4)])
  );
  if (!entry.enabled) {
    if (targetPath && entry.owner === "fclt") {
      const presence = await inspectCapability(async () => {
        await safeCapabilityPath(dirname(targetPath));
        return (await optionalStat(targetPath))
          ? ("present" as const)
          : ("absent" as const);
      });
      if ("value" in presence) {
        body.targetPresence = presence.value;
      }
    }
    return finish(
      "disabled",
      body.targetPresence === "present"
        ? "Management disabled; existing target retained and may remain discoverable"
        : "Management disabled; provider activation is not verified"
    );
  }
  if (entry.owner !== "fclt") {
    return finish(
      "independent",
      "Registered intent only; native/external manager owns files and observed version is unverified"
    );
  }
  const sourceRead = await inspectCapability(() =>
    snapshotCapability(sourcePath!)
  );
  if ("reason" in sourceRead) {
    return finish("blocked", `Source: ${sourceRead.reason}`);
  }
  const snapshot = sourceRead.value;
  body.hashes.source = snapshot?.hash ?? null;
  if (!snapshot) {
    return finish("blocked", "Canonical source is missing");
  }
  if (snapshot.hash !== entry.source.sha256) {
    return finish(
      "conflict",
      "Canonical content differs from its pinned source digest"
    );
  }
  if (
    entry.kind === "skill" &&
    !snapshot.nodes.some(
      (node) => node.path === "SKILL.md" && node.kind === "file"
    )
  ) {
    return finish("blocked", "Skill source requires SKILL.md");
  }
  const targetRead = await inspectCapability(() =>
    currentCapability(targetPath!)
  );
  if ("reason" in targetRead) {
    return finish("conflict", `Target preserved: ${targetRead.reason}`);
  }
  const current = targetRead.value;
  body.hashes.current = current.hash;
  body.targetPresence = current.hash === null ? "absent" : "present";
  const stateRead = await inspectCapability(() =>
    readCapabilityReceipt(statePath)
  );
  if ("reason" in stateRead) {
    return finish("conflict", `Receipt: ${stateRead.reason}`);
  }
  const state = stateRead.value;
  body.hashes.state = state.hash;
  if (
    state.receipt &&
    (state.receipt.id !== id || state.receipt.targetPath !== targetPath)
  ) {
    return finish("conflict", "Ownership receipt belongs to another binding");
  }
  if (body.missingReferences.length) {
    return finish(
      "blocked",
      "Required credential references are unavailable; no values are resolved"
    );
  }
  if (current.link) {
    if (current.link !== resolve(sourcePath!)) {
      return finish(
        "conflict",
        "Target is a foreign or broken link; preserved"
      );
    }
    return finish(
      "adopt",
      "Convert the exact canonical link to an independently owned copy"
    );
  }
  if (current.hash === snapshot.hash) {
    if (
      state.receipt?.sourceHash === snapshot.hash &&
      state.receipt.targetHash === snapshot.hash &&
      state.receipt.revision === entry.source.revision &&
      state.receipt.origin === entry.source.origin &&
      state.receipt.sourcePath === sourcePath
    ) {
      return finish("current", "Source, target, provenance, and receipt match");
    }
    return finish(
      "adopt",
      "Record ownership of identical content and current provenance"
    );
  }
  if (!current.hash) {
    return finish(
      state.receipt ? "restore" : "create",
      "Create a copy of the pinned canonical source"
    );
  }
  if (!state.receipt) {
    return finish(
      "conflict",
      "Unowned target differs from canonical source; both preserved"
    );
  }
  if (state.receipt.targetHash !== current.hash) {
    return finish(
      "conflict",
      "Owned target changed outside fclt; both preserved"
    );
  }
  return finish(
    "update",
    "Target still matches its ownership receipt; deploy pinned source update"
  );
}
