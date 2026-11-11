import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolvePhysicalPath } from "./paths";

const heldLocks = new AsyncLocalStorage<Set<string>>();

async function assertDirectoryTarget(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (metadata && !metadata.isDirectory()) {
    throw new Error(`Refusing unsafe generated state directory: ${path}`);
  }
}

async function assertRegularTarget(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (metadata && !metadata.isFile()) {
    throw new Error(`Refusing non-regular generated state target: ${path}`);
  }
}

async function prepareDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent === path) {
    await assertDirectoryTarget(path);
    return;
  }
  await prepareDirectory(parent);
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  if (!(await lstat(path)).isDirectory()) {
    throw new Error(`Refusing unsafe generated state directory: ${path}`);
  }
}

export async function assertGeneratedStateTarget(path: string): Promise<void> {
  await assertDirectoryTarget(dirname(path));
  await assertRegularTarget(path);
}

/** Publish one complete file; readers can keep using the prior snapshot during a build. */
export async function writeGeneratedState(
  path: string,
  body: string
): Promise<void> {
  await assertGeneratedStateTarget(path);
  await prepareDirectory(resolvePhysicalPath(dirname(path)));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body, { flag: "wx", mode: 0o600 });
    await assertRegularTarget(path);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

/** Fail closed on overlapping writers; never steal a potentially live or abandoned lock. */
export async function withGeneratedStateLock<T>(args: {
  directory: string;
  operation: () => Promise<T>;
}): Promise<T> {
  await assertDirectoryTarget(args.directory);
  const directory = resolvePhysicalPath(resolve(args.directory));
  if (heldLocks.getStore()?.has(directory)) {
    return args.operation();
  }
  await prepareDirectory(directory);
  const lock = join(directory, "writer.lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Generated state writer lock exists; retry after the writer finishes: ${lock}. If no fclt writer is running, remove that abandoned lock directory. See docs/generated-state.md for recovery guidance.`
      );
    }
    throw error;
  }
  try {
    return await heldLocks.run(
      new Set([...(heldLocks.getStore() ?? []), directory]),
      args.operation
    );
  } finally {
    await rmdir(lock);
  }
}
