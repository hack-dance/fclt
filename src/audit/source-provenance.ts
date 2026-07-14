import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
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
  schemaVersion: 4;
  protectedRoots: AuditProtectedRootIdentity[];
  evaluatedFiles: AuditEvaluatedFileIdentity[];
  evaluatedDirectories: AuditEvaluatedDirectoryIdentity[];
  capturedTrees: AuditCapturedTreeIdentity[];
  derivedContexts: AuditDerivedContextIdentity[];
  absentPaths: AuditAbsentPathIdentity[];
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
  path: string;
  relativeSegments: string[];
}

export interface AuditDerivedContextIdentity {
  kind: "git-path-exposure";
  path: string;
  sha256: string;
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

function isContainedPath(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
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

async function canonicalAbsentPath(
  pathValue: string
): Promise<AuditAbsentPathIdentity> {
  const requested = normalize(resolve(pathValue));
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
      return {
        ancestorDev: metadata.dev,
        ancestorIno: metadata.ino,
        ancestorPath: canonicalAncestor,
        path: normalize(join(canonicalAncestor, ...relativeSegments)),
        relativeSegments,
      };
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
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs
  );
}

async function readStableRegularFile(
  pathValue: string,
  options?: {
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

  readonly #platform: NodeJS.Platform;

  readonly #beforeReadChunk?: (args: {
    bytesRead: number;
    path: string;
  }) => Promise<void>;

  constructor(options?: {
    beforeReadChunk?: (args: {
      bytesRead: number;
      path: string;
    }) => Promise<void>;
    platform?: NodeJS.Platform;
  }) {
    this.#beforeReadChunk = options?.beforeReadChunk;
    this.#platform = options?.platform ?? process.platform;
  }

  async protect(paths: string[]): Promise<void> {
    for (const pathValue of paths) {
      if (!isAbsolute(pathValue)) {
        continue;
      }
      const requested = normalize(pathValue);
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
        this.#protectedRoots.set(canonical, {
          dev: after.dev,
          ino: after.ino,
          kind: "directory",
          path: canonical,
        });
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
        this.#protectedRoots.set(canonical, {
          dev: metadata.dev,
          ino: metadata.ino,
          kind,
          path: canonical,
        });
      } finally {
        await handle.close();
      }
    }
  }

  async read(
    pathValue: string,
    options?: { maxBytes?: number }
  ): Promise<Buffer> {
    const { bytes, identity } = await readStableRegularFile(pathValue, {
      beforeReadChunk: this.#beforeReadChunk,
      maxBytes: options?.maxBytes,
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
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(requested);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const proof = await canonicalAbsentPath(requested);
        this.#absentPaths.set(proof.path, proof);
        return;
      }
      throw error;
    }
    if (metadata.isFile()) {
      await this.read(requested);
      return;
    }
    if (metadata.isDirectory()) {
      await this.readDirectory(requested);
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
    try {
      return await this.readText(requested);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const proof = await canonicalAbsentPath(requested);
      this.#absentPaths.set(proof.path, proof);
      return null;
    }
  }

  async readDirectory(
    pathValue: string,
    options?: { maxEntries?: number }
  ): Promise<Dirent[] | null> {
    const requested = normalize(resolve(pathValue));
    let before: Awaited<ReturnType<typeof lstat>>;
    try {
      before = await lstat(requested);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const proof = await canonicalAbsentPath(requested);
        this.#absentPaths.set(proof.path, proof);
        return null;
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
    let aggregateBytes = 0;
    let visited = 1;

    const visit = async (
      directory: string,
      relativeDirectory: string,
      depth: number
    ): Promise<void> => {
      if (depth > maxDepth) {
        throw new Error(`Audit discovery tree exceeds depth limit: ${root}`);
      }
      const remainingEntries = maxEntries - visited;
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
      for (const entry of entries) {
        visited += 1;
        if (visited > maxEntries) {
          throw new Error(
            `Audit discovery tree exceeds entry limit: ${pathValue}`
          );
        }
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
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          await visit(entryPath, relativePath, depth + 1);
          continue;
        }
        if (entry.isSymbolicLink() || !entry.isFile()) {
          if (!strict) {
            continue;
          }
          throw new Error(
            `Audit discovery tree has an unsupported entry: ${entryPath}`
          );
        }
        if (strict) {
          const remainingBytes = maxAggregateBytes - aggregateBytes;
          if (remainingBytes < 0) {
            throw new Error(
              `Audit discovery tree exceeds aggregate byte limit: ${root}`
            );
          }
          const bytes = await this.read(entryPath, {
            maxBytes: Math.min(maxFileBytes, remainingBytes),
          });
          filePaths.add(await realpath(entryPath));
          aggregateBytes += bytes.byteLength;
          if (aggregateBytes > maxAggregateBytes) {
            throw new Error(
              `Audit discovery tree exceeds aggregate byte limit: ${root}`
            );
          }
        }
      }
    };

    if (visited > maxEntries) {
      throw new Error(`Audit discovery tree exceeds entry limit: ${root}`);
    }
    await visit(root, "", 0);
    if (!strict) {
      return;
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
    this.#capturedTrees.set(
      [
        canonicalRoot,
        maxEntries,
        maxAggregateBytes,
        maxDepth,
        maxFileBytes,
        maxRelativePathBytes,
      ].join("\0"),
      treeIdentity
    );
  }

  recordGitPathExposure(pathValue: string, value: unknown): void {
    const path = normalize(resolve(pathValue));
    this.#derivedContexts.set(`git-path-exposure\0${path}`, {
      kind: "git-path-exposure",
      path,
      sha256: digest(Buffer.from(JSON.stringify(value))),
    });
  }

  snapshot(): AuditSourceSnapshot {
    return {
      schemaVersion: 4,
      protectedRoots: [...this.#protectedRoots.values()].sort((a, b) =>
        a.path.localeCompare(b.path)
      ),
      // Preserve first-read order: this is the order in which bytes entered evaluation.
      evaluatedFiles: [...this.#evaluatedFiles.values()],
      evaluatedDirectories: [...this.#evaluatedDirectories.values()],
      capturedTrees: [...this.#capturedTrees.values()].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      ),
      derivedContexts: [...this.#derivedContexts.values()].sort((a, b) =>
        a.path.localeCompare(b.path)
      ),
      absentPaths: [...this.#absentPaths.values()].sort((a, b) =>
        a.path.localeCompare(b.path)
      ),
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
  const snapshot = value as Partial<AuditSourceSnapshot> | null;
  if (
    !snapshot ||
    snapshot.schemaVersion !== 4 ||
    !Array.isArray(snapshot.protectedRoots) ||
    !Array.isArray(snapshot.evaluatedFiles) ||
    !Array.isArray(snapshot.evaluatedDirectories) ||
    !Array.isArray(snapshot.capturedTrees) ||
    !Array.isArray(snapshot.derivedContexts) ||
    !Array.isArray(snapshot.absentPaths) ||
    snapshot.protectedRoots.some(
      (entry) =>
        !(
          entry &&
          typeof entry === "object" &&
          isAbsolute(entry.path) &&
          Number.isFinite(entry.dev) &&
          Number.isFinite(entry.ino)
        ) ||
        (entry.kind !== "directory" && entry.kind !== "file")
    ) ||
    snapshot.evaluatedFiles.some(
      (entry) =>
        !(
          entry &&
          typeof entry === "object" &&
          isAbsolute(entry.path) &&
          Number.isFinite(entry.ctimeMs) &&
          Number.isFinite(entry.dev) &&
          Number.isFinite(entry.ino) &&
          Number.isFinite(entry.mode) &&
          Number.isFinite(entry.mtimeMs) &&
          Number.isFinite(entry.size) &&
          SHA256_RE.test(entry.sha256)
        )
    ) ||
    snapshot.evaluatedDirectories.some(
      (entry) =>
        !(
          entry &&
          typeof entry === "object" &&
          isAbsolute(entry.path) &&
          Number.isFinite(entry.ctimeMs) &&
          Number.isFinite(entry.dev) &&
          Number.isFinite(entry.ino) &&
          isNonNegativeSafeInteger(entry.maxEntries) &&
          Number.isFinite(entry.mode) &&
          Number.isFinite(entry.mtimeMs) &&
          SHA256_RE.test(entry.entriesSha256)
        )
    ) ||
    snapshot.capturedTrees.some((entry) =>
      isInvalidCapturedTreeIdentity(
        entry,
        snapshot.evaluatedFiles as AuditEvaluatedFileIdentity[],
        snapshot.evaluatedDirectories as AuditEvaluatedDirectoryIdentity[]
      )
    ) ||
    snapshot.derivedContexts.some(
      (entry) =>
        !(entry && typeof entry === "object") ||
        entry.kind !== "git-path-exposure" ||
        !isAbsolute(entry.path) ||
        !SHA256_RE.test(entry.sha256)
    ) ||
    snapshot.absentPaths.some((entry) => !isValidAbsentPathIdentity(entry))
  ) {
    throw new Error("Audit source snapshot schema is unsupported");
  }
}

function isInvalidCapturedTreeIdentity(
  value: unknown,
  evaluatedFiles: AuditEvaluatedFileIdentity[],
  evaluatedDirectories: AuditEvaluatedDirectoryIdentity[]
): boolean {
  if (
    !(
      value &&
      typeof value === "object" &&
      hasExactKeys(value, CAPTURED_TREE_KEYS)
    )
  ) {
    return true;
  }
  const entry = value as Partial<AuditCapturedTreeIdentity>;
  if (
    typeof entry.root !== "string" ||
    !isAbsolute(entry.root) ||
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
      STRICT_CAPTURE_TREE_LIMITS.maxRelativePathBytes
  ) {
    return true;
  }
  const contract = entry as AuditCapturedTreeIdentity;
  const fileIdentities = new Map(
    evaluatedFiles.map((identity) => [identity.path, identity])
  );
  const directoryPaths = new Set(
    evaluatedDirectories.map((identity) => identity.path)
  );
  const allPaths = [...contract.directoryPaths, ...contract.filePaths];
  if (
    contract.directoryPaths.length + contract.filePaths.length >
      contract.maxEntries ||
    !contract.directoryPaths.includes(contract.root) ||
    new Set(allPaths).size !== allPaths.length ||
    !isSortedUniqueStringArray(contract.directoryPaths) ||
    !isSortedUniqueStringArray(contract.filePaths) ||
    contract.directoryPaths.some((path) => !directoryPaths.has(path)) ||
    contract.filePaths.some((path) => !fileIdentities.has(path))
  ) {
    return true;
  }
  let aggregateBytes = 0;
  for (const path of allPaths) {
    if (!(isAbsolute(path) && isContainedPath(contract.root, path))) {
      return true;
    }
    const relativePath = relative(contract.root, path);
    if (
      Buffer.byteLength(relativePath, "utf8") > contract.maxRelativePathBytes
    ) {
      return true;
    }
    const segments = relativePath ? relativePath.split(sep) : [];
    const depth = fileIdentities.has(path)
      ? Math.max(segments.length - 1, 0)
      : segments.length;
    if (depth > contract.maxDepth) {
      return true;
    }
    const file = fileIdentities.get(path);
    if (file) {
      if (file.size > contract.maxFileBytes) {
        return true;
      }
      aggregateBytes += file.size;
      if (aggregateBytes > contract.maxAggregateBytes) {
        return true;
      }
    }
  }
  return false;
}

function isValidAbsentPathIdentity(
  value: unknown
): value is AuditAbsentPathIdentity {
  if (!(value && typeof value === "object")) {
    return false;
  }
  const entry = value as Partial<AuditAbsentPathIdentity>;
  if (
    typeof entry.path !== "string" ||
    typeof entry.ancestorPath !== "string" ||
    !isAbsolute(entry.path) ||
    !isAbsolute(entry.ancestorPath) ||
    !Number.isFinite(entry.ancestorDev) ||
    !Number.isFinite(entry.ancestorIno) ||
    !Array.isArray(entry.relativeSegments) ||
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
    entry.path
  );
}

export async function validateAuditSourceSnapshot(
  snapshot: AuditSourceSnapshot,
  options?: { platform?: NodeJS.Platform }
): Promise<void> {
  assertAuditSourceSnapshot(snapshot);
  const platform = options?.platform ?? process.platform;
  for (const root of snapshot.protectedRoots) {
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
      continue;
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
  }
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
      actual.ctimeMs !== expected.ctimeMs ||
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino ||
      actual.mode !== expected.mode ||
      actual.mtimeMs !== expected.mtimeMs ||
      actual.entriesSha256 !== expected.entriesSha256
    ) {
      throw new Error(`Audit evaluated directory changed: ${expected.path}`);
    }
  }
  for (const expected of snapshot.derivedContexts) {
    const value = await getGitPathExposure(expected.path);
    if (digest(Buffer.from(JSON.stringify(value))) !== expected.sha256) {
      throw new Error(`Audit derived context changed: ${expected.path}`);
    }
  }
  for (const proof of snapshot.absentPaths) {
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
  }
}
