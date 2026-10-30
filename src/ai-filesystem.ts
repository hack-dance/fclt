import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { aiPathSafetyIssue, allowEphemeralAiPaths } from "./ai-path-guard";
import { resolvePhysicalPath } from "./paths";

interface MutationScope {
  homeDir: string;
  allowEphemeral: boolean;
}

const mutationScope = new AsyncLocalStorage<MutationScope>();

export function needsAiMutationScope(args: {
  homeDir: string;
  allowEphemeral?: boolean;
}): boolean {
  const current = mutationScope.getStore();
  return (
    !current ||
    current.homeDir !== args.homeDir ||
    (args.allowEphemeral !== undefined &&
      current.allowEphemeral !== args.allowEphemeral)
  );
}

export function withAiMutationScope<T>(
  args: { homeDir: string; allowEphemeral?: boolean },
  operation: () => Promise<T>
): Promise<T> {
  return mutationScope.run(
    {
      homeDir: args.homeDir,
      allowEphemeral:
        args.allowEphemeral ??
        mutationScope.getStore()?.allowEphemeral ??
        allowEphemeralAiPaths(),
    },
    operation
  );
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

async function prepareOutput(path: string, homeDir?: string): Promise<string> {
  assertAiOutputPaths([path], homeDir);
  const physical = resolvePhysicalPath(path);
  await mkdir(dirname(physical), { recursive: true });
  assertAiOutputPaths([path, physical], homeDir);
  if (resolvePhysicalPath(path) !== physical) {
    throw new Error(`AI output changed during path resolution: ${path}`);
  }
  return physical;
}

/** Stage exclusive files and replace the directory entry; never truncate through a swapped leaf link. */
export async function writeAiText(
  path: string,
  contents: string,
  homeDir?: string,
  beforeRename?: () => Promise<void>
): Promise<void> {
  const physical = await prepareOutput(path, homeDir);
  const temporary = `${physical}.${randomUUID()}.tmp`;
  let owned: { dev: number; ino: number } | undefined;
  try {
    const file = await open(
      temporary,
      constants.O_WRONLY +
        constants.O_CREAT +
        constants.O_EXCL +
        (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    const metadata = await file.stat();
    owned = { dev: metadata.dev, ino: metadata.ino };
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await beforeRename?.();
    assertAiOutputPaths([path, physical], homeDir);
    if (resolvePhysicalPath(path) !== physical) {
      throw new Error(`AI output changed before commit: ${path}`);
    }
    await rename(temporary, physical);
    owned = undefined;
  } finally {
    if (owned) {
      const remaining = await lstat(temporary).catch(() => null);
      if (remaining?.dev === owned.dev && remaining.ino === owned.ino) {
        await rm(temporary, { force: true });
      }
    }
  }
}

export async function appendAiJsonLine(
  path: string,
  value: unknown,
  homeDir?: string
): Promise<void> {
  const physical = await prepareOutput(path, homeDir);
  const file = await open(
    physical,
    constants.O_RDWR +
      constants.O_CREAT +
      constants.O_APPEND +
      (constants.O_NOFOLLOW ?? 0),
    0o600
  );
  try {
    assertAiOutputPaths([path, physical], homeDir);
    if (
      resolvePhysicalPath(path) !== physical ||
      !(await file.stat()).isFile()
    ) {
      throw new Error(`AI append destination changed: ${path}`);
    }
    const { size } = await file.stat();
    let separator = "";
    if (size > 0) {
      const last = Buffer.alloc(1);
      await file.read(last, 0, 1, size - 1);
      separator = last[0] === 10 ? "" : "\n";
    }
    await file.appendFile(`${separator}${JSON.stringify(value)}\n`, "utf8");
  } finally {
    await file.close();
  }
}

export async function readAiTarget(path: string) {
  const physical = await prepareOutput(path);
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(
      physical,
      constants.O_RDONLY +
        (constants.O_NOFOLLOW ?? 0) +
        (constants.O_NONBLOCK ?? 0)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { physical, contents: "", expected: null };
    }
    throw error;
  }
  try {
    const metadata = await file.stat();
    assertAiOutputPaths([path, physical]);
    const mapped = await lstat(physical);
    if (
      !metadata.isFile() ||
      mapped.isSymbolicLink() ||
      metadata.dev !== mapped.dev ||
      metadata.ino !== mapped.ino ||
      resolvePhysicalPath(path) !== physical
    ) {
      throw new Error(`Proposal target changed before read: ${path}`);
    }
    const contents = await file.readFile("utf8");
    return {
      physical,
      contents,
      expected: {
        contents,
        identity: { dev: metadata.dev, ino: metadata.ino },
        mode: metadata.mode % 0o1000,
      },
    };
  } finally {
    await file.close();
  }
}

/** Use the existing descriptor-relative conditional replacement to bind both the file and its parent. */
export async function replaceAiTarget(args: {
  path: string;
  contents: string;
  snapshot: Awaited<ReturnType<typeof readAiTarget>>;
  beforeCommit?: () => Promise<void>;
}): Promise<void> {
  const validate = () => {
    assertAiOutputPaths([args.path, args.snapshot.physical]);
    if (resolvePhysicalPath(args.path) !== args.snapshot.physical) {
      throw new Error(`Proposal target changed before write: ${args.path}`);
    }
  };
  validate();
  // Windows has no descriptor-relative exchange in the audit helper. Stage in
  // the validated parent and rename, with a fresh identity/content check.
  if (process.platform === "win32") {
    await writeAiText(args.path, args.contents, undefined, async () => {
      await args.beforeCommit?.();
      validate();
      const current = await readAiTarget(args.path);
      if (
        current.contents !== args.snapshot.contents ||
        current.expected?.identity.dev !==
          args.snapshot.expected?.identity.dev ||
        current.expected?.identity.ino !==
          args.snapshot.expected?.identity.ino ||
        current.expected?.mode !== args.snapshot.expected?.mode
      ) {
        throw new Error(`Proposal target changed before write: ${args.path}`);
      }
    });
    return;
  }
  const { replaceVerifiedFileAt } = await import("./audit/safe-openat");
  await replaceVerifiedFileAt({
    directoryPath: dirname(args.snapshot.physical),
    fileName: basename(args.snapshot.physical),
    contents: args.contents,
    expected: args.snapshot.expected,
    mode: args.snapshot.expected?.mode ?? 0o644,
    maxBytes: Math.max(
      Buffer.byteLength(args.snapshot.contents),
      Buffer.byteLength(args.contents)
    ),
    beforeCommit: async () => {
      await args.beforeCommit?.();
      validate();
    },
    beforeExchange: () => {
      validate();
      return Promise.resolve();
    },
  });
}
