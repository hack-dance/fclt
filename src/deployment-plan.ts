import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { getAdapter } from "./adapters";

declare const FCLT_COMPILED_VERSION: string | undefined;

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const SECRET_VARIABLE_RE = /^secret:([A-Z_][A-Z0-9_]*)$/;
const ONE_PASSWORD_REFERENCE_RE = /op:\/\/[A-Za-z0-9._~%/-]+/g;
const SAFE_RELATIVE_SEGMENT_RE = /^[A-Za-z0-9._/-]+$/;
const MARKDOWN_SUFFIX_RE = /\.md$/;
const PATH_SEPARATOR_RE = /[\\/]/;
const DEPLOYMENT_PLAN_SCHEMA_VERSION = 1 as const;
const DEPLOYMENT_STATE_SCHEMA_VERSION = 1 as const;
const PACKAGE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DESTINATION_IDENTITY_PREFIX = "physical-path-v1:";

export type DeploymentAssetKind = "instruction" | "snippet";
export type DeploymentOwnerMode = "fclt-owned" | "unowned";

export interface DeploymentLossReport {
  lossless: boolean;
  entries: Array<{
    code: string;
    message: string;
    sourcePath?: string;
  }>;
}

export interface DeploymentTranslation {
  desiredContent: Uint8Array;
  lossReport: DeploymentLossReport;
}

export interface DeploymentStateV1 {
  schemaVersion: 1;
  planSchemaVersion: 1;
  binding: {
    assetCanonicalRef: string;
    destinationIdentity: string;
    destinationPath: string;
    tool: string;
    adapterVersion: string;
  };
  desiredHash: string;
  ownerMode: "fclt-owned";
  rollbackTarget:
    | { kind: "absent"; path: string }
    | { kind: "snapshot"; path: string; expectedHash: string };
}

export interface DeploymentPlanV1 {
  schemaVersion: 1;
  planId: string;
  planner: { name: "fclt"; version: string };
  binding: {
    asset: {
      kind: DeploymentAssetKind;
      selector: string;
      canonicalRef: string;
      path: string;
    };
    destination: {
      tool: string;
      root: string;
      relativePath: string;
      path: string;
      identity: string;
    };
  };
  hashes: {
    source: string;
    current: string | null;
    desired: string;
    state: string | null;
  };
  ownerMode: DeploymentOwnerMode;
  adapter: { id: string; version: string };
  lossReport: DeploymentLossReport;
  secretReferences: Array<
    | { kind: "environment"; name: string }
    | { kind: "one-password"; reference: string }
  >;
  operations: {
    reads: Array<{
      kind:
        | "canonical-source"
        | "current-target"
        | "ownership-directory"
        | "deployment-state"
        | "rollback-snapshot";
      path: string;
      required: boolean;
      expectedHash: string | null;
    }>;
    writes: Array<{
      kind: "rollback-snapshot" | "target" | "deployment-state";
      path: string;
      contentSource:
        | { kind: "path"; path: string }
        | {
            kind: "inline-state";
            serialization: "stable-json-v1";
            state: DeploymentStateV1;
          };
      expectedCurrentHash: string | null;
      desiredHash: string;
    }>;
    removals: Array<{ path: string; expectedHash: string }>;
    nativeCommands: Array<{ argv: string[]; cwd: string }>;
  };
  verificationProbe: {
    kind: "file-sha256";
    path: string;
    expectedHash: string;
  };
  rollbackTarget: DeploymentStateV1["rollbackTarget"];
}

export interface BuildDeploymentPlanOptions {
  adapterVersion: string;
  asset: string;
  canonicalRoot: string;
  destination: string;
  expectedCurrentHash?: string | null;
  expectedSourceHash?: string;
  plannerVersion?: string;
  scope: "global" | "project";
  stateRoot: string;
  targetRoot: string;
  tool: string;
  translation?: DeploymentTranslation;
}

interface ParsedAssetSelector {
  canonicalRef: string;
  kind: DeploymentAssetKind;
  relativePath: string;
  selector: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortValue(value[key]);
  }
  return sorted;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function validateHash(value: string, label: string): string {
  const normalized = value.toLowerCase();
  if (!SHA256_RE.test(normalized)) {
    throw new Error(`${label} must be a sha256:<64 lowercase hex> hash.`);
  }
  return normalized;
}

function validateRelativePath(pathValue: string, label: string): string {
  const normalized = pathValue.replace(/\\/g, "/");
  if (
    !normalized ||
    isAbsolute(pathValue) ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    !SAFE_RELATIVE_SEGMENT_RE.test(normalized) ||
    normalized
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a safe relative path.`);
  }
  return normalized;
}

function parseAssetSelector(args: {
  scope: "global" | "project";
  selector: string;
}): ParsedAssetSelector {
  const separator = args.selector.indexOf(":");
  const kind = args.selector.slice(0, separator);
  const rawName = args.selector.slice(separator + 1);
  if (separator <= 0 || (kind !== "instruction" && kind !== "snippet")) {
    throw new Error(
      "--asset must use instruction:<name> or snippet:<relative-path>."
    );
  }
  const safeName = validateRelativePath(rawName, "Asset name");
  const relativeName = safeName.endsWith(".md") ? safeName : `${safeName}.md`;
  const relativePath = `${kind === "instruction" ? "instructions" : "snippets"}/${relativeName}`;
  const prefix = args.scope === "global" ? "@ai" : "@project";
  return {
    canonicalRef: `${prefix}/${relativePath}`,
    kind,
    relativePath,
    selector: `${kind}:${safeName.replace(MARKDOWN_SUFFIX_RE, "")}`,
  };
}

async function assertRootDirectory(
  pathValue: string,
  label: string
): Promise<string> {
  const absolute = resolve(pathValue);
  const stat = await lstat(absolute).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `${label} must be an existing non-symlink directory: ${absolute}`
    );
  }
  return absolute;
}

async function assertContainedPath(args: {
  label: string;
  path: string;
  root: string;
}): Promise<string> {
  const candidate = resolve(args.path);
  const rel = relative(args.root, candidate);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${args.label} escapes its root: ${candidate}`);
  }

  let cursor = args.root;
  for (const segment of rel.split(PATH_SEPARATOR_RE)) {
    cursor = join(cursor, segment);
    const stat = await lstat(cursor).catch(() => null);
    if (!stat) {
      break;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${args.label} traverses a symlink: ${cursor}`);
    }
  }
  return candidate;
}

async function canonicalPhysicalPath(
  pathValue: string,
  label: string
): Promise<string> {
  const absolute = resolve(pathValue);
  const missingSegments: string[] = [];
  let cursor = absolute;
  let stat = await lstat(cursor).catch(() => null);
  while (!stat) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Error(`${label} identity cannot be established safely.`);
    }
    missingSegments.unshift(basename(cursor));
    cursor = parent;
    stat = await lstat(cursor).catch(() => null);
  }
  if (
    stat.isSymbolicLink() ||
    (missingSegments.length > 0 && !stat.isDirectory())
  ) {
    throw new Error(`${label} identity cannot be established safely.`);
  }
  let canonicalAncestor: string;
  try {
    canonicalAncestor = await realpath(cursor);
  } catch {
    throw new Error(`${label} identity cannot be established safely.`);
  }
  return join(canonicalAncestor, ...missingSegments);
}

function physicalPathIdentity(canonicalPath: string): string {
  const portablePath = canonicalPath
    .replace(/\\/g, "/")
    .normalize("NFC")
    .toLowerCase();
  return `${DESTINATION_IDENTITY_PREFIX}${portablePath}`;
}

async function resolveDestinationIdentity(args: {
  destinationPath: string;
  label: string;
  targetRoot?: string;
}): Promise<string> {
  const canonicalDestination = await canonicalPhysicalPath(
    args.destinationPath,
    args.label
  );
  if (args.targetRoot) {
    const canonicalRoot = await canonicalPhysicalPath(
      args.targetRoot,
      "Target root"
    );
    const rel = relative(canonicalRoot, canonicalDestination);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`${args.label} escapes its physical root.`);
    }
  }
  return physicalPathIdentity(canonicalDestination);
}

async function readRegularFileOrNull(args: {
  label: string;
  path: string;
}): Promise<Uint8Array | null> {
  const stat = await lstat(args.path).catch(() => null);
  if (!stat) {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `${args.label} must be a regular non-symlink file: ${args.path}`
    );
  }
  return await readFile(args.path);
}

function decodeUtf8(value: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error(`${label} must contain valid UTF-8 text.`);
  }
}

function collectSecretReferences(
  text: string
): DeploymentPlanV1["secretReferences"] {
  const references: DeploymentPlanV1["secretReferences"] = [];
  const environmentNames = new Set<string>();
  const onePasswordReferences = new Set<string>();

  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("${", cursor);
    if (start < 0) {
      break;
    }
    const end = text.indexOf("}", start + 2);
    if (end < 0) {
      throwInterpolationError(text, start);
    }
    const expression = text.slice(start + 2, end);
    const secret = SECRET_VARIABLE_RE.exec(expression);
    if (!secret?.[1]) {
      throwInterpolationError(text, start);
    }
    environmentNames.add(secret[1]);
    cursor = end + 1;
  }
  for (const match of text.matchAll(ONE_PASSWORD_REFERENCE_RE)) {
    if (match[0]) {
      onePasswordReferences.add(match[0]);
    }
  }
  for (const name of [...environmentNames].sort()) {
    references.push({ kind: "environment", name });
  }
  for (const reference of [...onePasswordReferences].sort()) {
    references.push({ kind: "one-password", reference });
  }
  return references;
}

function throwInterpolationError(text: string, offset: number): never {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const column = offset - lastNewline;
  throw new Error(
    `Invalid interpolation at line ${line}, column ${column} (expression redacted).`
  );
}

function parseDeploymentState(args: {
  bytes: Uint8Array;
  path: string;
}): DeploymentStateV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(args.bytes, "Deployment state")) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.includes("valid UTF-8")) {
      throw error;
    }
    throw new Error(`Deployment state is corrupt JSON: ${args.path}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Deployment state is corrupt: ${args.path}`);
  }
  if (parsed.schemaVersion !== DEPLOYMENT_STATE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported deployment state version: ${String(parsed.schemaVersion)}`
    );
  }
  if (
    parsed.planSchemaVersion !== DEPLOYMENT_PLAN_SCHEMA_VERSION ||
    parsed.ownerMode !== "fclt-owned" ||
    typeof parsed.desiredHash !== "string" ||
    !SHA256_RE.test(parsed.desiredHash) ||
    !isPlainObject(parsed.binding) ||
    typeof parsed.binding.assetCanonicalRef !== "string" ||
    typeof parsed.binding.destinationIdentity !== "string" ||
    !parsed.binding.destinationIdentity.startsWith(
      DESTINATION_IDENTITY_PREFIX
    ) ||
    parsed.binding.destinationIdentity.length ===
      DESTINATION_IDENTITY_PREFIX.length ||
    typeof parsed.binding.destinationPath !== "string" ||
    typeof parsed.binding.tool !== "string" ||
    typeof parsed.binding.adapterVersion !== "string" ||
    !isPlainObject(parsed.rollbackTarget)
  ) {
    throw new Error(`Deployment state is corrupt: ${args.path}`);
  }
  const rollback = parsed.rollbackTarget;
  const validRollback =
    (rollback.kind === "absent" &&
      rollback.path === parsed.binding.destinationPath) ||
    (rollback.kind === "snapshot" &&
      typeof rollback.path === "string" &&
      typeof rollback.expectedHash === "string" &&
      SHA256_RE.test(rollback.expectedHash));
  if (!validRollback) {
    throw new Error(
      `Deployment state has an invalid or escaped rollback target: ${args.path}`
    );
  }
  return parsed as unknown as DeploymentStateV1;
}

function destinationOwnershipId(
  binding: Pick<DeploymentStateV1["binding"], "destinationIdentity" | "tool">
): string {
  return createHash("sha256")
    .update(
      stableJson({
        destinationIdentity: binding.destinationIdentity,
        tool: binding.tool,
      })
    )
    .digest("hex")
    .slice(0, 24);
}

export function serializeDeploymentState(state: DeploymentStateV1): string {
  return `${stableJson(state)}\n`;
}

interface ScannedDeploymentState {
  hash: string;
  path: string;
  state: DeploymentStateV1;
}

async function scanDeploymentStates(args: {
  directory: string;
  expectedPath: string;
  requestedBinding: DeploymentStateV1["binding"];
  stateRoot: string;
}): Promise<{
  directoryHash: string | null;
  existing: ScannedDeploymentState | null;
  records: ScannedDeploymentState[];
}> {
  const stat = await lstat(args.directory).catch(() => null);
  if (!stat) {
    return { directoryHash: null, existing: null, records: [] };
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Deployment state directory must be a non-symlink directory: ${args.directory}`
    );
  }

  const records: ScannedDeploymentState[] = [];
  for (const entry of (await readdir(args.directory)).sort()) {
    if (!entry.endsWith(".json")) {
      throw new Error(
        `Unexpected entry in deployment state directory: ${join(args.directory, entry)}`
      );
    }
    const path = await assertContainedPath({
      label: "Deployment state record",
      path: join(args.directory, entry),
      root: args.directory,
    });
    const bytes = await readRegularFileOrNull({
      label: "Deployment state",
      path,
    });
    if (!bytes) {
      throw new Error(`Deployment state disappeared during planning: ${path}`);
    }
    const state = parseDeploymentState({ bytes, path });
    if (state.rollbackTarget.kind === "snapshot") {
      await assertContainedPath({
        label: "Recorded rollback snapshot",
        path: state.rollbackTarget.path,
        root: args.stateRoot,
      });
    }
    records.push({
      hash: sha256(bytes),
      path,
      state,
    });
  }

  const claims = records.filter(
    (record) =>
      record.state.binding.tool === args.requestedBinding.tool &&
      record.state.binding.destinationIdentity ===
        args.requestedBinding.destinationIdentity
  );
  for (const claim of claims) {
    const recordedIdentity = await resolveDestinationIdentity({
      destinationPath: claim.state.binding.destinationPath,
      label: "Recorded deployment destination",
    });
    if (recordedIdentity !== claim.state.binding.destinationIdentity) {
      throw new Error(
        `Deployment state has a corrupt destination identity: ${claim.path}`
      );
    }
  }
  if (claims.length > 1) {
    throw new Error(
      "Conflicting deployment ownership claims exist for the destination."
    );
  }
  const existing = claims[0] ?? null;
  const recordAtAuthoritativePath = records.find(
    (record) => record.path === args.expectedPath
  );
  if (recordAtAuthoritativePath && !existing) {
    throw new Error(
      "Authoritative destination state path is occupied by an orphaned ownership claim."
    );
  }
  if (existing && existing.path !== args.expectedPath) {
    throw new Error(
      "Orphaned deployment ownership claim exists outside the authoritative destination state path."
    );
  }
  if (
    existing &&
    (existing.state.binding.assetCanonicalRef !==
      args.requestedBinding.assetCanonicalRef ||
      existing.state.binding.adapterVersion !==
        args.requestedBinding.adapterVersion)
  ) {
    throw new Error(
      "Destination ownership transfer requires a future explicit migration/transfer command; implicit transfer is not supported."
    );
  }

  const manifest = records.map((record) => ({
    hash: record.hash,
    path: record.path,
  }));
  return {
    directoryHash: sha256(stableJson(manifest)),
    existing,
    records,
  };
}

async function authoritativePlannerVersion(
  explicitVersion?: string
): Promise<string> {
  let authoritative: unknown =
    typeof FCLT_COMPILED_VERSION === "string"
      ? FCLT_COMPILED_VERSION
      : undefined;
  if (authoritative === undefined) {
    const packagePath = resolve(import.meta.dir, "..", "package.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(packagePath, "utf8")) as unknown;
    } catch {
      throw new Error("Authoritative fclt planner version is unavailable.");
    }
    authoritative = isPlainObject(parsed) ? parsed.version : undefined;
  }
  if (
    typeof authoritative !== "string" ||
    !PACKAGE_VERSION_RE.test(authoritative)
  ) {
    throw new Error("Authoritative fclt planner version is invalid.");
  }
  if (
    explicitVersion !== undefined &&
    (!PACKAGE_VERSION_RE.test(explicitVersion) ||
      explicitVersion !== authoritative)
  ) {
    throw new Error(
      "Explicit planner version does not match the authoritative fclt version."
    );
  }
  return authoritative;
}

export async function buildDeploymentPlan(
  options: BuildDeploymentPlanOptions
): Promise<Readonly<DeploymentPlanV1>> {
  if (options.tool !== "codex") {
    throw new Error(`Unsupported deployment tool: ${options.tool}`);
  }
  const adapter = getAdapter(options.tool);
  if (!(adapter && adapter.versions.includes(options.adapterVersion))) {
    throw new Error(
      `Unsupported ${options.tool} adapter version: ${options.adapterVersion}`
    );
  }

  const canonicalRoot = await assertRootDirectory(
    options.canonicalRoot,
    "Canonical root"
  );
  const targetRoot = await assertRootDirectory(
    options.targetRoot,
    "Target root"
  );
  const stateRoot = await assertRootDirectory(options.stateRoot, "State root");
  const asset = parseAssetSelector({
    scope: options.scope,
    selector: options.asset,
  });
  const sourcePath = await assertContainedPath({
    label: "Canonical source path",
    path: join(canonicalRoot, asset.relativePath),
    root: canonicalRoot,
  });
  const sourceBytes = await readRegularFileOrNull({
    label: "Canonical source",
    path: sourcePath,
  });
  if (!sourceBytes) {
    throw new Error(`Canonical source does not exist: ${sourcePath}`);
  }
  const sourceHash = sha256(sourceBytes);
  if (
    options.expectedSourceHash &&
    validateHash(options.expectedSourceHash, "Expected source hash") !==
      sourceHash
  ) {
    throw new Error(
      "Stale source hash: canonical source changed before planning."
    );
  }

  const destinationRelativePath = validateRelativePath(
    options.destination,
    "Destination"
  );
  const destinationPath = await assertContainedPath({
    label: "Destination path",
    path: join(targetRoot, destinationRelativePath),
    root: targetRoot,
  });
  const destinationIdentity = await resolveDestinationIdentity({
    destinationPath,
    label: "Destination path",
    targetRoot,
  });
  const currentBytes = await readRegularFileOrNull({
    label: "Current target",
    path: destinationPath,
  });
  const currentHash = currentBytes ? sha256(currentBytes) : null;
  if (options.expectedCurrentHash !== undefined) {
    const expected =
      options.expectedCurrentHash === null
        ? null
        : validateHash(options.expectedCurrentHash, "Expected current hash");
    if (expected !== currentHash) {
      throw new Error(
        "Stale current hash: destination changed before planning."
      );
    }
  }

  const translation = options.translation ?? {
    desiredContent: sourceBytes,
    lossReport: { lossless: true, entries: [] },
  };
  if (
    !translation.lossReport.lossless ||
    translation.lossReport.entries.length > 0
  ) {
    throw new Error("Lossy translation is not allowed for deployment plans.");
  }
  const desiredHash = sha256(translation.desiredContent);
  if (desiredHash !== sourceHash) {
    throw new Error(
      "Non-identity translation is unsupported by the first deployment planner slice."
    );
  }
  const desiredText = decodeUtf8(translation.desiredContent, "Desired content");
  const secretReferences = collectSecretReferences(desiredText);

  const stateBinding: DeploymentStateV1["binding"] = {
    adapterVersion: options.adapterVersion,
    assetCanonicalRef: asset.canonicalRef,
    destinationIdentity,
    destinationPath,
    tool: options.tool,
  };
  const ownershipId = destinationOwnershipId(stateBinding);
  const deploymentsDirectory = await assertContainedPath({
    label: "Deployment state directory",
    path: join(stateRoot, "deployments"),
    root: stateRoot,
  });
  const statePath = await assertContainedPath({
    label: "Deployment state path",
    path: join(deploymentsDirectory, `${ownershipId}.json`),
    root: stateRoot,
  });
  const stateScan = await scanDeploymentStates({
    directory: deploymentsDirectory,
    expectedPath: statePath,
    requestedBinding: stateBinding,
    stateRoot,
  });
  const existingStateRecord = stateScan.existing;
  const existingState = existingStateRecord?.state ?? null;
  const stateHash = existingStateRecord?.hash ?? null;
  const ownerMode: DeploymentOwnerMode = existingState
    ? "fclt-owned"
    : "unowned";
  if (existingState && existingState.desiredHash !== currentHash) {
    throw new Error(
      "Target tamper detected: owned destination no longer matches deployment state."
    );
  }
  if (
    !existingState &&
    currentHash !== null &&
    options.expectedCurrentHash === undefined
  ) {
    throw new Error(
      "Unowned destination exists; provide its exact --expected-current-hash to plan replacement."
    );
  }

  let rollbackTarget: DeploymentStateV1["rollbackTarget"];
  let snapshotHash: string | null = null;
  let snapshotRequired = false;
  if (existingState) {
    rollbackTarget = existingState.rollbackTarget;
    if (rollbackTarget.kind === "snapshot") {
      const snapshotPath = await assertContainedPath({
        label: "Existing rollback snapshot path",
        path: rollbackTarget.path,
        root: stateRoot,
      });
      const snapshotBytes = await readRegularFileOrNull({
        label: "Rollback snapshot",
        path: snapshotPath,
      });
      if (!snapshotBytes) {
        throw new Error(
          "Rollback snapshot is missing for the owned destination."
        );
      }
      snapshotHash = sha256(snapshotBytes);
      if (snapshotHash !== rollbackTarget.expectedHash) {
        throw new Error(
          "Rollback snapshot tamper detected: content hash does not match deployment state."
        );
      }
      snapshotRequired = true;
    }
  } else if (currentHash) {
    const snapshotPath = await assertContainedPath({
      label: "Rollback snapshot path",
      path: join(
        stateRoot,
        "rollback",
        ownershipId,
        currentHash.slice("sha256:".length)
      ),
      root: stateRoot,
    });
    const snapshotBytes = await readRegularFileOrNull({
      label: "Rollback snapshot",
      path: snapshotPath,
    });
    snapshotHash = snapshotBytes ? sha256(snapshotBytes) : null;
    if (snapshotHash && snapshotHash !== currentHash) {
      throw new Error(
        "Rollback snapshot tamper detected: content hash does not match its destination binding."
      );
    }
    rollbackTarget = {
      kind: "snapshot",
      path: snapshotPath,
      expectedHash: currentHash,
    };
  } else {
    rollbackTarget = { kind: "absent", path: destinationPath };
  }

  const desiredState: DeploymentStateV1 = {
    schemaVersion: DEPLOYMENT_STATE_SCHEMA_VERSION,
    planSchemaVersion: DEPLOYMENT_PLAN_SCHEMA_VERSION,
    binding: existingState?.binding ?? stateBinding,
    desiredHash,
    ownerMode: "fclt-owned",
    rollbackTarget,
  };
  const desiredStateHash = sha256(serializeDeploymentState(desiredState));

  const reads: DeploymentPlanV1["operations"]["reads"] = [
    {
      kind: "canonical-source",
      path: sourcePath,
      required: true,
      expectedHash: sourceHash,
    },
    {
      kind: "current-target",
      path: destinationPath,
      required: false,
      expectedHash: currentHash,
    },
    {
      kind: "ownership-directory",
      path: deploymentsDirectory,
      required: false,
      expectedHash: stateScan.directoryHash,
    },
    ...stateScan.records.map((record) => ({
      kind: "deployment-state" as const,
      path: record.path,
      required: true,
      expectedHash: record.hash,
    })),
    ...(existingStateRecord
      ? []
      : [
          {
            kind: "deployment-state" as const,
            path: statePath,
            required: false,
            expectedHash: null,
          },
        ]),
  ];
  if (rollbackTarget.kind === "snapshot") {
    reads.push({
      kind: "rollback-snapshot",
      path: rollbackTarget.path,
      required: snapshotRequired,
      expectedHash: snapshotHash,
    });
  }
  const writes: DeploymentPlanV1["operations"]["writes"] = [];
  if (
    !existingState &&
    rollbackTarget.kind === "snapshot" &&
    currentHash &&
    snapshotHash === null
  ) {
    writes.push({
      kind: "rollback-snapshot",
      path: rollbackTarget.path,
      contentSource: { kind: "path", path: destinationPath },
      expectedCurrentHash: null,
      desiredHash: currentHash,
    });
  }
  if (currentHash !== desiredHash) {
    writes.push({
      kind: "target",
      path: destinationPath,
      contentSource: { kind: "path", path: sourcePath },
      expectedCurrentHash: currentHash,
      desiredHash,
    });
  }
  if (stateHash !== desiredStateHash) {
    writes.push({
      kind: "deployment-state",
      path: statePath,
      contentSource: {
        kind: "inline-state",
        serialization: "stable-json-v1",
        state: desiredState,
      },
      expectedCurrentHash: stateHash,
      desiredHash: desiredStateHash,
    });
  }

  const plannerVersion = await authoritativePlannerVersion(
    options.plannerVersion
  );

  const planBody = {
    schemaVersion: DEPLOYMENT_PLAN_SCHEMA_VERSION,
    planner: {
      name: "fclt" as const,
      version: plannerVersion,
    },
    binding: {
      asset: {
        kind: asset.kind,
        selector: asset.selector,
        canonicalRef: asset.canonicalRef,
        path: sourcePath,
      },
      destination: {
        tool: options.tool,
        root: targetRoot,
        relativePath: destinationRelativePath,
        path: destinationPath,
        identity: destinationIdentity,
      },
    },
    hashes: {
      source: sourceHash,
      current: currentHash,
      desired: desiredHash,
      state: stateHash,
    },
    ownerMode,
    adapter: { id: adapter.id, version: options.adapterVersion },
    lossReport: translation.lossReport,
    secretReferences,
    operations: {
      reads,
      writes,
      removals: [],
      nativeCommands: [],
    },
    verificationProbe: {
      kind: "file-sha256" as const,
      path: destinationPath,
      expectedHash: desiredHash,
    },
    rollbackTarget,
  };
  const plan: DeploymentPlanV1 = {
    ...planBody,
    planId: sha256(stableJson(planBody)),
  };
  return deepFreeze(plan);
}

interface ParsedDeployArgs {
  adapterVersion?: string;
  asset?: string;
  destination?: string;
  expectedCurrentHash?: string | null;
  expectedSourceHash?: string;
  root?: string;
  scope: "global" | "project";
  stateRoot?: string;
  targetRoot?: string;
  tool?: string;
}

function parseDeployArgs(argv: string[]): ParsedDeployArgs {
  const parsed: ParsedDeployArgs = { scope: "global" };
  const valueFlags = new Map<string, keyof ParsedDeployArgs>([
    ["--adapter-version", "adapterVersion"],
    ["--asset", "asset"],
    ["--destination", "destination"],
    ["--expected-current-hash", "expectedCurrentHash"],
    ["--expected-source-hash", "expectedSourceHash"],
    ["--root", "root"],
    ["--scope", "scope"],
    ["--state-root", "stateRoot"],
    ["--target-root", "targetRoot"],
    ["--tool", "tool"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || arg === "--json") {
      continue;
    }
    const key = valueFlags.get(arg);
    if (!key) {
      throw new Error(`Unknown deploy plan option: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value.`);
    }
    index += 1;
    if (key === "scope") {
      if (value !== "global" && value !== "project") {
        throw new Error("--scope must be global or project.");
      }
      parsed.scope = value;
    } else if (key === "expectedCurrentHash") {
      parsed.expectedCurrentHash = value === "absent" ? null : value;
    } else {
      parsed[key] = value;
    }
  }
  return parsed;
}

function requireDeployOption(value: string | undefined, flag: string): string {
  if (!value) {
    throw new Error(`${flag} is required.`);
  }
  return value;
}

export async function deployCommand(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(`fclt deploy plan — build one immutable read-only deployment plan

Usage:
  fclt deploy plan --asset instruction:<name>|snippet:<path> --destination <relative-path> \\
    --tool codex --adapter-version v1 --root <canonical-root> \\
    --target-root <isolated-tool-root> --state-root <isolated-state-root> \\
    [--scope global|project] [--expected-source-hash sha256:<hex>] \\
    [--expected-current-hash absent|sha256:<hex>] [--json]

This command only reads files and prints a plan. It cannot apply a plan.
`);
    return;
  }
  try {
    if (argv[0] !== "plan") {
      throw new Error("deploy requires the read-only subcommand: plan");
    }
    const parsed = parseDeployArgs(argv.slice(1));
    const plan = await buildDeploymentPlan({
      adapterVersion: requireDeployOption(
        parsed.adapterVersion,
        "--adapter-version"
      ),
      asset: requireDeployOption(parsed.asset, "--asset"),
      canonicalRoot: requireDeployOption(parsed.root, "--root"),
      destination: requireDeployOption(parsed.destination, "--destination"),
      expectedCurrentHash: parsed.expectedCurrentHash,
      expectedSourceHash: parsed.expectedSourceHash,
      scope: parsed.scope,
      stateRoot: requireDeployOption(parsed.stateRoot, "--state-root"),
      targetRoot: requireDeployOption(parsed.targetRoot, "--target-root"),
      tool: requireDeployOption(parsed.tool, "--tool"),
    });
    console.log(JSON.stringify(plan, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
