import { createHash } from "node:crypto";
import { type BigIntStats, constants, type Dirent } from "node:fs";
import { lstat, open, opendir, readlink, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { getGitPathExposure } from "../util/git";

const SHA256_RE = /^[a-f0-9]{64}$/;
const NON_NEGATIVE_DECIMAL_RE = /^(?:0|[1-9]\d*)$/;
const POSITIVE_DECIMAL_RE = /^[1-9]\d*$/;

export interface AuditProtectedRootIdentity {
  dev: number;
  ino: number;
  kind: "directory" | "file";
  path: string;
}

export interface AuditEvaluatedFileIdentity {
  ctimeMs: number;
  dev: number;
  ino: number;
  mode: number;
  mtimeMs: number;
  path: string;
  sha256: string;
  size: number;
}

export interface AuditSourceSnapshot {
  schemaVersion: 9;
  protectedRoots: AuditProtectedRootIdentity[];
  evaluatedFiles: AuditEvaluatedFileIdentity[];
  evaluatedDirectories: AuditEvaluatedDirectoryIdentity[];
  capturedTrees: AuditCapturedTreeIdentity[];
  derivedContexts: AuditDerivedContextIdentity[];
  absentPaths: AuditAbsentPathIdentity[];
  requestedPaths: AuditRequestedPathIdentity[];
  validationContractSha256: string;
}

export interface AuditCapturedTreeIdentity {
  directoryPaths: string[];
  filePaths: string[];
  maxAggregateBytes: number;
  maxDepth: number;
  maxEntries: number;
  maxFileBytes: number;
  maxRelativePathBytes: number;
  rejectUnsupportedEntries: true;
  root: string;
}

export interface AuditAbsentPathIdentity {
  ancestorDev: number;
  ancestorIno: number;
  ancestorPath: string;
  lexicalChain: AuditLexicalPathComponentIdentity[];
  path: string;
  relativeSegments: string[];
  requestedPath: string;
}

export interface AuditRequestedPathIdentity {
  canonicalPath: string;
  dev: number;
  ino: number;
  kind: "directory" | "file";
  lexicalChain: AuditLexicalPathComponentIdentity[];
  requestedPath: string;
}

export interface AuditLexicalPathComponentIdentity {
  birthtimeNs: string | null;
  ctimeNs: string | null;
  dev: string;
  ino: string;
  kind: "directory" | "file" | "symlink";
  linkTarget: string | null;
  path: string;
}

export interface AuditDerivedContextIdentity {
  ctimeMs: number;
  dev: number;
  ino: number;
  kind: "git-path-exposure";
  mode: number;
  mtimeMs: number;
  path: string;
  pathKind: "directory" | "file";
  sha256: string;
  size: number;
}

export interface AuditEvaluatedDirectoryIdentity {
  ctimeMs: number;
  dev: number;
  entriesSha256: string;
  ino: number;
  mode: number;
  maxEntries: number;
  mtimeMs: number;
  path: string;
}

const STRICT_CAPTURE_TREE_LIMITS = Object.freeze({
  maxAggregateBytes: 4 * 1024 * 1024,
  maxDepth: 12,
  maxEntries: 256,
  maxFileBytes: 1024 * 1024,
  maxRelativePathBytes: 512,
  readChunkBytes: 64 * 1024,
});

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function hasUsablePhysicalIdentity(dev: number, ino: number): boolean {
  return isNonNegativeSafeInteger(dev) && isPositiveSafeInteger(ino);
}

function isContainedPath(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    normalize(resolve(value)) === value
  );
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isSortedUniqueStringArray(value: unknown[]): value is string[] {
  return value.every(
    (entry, index) =>
      typeof entry === "string" &&
      (index === 0 || entry > (value[index - 1] as string))
  );
}

function isSortedUniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string
): boolean {
  return values.every(
    (value, index) => index === 0 || key(value) > key(values[index - 1]!)
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const CAPTURED_TREE_KEYS = [
  "directoryPaths",
  "filePaths",
  "maxAggregateBytes",
  "maxDepth",
  "maxEntries",
  "maxFileBytes",
  "maxRelativePathBytes",
  "rejectUnsupportedEntries",
  "root",
] as const;

const ABSENT_PATH_KEYS = [
  "ancestorDev",
  "ancestorIno",
  "ancestorPath",
  "lexicalChain",
  "path",
  "relativeSegments",
  "requestedPath",
] as const;
const REQUESTED_PATH_KEYS = [
  "canonicalPath",
  "dev",
  "ino",
  "kind",
  "lexicalChain",
  "requestedPath",
] as const;
const LEXICAL_PATH_COMPONENT_KEYS = [
  "birthtimeNs",
  "ctimeNs",
  "dev",
  "ino",
  "kind",
  "linkTarget",
  "path",
] as const;
const DERIVED_CONTEXT_KEYS = [
  "ctimeMs",
  "dev",
  "ino",
  "kind",
  "mode",
  "mtimeMs",
  "path",
  "pathKind",
  "sha256",
  "size",
] as const;
const DIRECTORY_IDENTITY_KEYS = [
  "ctimeMs",
  "dev",
  "entriesSha256",
  "ino",
  "maxEntries",
  "mode",
  "mtimeMs",
  "path",
] as const;
const FILE_IDENTITY_KEYS = [
  "ctimeMs",
  "dev",
  "ino",
  "mode",
  "mtimeMs",
  "path",
  "sha256",
  "size",
] as const;
const PROTECTED_ROOT_KEYS = ["dev", "ino", "kind", "path"] as const;
const SNAPSHOT_KEYS = [
  "absentPaths",
  "capturedTrees",
  "derivedContexts",
  "evaluatedDirectories",
  "evaluatedFiles",
  "protectedRoots",
  "requestedPaths",
  "schemaVersion",
  "validationContractSha256",
] as const;

type AuditSourceSnapshotContract = Omit<
  AuditSourceSnapshot,
  "validationContractSha256"
>;

function validationContractDigest(
  snapshot: AuditSourceSnapshotContract
): string {
  return digest(Buffer.from(JSON.stringify(snapshot)));
}

function canonicalSnapshotContract(
  snapshot: AuditSourceSnapshotContract
): AuditSourceSnapshotContract {
  return {
    schemaVersion: 9,
    protectedRoots: snapshot.protectedRoots.map((entry) => ({
      dev: entry.dev,
      ino: entry.ino,
      kind: entry.kind,
      path: entry.path,
    })),
    evaluatedFiles: snapshot.evaluatedFiles.map((entry) => ({
      ctimeMs: entry.ctimeMs,
      dev: entry.dev,
      ino: entry.ino,
      mode: entry.mode,
      mtimeMs: entry.mtimeMs,
      path: entry.path,
      sha256: entry.sha256,
      size: entry.size,
    })),
    evaluatedDirectories: snapshot.evaluatedDirectories.map((entry) => ({
      ctimeMs: entry.ctimeMs,
      dev: entry.dev,
      entriesSha256: entry.entriesSha256,
      ino: entry.ino,
      maxEntries: entry.maxEntries,
      mode: entry.mode,
      mtimeMs: entry.mtimeMs,
      path: entry.path,
    })),
    capturedTrees: snapshot.capturedTrees.map((entry) => ({
      directoryPaths: [...entry.directoryPaths],
      filePaths: [...entry.filePaths],
      maxAggregateBytes: entry.maxAggregateBytes,
      maxDepth: entry.maxDepth,
      maxEntries: entry.maxEntries,
      maxFileBytes: entry.maxFileBytes,
      maxRelativePathBytes: entry.maxRelativePathBytes,
      rejectUnsupportedEntries: true,
      root: entry.root,
    })),
    derivedContexts: snapshot.derivedContexts.map((entry) => ({
      ctimeMs: entry.ctimeMs,
      dev: entry.dev,
      ino: entry.ino,
      kind: entry.kind,
      mode: entry.mode,
      mtimeMs: entry.mtimeMs,
      path: entry.path,
      pathKind: entry.pathKind,
      sha256: entry.sha256,
      size: entry.size,
    })),
    absentPaths: snapshot.absentPaths.map((entry) => ({
      ancestorDev: entry.ancestorDev,
      ancestorIno: entry.ancestorIno,
      ancestorPath: entry.ancestorPath,
      lexicalChain: entry.lexicalChain.map((component) => ({
        birthtimeNs: component.birthtimeNs,
        ctimeNs: component.ctimeNs,
        dev: component.dev,
        ino: component.ino,
        kind: component.kind,
        linkTarget: component.linkTarget,
        path: component.path,
      })),
      path: entry.path,
      relativeSegments: [...entry.relativeSegments],
      requestedPath: entry.requestedPath,
    })),
    requestedPaths: snapshot.requestedPaths.map((entry) => ({
      canonicalPath: entry.canonicalPath,
      dev: entry.dev,
      ino: entry.ino,
      kind: entry.kind,
      lexicalChain: entry.lexicalChain.map((component) => ({
        birthtimeNs: component.birthtimeNs,
        ctimeNs: component.ctimeNs,
        dev: component.dev,
        ino: component.ino,
        kind: component.kind,
        linkTarget: component.linkTarget,
        path: component.path,
      })),
      requestedPath: entry.requestedPath,
    })),
  };
}

export function canonicalAuditSourceSnapshot(
  snapshot: AuditSourceSnapshot
): AuditSourceSnapshot {
  assertAuditSourceSnapshot(snapshot);
  return {
    ...canonicalSnapshotContract(snapshot),
    validationContractSha256: snapshot.validationContractSha256,
  };
}

function compareDirents(left: Dirent, right: Dirent): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

async function readBoundedDirectoryEntries(
  pathValue: string,
  maxEntries: number
): Promise<Dirent[]> {
  const directory = await opendir(pathValue);
  const entries: Dirent[] = [];
  try {
    while (true) {
      const entry = await directory.read();
      if (!entry) {
        break;
      }
      if (entries.length >= maxEntries) {
        throw new Error(
          `Audit discovery tree exceeds entry limit: ${pathValue}`
        );
      }
      entries.push(entry);
    }
  } finally {
    try {
      await directory.close();
    } catch {
      // A terminal read may already have closed the directory handle.
    }
  }
  return entries.sort(compareDirents);
}

function directoryEntriesDigest(entries: Dirent[]): string {
  return digest(
    Buffer.from(
      JSON.stringify(
        entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory()
            ? "directory"
            : entry.isFile()
              ? "file"
              : entry.isSymbolicLink()
                ? "symlink"
                : "special",
        }))
      )
    )
  );
}

function readOnlyNoFollowFlags(): number {
  return constants.O_RDONLY + (constants.O_NOFOLLOW ?? 0);
}

const MAX_LEXICAL_PATH_COMPONENTS = 256;

function lexicalPathPrefixes(pathValue: string): string[] {
  const requested = normalize(resolve(pathValue));
  const prefixes: string[] = [];
  let current = requested;
  while (true) {
    prefixes.push(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
    if (prefixes.length > MAX_LEXICAL_PATH_COMPONENTS) {
      throw new Error(
        `Audit lexical path has too many components: ${requested}`
      );
    }
  }
  return prefixes.reverse();
}

async function captureLexicalPathChainOnce(
  pathValue: string,
  allowAbsent: boolean
): Promise<AuditLexicalPathComponentIdentity[]> {
  const requested = normalize(resolve(pathValue));
  const chain: AuditLexicalPathComponentIdentity[] = [];
  for (const componentPath of lexicalPathPrefixes(requested)) {
    let before: BigIntStats;
    try {
      before = await lstat(componentPath, { bigint: true });
    } catch (error) {
      if (allowAbsent && (error as NodeJS.ErrnoException).code === "ENOENT") {
        break;
      }
      throw error;
    }
    const kind = before.isSymbolicLink()
      ? "symlink"
      : before.isDirectory()
        ? "directory"
        : before.isFile()
          ? "file"
          : null;
    if (!(kind && before.dev >= 0n && before.ino > 0n)) {
      throw new Error(
        `Audit lexical path has an unsupported component: ${componentPath}`
      );
    }
    const linkTarget =
      kind === "symlink" ? await readlink(componentPath) : null;
    chain.push({
      birthtimeNs: kind === "symlink" ? before.birthtimeNs.toString() : null,
      ctimeNs: kind === "symlink" ? before.ctimeNs.toString() : null,
      dev: before.dev.toString(),
      ino: before.ino.toString(),
      kind,
      linkTarget,
      path: componentPath,
    });
  }
  if (
    chain.length === 0 ||
    (!allowAbsent && chain.at(-1)?.path !== requested)
  ) {
    throw new Error(`Audit lexical path is absent or incomplete: ${requested}`);
  }
  return chain;
}

export async function captureStableAuditLexicalPathChain(
  pathValue: string,
  options?: { allowAbsent?: boolean }
): Promise<AuditLexicalPathComponentIdentity[]> {
  const requested = normalize(resolve(pathValue));
  const allowAbsent = options?.allowAbsent === true;
  const before = await captureLexicalPathChainOnce(requested, allowAbsent);
  const after = await captureLexicalPathChainOnce(requested, allowAbsent);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`Audit lexical path changed: ${requested}`);
  }
  return before;
}

async function captureAuditLexicalPathStateOnce(pathValue: string): Promise<{
  chain: AuditLexicalPathComponentIdentity[];
  complete: boolean;
}> {
  const requested = normalize(resolve(pathValue));
  const chain = await captureLexicalPathChainOnce(requested, true);
  return { chain, complete: chain.at(-1)?.path === requested };
}

function assertLexicalChainUnchanged(
  requestedPath: string,
  before: AuditLexicalPathComponentIdentity[],
  after: AuditLexicalPathComponentIdentity[]
): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`Audit requested path changed: ${requestedPath}`);
  }
}

async function canonicalAbsentPath(
  pathValue: string,
  initialLexicalChain?: AuditLexicalPathComponentIdentity[]
): Promise<AuditAbsentPathIdentity> {
  const requested = normalize(resolve(pathValue));
  const currentLexicalChain = await captureStableAuditLexicalPathChain(
    requested,
    {
      allowAbsent: true,
    }
  );
  if (initialLexicalChain) {
    assertLexicalChainUnchanged(
      requested,
      initialLexicalChain,
      currentLexicalChain
    );
  }
  const lexicalChain = initialLexicalChain ?? currentLexicalChain;
  const suffix: string[] = [];
  let ancestor = requested;
  while (true) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      const metadata = await lstat(canonicalAncestor);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(
          `Audit context absent path has no stable directory ancestor: ${requested}`
        );
      }
      const relativeSegments = suffix.reverse();
      const proof: AuditAbsentPathIdentity = {
        ancestorDev: metadata.dev,
        ancestorIno: metadata.ino,
        ancestorPath: canonicalAncestor,
        lexicalChain,
        path: normalize(join(canonicalAncestor, ...relativeSegments)),
        relativeSegments,
        requestedPath: requested,
      };
      const lexicalAfter = await captureStableAuditLexicalPathChain(requested, {
        allowAbsent: true,
      });
      assertLexicalChainUnchanged(requested, lexicalChain, lexicalAfter);
      const lexicalAncestor = lexicalChain.at(-1);
      if (
        !lexicalAncestor ||
        normalize(join(lexicalAncestor.path, ...proof.relativeSegments)) !==
          requested ||
        (await realpath(lexicalAncestor.path)) !== proof.ancestorPath
      ) {
        throw new Error(
          `Audit context absent path has an inconsistent lexical ancestor: ${requested}`
        );
      }
      return proof;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new Error(
        `Audit context absent path has no resolvable ancestor: ${requested}`
      );
    }
    suffix.push(basename(ancestor));
    ancestor = parent;
  }
}

function sameFileMetadata(
  left: {
    ctimeMs: number;
    dev: number;
    ino: number;
    mode: number;
    mtimeMs: number;
    size: number;
  },
  right: {
    ctimeMs: number;
    dev: number;
    ino: number;
    mode: number;
    mtimeMs: number;
    size: number;
  }
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.size === right.size
  );
}

function sameDirectoryMetadata(
  left: AuditEvaluatedDirectoryIdentity,
  right: AuditEvaluatedDirectoryIdentity
): boolean {
  return (
    left.ctimeMs === right.ctimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.maxEntries === right.maxEntries &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs
  );
}

interface StablePhysicalPathIdentity {
  ctimeMs: number;
  dev: number;
  ino: number;
  kind: "directory" | "file";
  mode: number;
  mtimeMs: number;
  path: string;
  size: number;
}

function samePhysicalPathIdentity(
  left: StablePhysicalPathIdentity,
  right: StablePhysicalPathIdentity
): boolean {
  return (
    left.path === right.path &&
    left.kind === right.kind &&
    sameFileMetadata(left, right)
  );
}

async function captureStablePhysicalPathIdentity(
  pathValue: string,
  platform: NodeJS.Platform
): Promise<StablePhysicalPathIdentity> {
  const requested = normalize(resolve(pathValue));
  const before = await lstat(requested);
  if (before.isSymbolicLink() || !(before.isDirectory() || before.isFile())) {
    throw new Error(
      `Audit context must have a stable physical identity: ${requested}`
    );
  }
  const canonical = await realpath(requested);
  const kind = before.isDirectory() ? "directory" : "file";
  if (platform === "win32") {
    const after = await lstat(requested);
    const canonicalAfter = await realpath(requested);
    if (
      canonicalAfter !== canonical ||
      (after.isDirectory() ? "directory" : after.isFile() ? "file" : null) !==
        kind ||
      !sameFileMetadata(before, after)
    ) {
      throw new Error(`Audit context physical identity changed: ${canonical}`);
    }
    return {
      ctimeMs: after.ctimeMs,
      dev: after.dev,
      ino: after.ino,
      kind,
      mode: after.mode,
      mtimeMs: after.mtimeMs,
      path: canonical,
      size: after.size,
    };
  }
  const handle = await open(requested, readOnlyNoFollowFlags());
  try {
    const opened = await handle.stat();
    const after = await lstat(requested);
    const canonicalAfter = await realpath(requested);
    if (
      canonicalAfter !== canonical ||
      (opened.isDirectory() ? "directory" : opened.isFile() ? "file" : null) !==
        kind ||
      !sameFileMetadata(before, opened) ||
      !sameFileMetadata(opened, after)
    ) {
      throw new Error(`Audit context physical identity changed: ${canonical}`);
    }
    return {
      ctimeMs: opened.ctimeMs,
      dev: opened.dev,
      ino: opened.ino,
      kind,
      mode: opened.mode,
      mtimeMs: opened.mtimeMs,
      path: canonical,
      size: opened.size,
    };
  } finally {
    await handle.close();
  }
}

async function readStableRegularFile(
  pathValue: string,
  options?: {
    beforeFileOpen?: (args: { path: string }) => Promise<void>;
    beforeReadChunk?: (args: {
      bytesRead: number;
      path: string;
    }) => Promise<void>;
    maxBytes?: number;
  }
): Promise<{ bytes: Buffer; identity: AuditEvaluatedFileIdentity }> {
  const requested = normalize(resolve(pathValue));
  const requestedMetadata = await lstat(requested);
  if (requestedMetadata.isSymbolicLink() || !requestedMetadata.isFile()) {
    throw new Error(
      `Audit context must be a regular non-symlink file: ${requested}`
    );
  }
  await options?.beforeFileOpen?.({ path: requested });
  const handle = await open(requested, readOnlyNoFollowFlags());
  try {
    const before = await handle.stat();
    const canonical = await realpath(requested);
    if (!(before.isFile() && sameFileMetadata(requestedMetadata, before))) {
      throw new Error(`Audit context must be a regular file: ${requested}`);
    }
    const maxBytes = options?.maxBytes ?? 16 * 1024 * 1024;
    if (
      !(Number.isSafeInteger(before.size) && before.size >= 0) ||
      before.size > maxBytes
    ) {
      throw new Error(`Audit context exceeds byte limit: ${canonical}`);
    }
    if (
      process.platform !== "win32" &&
      before.size > 0 &&
      before.blocks * 512 < before.size
    ) {
      throw new Error(`Audit context is sparse: ${canonical}`);
    }
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead < before.size) {
      await options?.beforeReadChunk?.({ bytesRead, path: canonical });
      const current = await handle.stat();
      if (!sameFileMetadata(before, current) || current.size > maxBytes) {
        throw new Error(
          `Audit context changed while it was read: ${canonical}`
        );
      }
      const chunk = Buffer.allocUnsafe(
        Math.min(
          STRICT_CAPTURE_TREE_LIMITS.readChunkBytes,
          before.size - bytesRead
        )
      );
      const result = await handle.read(chunk, 0, chunk.length, null);
      if (result.bytesRead <= 0) {
        throw new Error(
          `Audit context ended before its declared size: ${canonical}`
        );
      }
      bytesRead += result.bytesRead;
      chunks.push(chunk.subarray(0, result.bytesRead));
    }
    await options?.beforeReadChunk?.({ bytesRead, path: canonical });
    const sentinel = Buffer.allocUnsafe(1);
    const trailing = await handle.read(sentinel, 0, 1, null);
    if (trailing.bytesRead !== 0) {
      throw new Error(`Audit context grew while it was read: ${canonical}`);
    }
    const bytes = Buffer.concat(chunks, bytesRead);
    const after = await handle.stat();
    const pathAfter = await lstat(requested);
    const canonicalAfter = await realpath(requested);
    if (
      !(
        sameFileMetadata(before, after) && sameFileMetadata(after, pathAfter)
      ) ||
      canonicalAfter !== canonical
    ) {
      throw new Error(`Audit context changed while it was read: ${canonical}`);
    }
    return {
      bytes,
      identity: {
        ctimeMs: after.ctimeMs,
        dev: after.dev,
        ino: after.ino,
        mode: after.mode,
        mtimeMs: after.mtimeMs,
        path: canonical,
        sha256: digest(bytes),
        size: after.size,
      },
    };
  } finally {
    await handle.close();
  }
}

export class AuditSourceTracker {
  readonly #absentPaths = new Map<string, AuditAbsentPathIdentity>();
  readonly #capturedTrees = new Map<string, AuditCapturedTreeIdentity>();
  readonly #evaluatedFiles = new Map<string, AuditEvaluatedFileIdentity>();
  readonly #evaluatedDirectories = new Map<
    string,
    AuditEvaluatedDirectoryIdentity
  >();
  readonly #derivedContexts = new Map<string, AuditDerivedContextIdentity>();
  readonly #protectedRoots = new Map<string, AuditProtectedRootIdentity>();
  readonly #physicalIdentityToPath = new Map<string, string>();
  readonly #physicalPathToIdentity = new Map<string, string>();
  readonly #canonicalRequests = new Map<string, string>();
  readonly #requestedPaths = new Map<string, AuditRequestedPathIdentity>();

  readonly #platform: NodeJS.Platform;

  readonly #beforeDerivedContextEvaluation?: (args: {
    path: string;
  }) => Promise<void>;

  readonly #beforeAbsentProof?: (args: { path: string }) => Promise<void>;

  readonly #beforeDirectoryRead?: (args: { path: string }) => Promise<void>;

  readonly #beforeFileOpen?: (args: { path: string }) => Promise<void>;

  readonly #beforeReadChunk?: (args: {
    bytesRead: number;
    path: string;
  }) => Promise<void>;

  constructor(options?: {
    beforeAbsentProof?: (args: { path: string }) => Promise<void>;
    beforeDerivedContextEvaluation?: (args: { path: string }) => Promise<void>;
    beforeDirectoryRead?: (args: { path: string }) => Promise<void>;
    beforeFileOpen?: (args: { path: string }) => Promise<void>;
    beforeReadChunk?: (args: {
      bytesRead: number;
      path: string;
    }) => Promise<void>;
    platform?: NodeJS.Platform;
  }) {
    this.#beforeAbsentProof = options?.beforeAbsentProof;
    this.#beforeDerivedContextEvaluation =
      options?.beforeDerivedContextEvaluation;
    this.#beforeDirectoryRead = options?.beforeDirectoryRead;
    this.#beforeFileOpen = options?.beforeFileOpen;
    this.#beforeReadChunk = options?.beforeReadChunk;
    this.#platform = options?.platform ?? process.platform;
  }

  async #recordInitialAbsence(
    requested: string,
    lexicalChain: AuditLexicalPathComponentIdentity[]
  ): Promise<void> {
    await this.#beforeAbsentProof?.({ path: requested });
    const proof = await canonicalAbsentPath(requested, lexicalChain);
    this.#recordAbsentProof(requested, proof);
  }

  #assertRequestedPathChain(
    requested: string,
    expected: AuditLexicalPathComponentIdentity[]
  ): void {
    const recorded = this.#requestedPaths.get(requested);
    if (
      !recorded ||
      JSON.stringify(recorded.lexicalChain) !== JSON.stringify(expected)
    ) {
      throw new Error(`Audit requested path changed: ${requested}`);
    }
  }

  #registerPhysicalIdentity(args: {
    dev: number;
    ino: number;
    kind: "directory" | "file";
    lexicalChain?: AuditLexicalPathComponentIdentity[];
    path: string;
    requestedPath?: string;
  }): void {
    const physicalIdentity = `${args.dev}\0${args.ino}`;
    const pathIdentity = `${args.kind}\0${physicalIdentity}`;
    const identityPath = this.#physicalIdentityToPath.get(physicalIdentity);
    const priorPathIdentity = this.#physicalPathToIdentity.get(args.path);
    if (
      (identityPath !== undefined && identityPath !== args.path) ||
      (priorPathIdentity !== undefined && priorPathIdentity !== pathIdentity)
    ) {
      throw new Error(
        `Audit context has a physical path alias or conflicting identity: ${args.path}`
      );
    }
    if (args.requestedPath !== undefined) {
      const requested = normalize(resolve(args.requestedPath));
      if (!args.lexicalChain) {
        throw new Error(
          `Audit requested path has no lexical identity: ${requested}`
        );
      }
      const binding: AuditRequestedPathIdentity = {
        canonicalPath: args.path,
        dev: args.dev,
        ino: args.ino,
        kind: args.kind,
        lexicalChain: args.lexicalChain,
        requestedPath: requested,
      };
      const priorBinding = this.#requestedPaths.get(requested);
      const priorRequest = this.#canonicalRequests.get(args.path);
      if (
        (priorBinding !== undefined &&
          JSON.stringify(priorBinding) !== JSON.stringify(binding)) ||
        (priorRequest !== undefined && priorRequest !== requested)
      ) {
        throw new Error(
          `Audit requested path changed physical identity: ${requested}`
        );
      }
      this.#requestedPaths.set(requested, binding);
      this.#canonicalRequests.set(args.path, requested);
    }
    this.#physicalIdentityToPath.set(physicalIdentity, args.path);
    this.#physicalPathToIdentity.set(args.path, pathIdentity);
  }

  async protect(paths: string[]): Promise<void> {
    for (const pathValue of paths) {
      if (!isAbsolute(pathValue)) {
        continue;
      }
      const requested = normalize(pathValue);
      const lexicalChain = await captureLexicalPathChainOnce(requested, false);
      const requestedMetadata = await lstat(requested);
      if (requestedMetadata.isSymbolicLink()) {
        throw new Error(
          `Audited source root must not be a symlink: ${requested}`
        );
      }
      const canonical = await realpath(requested);
      if (requestedMetadata.isDirectory() && this.#platform === "win32") {
        const after = await lstat(requested);
        const canonicalAfter = await realpath(requested);
        if (
          !sameFileMetadata(requestedMetadata, after) ||
          canonicalAfter !== canonical
        ) {
          throw new Error(`Audited source root changed: ${requested}`);
        }
        const identity = {
          dev: after.dev,
          ino: after.ino,
          kind: "directory",
          path: canonical,
        } as const;
        const lexicalAfter = await captureLexicalPathChainOnce(
          requested,
          false
        );
        assertLexicalChainUnchanged(requested, lexicalChain, lexicalAfter);
        this.#registerPhysicalIdentity({
          ...identity,
          lexicalChain,
          requestedPath: requested,
        });
        this.#protectedRoots.set(canonical, identity);
        continue;
      }
      const handle = await open(requested, readOnlyNoFollowFlags());
      try {
        const metadata = await handle.stat();
        const kind = metadata.isFile()
          ? "file"
          : metadata.isDirectory()
            ? "directory"
            : null;
        if (!(kind && sameFileMetadata(requestedMetadata, metadata))) {
          throw new Error(
            `Audited source root has an unsupported or unstable file type: ${canonical}`
          );
        }
        const identity: AuditProtectedRootIdentity = {
          dev: metadata.dev,
          ino: metadata.ino,
          kind,
          path: canonical,
        };
        const lexicalAfter = await captureLexicalPathChainOnce(
          requested,
          false
        );
        assertLexicalChainUnchanged(requested, lexicalChain, lexicalAfter);
        this.#registerPhysicalIdentity({
          ...identity,
          lexicalChain,
          requestedPath: requested,
        });
        this.#protectedRoots.set(canonical, identity);
      } finally {
        await handle.close();
      }
    }
  }

  async read(
    pathValue: string,
    options?: { maxBytes?: number }
  ): Promise<Buffer> {
    const requested = normalize(resolve(pathValue));
    const initialState = await captureAuditLexicalPathStateOnce(requested);
    if (!initialState.complete) {
      const error = new Error(
        `Audit requested path is absent: ${requested}`
      ) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    const lexicalChain = initialState.chain;
    const { bytes, identity } = await readStableRegularFile(pathValue, {
      beforeFileOpen: this.#beforeFileOpen,
      beforeReadChunk: this.#beforeReadChunk,
      maxBytes: options?.maxBytes,
    });
    const lexicalAfter = await captureLexicalPathChainOnce(requested, false);
    assertLexicalChainUnchanged(requested, lexicalChain, lexicalAfter);
    this.#registerPhysicalIdentity({
      ...identity,
      kind: "file",
      lexicalChain,
      requestedPath: requested,
    });
    const existing = this.#evaluatedFiles.get(identity.path);
    if (
      existing &&
      (!sameFileMetadata(existing, identity) ||
        existing.sha256 !== identity.sha256)
    ) {
      throw new Error(`Audit context changed between reads: ${identity.path}`);
    }
    if (!existing) {
      this.#evaluatedFiles.set(identity.path, identity);
    }
    return bytes;
  }

  async capture(pathValue: string): Promise<void> {
    const requested = normalize(resolve(pathValue));
    const initialState = await captureAuditLexicalPathStateOnce(requested);
    if (!initialState.complete) {
      await this.#recordInitialAbsence(requested, initialState.chain);
      return;
    }
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(requested);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Audit requested path changed: ${requested}`);
      }
      throw error;
    }
    if (metadata.isFile()) {
      await this.read(requested);
      this.#assertRequestedPathChain(requested, initialState.chain);
      return;
    }
    if (metadata.isDirectory()) {
      await this.readDirectory(requested);
      this.#assertRequestedPathChain(requested, initialState.chain);
      return;
    }
    throw new Error(`Audit context has an unsupported file type: ${requested}`);
  }

  async readText(
    pathValue: string,
    options?: { maxBytes?: number }
  ): Promise<string> {
    return (await this.read(pathValue, options)).toString("utf8");
  }

  async readOptionalText(pathValue: string): Promise<string | null> {
    const requested = normalize(resolve(pathValue));
    const initialState = await captureAuditLexicalPathStateOnce(requested);
    if (!initialState.complete) {
      await this.#recordInitialAbsence(requested, initialState.chain);
      return null;
    }
    try {
      const value = await this.readText(requested);
      this.#assertRequestedPathChain(requested, initialState.chain);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Audit requested path changed: ${requested}`);
      }
      throw error;
    }
  }

  async readDirectory(
    pathValue: string,
    options?: { maxEntries?: number }
  ): Promise<Dirent[] | null> {
    const requested = normalize(resolve(pathValue));
    const initialState = await captureAuditLexicalPathStateOnce(requested);
    if (!initialState.complete) {
      await this.#recordInitialAbsence(requested, initialState.chain);
      return null;
    }
    const lexicalChain = initialState.chain;
    let before: Awaited<ReturnType<typeof lstat>>;
    try {
      before = await lstat(requested);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Audit requested path changed: ${requested}`);
      }
      throw error;
    }
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new Error(
        `Audit context must be a non-symlink directory: ${requested}`
      );
    }
    let canonical: string;
    let after: Awaited<ReturnType<typeof lstat>>;
    let entries: Dirent[];
    const requestedMaxEntries = options?.maxEntries ?? 50_000;
    if (!isNonNegativeSafeInteger(requestedMaxEntries)) {
      throw new Error(
        `Audit directory has an invalid entry limit: ${requested}`
      );
    }
    const existingCanonical = await realpath(requested);
    const priorIdentity = this.#evaluatedDirectories.get(existingCanonical);
    const maxEntries = Math.min(
      requestedMaxEntries,
      priorIdentity?.maxEntries ?? requestedMaxEntries
    );
    await this.#beforeDirectoryRead?.({ path: existingCanonical });
    if (this.#platform === "win32") {
      // Windows cannot portably open directory descriptors. Persistence is
      // disabled there, but read-only evaluation still binds a before/after
      // directory identity and fails if discovery changes.
      canonical = await realpath(requested);
      entries = await readBoundedDirectoryEntries(requested, maxEntries);
      after = await lstat(requested);
      const canonicalAfter = await realpath(requested);
      if (!sameFileMetadata(before, after) || canonicalAfter !== canonical) {
        throw new Error(
          `Audit directory changed while it was read: ${canonical}`
        );
      }
    } else {
      const handle = await open(requested, readOnlyNoFollowFlags());
      try {
        const openedBefore = await handle.stat();
        canonical = await realpath(requested);
        if (
          !(
            openedBefore.isDirectory() && sameFileMetadata(before, openedBefore)
          )
        ) {
          throw new Error(
            `Audit directory changed while it was opened: ${requested}`
          );
        }
        entries = await readBoundedDirectoryEntries(requested, maxEntries);
        const openedAfter = await handle.stat();
        after = await lstat(requested);
        const canonicalAfter = await realpath(requested);
        if (
          !(
            sameFileMetadata(openedBefore, openedAfter) &&
            sameFileMetadata(openedAfter, after)
          ) ||
          canonicalAfter !== canonical
        ) {
          throw new Error(
            `Audit directory changed while it was read: ${canonical}`
          );
        }
      } finally {
        await handle.close();
      }
    }
    const stableEntries = await readBoundedDirectoryEntries(
      requested,
      maxEntries
    );
    const entriesSha256 = directoryEntriesDigest(entries);
    if (directoryEntriesDigest(stableEntries) !== entriesSha256) {
      throw new Error(
        `Audit directory changed while it was read: ${canonical}`
      );
    }
    const stableMetadata = await lstat(requested);
    if (
      !sameFileMetadata(after, stableMetadata) ||
      (await realpath(requested)) !== canonical
    ) {
      throw new Error(
        `Audit directory changed while it was read: ${canonical}`
      );
    }
    const identity = {
      ctimeMs: stableMetadata.ctimeMs,
      dev: stableMetadata.dev,
      entriesSha256,
      ino: stableMetadata.ino,
      maxEntries,
      mode: stableMetadata.mode,
      mtimeMs: stableMetadata.mtimeMs,
      path: canonical,
    };
    const lexicalAfter = await captureLexicalPathChainOnce(requested, false);
    assertLexicalChainUnchanged(requested, lexicalChain, lexicalAfter);
    this.#registerPhysicalIdentity({
      ...identity,
      kind: "directory",
      lexicalChain,
      requestedPath: requested,
    });
    const existing = this.#evaluatedDirectories.get(canonical);
    if (
      existing &&
      (existing.dev !== identity.dev ||
        existing.ino !== identity.ino ||
        existing.mode !== identity.mode ||
        existing.mtimeMs !== identity.mtimeMs ||
        existing.ctimeMs !== identity.ctimeMs ||
        existing.entriesSha256 !== entriesSha256)
    ) {
      throw new Error(`Audit directory changed between reads: ${canonical}`);
    }
    this.#evaluatedDirectories.set(canonical, identity);
    return entries;
  }

  async captureTree(
    pathValue: string,
    options?: {
      maxAggregateBytes?: number;
      maxDepth?: number;
      maxEntries?: number;
      maxFileBytes?: number;
      maxRelativePathBytes?: number;
      rejectUnsupportedEntries?: boolean;
    }
  ): Promise<void> {
    const strict = options?.rejectUnsupportedEntries === true;
    const maxEntries =
      options?.maxEntries ??
      (strict ? STRICT_CAPTURE_TREE_LIMITS.maxEntries : 50_000);
    const maxAggregateBytes =
      options?.maxAggregateBytes ??
      STRICT_CAPTURE_TREE_LIMITS.maxAggregateBytes;
    const maxDepth = options?.maxDepth ?? STRICT_CAPTURE_TREE_LIMITS.maxDepth;
    const maxFileBytes =
      options?.maxFileBytes ?? STRICT_CAPTURE_TREE_LIMITS.maxFileBytes;
    const maxRelativePathBytes =
      options?.maxRelativePathBytes ??
      STRICT_CAPTURE_TREE_LIMITS.maxRelativePathBytes;
    const limitsAreValid =
      isPositiveSafeInteger(maxEntries) &&
      isNonNegativeSafeInteger(maxAggregateBytes) &&
      isNonNegativeSafeInteger(maxDepth) &&
      isNonNegativeSafeInteger(maxFileBytes) &&
      isPositiveSafeInteger(maxRelativePathBytes);
    const strictLimitsAreConservative =
      !strict ||
      (maxEntries <= STRICT_CAPTURE_TREE_LIMITS.maxEntries &&
        maxAggregateBytes <= STRICT_CAPTURE_TREE_LIMITS.maxAggregateBytes &&
        maxDepth <= STRICT_CAPTURE_TREE_LIMITS.maxDepth &&
        maxFileBytes <= STRICT_CAPTURE_TREE_LIMITS.maxFileBytes &&
        maxRelativePathBytes <=
          STRICT_CAPTURE_TREE_LIMITS.maxRelativePathBytes);
    if (!(limitsAreValid && strictLimitsAreConservative)) {
      throw new Error(
        `Audit discovery tree has invalid resource limits: ${pathValue}`
      );
    }
    const root = normalize(resolve(pathValue));
    const directoryPaths = new Set<string>();
    const filePaths = new Set<string>();
    const reservedFiles: { entryPath: string; relativePath: string }[] = [];
    let aggregateBytes = 0;
    let usedEntries = 1;

    const reserveShape = async (
      directory: string,
      relativeDirectory: string,
      depth: number
    ): Promise<void> => {
      if (depth > maxDepth) {
        throw new Error(`Audit discovery tree exceeds depth limit: ${root}`);
      }
      const remainingEntries = maxEntries - usedEntries;
      if (remainingEntries < 0) {
        throw new Error(
          `Audit discovery tree exceeds entry limit: ${pathValue}`
        );
      }
      const entries = await this.readDirectory(directory, {
        maxEntries: remainingEntries,
      });
      if (entries === null) {
        if (strict) {
          throw new Error(
            `Audit discovery tree disappeared while it was captured: ${directory}`
          );
        }
        return;
      }
      if (strict) {
        directoryPaths.add(await realpath(directory));
      }
      usedEntries += entries.length;
      if (usedEntries > maxEntries) {
        throw new Error(
          `Audit discovery tree exceeds entry limit: ${pathValue}`
        );
      }
      const manifest = entries.map((entry) => {
        if (
          !entry.name ||
          entry.name === "." ||
          entry.name === ".." ||
          entry.name.includes("/") ||
          entry.name.includes("\\")
        ) {
          throw new Error(
            `Audit discovery tree has an unsafe entry name: ${root}`
          );
        }
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        if (Buffer.byteLength(relativePath, "utf8") > maxRelativePathBytes) {
          throw new Error(
            `Audit discovery tree exceeds relative path limit: ${root}`
          );
        }
        const entryPath = join(directory, entry.name);
        const isDirectory = entry.isDirectory() && !entry.isSymbolicLink();
        const isFile = entry.isFile() && !entry.isSymbolicLink();
        if (!(isDirectory || isFile)) {
          if (!strict) {
            return { entryPath, isDirectory, isFile, relativePath };
          }
          throw new Error(
            `Audit discovery tree has an unsupported entry: ${entryPath}`
          );
        }
        return { entryPath, isDirectory, isFile, relativePath };
      });
      for (const entry of manifest) {
        if (entry.isDirectory) {
          if (usedEntries >= maxEntries) {
            throw new Error(
              `Audit discovery tree exceeds entry limit: ${pathValue}`
            );
          }
          await reserveShape(entry.entryPath, entry.relativePath, depth + 1);
          continue;
        }
        if (strict && entry.isFile) {
          reservedFiles.push({
            entryPath: entry.entryPath,
            relativePath: entry.relativePath,
          });
        }
      }
    };

    if (usedEntries > maxEntries) {
      throw new Error(`Audit discovery tree exceeds entry limit: ${root}`);
    }
    await reserveShape(root, "", 0);
    if (!strict) {
      return;
    }
    reservedFiles.sort((left, right) =>
      compareStrings(left.relativePath, right.relativePath)
    );
    for (const file of reservedFiles) {
      const remainingBytes = maxAggregateBytes - aggregateBytes;
      if (remainingBytes < 0) {
        throw new Error(
          `Audit discovery tree exceeds aggregate byte limit: ${root}`
        );
      }
      const bytes = await this.read(file.entryPath, {
        maxBytes: Math.min(maxFileBytes, remainingBytes),
      });
      filePaths.add(await realpath(file.entryPath));
      aggregateBytes += bytes.byteLength;
      if (aggregateBytes > maxAggregateBytes) {
        throw new Error(
          `Audit discovery tree exceeds aggregate byte limit: ${root}`
        );
      }
    }
    const canonicalRoot = await realpath(root);
    const treeIdentity: AuditCapturedTreeIdentity = {
      directoryPaths: [...directoryPaths].sort(),
      filePaths: [...filePaths].sort(),
      maxAggregateBytes,
      maxDepth,
      maxEntries,
      maxFileBytes,
      maxRelativePathBytes,
      rejectUnsupportedEntries: true,
      root: canonicalRoot,
    };
    const existingTree = this.#capturedTrees.get(canonicalRoot);
    if (
      existingTree &&
      JSON.stringify(existingTree) !== JSON.stringify(treeIdentity)
    ) {
      throw new Error(
        `Audit discovery tree has conflicting contracts: ${canonicalRoot}`
      );
    }
    this.#capturedTrees.set(canonicalRoot, treeIdentity);
  }

  async recordGitPathExposure(
    pathValue: string
  ): Promise<Awaited<ReturnType<typeof getGitPathExposure>>> {
    const requested = normalize(resolve(pathValue));
    const lexicalChain = await captureLexicalPathChainOnce(requested, false);
    const before = await captureStablePhysicalPathIdentity(
      pathValue,
      this.#platform
    );
    await this.#beforeDerivedContextEvaluation?.({ path: before.path });
    const value = await getGitPathExposure(before.path);
    const after = await captureStablePhysicalPathIdentity(
      before.path,
      this.#platform
    );
    if (!samePhysicalPathIdentity(before, after)) {
      throw new Error(
        `Audit derived context physical identity changed: ${before.path}`
      );
    }
    const lexicalAfter = await captureLexicalPathChainOnce(requested, false);
    assertLexicalChainUnchanged(requested, lexicalChain, lexicalAfter);
    this.#registerPhysicalIdentity({
      ...after,
      lexicalChain,
      requestedPath: requested,
    });
    const key = `git-path-exposure\0${before.path}`;
    if (this.#derivedContexts.has(key)) {
      throw new Error(
        `Audit derived context has a duplicate physical target: ${before.path}`
      );
    }
    this.#derivedContexts.set(key, {
      ctimeMs: after.ctimeMs,
      dev: after.dev,
      ino: after.ino,
      kind: "git-path-exposure",
      mode: after.mode,
      mtimeMs: after.mtimeMs,
      path: after.path,
      pathKind: after.kind,
      sha256: digest(Buffer.from(JSON.stringify(value))),
      size: after.size,
    });
    return value;
  }

  #recordAbsentProof(
    requestedPath: string,
    proof: AuditAbsentPathIdentity
  ): void {
    const requested = normalize(resolve(requestedPath));
    const priorProof = this.#absentPaths.get(requested);
    if (
      priorProof !== undefined &&
      JSON.stringify(priorProof) !== JSON.stringify(proof)
    ) {
      throw new Error(
        `Audit absent requested path changed physical identity: ${requested}`
      );
    }
    this.#registerPhysicalIdentity({
      dev: proof.ancestorDev,
      ino: proof.ancestorIno,
      kind: "directory",
      path: proof.ancestorPath,
    });
    this.#absentPaths.set(requested, proof);
  }

  snapshot(): AuditSourceSnapshot {
    const contract: AuditSourceSnapshotContract = {
      schemaVersion: 9,
      protectedRoots: [...this.#protectedRoots.values()].sort((a, b) =>
        compareStrings(a.path, b.path)
      ),
      evaluatedFiles: [...this.#evaluatedFiles.values()].sort((a, b) =>
        compareStrings(a.path, b.path)
      ),
      evaluatedDirectories: [...this.#evaluatedDirectories.values()].sort(
        (a, b) => compareStrings(a.path, b.path)
      ),
      capturedTrees: [...this.#capturedTrees.values()].sort((left, right) =>
        compareStrings(left.root, right.root)
      ),
      derivedContexts: [...this.#derivedContexts.values()].sort((a, b) =>
        compareStrings(`${a.kind}\0${a.path}`, `${b.kind}\0${b.path}`)
      ),
      absentPaths: [...this.#absentPaths.values()].sort((a, b) =>
        compareStrings(a.requestedPath, b.requestedPath)
      ),
      requestedPaths: [...this.#requestedPaths.values()].sort((a, b) =>
        compareStrings(a.requestedPath, b.requestedPath)
      ),
    };
    const canonicalContract = canonicalSnapshotContract(contract);
    return {
      ...canonicalContract,
      validationContractSha256: validationContractDigest(canonicalContract),
    };
  }
}

export async function captureAuditSourceSnapshot(args: {
  evaluatedFiles?: string[];
  protectedRoots: string[];
}): Promise<AuditSourceSnapshot> {
  const tracker = new AuditSourceTracker();
  await tracker.protect(args.protectedRoots);
  for (const pathValue of args.evaluatedFiles ?? []) {
    await tracker.read(pathValue);
  }
  return tracker.snapshot();
}

export function assertAuditSourceSnapshot(
  value: unknown
): asserts value is AuditSourceSnapshot {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    throw new Error("Audit source snapshot schema is unsupported");
  }
  const snapshot = value as Partial<AuditSourceSnapshot>;
  const shapeIsValid =
    hasExactKeys(value, SNAPSHOT_KEYS) &&
    snapshot.schemaVersion === 9 &&
    typeof snapshot.validationContractSha256 === "string" &&
    SHA256_RE.test(snapshot.validationContractSha256) &&
    Array.isArray(snapshot.protectedRoots) &&
    Array.isArray(snapshot.evaluatedFiles) &&
    Array.isArray(snapshot.evaluatedDirectories) &&
    Array.isArray(snapshot.capturedTrees) &&
    Array.isArray(snapshot.derivedContexts) &&
    Array.isArray(snapshot.absentPaths) &&
    Array.isArray(snapshot.requestedPaths) &&
    snapshot.protectedRoots.every(isValidProtectedRootIdentity) &&
    snapshot.evaluatedFiles.every(isValidFileIdentity) &&
    snapshot.evaluatedDirectories.every(isValidDirectoryIdentity) &&
    snapshot.capturedTrees.every(isValidCapturedTreeIdentity) &&
    snapshot.derivedContexts.every(isValidDerivedContextIdentity) &&
    snapshot.absentPaths.every(isValidAbsentPathIdentity) &&
    snapshot.requestedPaths.every(isValidRequestedPathIdentity);
  if (!shapeIsValid) {
    throw new Error("Audit source snapshot schema is unsupported");
  }

  const exactSnapshot = snapshot as AuditSourceSnapshot;
  if (
    !(
      isSortedUniqueBy(exactSnapshot.protectedRoots, (entry) => entry.path) &&
      isSortedUniqueBy(exactSnapshot.evaluatedFiles, (entry) => entry.path) &&
      isSortedUniqueBy(
        exactSnapshot.evaluatedDirectories,
        (entry) => entry.path
      ) &&
      isSortedUniqueBy(exactSnapshot.capturedTrees, (entry) => entry.root) &&
      isSortedUniqueBy(
        exactSnapshot.derivedContexts,
        (entry) => `${entry.kind}\0${entry.path}`
      ) &&
      isSortedUniqueBy(
        exactSnapshot.absentPaths,
        (entry) => entry.requestedPath
      ) &&
      isSortedUniqueBy(
        exactSnapshot.requestedPaths,
        (entry) => entry.requestedPath
      )
    )
  ) {
    throw new Error("Audit source snapshot schema is unsupported");
  }

  const contract = canonicalSnapshotContract(exactSnapshot);
  if (
    validationContractDigest(contract) !==
    exactSnapshot.validationContractSha256
  ) {
    throw new Error("Audit source snapshot schema is unsupported");
  }
  if (!hasCoherentPhysicalIdentities(exactSnapshot)) {
    throw new Error("Audit source snapshot schema is unsupported");
  }

  const requestedByCanonicalPath = new Map(
    exactSnapshot.requestedPaths.map((entry) => [entry.canonicalPath, entry])
  );
  if (requestedByCanonicalPath.size !== exactSnapshot.requestedPaths.length) {
    throw new Error("Audit source snapshot schema is unsupported");
  }
  const presentRequestedPaths = new Set(
    exactSnapshot.requestedPaths.map((entry) => entry.requestedPath)
  );
  if (
    exactSnapshot.absentPaths.some((entry) =>
      presentRequestedPaths.has(entry.requestedPath)
    )
  ) {
    throw new Error("Audit source snapshot schema is unsupported");
  }
  const hasRequestedBinding = (args: {
    dev: number;
    ino: number;
    kind: "directory" | "file";
    path: string;
  }): boolean => {
    const binding = requestedByCanonicalPath.get(args.path);
    return Boolean(
      binding &&
        binding.dev === args.dev &&
        binding.ino === args.ino &&
        binding.kind === args.kind
    );
  };
  const referencedCanonicalPaths = new Set([
    ...exactSnapshot.protectedRoots.map((entry) => entry.path),
    ...exactSnapshot.evaluatedFiles.map((entry) => entry.path),
    ...exactSnapshot.evaluatedDirectories.map((entry) => entry.path),
    ...exactSnapshot.derivedContexts.map((entry) => entry.path),
  ]);
  if (
    requestedByCanonicalPath.size !== referencedCanonicalPaths.size ||
    [...requestedByCanonicalPath.keys()].some(
      (path) => !referencedCanonicalPaths.has(path)
    ) ||
    exactSnapshot.protectedRoots.some((entry) => !hasRequestedBinding(entry)) ||
    exactSnapshot.evaluatedFiles.some(
      (entry) => !hasRequestedBinding({ ...entry, kind: "file" })
    ) ||
    exactSnapshot.evaluatedDirectories.some(
      (entry) => !hasRequestedBinding({ ...entry, kind: "directory" })
    ) ||
    exactSnapshot.derivedContexts.some(
      (entry) => !hasRequestedBinding({ ...entry, kind: entry.pathKind })
    )
  ) {
    throw new Error("Audit source snapshot schema is unsupported");
  }

  const files = new Map(
    exactSnapshot.evaluatedFiles.map((entry) => [entry.path, entry])
  );
  const directories = new Map(
    exactSnapshot.evaluatedDirectories.map((entry) => [entry.path, entry])
  );
  if ([...files.keys()].some((path) => directories.has(path))) {
    throw new Error("Audit source snapshot schema is unsupported");
  }

  const treeOwners = new Map<string, string>();
  for (let index = 0; index < exactSnapshot.capturedTrees.length; index += 1) {
    const tree = exactSnapshot.capturedTrees[index]!;
    for (const other of exactSnapshot.capturedTrees.slice(index + 1)) {
      if (
        isContainedPath(tree.root, other.root) ||
        isContainedPath(other.root, tree.root)
      ) {
        throw new Error("Audit source snapshot schema is unsupported");
      }
    }
    const budgets = deriveCapturedTreeDirectoryBudgets(tree);
    if (!budgets) {
      throw new Error("Audit source snapshot schema is unsupported");
    }
    let aggregateBytes = 0;
    for (const path of tree.directoryPaths) {
      const identity = directories.get(path);
      const expectedBudget = budgets.get(path);
      if (!identity || identity.maxEntries !== expectedBudget) {
        throw new Error("Audit source snapshot schema is unsupported");
      }
      if (treeOwners.has(path)) {
        throw new Error("Audit source snapshot schema is unsupported");
      }
      treeOwners.set(path, tree.root);
    }
    for (const path of tree.filePaths) {
      const identity = files.get(path);
      if (!identity || treeOwners.has(path)) {
        throw new Error("Audit source snapshot schema is unsupported");
      }
      aggregateBytes += identity.size;
      if (
        identity.size > tree.maxFileBytes ||
        aggregateBytes > tree.maxAggregateBytes
      ) {
        throw new Error("Audit source snapshot schema is unsupported");
      }
      treeOwners.set(path, tree.root);
    }
  }

  for (const path of [...files.keys(), ...directories.keys()]) {
    const containingTree = exactSnapshot.capturedTrees.find((tree) =>
      isContainedPath(tree.root, path)
    );
    if (containingTree && treeOwners.get(path) !== containingTree.root) {
      throw new Error("Audit source snapshot schema is unsupported");
    }
  }

  const protectedPaths = new Set(
    exactSnapshot.protectedRoots.map((root) => root.path)
  );
  if (
    exactSnapshot.absentPaths.some(
      (proof) =>
        files.has(proof.path) ||
        directories.has(proof.path) ||
        protectedPaths.has(proof.path)
    )
  ) {
    throw new Error("Audit source snapshot schema is unsupported");
  }

  for (const root of exactSnapshot.protectedRoots) {
    const file = files.get(root.path);
    const directory = directories.get(root.path);
    if (
      (file &&
        (root.kind !== "file" ||
          root.dev !== file.dev ||
          root.ino !== file.ino)) ||
      (directory &&
        (root.kind !== "directory" ||
          root.dev !== directory.dev ||
          root.ino !== directory.ino))
    ) {
      throw new Error("Audit source snapshot schema is unsupported");
    }
  }
}

function isValidProtectedRootIdentity(
  value: unknown
): value is AuditProtectedRootIdentity {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    return false;
  }
  const entry = value as Partial<AuditProtectedRootIdentity>;
  return (
    hasExactKeys(value, PROTECTED_ROOT_KEYS) &&
    hasUsablePhysicalIdentity(
      entry.dev ?? Number.NaN,
      entry.ino ?? Number.NaN
    ) &&
    (entry.kind === "directory" || entry.kind === "file") &&
    isCanonicalAbsolutePath(entry.path)
  );
}

function isValidFileIdentity(
  value: unknown
): value is AuditEvaluatedFileIdentity {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    return false;
  }
  const entry = value as Partial<AuditEvaluatedFileIdentity>;
  return (
    hasExactKeys(value, FILE_IDENTITY_KEYS) &&
    Number.isFinite(entry.ctimeMs) &&
    hasUsablePhysicalIdentity(
      entry.dev ?? Number.NaN,
      entry.ino ?? Number.NaN
    ) &&
    isNonNegativeSafeInteger(entry.mode ?? Number.NaN) &&
    Number.isFinite(entry.mtimeMs) &&
    isCanonicalAbsolutePath(entry.path) &&
    typeof entry.sha256 === "string" &&
    SHA256_RE.test(entry.sha256) &&
    isNonNegativeSafeInteger(entry.size ?? Number.NaN)
  );
}

function isValidDirectoryIdentity(
  value: unknown
): value is AuditEvaluatedDirectoryIdentity {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    return false;
  }
  const entry = value as Partial<AuditEvaluatedDirectoryIdentity>;
  return (
    hasExactKeys(value, DIRECTORY_IDENTITY_KEYS) &&
    Number.isFinite(entry.ctimeMs) &&
    hasUsablePhysicalIdentity(
      entry.dev ?? Number.NaN,
      entry.ino ?? Number.NaN
    ) &&
    typeof entry.entriesSha256 === "string" &&
    SHA256_RE.test(entry.entriesSha256) &&
    isNonNegativeSafeInteger(entry.maxEntries ?? Number.NaN) &&
    entry.maxEntries! <= 50_000 &&
    isNonNegativeSafeInteger(entry.mode ?? Number.NaN) &&
    Number.isFinite(entry.mtimeMs) &&
    isCanonicalAbsolutePath(entry.path)
  );
}

function isValidCapturedTreeIdentity(
  value: unknown
): value is AuditCapturedTreeIdentity {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    return false;
  }
  const entry = value as Partial<AuditCapturedTreeIdentity>;
  if (
    !(
      hasExactKeys(value, CAPTURED_TREE_KEYS) &&
      isCanonicalAbsolutePath(entry.root)
    ) ||
    entry.rejectUnsupportedEntries !== true ||
    !Array.isArray(entry.filePaths) ||
    !Array.isArray(entry.directoryPaths) ||
    !isPositiveSafeInteger(entry.maxEntries ?? Number.NaN) ||
    !isNonNegativeSafeInteger(entry.maxAggregateBytes ?? Number.NaN) ||
    !isNonNegativeSafeInteger(entry.maxDepth ?? Number.NaN) ||
    !isNonNegativeSafeInteger(entry.maxFileBytes ?? Number.NaN) ||
    !isPositiveSafeInteger(entry.maxRelativePathBytes ?? Number.NaN) ||
    entry.maxEntries! > STRICT_CAPTURE_TREE_LIMITS.maxEntries ||
    entry.maxAggregateBytes! > STRICT_CAPTURE_TREE_LIMITS.maxAggregateBytes ||
    entry.maxDepth! > STRICT_CAPTURE_TREE_LIMITS.maxDepth ||
    entry.maxFileBytes! > STRICT_CAPTURE_TREE_LIMITS.maxFileBytes ||
    entry.maxRelativePathBytes! >
      STRICT_CAPTURE_TREE_LIMITS.maxRelativePathBytes ||
    !isSortedUniqueStringArray(entry.directoryPaths) ||
    !isSortedUniqueStringArray(entry.filePaths)
  ) {
    return false;
  }
  const tree = entry as AuditCapturedTreeIdentity;
  const allPaths = [...tree.directoryPaths, ...tree.filePaths];
  if (
    tree.directoryPaths[0] !== tree.root ||
    new Set(allPaths).size !== allPaths.length ||
    allPaths.length > tree.maxEntries
  ) {
    return false;
  }
  const files = new Set(tree.filePaths);
  return allPaths.every((path) => {
    if (!(isCanonicalAbsolutePath(path) && isContainedPath(tree.root, path))) {
      return false;
    }
    const relativePath = relative(tree.root, path);
    if (Buffer.byteLength(relativePath, "utf8") > tree.maxRelativePathBytes) {
      return false;
    }
    const segments = relativePath ? relativePath.split(sep) : [];
    const depth = files.has(path)
      ? Math.max(segments.length - 1, 0)
      : segments.length;
    return depth <= tree.maxDepth;
  });
}

function deriveCapturedTreeDirectoryBudgets(
  tree: AuditCapturedTreeIdentity
): Map<string, number> | null {
  const directories = new Set(tree.directoryPaths);
  const childDirectories = new Map<string, string[]>();
  const childFiles = new Map<string, string[]>();
  for (const path of tree.directoryPaths) {
    childDirectories.set(path, []);
    childFiles.set(path, []);
  }
  for (const path of tree.directoryPaths) {
    if (path === tree.root) {
      continue;
    }
    const parent = dirname(path);
    if (!directories.has(parent)) {
      return null;
    }
    childDirectories.get(parent)!.push(path);
  }
  for (const path of tree.filePaths) {
    const parent = dirname(path);
    if (!directories.has(parent)) {
      return null;
    }
    childFiles.get(parent)!.push(path);
  }
  for (const children of childDirectories.values()) {
    children.sort(compareStrings);
  }
  let usedEntries = 1;
  const budgets = new Map<string, number>();
  const visit = (path: string): boolean => {
    const remaining = tree.maxEntries - usedEntries;
    if (remaining < 0 || budgets.has(path)) {
      return false;
    }
    budgets.set(path, remaining);
    usedEntries +=
      childDirectories.get(path)!.length + childFiles.get(path)!.length;
    if (usedEntries > tree.maxEntries) {
      return false;
    }
    for (const child of childDirectories.get(path)!) {
      if (usedEntries >= tree.maxEntries || !visit(child)) {
        return false;
      }
    }
    return true;
  };
  if (
    !visit(tree.root) ||
    budgets.size !== tree.directoryPaths.length ||
    usedEntries !== tree.directoryPaths.length + tree.filePaths.length
  ) {
    return null;
  }
  return budgets;
}

function isValidDerivedContextIdentity(
  value: unknown
): value is AuditDerivedContextIdentity {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    return false;
  }
  const entry = value as Partial<AuditDerivedContextIdentity>;
  return (
    hasExactKeys(value, DERIVED_CONTEXT_KEYS) &&
    Number.isFinite(entry.ctimeMs) &&
    hasUsablePhysicalIdentity(
      entry.dev ?? Number.NaN,
      entry.ino ?? Number.NaN
    ) &&
    entry.kind === "git-path-exposure" &&
    isNonNegativeSafeInteger(entry.mode ?? Number.NaN) &&
    Number.isFinite(entry.mtimeMs) &&
    isCanonicalAbsolutePath(entry.path) &&
    (entry.pathKind === "directory" || entry.pathKind === "file") &&
    typeof entry.sha256 === "string" &&
    SHA256_RE.test(entry.sha256) &&
    isNonNegativeSafeInteger(entry.size ?? Number.NaN)
  );
}

function isValidAbsentPathIdentity(
  value: unknown
): value is AuditAbsentPathIdentity {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    return false;
  }
  const entry = value as Partial<AuditAbsentPathIdentity>;
  if (
    !(
      hasExactKeys(value, ABSENT_PATH_KEYS) &&
      isCanonicalAbsolutePath(entry.path) &&
      isCanonicalAbsolutePath(entry.ancestorPath) &&
      hasUsablePhysicalIdentity(
        entry.ancestorDev ?? Number.NaN,
        entry.ancestorIno ?? Number.NaN
      ) &&
      Array.isArray(entry.lexicalChain) &&
      Array.isArray(entry.relativeSegments) &&
      isCanonicalAbsolutePath(entry.requestedPath)
    ) ||
    entry.relativeSegments.length === 0
  ) {
    return false;
  }
  if (
    entry.relativeSegments.some(
      (segment) =>
        typeof segment !== "string" ||
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\")
    )
  ) {
    return false;
  }
  return (
    normalize(join(entry.ancestorPath, ...entry.relativeSegments)) ===
      entry.path &&
    isContainedPath(entry.ancestorPath, entry.path) &&
    isValidLexicalPathChain(entry.lexicalChain, entry.requestedPath, false) &&
    entry.lexicalChain.length <
      lexicalPathPrefixes(entry.requestedPath).length &&
    JSON.stringify(
      lexicalPathPrefixes(entry.requestedPath)
        .slice(entry.lexicalChain.length)
        .map((path) => basename(path))
    ) === JSON.stringify(entry.relativeSegments)
  );
}

function isValidLexicalPathComponentIdentity(
  value: unknown
): value is AuditLexicalPathComponentIdentity {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    return false;
  }
  const entry = value as Partial<AuditLexicalPathComponentIdentity>;
  const linkTargetIsValid =
    entry.kind === "symlink"
      ? typeof entry.linkTarget === "string" && !entry.linkTarget.includes("\0")
      : entry.linkTarget === null;
  const generationIdentityIsValid =
    entry.kind === "symlink"
      ? typeof entry.birthtimeNs === "string" &&
        NON_NEGATIVE_DECIMAL_RE.test(entry.birthtimeNs) &&
        typeof entry.ctimeNs === "string" &&
        POSITIVE_DECIMAL_RE.test(entry.ctimeNs)
      : entry.birthtimeNs === null && entry.ctimeNs === null;
  return (
    hasExactKeys(value, LEXICAL_PATH_COMPONENT_KEYS) &&
    generationIdentityIsValid &&
    typeof entry.dev === "string" &&
    NON_NEGATIVE_DECIMAL_RE.test(entry.dev) &&
    typeof entry.ino === "string" &&
    POSITIVE_DECIMAL_RE.test(entry.ino) &&
    (entry.kind === "directory" ||
      entry.kind === "file" ||
      entry.kind === "symlink") &&
    linkTargetIsValid &&
    isCanonicalAbsolutePath(entry.path)
  );
}

function isValidLexicalPathChain(
  value: unknown[],
  requestedPath: string,
  complete: boolean
): value is AuditLexicalPathComponentIdentity[] {
  if (
    value.length === 0 ||
    value.length > MAX_LEXICAL_PATH_COMPONENTS ||
    !value.every(isValidLexicalPathComponentIdentity)
  ) {
    return false;
  }
  const prefixes = lexicalPathPrefixes(requestedPath);
  if (
    complete
      ? value.length !== prefixes.length
      : value.length >= prefixes.length
  ) {
    return false;
  }
  return value.every(
    (component, index) =>
      component.path === prefixes[index] &&
      (index === value.length - 1
        ? complete || component.kind !== "file"
        : component.kind !== "file")
  );
}

function isValidRequestedPathIdentity(
  value: unknown
): value is AuditRequestedPathIdentity {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    return false;
  }
  const entry = value as Partial<AuditRequestedPathIdentity>;
  return (
    hasExactKeys(value, REQUESTED_PATH_KEYS) &&
    isCanonicalAbsolutePath(entry.canonicalPath) &&
    hasUsablePhysicalIdentity(
      entry.dev ?? Number.NaN,
      entry.ino ?? Number.NaN
    ) &&
    (entry.kind === "directory" || entry.kind === "file") &&
    Array.isArray(entry.lexicalChain) &&
    isCanonicalAbsolutePath(entry.requestedPath) &&
    isValidLexicalPathChain(entry.lexicalChain, entry.requestedPath, true) &&
    entry.lexicalChain.at(-1)?.dev === String(entry.dev) &&
    entry.lexicalChain.at(-1)?.ino === String(entry.ino) &&
    entry.lexicalChain.at(-1)?.kind === entry.kind
  );
}

function hasCoherentPhysicalIdentities(snapshot: AuditSourceSnapshot): boolean {
  const identityToPath = new Map<string, string>();
  const pathToIdentity = new Map<string, string>();
  const register = (args: {
    dev: number;
    ino: number;
    kind: "directory" | "file";
    path: string;
  }): boolean => {
    const physicalIdentity = `${args.dev}\0${args.ino}`;
    const expectedPathIdentity = `${args.kind}\0${physicalIdentity}`;
    const identityPath = identityToPath.get(physicalIdentity);
    const existingPathIdentity = pathToIdentity.get(args.path);
    if (
      (identityPath !== undefined && identityPath !== args.path) ||
      (existingPathIdentity !== undefined &&
        existingPathIdentity !== expectedPathIdentity)
    ) {
      return false;
    }
    identityToPath.set(physicalIdentity, args.path);
    pathToIdentity.set(args.path, expectedPathIdentity);
    return true;
  };
  for (const root of snapshot.protectedRoots) {
    if (!register(root)) {
      return false;
    }
  }
  for (const file of snapshot.evaluatedFiles) {
    if (!register({ ...file, kind: "file" })) {
      return false;
    }
  }
  for (const directory of snapshot.evaluatedDirectories) {
    if (!register({ ...directory, kind: "directory" })) {
      return false;
    }
  }
  for (const context of snapshot.derivedContexts) {
    if (!register({ ...context, kind: context.pathKind })) {
      return false;
    }
  }
  for (const proof of snapshot.absentPaths) {
    if (
      !register({
        dev: proof.ancestorDev,
        ino: proof.ancestorIno,
        kind: "directory",
        path: proof.ancestorPath,
      })
    ) {
      return false;
    }
  }
  for (const binding of snapshot.requestedPaths) {
    if (
      !register({
        dev: binding.dev,
        ino: binding.ino,
        kind: binding.kind,
        path: binding.canonicalPath,
      })
    ) {
      return false;
    }
  }
  return true;
}

export async function validateAuditSourceSnapshot(
  snapshot: AuditSourceSnapshot,
  options?: { platform?: NodeJS.Platform }
): Promise<void> {
  assertAuditSourceSnapshot(snapshot);
  const platform = options?.platform ?? process.platform;
  const validateRequestedBinding = async (
    expected: AuditRequestedPathIdentity
  ): Promise<void> => {
    const lexicalChain = await captureStableAuditLexicalPathChain(
      expected.requestedPath
    ).catch(() => null);
    const actual = await captureStablePhysicalPathIdentity(
      expected.requestedPath,
      platform
    ).catch(() => null);
    if (
      !(actual && lexicalChain) ||
      JSON.stringify(lexicalChain) !== JSON.stringify(expected.lexicalChain) ||
      actual.path !== expected.canonicalPath ||
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino ||
      actual.kind !== expected.kind
    ) {
      throw new Error(
        `Audit requested path changed: ${expected.requestedPath}`
      );
    }
  };
  const validateRequestedBindings = async (): Promise<void> => {
    for (const expected of snapshot.requestedPaths) {
      await validateRequestedBinding(expected);
    }
  };
  const capturedTreeMemberPaths = new Set(
    snapshot.capturedTrees.flatMap((tree) => [
      ...tree.directoryPaths,
      ...tree.filePaths,
    ])
  );
  for (const expected of snapshot.requestedPaths) {
    // Strict trees must reserve and validate their complete manifests before
    // any member path is opened. The tree pass below revalidates these exact
    // lexical bindings after that reservation succeeds.
    if (!capturedTreeMemberPaths.has(expected.canonicalPath)) {
      await validateRequestedBinding(expected);
    }
  }
  const validateProtectedRoot = async (
    root: AuditProtectedRootIdentity
  ): Promise<void> => {
    const canonical = await realpath(root.path).catch(() => null);
    const pathMetadata = await lstat(root.path).catch(() => null);
    if (
      !pathMetadata ||
      pathMetadata.isSymbolicLink() ||
      canonical !== root.path
    ) {
      throw new Error(`Audit source root changed: ${root.path}`);
    }
    if (root.kind === "directory" && platform === "win32") {
      const after = await lstat(root.path).catch(() => null);
      const canonicalAfter = await realpath(root.path).catch(() => null);
      if (
        !after?.isDirectory() ||
        after.dev !== root.dev ||
        after.ino !== root.ino ||
        !sameFileMetadata(pathMetadata, after) ||
        canonicalAfter !== root.path
      ) {
        throw new Error(`Audit source root changed: ${root.path}`);
      }
      return;
    }
    const handle = await open(root.path, readOnlyNoFollowFlags()).catch(
      () => null
    );
    if (!handle) {
      throw new Error(`Audit source root changed: ${root.path}`);
    }
    try {
      const metadata = await handle.stat();
      const kind = metadata.isFile()
        ? "file"
        : metadata.isDirectory()
          ? "directory"
          : null;
      if (
        canonical !== root.path ||
        metadata.dev !== root.dev ||
        metadata.ino !== root.ino ||
        kind !== root.kind
      ) {
        throw new Error(`Audit source root changed: ${root.path}`);
      }
    } finally {
      await handle.close();
    }
  };
  const expectedFiles = new Map(
    snapshot.evaluatedFiles.map((identity) => [identity.path, identity])
  );
  const expectedDirectories = new Map(
    snapshot.evaluatedDirectories.map((identity) => [identity.path, identity])
  );
  const validatedFiles = new Set<string>();
  const validatedDirectories = new Set<string>();
  for (const expected of snapshot.capturedTrees) {
    const tracker = new AuditSourceTracker({ platform });
    await tracker.captureTree(expected.root, {
      maxAggregateBytes: expected.maxAggregateBytes,
      maxDepth: expected.maxDepth,
      maxEntries: expected.maxEntries,
      maxFileBytes: expected.maxFileBytes,
      maxRelativePathBytes: expected.maxRelativePathBytes,
      rejectUnsupportedEntries: expected.rejectUnsupportedEntries,
    });
    const actualSnapshot = tracker.snapshot();
    const actualTree = actualSnapshot.capturedTrees[0];
    if (
      !actualTree ||
      JSON.stringify(actualTree) !== JSON.stringify(expected)
    ) {
      throw new Error(`Audit captured tree changed: ${expected.root}`);
    }
    for (const binding of snapshot.requestedPaths) {
      if (
        expected.directoryPaths.includes(binding.canonicalPath) ||
        expected.filePaths.includes(binding.canonicalPath)
      ) {
        await validateRequestedBinding(binding);
      }
    }
    const actualFiles = new Map(
      actualSnapshot.evaluatedFiles.map((identity) => [identity.path, identity])
    );
    const actualDirectories = new Map(
      actualSnapshot.evaluatedDirectories.map((identity) => [
        identity.path,
        identity,
      ])
    );
    for (const path of expected.filePaths) {
      const expectedIdentity = expectedFiles.get(path);
      const actualIdentity = actualFiles.get(path);
      const identityMatches =
        expectedIdentity &&
        actualIdentity &&
        sameFileMetadata(expectedIdentity, actualIdentity) &&
        expectedIdentity.sha256 === actualIdentity.sha256;
      if (!identityMatches) {
        throw new Error(`Audit captured tree changed: ${expected.root}`);
      }
      validatedFiles.add(path);
    }
    for (const path of expected.directoryPaths) {
      const expectedIdentity = expectedDirectories.get(path);
      const actualIdentity = actualDirectories.get(path);
      const identityMatches =
        expectedIdentity &&
        actualIdentity &&
        sameDirectoryMetadata(expectedIdentity, actualIdentity) &&
        expectedIdentity.entriesSha256 === actualIdentity.entriesSha256;
      if (!identityMatches) {
        throw new Error(`Audit captured tree changed: ${expected.root}`);
      }
      validatedDirectories.add(path);
    }
  }
  // Strict-tree manifests must reserve their complete aggregate budget before
  // any overlapping protected child is opened independently.
  for (const root of snapshot.protectedRoots) {
    await validateProtectedRoot(root);
  }
  for (const expected of snapshot.evaluatedFiles) {
    if (validatedFiles.has(expected.path)) {
      continue;
    }
    const { identity } = await readStableRegularFile(expected.path, {
      maxBytes: Math.max(expected.size, 1),
    }).catch(() => ({
      identity: null,
    }));
    if (
      !identity ||
      identity.path !== expected.path ||
      !sameFileMetadata(identity, expected) ||
      identity.sha256 !== expected.sha256
    ) {
      throw new Error(`Audit evaluated context changed: ${expected.path}`);
    }
  }
  for (const expected of snapshot.evaluatedDirectories) {
    if (validatedDirectories.has(expected.path)) {
      continue;
    }
    const tracker = new AuditSourceTracker({ platform });
    const entries = await tracker
      .readDirectory(expected.path, { maxEntries: expected.maxEntries })
      .catch(() => null);
    const actual = tracker.snapshot().evaluatedDirectories[0];
    if (
      !(entries && actual) ||
      actual.path !== expected.path ||
      !sameDirectoryMetadata(actual, expected) ||
      actual.entriesSha256 !== expected.entriesSha256
    ) {
      throw new Error(`Audit evaluated directory changed: ${expected.path}`);
    }
  }
  for (const expected of snapshot.derivedContexts) {
    const expectedIdentity: StablePhysicalPathIdentity = {
      ctimeMs: expected.ctimeMs,
      dev: expected.dev,
      ino: expected.ino,
      kind: expected.pathKind,
      mode: expected.mode,
      mtimeMs: expected.mtimeMs,
      path: expected.path,
      size: expected.size,
    };
    const before = await captureStablePhysicalPathIdentity(
      expected.path,
      platform
    ).catch(() => null);
    if (!(before && samePhysicalPathIdentity(before, expectedIdentity))) {
      throw new Error(`Audit derived context changed: ${expected.path}`);
    }
    const value = await getGitPathExposure(expected.path);
    const after = await captureStablePhysicalPathIdentity(
      expected.path,
      platform
    ).catch(() => null);
    if (
      !(
        after &&
        samePhysicalPathIdentity(before, after) &&
        samePhysicalPathIdentity(after, expectedIdentity)
      ) ||
      digest(Buffer.from(JSON.stringify(value))) !== expected.sha256
    ) {
      throw new Error(`Audit derived context changed: ${expected.path}`);
    }
  }
  for (const proof of snapshot.absentPaths) {
    const currentProof = await canonicalAbsentPath(proof.requestedPath).catch(
      () => null
    );
    if (
      !currentProof ||
      JSON.stringify(currentProof) !== JSON.stringify(proof)
    ) {
      throw new Error(
        `Audit absent requested path changed: ${proof.requestedPath}`
      );
    }
    const ancestor = await lstat(proof.ancestorPath).catch(() => null);
    const ancestorCanonical = await realpath(proof.ancestorPath).catch(
      () => null
    );
    if (
      !ancestor?.isDirectory() ||
      ancestor.isSymbolicLink() ||
      ancestor.dev !== proof.ancestorDev ||
      ancestor.ino !== proof.ancestorIno ||
      ancestorCanonical !== proof.ancestorPath
    ) {
      throw new Error(
        `Audit context absent ancestor changed: ${proof.ancestorPath}`
      );
    }
    let current = proof.ancestorPath;
    let stillAbsent = false;
    for (let index = 0; index < proof.relativeSegments.length; index += 1) {
      current = join(current, proof.relativeSegments[index]!);
      const metadata = await lstat(current).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      });
      if (!metadata) {
        stillAbsent = true;
        break;
      }
      if (metadata.isSymbolicLink()) {
        throw new Error(
          `Audit context absent path became a symlink: ${current}`
        );
      }
      const isLast = index === proof.relativeSegments.length - 1;
      if (isLast) {
        throw new Error(
          `Audit context appeared after evaluation: ${proof.path}`
        );
      }
      if (!metadata.isDirectory()) {
        throw new Error(
          `Audit context absent path ancestor became non-directory: ${current}`
        );
      }
      const canonical = await realpath(current).catch(() => null);
      if (canonical !== current) {
        throw new Error(`Audit context absent path escaped: ${current}`);
      }
    }
    if (!stillAbsent) {
      throw new Error(`Audit context appeared after evaluation: ${proof.path}`);
    }
    const ancestorAfter = await lstat(proof.ancestorPath).catch(() => null);
    const ancestorCanonicalAfter = await realpath(proof.ancestorPath).catch(
      () => null
    );
    if (
      !ancestorAfter?.isDirectory() ||
      ancestorAfter.isSymbolicLink() ||
      ancestorAfter.dev !== proof.ancestorDev ||
      ancestorAfter.ino !== proof.ancestorIno ||
      ancestorCanonicalAfter !== proof.ancestorPath
    ) {
      throw new Error(
        `Audit context absent ancestor changed: ${proof.ancestorPath}`
      );
    }
    const finalProof = await canonicalAbsentPath(proof.requestedPath).catch(
      () => null
    );
    if (!finalProof || JSON.stringify(finalProof) !== JSON.stringify(proof)) {
      throw new Error(
        `Audit absent requested path changed: ${proof.requestedPath}`
      );
    }
  }
  await validateRequestedBindings();
}
