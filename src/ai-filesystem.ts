import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  readFileSync,
  readSync,
  renameSync,
  type Stats,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, parse } from "node:path";
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
  facultAiStateDir,
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
  rootDir?: string;
}
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
    roots: args.rootDir
      ? [
          facultMachineStateDir(args.homeDir, args.rootDir),
          projectRootFromAiRoot(args.rootDir, args.homeDir) ?? args.rootDir,
          facultAiStateDir(args.homeDir, args.rootDir),
          preferredGlobalAiRoot(args.homeDir),
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

export function assertAiOutputPaths(paths: string[], homeDir?: string): void {
  const scope = mutationScope.getStore();
  if (scope?.allowEphemeral ?? allowEphemeralAiPaths()) {
    return;
  }
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
  const temporaryReadOverride =
    !args.output &&
    (scope?.allowEphemeral ?? allowEphemeralAiPaths()) &&
    aiPathSafetyIssue({ homeDir: realUserHome(), paths: [lexical] })?.includes(
      "OS temporary directory"
    );
  const rootPath = absoluteFilesystemPath(
    temporaryReadOverride
      ? parse(lexical).root
      : (args.root ??
          (scope?.allowEphemeral
            ? undefined
            : scope?.roots.find((candidate) =>
                aiPathWithin(lexical, candidate)
              )) ??
          parse(lexical).root)
  );
  if (!aiPathWithin(lexical, rootPath)) {
    throw new Error(`AI path escapes authorized scope boundary: ${path}`);
  }
  let root = scope?.boundaries.get(rootPath);
  const owned = !scope;
  if (!root) {
    root = new AiDirectoryBoundary(rootPath, args.create);
    scope?.boundaries.set(rootPath, root);
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
  const validate = () => {
    if (checkSafety) {
      assertAiOutputPaths([lexical, physical], args.homeDir);
    }
    root.validate();
    parent.validate();
    if (
      resolvePhysicalPath(lexical) !== physical ||
      !aiPathWithin(physical, root.physical)
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
  homeDir?: string
): Promise<void> {
  await Promise.resolve();
  assertAiOutputPaths([path], homeDir);
  const boundary = new AiDirectoryBoundary(path, true);
  try {
    assertAiOutputPaths([boundary.physical], homeDir);
    boundary.validate();
  } finally {
    boundary.close();
  }
}

export async function replaceAiTarget(args: {
  path: string;
  contents: string;
  snapshot: Awaited<ReturnType<typeof readAiTarget>>;
  homeDir?: string;
  mode?: number;
  beforeCommit?: () => Promise<void>;
}): Promise<void> {
  const validate = () => {
    args.snapshot.validate();
    assertAiOutputPaths([args.path, args.snapshot.physical], args.homeDir);
  };
  try {
    validate();
    if (process.platform === "win32") {
      await replaceAiTargetOnWindows(args, validate);
      return;
    }
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

/** Windows uses the same bound ancestry and leaf checks around its synchronous rename. */
async function replaceAiTargetOnWindows(
  args: {
    snapshot: Awaited<ReturnType<typeof readAiTarget>>;
    contents: string;
    mode?: number;
    beforeCommit?: () => Promise<void>;
  },
  validate: () => void
): Promise<void> {
  const { snapshot } = args;
  const name = `${basename(snapshot.physical)}.${randomUUID()}.tmp`;
  const temporary = `${dirname(snapshot.physical)}/${name}`;
  const fd = snapshot.parent.open(
    name,
    constants.O_RDWR +
      constants.O_CREAT +
      constants.O_EXCL +
      (constants.O_NOFOLLOW ?? 0),
    args.mode ?? snapshot.expected?.mode ?? 0o644
  );
  const staged = fstatSync(fd);
  let committed = false;
  try {
    writeSync(fd, args.contents, null, "utf8");
    fsyncSync(fd);
    await args.beforeCommit?.();
    validate();
    const existing = await readAiTarget(snapshot.physical);
    try {
      if (
        JSON.stringify(existing.expected) !== JSON.stringify(snapshot.expected)
      ) {
        throw new Error("AI bound target changed before commit");
      }
    } finally {
      existing.close();
    }
    if (
      !sameAiIdentity(lstatSync(temporary), staged) ||
      readFileSync(temporary, "utf8") !== args.contents
    ) {
      throw new Error("AI staging file changed before commit");
    }
    validate();
    renameSync(temporary, snapshot.physical);
    if (!sameAiIdentity(lstatSync(snapshot.physical), staged)) {
      throw new Error("AI staging identity changed at commit");
    }
    committed = true;
    validate();
  } finally {
    closeSync(fd);
    if (!committed) {
      try {
        snapshot.validate();
        if (sameAiIdentity(lstatSync(temporary), staged)) {
          snapshot.parent.unlink(name);
        }
      } catch {
        /* Preserve entries whose identity or parent changed. */
      }
    }
  }
}

export async function writeAiText(
  path: string,
  contents: string,
  homeDir?: string,
  beforeRename?: () => Promise<void>
): Promise<void> {
  const snapshot = await readAiTarget(path, homeDir);
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
  afterOpen?: () => Promise<void>
): Promise<void> {
  const binding = bindPath(path, { homeDir, create: true, output: true });
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
  homeDir: string
): Promise<() => void> {
  await Promise.resolve();
  const binding = bindPath(path, { homeDir, create: true, output: true });
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
