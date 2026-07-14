import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
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
  dev: number;
  ino: number;
  mtimeMs: number;
  path: string;
  sha256: string;
  size: number;
}

export interface AuditSourceSnapshot {
  schemaVersion: 1;
  protectedRoots: AuditProtectedRootIdentity[];
  evaluatedFiles: AuditEvaluatedFileIdentity[];
  evaluatedDirectories: AuditEvaluatedDirectoryIdentity[];
  derivedContexts: AuditDerivedContextIdentity[];
  absentPaths: string[];
}

export interface AuditDerivedContextIdentity {
  kind: "git-path-exposure";
  path: string;
  sha256: string;
}

export interface AuditEvaluatedDirectoryIdentity {
  dev: number;
  entriesSha256: string;
  ino: number;
  mtimeMs: number;
  path: string;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readOnlyNoFollowFlags(): number {
  return constants.O_RDONLY + (constants.O_NOFOLLOW ?? 0);
}

async function canonicalAbsentPath(pathValue: string): Promise<string> {
  const requested = normalize(resolve(pathValue));
  const suffix: string[] = [];
  let ancestor = requested;
  while (true) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      return normalize(join(canonicalAncestor, ...suffix.reverse()));
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
  left: { dev: number; ino: number; mtimeMs: number; size: number },
  right: { dev: number; ino: number; mtimeMs: number; size: number }
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size
  );
}

async function readStableRegularFile(
  pathValue: string
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
    const bytes = await handle.readFile();
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
        dev: after.dev,
        ino: after.ino,
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
  readonly #absentPaths = new Set<string>();
  readonly #evaluatedFiles = new Map<string, AuditEvaluatedFileIdentity>();
  readonly #evaluatedDirectories = new Map<
    string,
    AuditEvaluatedDirectoryIdentity
  >();
  readonly #derivedContexts = new Map<string, AuditDerivedContextIdentity>();
  readonly #protectedRoots = new Map<string, AuditProtectedRootIdentity>();

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
      const handle = await open(requested, readOnlyNoFollowFlags());
      try {
        const metadata = await handle.stat();
        const kind = metadata.isFile()
          ? "file"
          : metadata.isDirectory()
            ? "directory"
            : null;
        if (!kind) {
          throw new Error(
            `Audited source root has an unsupported file type: ${canonical}`
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

  async read(pathValue: string): Promise<Buffer> {
    const { bytes, identity } = await readStableRegularFile(pathValue);
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
        this.#absentPaths.add(await canonicalAbsentPath(requested));
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

  async readText(pathValue: string): Promise<string> {
    return (await this.read(pathValue)).toString("utf8");
  }

  async readOptionalText(pathValue: string): Promise<string | null> {
    const requested = normalize(resolve(pathValue));
    try {
      return await this.readText(requested);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.#absentPaths.add(await canonicalAbsentPath(requested));
      return null;
    }
  }

  async readDirectory(pathValue: string): Promise<Dirent[] | null> {
    const requested = normalize(resolve(pathValue));
    let before: Awaited<ReturnType<typeof lstat>>;
    try {
      before = await lstat(requested);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#absentPaths.add(await canonicalAbsentPath(requested));
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
    if (process.platform === "win32") {
      // Windows cannot portably open directory descriptors. Persistence is
      // disabled there, but read-only evaluation still binds a before/after
      // directory identity and fails if discovery changes.
      canonical = await realpath(requested);
      entries = (await readdir(requested, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name)
      );
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
        entries = (await readdir(requested, { withFileTypes: true })).sort(
          (a, b) => a.name.localeCompare(b.name)
        );
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
    const entriesSha256 = digest(
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
    const identity = {
      dev: after.dev,
      entriesSha256,
      ino: after.ino,
      mtimeMs: after.mtimeMs,
      path: canonical,
    };
    const existing = this.#evaluatedDirectories.get(canonical);
    if (
      existing &&
      (existing.dev !== identity.dev ||
        existing.ino !== identity.ino ||
        existing.mtimeMs !== identity.mtimeMs ||
        existing.entriesSha256 !== entriesSha256)
    ) {
      throw new Error(`Audit directory changed between reads: ${canonical}`);
    }
    this.#evaluatedDirectories.set(canonical, identity);
    return entries;
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
      schemaVersion: 1,
      protectedRoots: [...this.#protectedRoots.values()].sort((a, b) =>
        a.path.localeCompare(b.path)
      ),
      // Preserve first-read order: this is the order in which bytes entered evaluation.
      evaluatedFiles: [...this.#evaluatedFiles.values()],
      evaluatedDirectories: [...this.#evaluatedDirectories.values()],
      derivedContexts: [...this.#derivedContexts.values()].sort((a, b) =>
        a.path.localeCompare(b.path)
      ),
      absentPaths: [...this.#absentPaths].sort(),
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
    snapshot.schemaVersion !== 1 ||
    !Array.isArray(snapshot.protectedRoots) ||
    !Array.isArray(snapshot.evaluatedFiles) ||
    !Array.isArray(snapshot.evaluatedDirectories) ||
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
          Number.isFinite(entry.dev) &&
          Number.isFinite(entry.ino) &&
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
          Number.isFinite(entry.dev) &&
          Number.isFinite(entry.ino) &&
          Number.isFinite(entry.mtimeMs) &&
          SHA256_RE.test(entry.entriesSha256)
        )
    ) ||
    snapshot.derivedContexts.some(
      (entry) =>
        !(entry && typeof entry === "object") ||
        entry.kind !== "git-path-exposure" ||
        !isAbsolute(entry.path) ||
        !SHA256_RE.test(entry.sha256)
    ) ||
    snapshot.absentPaths.some((entry) => !isAbsolute(entry))
  ) {
    throw new Error("Audit source snapshot schema is unsupported");
  }
}

export async function validateAuditSourceSnapshot(
  snapshot: AuditSourceSnapshot
): Promise<void> {
  assertAuditSourceSnapshot(snapshot);
  for (const root of snapshot.protectedRoots) {
    const canonical = await realpath(root.path).catch(() => null);
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
  for (const expected of snapshot.evaluatedFiles) {
    const { identity } = await readStableRegularFile(expected.path).catch(
      () => ({
        identity: null,
      })
    );
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
    const tracker = new AuditSourceTracker();
    const entries = await tracker
      .readDirectory(expected.path)
      .catch(() => null);
    const actual = tracker.snapshot().evaluatedDirectories[0];
    if (
      !(entries && actual) ||
      actual.path !== expected.path ||
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino ||
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
  for (const pathValue of snapshot.absentPaths) {
    const metadata = await lstat(pathValue).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (metadata) {
      throw new Error(`Audit context appeared after evaluation: ${pathValue}`);
    }
  }
}
