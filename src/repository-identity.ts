import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { withoutLocalGitEnvironment } from "./util/git-environment";

const SCP_REMOTE_RE = /^([^@/\s]+@)?([^:/\s]+):(.+)$/;
const GIT_PROTOCOL_PREFIX_RE = /^git\+/;
const GIT_SUFFIX_RE = /\.git\/?$/;
const TRAILING_SLASH_RE = /\/+$/;
const WHITESPACE_RE = /\s+/;
const WINDOWS_DRIVE_LOCAL_RE = /^[A-Za-z]:/;
const WINDOWS_UNC_LOCAL_RE = /^\\\\/;
const GIT_POINTER_MAX_BYTES = 4096;

export interface RepositoryIdentity {
  id: string;
  kind: "remote" | "root-commit" | "git-common-dir";
  fingerprint: string;
  stability: "portable" | "machine-local";
  aliases: RepositoryIdentityAlias[];
}

export interface RepositoryIdentityAlias {
  id: string;
  kind: "remote" | "root-commit" | "git-common-dir";
  fingerprint: string;
  stability: "portable" | "machine-local";
}

export interface RepositoryExecutionIdentity {
  id: string;
  fingerprint: string;
}

export interface RepositoryCommonDirectoryMetadata {
  birthtimeNs: bigint;
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function repositoryCommonDirectoryFingerprint(
  metadata: RepositoryCommonDirectoryMetadata
): string {
  if (metadata.birthtimeNs <= 0n) {
    throw new Error(
      "Unable to derive a safe Git common-directory creation identity because birth time is unavailable"
    );
  }
  return `v2:${metadata.dev}:${metadata.ino}:birth:${metadata.birthtimeNs}`;
}

export function normalizeRepositoryRemote(raw: string): string | null {
  const value = raw.trim();
  if (
    !value ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    WINDOWS_DRIVE_LOCAL_RE.test(value) ||
    WINDOWS_UNC_LOCAL_RE.test(value)
  ) {
    return null;
  }
  const scpMatch = value.includes("://") ? null : value.match(SCP_REMOTE_RE);
  if (scpMatch) {
    const usernameWithAt = scpMatch[1] ?? "";
    const username = usernameWithAt ? usernameWithAt.slice(0, -1) : "";
    const usernamePrefix =
      username && username !== "git" ? `${encodeURIComponent(username)}@` : "";
    const hostname = scpMatch[2]?.toLowerCase() ?? "";
    const pathname = `/${scpMatch[3] ?? ""}`
      .replace(GIT_SUFFIX_RE, "")
      .replace(TRAILING_SLASH_RE, "");
    return `${usernamePrefix}${hostname}${pathname}`;
  }
  const asUrl = value.replace(GIT_PROTOCOL_PREFIX_RE, "");
  try {
    const parsed = new URL(asUrl);
    if (parsed.protocol === "file:") {
      return null;
    }
    const normalizedSshUsername =
      parsed.protocol === "ssh:" && parsed.username
        ? decodeURIComponent(parsed.username)
        : "";
    const sshUsernameIdentity = encodeURIComponent(normalizedSshUsername);
    const sshUsername =
      normalizedSshUsername && normalizedSshUsername !== "git"
        ? `${sshUsernameIdentity}@`
        : "";
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname
      .replace(GIT_SUFFIX_RE, "")
      .replace(TRAILING_SLASH_RE, "");
    const port =
      parsed.port &&
      !(
        (parsed.protocol === "https:" && parsed.port === "443") ||
        (parsed.protocol === "http:" && parsed.port === "80") ||
        (parsed.protocol === "ssh:" && parsed.port === "22")
      )
        ? `:${parsed.port}`
        : "";
    return `${sshUsername}${parsed.hostname}${port}${parsed.pathname}`;
  } catch {
    return null;
  }
}

export function repositoryIdentityFromGitFacts(args: {
  commonDir?: string | null;
  commonDirMetadata?: RepositoryCommonDirectoryMetadata;
  originUrl?: string | null;
  projectRoot: string;
  remoteUrls?: string[];
  rootCommit?: string | null;
}): RepositoryIdentity {
  const normalizedOrigin = args.originUrl
    ? normalizeRepositoryRemote(args.originUrl)
    : null;
  const normalizedRemotes = [
    ...new Set(
      [
        normalizedOrigin,
        ...(args.remoteUrls ?? []).map(normalizeRepositoryRemote),
      ]
        .filter((value): value is string => value !== null)
        .sort()
    ),
  ];
  const rootCommit = args.rootCommit
    ?.split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .sort()[0];
  const commonPath = resolve(args.projectRoot, args.commonDir || ".git");
  let commonDirectoryMetadata = args.commonDirMetadata;
  if (!commonDirectoryMetadata) {
    let metadata: BigIntStats;
    try {
      metadata = lstatSync(commonPath, { bigint: true });
    } catch {
      throw new Error(
        "Unable to inspect the Git common directory for repository identity"
      );
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("The Git common directory is unsafe");
    }
    commonDirectoryMetadata = metadata;
  }
  const commonFingerprint = repositoryCommonDirectoryFingerprint(
    commonDirectoryMetadata
  );
  const commonAlias: RepositoryIdentityAlias = {
    id: `repo_${sha256(`git-common-dir:${commonFingerprint}`).slice(0, 24)}`,
    kind: "git-common-dir",
    fingerprint: sha256(commonFingerprint),
    stability: "machine-local",
  };
  const primaryRemoteValue =
    normalizedOrigin ??
    (normalizedRemotes.length === 1
      ? normalizedRemotes[0]
      : normalizedRemotes.length > 1
        ? `set:${normalizedRemotes.join("\n")}`
        : null);
  const primaryRemote: RepositoryIdentityAlias | null = primaryRemoteValue
    ? {
        id: `repo_${sha256(`remote:${primaryRemoteValue}`).slice(0, 24)}`,
        kind: "remote",
        fingerprint: primaryRemoteValue,
        stability: "portable",
      }
    : null;
  const rootAlias: RepositoryIdentityAlias | null = rootCommit
    ? {
        id: `repo_${sha256(`root-commit:${rootCommit}`).slice(0, 24)}`,
        kind: "root-commit",
        fingerprint: rootCommit,
        stability: "portable",
      }
    : null;
  if (primaryRemote) {
    return {
      ...primaryRemote,
      aliases: [rootAlias, commonAlias].filter(
        (alias): alias is RepositoryIdentityAlias => alias !== null
      ),
    };
  }
  if (rootAlias) {
    return {
      ...commonAlias,
      aliases: [rootAlias],
    };
  }

  return {
    ...commonAlias,
    aliases: [],
  };
}

function readGitRemoteUrls(projectRoot: string): string[] {
  const output = readGit(projectRoot, [
    "config",
    "--get-regexp",
    "^remote\\..*\\.url$",
  ]);
  if (!output) {
    return [];
  }
  return output
    .split("\n")
    .map((line) => line.trim().split(WHITESPACE_RE, 2)[1] ?? "")
    .filter(Boolean);
}

export function repositoryIdentityAliasForPrimary(
  identity: RepositoryIdentity
): RepositoryIdentityAlias {
  return {
    id: identity.id,
    kind: identity.kind,
    fingerprint: identity.fingerprint,
    stability: identity.stability,
  };
}

export function canonicalRepositoryPath(
  projectRoot: string,
  platform: NodeJS.Platform = process.platform
): string {
  const canonical = realpathSync.native(resolve(projectRoot));
  return repositoryPathComparisonKey(canonical, platform);
}

export function repositoryPathComparisonKey(
  canonicalPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  return platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
}

function pointerMetadataMatches(
  left: BigIntStats,
  right: BigIntStats
): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.nlink === 1n &&
    right.nlink === 1n &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

function readBoundedRegularFileSync(
  pathValue: string
): { contents: string; metadata: BigIntStats } | null {
  let before: BigIntStats;
  try {
    before = lstatSync(pathValue, { bigint: true });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : null;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size <= 0n ||
    before.size > BigInt(GIT_POINTER_MAX_BYTES) ||
    !constants.O_NOFOLLOW
  ) {
    throw new Error(`Refusing unsafe Git pointer file: ${pathValue}`);
  }
  const descriptor = openSync(
    pathValue,
    constants.O_RDONLY + constants.O_NOFOLLOW + (constants.O_NONBLOCK ?? 0)
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!pointerMetadataMatches(before, opened)) {
      throw new Error(`Git pointer changed before read: ${pathValue}`);
    }
    const contents = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < contents.length) {
      const count = readSync(
        descriptor,
        contents,
        offset,
        contents.length - offset,
        offset
      );
      if (count === 0) {
        throw new Error(`Git pointer changed during read: ${pathValue}`);
      }
      offset += count;
    }
    const trailing = Buffer.alloc(1);
    if (readSync(descriptor, trailing, 0, 1, contents.length) !== 0) {
      throw new Error(`Git pointer changed during read: ${pathValue}`);
    }
    const [afterRead, rebound] = [
      fstatSync(descriptor, { bigint: true }),
      lstatSync(pathValue, { bigint: true }),
    ];
    if (
      rebound.isSymbolicLink() ||
      !pointerMetadataMatches(opened, afterRead) ||
      !pointerMetadataMatches(afterRead, rebound)
    ) {
      throw new Error(`Git pointer changed during read: ${pathValue}`);
    }
    return {
      contents: contents.toString("utf8"),
      metadata: afterRead,
    };
  } finally {
    closeSync(descriptor);
  }
}

/** Checkout identity for receipts and coordination; the worktree_ prefix also applies to primary checkouts. */
export function repositoryExecutionIdentity(
  projectRoot: string
): RepositoryExecutionIdentity {
  const canonicalRoot = canonicalRepositoryPath(projectRoot);
  const dotGitPath = join(canonicalRoot, ".git");
  const dotGit = lstatSync(dotGitPath, { bigint: true });
  let gitDirectoryPath: string;
  let executionMetadata: BigIntStats;
  if (dotGit.isDirectory() && !dotGit.isSymbolicLink()) {
    gitDirectoryPath = dotGitPath;
    executionMetadata = dotGit;
  } else if (dotGit.isFile() && !dotGit.isSymbolicLink() && dotGit.size > 0n) {
    const pointerFile = readBoundedRegularFileSync(dotGitPath);
    const pointer = pointerFile?.contents.trim() ?? "";
    if (!pointer.startsWith("gitdir:")) {
      throw new Error(
        "Unable to derive a safe worktree Git-directory identity"
      );
    }
    const target = pointer.slice("gitdir:".length).trim();
    if (!target || target.includes("\0")) {
      throw new Error(
        "Unable to derive a safe worktree Git-directory identity"
      );
    }
    gitDirectoryPath = realpathSync.native(
      resolve(dirname(dotGitPath), target)
    );
    if (!pointerFile) {
      throw new Error("Unable to read the worktree Git-directory pointer");
    }
    executionMetadata = pointerFile.metadata;
  } else {
    throw new Error("Unable to derive a safe worktree Git-directory identity");
  }
  const gitDirectory = lstatSync(gitDirectoryPath, { bigint: true });
  if (gitDirectory.isSymbolicLink() || !gitDirectory.isDirectory()) {
    throw new Error("The worktree Git directory is unsafe");
  }
  const checkoutFingerprint =
    repositoryCommonDirectoryFingerprint(executionMetadata);
  const gitDirectoryFingerprint =
    repositoryCommonDirectoryFingerprint(gitDirectory);
  if (dotGit.isDirectory() && checkoutFingerprint !== gitDirectoryFingerprint) {
    throw new Error("The checkout Git directory changed during inspection");
  }
  const source = `${checkoutFingerprint}\n${gitDirectoryFingerprint}`;
  return {
    id: `worktree_${sha256(`git-dir:${source}`).slice(0, 24)}`,
    fingerprint: sha256(`git-dir:${source}`),
  };
}

function readGit(projectRoot: string, argv: string[]): string | null {
  const result = spawnSync("git", ["-C", projectRoot, ...argv], {
    encoding: "utf8",
    env: {
      ...withoutLocalGitEnvironment(process.env),
      GIT_OPTIONAL_LOCKS: "0",
    },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return null;
  }
  return result.stdout.trim() || null;
}

export function hasGitMetadataAbove(projectRoot: string): boolean {
  let current = resolve(projectRoot);
  for (;;) {
    try {
      lstatSync(join(current, ".git"));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

/** Resolve durable project authority through Git's common directory, never a remote URL. */
export function canonicalProjectRoot(projectRoot: string): string {
  const requested = resolve(projectRoot);
  if (!hasGitMetadataAbove(requested)) {
    return requested;
  }
  const facts = readGit(requested, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
    "--show-toplevel",
  ])?.split("\n");
  if (!facts) {
    throw new Error(
      `Cannot safely resolve canonical repository for ${requested}: Git metadata is unavailable or invalid`
    );
  }
  const [gitDir, commonDir, topLevel] = facts;
  if (
    facts.length !== 3 ||
    !gitDir ||
    !commonDir ||
    !topLevel ||
    !facts.every(isAbsolute)
  ) {
    throw new Error(
      `Cannot safely resolve canonical repository for ${requested}: unexpected Git paths`
    );
  }
  for (const path of [gitDir, commonDir]) {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(
        `Cannot safely resolve canonical repository: unsafe Git directory ${path}`
      );
    }
  }
  // Validate the checkout pointer with the same bounded, no-follow reader used by receipts.
  repositoryExecutionIdentity(topLevel);
  const common = realpathSync.native(commonDir);
  if (realpathSync.native(gitDir) === common) {
    return realpathSync.native(requested);
  }
  const checkoutPointer = readBoundedRegularFileSync(join(gitDir, "gitdir"));
  if (
    dirname(realpathSync.native(gitDir)) !== join(common, "worktrees") ||
    !checkoutPointer ||
    canonicalRepositoryPath(
      resolve(gitDir, checkoutPointer.contents.trim())
    ) !== canonicalRepositoryPath(join(topLevel, ".git"))
  ) {
    throw new Error(
      `Cannot safely resolve canonical repository for ${requested}: linked checkout is not registered in the Git common directory`
    );
  }
  const configuredWorktree = readGit(requested, [
    "config",
    "--get",
    "core.worktree",
  ]);
  const primary =
    basename(common) === ".git"
      ? dirname(common)
      : configuredWorktree
        ? resolve(common, configuredWorktree)
        : null;
  const primaryFacts = primary
    ? readGit(primary, [
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
        "--git-common-dir",
        "--show-toplevel",
      ])?.split("\n")
    : null;
  if (
    !primary ||
    primaryFacts?.length !== 3 ||
    primaryFacts.some((path) => !isAbsolute(path)) ||
    realpathSync.native(primaryFacts[0]!) !== common ||
    realpathSync.native(primaryFacts[1]!) !== common ||
    canonicalRepositoryPath(primaryFacts[2]!) !==
      canonicalRepositoryPath(primary)
  ) {
    throw new Error(
      `Cannot safely resolve canonical repository for ${requested}: primary checkout is missing or does not share the Git common directory`
    );
  }
  repositoryExecutionIdentity(primary);
  return join(
    realpathSync.native(primary),
    relative(realpathSync.native(topLevel), realpathSync.native(requested))
  );
}

export function resolveRepositoryIdentitySync(
  projectRoot: string
): RepositoryIdentity | null {
  const topLevel = readGit(projectRoot, ["rev-parse", "--show-toplevel"]);
  if (
    !topLevel ||
    canonicalRepositoryPath(topLevel) !== canonicalRepositoryPath(projectRoot)
  ) {
    return null;
  }
  return repositoryIdentityFromGitFacts({
    projectRoot,
    originUrl: readGit(projectRoot, ["remote", "get-url", "origin"]),
    remoteUrls: readGitRemoteUrls(projectRoot),
    rootCommit: readGit(projectRoot, ["rev-list", "--max-parents=0", "HEAD"]),
    commonDir: readGit(projectRoot, ["rev-parse", "--git-common-dir"]),
  });
}

export function repositoryCommonIdentitySync(
  projectRoot: string
): RepositoryIdentity | null {
  if (!hasGitMetadataAbove(projectRoot)) {
    return null;
  }
  const [commonDir, topLevel] =
    readGit(projectRoot, [
      "rev-parse",
      "--git-common-dir",
      "--show-toplevel",
    ])?.split("\n") ?? [];
  if (
    !topLevel ||
    canonicalRepositoryPath(topLevel) !== canonicalRepositoryPath(projectRoot)
  ) {
    return null;
  }
  return commonDir
    ? repositoryIdentityFromGitFacts({ projectRoot, commonDir })
    : null;
}

export function resolveRepositoryExecutionIdentitySync(
  projectRoot: string
): RepositoryExecutionIdentity | null {
  const identity = resolveRepositoryIdentitySync(projectRoot);
  if (!identity) {
    return null;
  }
  return repositoryExecutionIdentity(projectRoot);
}
