import { AsyncLocalStorage } from "node:async_hooks";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  readFileSync,
  readSync,
  type Stats,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
  AiDirectoryBoundary,
  aiPathWithin,
  sameAiIdentity,
} from "./ai-boundary";
import {
  aiPathSafetyIssue,
  allowEphemeralAiPaths,
  realUserHome,
} from "./ai-path-guard";
import {
  absoluteFilesystemPath,
  facultAiEvolutionReviewDir,
  facultAiRuntimeScopeDir,
  facultAiStateDir,
  facultAiWritebackReviewDir,
  facultMachineStateDir,
  preferredGlobalAiRoot,
  projectRootFromAiRoot,
  resolvePhysicalPath,
} from "./paths";

interface MutationScope {
  homeDir: string;
  allowEphemeral: boolean;
  boundaries: Map<string, AiDirectoryBoundary>;
  roots: string[];
  anchors: string[];
  rootDir?: string;
}
// Legacy sequential ids (WB-00001) and dated ids (WB-20261030-7K2M9QXA).
const WRITEBACK_ID_RE = /^WB-(?:[0-9]+|[0-9]{8}-[0-9A-HJKMNP-TV-Z]{8})$/;
const PROPOSAL_ID_RE = /^EV-(?:[0-9]+|[0-9]{8}-[0-9A-HJKMNP-TV-Z]{8})$/;
const mutationScope = new AsyncLocalStorage<MutationScope>();

export function needsAiMutationScope(args: {
  rootDir?: string;
  homeDir: string;
  allowEphemeral?: boolean;
}): boolean {
  const current = mutationScope.getStore();
  return (
    !current ||
    current.homeDir !== args.homeDir ||
    (args.rootDir !== undefined && current.rootDir !== args.rootDir) ||
    (args.allowEphemeral !== undefined &&
      current.allowEphemeral !== args.allowEphemeral)
  );
}

export async function withAiMutationScope<T>(
  args: { homeDir: string; rootDir?: string; allowEphemeral?: boolean },
  operation: () => Promise<T>
): Promise<T> {
  const scope: MutationScope = {
    homeDir: args.homeDir,
    rootDir: args.rootDir,
    allowEphemeral:
      args.allowEphemeral ??
      mutationScope.getStore()?.allowEphemeral ??
      allowEphemeralAiPaths(),
    boundaries: new Map(),
    anchors: args.rootDir
      ? [
          facultMachineStateDir(args.homeDir, args.rootDir),
          args.rootDir,
          projectRootFromAiRoot(args.rootDir, args.homeDir),
          preferredGlobalAiRoot(args.homeDir),
        ].filter((root): root is string => Boolean(root))
      : [],
    roots: args.rootDir
      ? [
          facultAiRuntimeScopeDir(args.homeDir, args.rootDir),
          facultAiStateDir(args.homeDir, args.rootDir),
          facultAiWritebackReviewDir(args.homeDir, args.rootDir),
          facultAiEvolutionReviewDir(args.homeDir, args.rootDir),
        ]
      : [],
  };
  try {
    return await mutationScope.run(scope, operation);
  } finally {
    for (const boundary of scope.boundaries.values()) {
      boundary.close();
    }
  }
}

/** A read-only operation keeps its explicitly authorized root identities for the whole scan. */
export async function withAiReadCache<T>(
  anchors: string[],
  operation: () => Promise<T>
): Promise<T> {
  if (mutationScope.getStore()) {
    return operation();
  }
  const scope: MutationScope = {
    homeDir: process.env.HOME ?? homedir(),
    allowEphemeral: allowEphemeralAiPaths(),
    roots: [],
    anchors,
    boundaries: new Map(),
  };
  try {
    return await mutationScope.run(scope, operation);
  } finally {
    for (const boundary of scope.boundaries.values()) {
      boundary.close();
    }
  }
}

function operationRoot(rootPath: string, scope = mutationScope.getStore()) {
  if (dirname(rootPath) === rootPath) {
    throw new Error("Filesystem-wide AI operation roots are forbidden");
  }
  const anchorPath =
    scope?.anchors.find((candidate) => aiPathWithin(rootPath, candidate)) ??
    rootPath;
  const physicalRoot = join(
    resolvePhysicalPath(anchorPath),
    relative(anchorPath, rootPath)
  );
  if (resolvePhysicalPath(rootPath) !== physicalRoot) {
    throw new Error(
      `AI operation root escapes its trusted boundary: ${rootPath}`
    );
  }
  return { anchorPath, physicalRoot };
}

export function assertAiOutputPaths(paths: string[], homeDir?: string): void {
  const scope = mutationScope.getStore();
  if (!(scope?.allowEphemeral ?? allowEphemeralAiPaths())) {
    const issue = aiPathSafetyIssue({
      homeDir: homeDir ?? scope?.homeDir ?? process.env.HOME ?? homedir(),
      paths,
    });
    if (issue) {
      throw new Error(
        `Refusing ephemeral AI output: ${issue}. Use --allow-ephemeral or FCLT_ALLOW_EPHEMERAL_AI_PATHS=1 for intentional temporary work.`
      );
    }
  }
  // Preflight every known output before a multi-file operation mutates state.
  for (const path of paths) {
    const lexical = absoluteFilesystemPath(path);
    const root = scope?.roots.find((candidate) =>
      aiPathWithin(lexical, candidate)
    );
    if (
      root &&
      !aiPathWithin(
        resolvePhysicalPath(lexical),
        operationRoot(root).physicalRoot
      )
    ) {
      throw new Error(`AI output escapes authorized operation root: ${path}`);
    }
  }
}

function bindPath(
  path: string,
  args: {
    root?: string;
    create?: boolean;
    homeDir?: string;
    output?: boolean;
    read?: boolean;
  } = {}
) {
  const lexical = absoluteFilesystemPath(path);
  const scope = mutationScope.getStore();
  const checkSafety = args.output || (args.read && scope?.rootDir);
  if (checkSafety) {
    assertAiOutputPaths([lexical], args.homeDir);
  }
  const authorizedRoot =
    args.root ??
    scope?.roots.find((candidate) => aiPathWithin(lexical, candidate));
  if (!authorizedRoot) {
    throw new Error(`AI path has no authorized operation root: ${path}`);
  }
  const rootPath = absoluteFilesystemPath(authorizedRoot);
  if (!aiPathWithin(lexical, rootPath)) {
    throw new Error(`AI path escapes authorized scope boundary: ${path}`);
  }
  const { anchorPath, physicalRoot } = operationRoot(rootPath, scope);
  let root = scope?.boundaries.get(anchorPath);
  const owned = !scope;
  if (!root) {
    root = new AiDirectoryBoundary(anchorPath, args.create);
    scope?.boundaries.set(anchorPath, root);
  }
  let parent: AiDirectoryBoundary;
  try {
    parent = root.parentFor(lexical, args.create ?? false);
  } catch (error) {
    if (owned) {
      root.close();
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      assertAiOutputPaths(
        [lexical],
        args.output ? args.homeDir : realUserHome()
      );
    }
    throw error;
  }
  const physical = resolvePhysicalPath(lexical);
  if (!aiPathWithin(physical, physicalRoot)) {
    parent.close();
    if (owned) {
      root.close();
    }
    throw new Error(`AI path escapes authorized operation root: ${path}`);
  }
  const validate = () => {
    if (checkSafety) {
      assertAiOutputPaths([lexical, physical], args.homeDir);
    }
    root.validate();
    parent.validate();
    if (
      resolvePhysicalPath(lexical) !== physical ||
      !aiPathWithin(physical, physicalRoot) ||
      resolvePhysicalPath(rootPath) !== physicalRoot
    ) {
      throw new Error(`AI bound path changed: ${path}`);
    }
  };
  return {
    physical,
    parent,
    validate,
    close: () => {
      parent.close();
      if (owned) {
        root.close();
      }
    },
  };
}

function validateFile(
  binding: ReturnType<typeof bindPath>,
  fd: number,
  before?: Stats
): Stats {
  binding.validate();
  const metadata = fstatSync(fd);
  const mapped = lstatSync(binding.physical);
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    mapped.isSymbolicLink() ||
    !sameAiIdentity(metadata, mapped) ||
    (before &&
      (!sameAiIdentity(metadata, before) ||
        before.size !== metadata.size ||
        before.mtimeMs !== metadata.mtimeMs ||
        before.ctimeMs !== metadata.ctimeMs))
  ) {
    throw new Error(`AI bound file changed: ${binding.physical}`);
  }
  return metadata;
}

/** Reads and mutations share a descriptor-bound root, ancestry, parent and leaf identity. */
export async function readAiTarget(
  path: string,
  homeDir?: string,
  root?: string
) {
  await Promise.resolve();
  const binding = bindPath(path, { homeDir, root, create: true, output: true });
  try {
    let fd: number;
    try {
      fd = binding.parent.open(
        basename(binding.physical),
        constants.O_RDONLY +
          (constants.O_NOFOLLOW ?? 0) +
          (constants.O_NONBLOCK ?? 0)
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ...binding, contents: "", expected: null };
      }
      throw error;
    }
    try {
      const metadata = validateFile(binding, fd);
      const contents = readFileSync(fd, "utf8");
      validateFile(binding, fd, metadata);
      return {
        ...binding,
        contents,
        expected: {
          contents,
          identity: { dev: metadata.dev, ino: metadata.ino },
          mode: metadata.mode % 0o1000,
        },
      };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    binding.close();
    throw error;
  }
}

export async function readAiText(
  path: string,
  _encoding: "utf8" = "utf8",
  root?: string
): Promise<string> {
  await Promise.resolve();
  const binding = bindPath(path, { root, read: true });
  try {
    const fd = binding.parent.open(
      basename(binding.physical),
      constants.O_RDONLY +
        (constants.O_NOFOLLOW ?? 0) +
        (constants.O_NONBLOCK ?? 0)
    );
    try {
      const before = validateFile(binding, fd);
      const contents = readFileSync(fd, "utf8");
      validateFile(binding, fd, before);
      return contents;
    } finally {
      closeSync(fd);
    }
  } finally {
    binding.close();
  }
}

export async function aiFileExists(
  path: string,
  root?: string
): Promise<boolean> {
  await Promise.resolve();
  let binding: ReturnType<typeof bindPath> | undefined;
  try {
    binding = bindPath(path, { root });
    const fd = binding.parent.open(
      basename(binding.physical),
      constants.O_RDONLY +
        (constants.O_NOFOLLOW ?? 0) +
        (constants.O_NONBLOCK ?? 0)
    );
    try {
      binding.validate();
      return fstatSync(fd).isFile();
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  } finally {
    binding?.close();
  }
}

export async function readAiDirectory(
  path: string,
  root?: string
): Promise<string[]> {
  await Promise.resolve();
  const binding = bindPath(`${path}/.fclt-directory-entry`, { root });
  try {
    binding.validate();
    return binding.parent.entries();
  } finally {
    binding.close();
  }
}

export async function mkdirAiDirectory(
  path: string,
  homeDir?: string,
  root?: string
): Promise<void> {
  await Promise.resolve();
  const binding = bindPath(join(path, ".fclt-directory-entry"), {
    homeDir,
    root,
    create: true,
    output: true,
  });
  try {
    binding.validate();
  } finally {
    binding.close();
  }
}

export async function aiStatPath(path: string, root: string): Promise<Stats> {
  await Promise.resolve();
  if (absoluteFilesystemPath(path) === absoluteFilesystemPath(root)) {
    const binding = bindPath(join(path, ".fclt-stat"), { root, read: true });
    try {
      return binding.parent.metadata();
    } finally {
      binding.close();
    }
  }
  const binding = bindPath(path, { root, read: true });
  try {
    const metadata = lstatSync(binding.physical);
    if (metadata.isDirectory()) {
      const directory = bindPath(join(path, ".fclt-directory-entry"), {
        root,
        read: true,
      });
      try {
        return directory.parent.metadata();
      } finally {
        directory.close();
      }
    }
    const fd = binding.parent.open(
      basename(binding.physical),
      constants.O_RDONLY +
        (constants.O_NOFOLLOW ?? 0) +
        (constants.O_NONBLOCK ?? 0)
    );
    try {
      return validateFile(binding, fd);
    } finally {
      closeSync(fd);
    }
  } finally {
    binding.close();
  }
}

export function assertAiAtomicReplacementSupported(
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === "win32") {
    throw new Error(
      "AI atomic replacement is unavailable on win32: handle-bound replacement is required"
    );
  }
}

export async function replaceAiTarget(args: {
  path: string;
  contents: string;
  snapshot: Awaited<ReturnType<typeof readAiTarget>>;
  homeDir?: string;
  mode?: number;
  beforeCommit?: () => Promise<void>;
  /** @internal Cross-platform verification of the fail-closed backend. */
  platform?: NodeJS.Platform;
}): Promise<void> {
  const validate = () => {
    args.snapshot.validate();
    assertAiOutputPaths([args.path, args.snapshot.physical], args.homeDir);
  };
  try {
    assertAiAtomicReplacementSupported(args.platform ?? process.platform);
    validate();
    const { replaceVerifiedFileAt } = await import("./audit/safe-openat");
    await replaceVerifiedFileAt({
      directoryFd: args.snapshot.parent.fd,
      directoryPath: dirname(args.snapshot.physical),
      fileName: basename(args.snapshot.physical),
      contents: args.contents,
      expected: args.snapshot.expected,
      mode: args.mode ?? args.snapshot.expected?.mode ?? 0o644,
      maxBytes: Math.max(
        Buffer.byteLength(args.snapshot.contents),
        Buffer.byteLength(args.contents)
      ),
      validateBoundary: validate,
      beforeCommit: async () => {
        await args.beforeCommit?.();
        validate();
      },
      beforeExchange: () => {
        validate();
        return Promise.resolve();
      },
    });
    validate();
  } finally {
    args.snapshot.close();
  }
}

export async function writeAiText(
  path: string,
  contents: string,
  homeDir?: string,
  beforeRename?: () => Promise<void>,
  root?: string
): Promise<void> {
  assertAiAtomicReplacementSupported();
  const snapshot = await readAiTarget(path, homeDir, root);
  await replaceAiTarget({
    path,
    contents,
    snapshot,
    beforeCommit: beforeRename,
    homeDir,
    mode: 0o600,
  });
}

export async function appendAiJsonLine(
  path: string,
  value: unknown,
  homeDir?: string,
  afterOpen?: () => Promise<void>,
  root?: string
): Promise<void> {
  const binding = bindPath(path, { homeDir, root, create: true, output: true });
  try {
    const fd = binding.parent.open(
      basename(binding.physical),
      constants.O_RDWR +
        constants.O_CREAT +
        constants.O_APPEND +
        (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    try {
      const before = validateFile(binding, fd);
      await afterOpen?.();
      validateFile(binding, fd, before);
      const last = Buffer.alloc(1);
      if (before.size > 0) {
        readSync(fd, last, 0, 1, before.size - 1);
      }
      const text = `${before.size > 0 && last[0] !== 10 ? "\n" : ""}${JSON.stringify(value)}\n`;
      validateFile(binding, fd, before);
      writeSync(fd, text, null, "utf8");
      fsyncSync(fd);
      validateFile(binding, fd);
    } finally {
      closeSync(fd);
    }
  } finally {
    binding.close();
  }
}

/** Locks are created and removed only through the same owned directory entry. */
export async function createAiLock(
  path: string,
  contents: string,
  homeDir: string,
  root?: string
): Promise<() => void> {
  await Promise.resolve();
  const binding = bindPath(path, { homeDir, root, create: true, output: true });
  let fd: number;
  try {
    fd = binding.parent.open(
      basename(binding.physical),
      constants.O_WRONLY +
        constants.O_CREAT +
        constants.O_EXCL +
        (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    validateFile(binding, fd);
    writeSync(fd, contents, null, "utf8");
    validateFile(binding, fd);
  } catch (error) {
    binding.close();
    throw error;
  }
  return () => {
    try {
      validateFile(binding, fd);
      binding.parent.unlink(basename(binding.physical));
    } finally {
      closeSync(fd);
      binding.close();
    }
  };
}

export function assertAiRecordId(
  id: unknown,
  kind: "WB" | "EV"
): asserts id is string {
  const pattern = kind === "WB" ? WRITEBACK_ID_RE : PROPOSAL_ID_RE;
  if (typeof id !== "string" || !pattern.test(id)) {
    throw new Error(
      `Invalid ${kind} record identity: expected a ${kind}-NNNNN or dated ${kind} record ID`
    );
  }
}
