import { AsyncLocalStorage } from "node:async_hooks";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { aiPathWithin } from "./ai-boundary";
import {
  aiStatPath,
  readAiDirectory,
  readAiText,
  withAiReadCache,
} from "./ai-filesystem";
import { absoluteFilesystemPath, resolvePhysicalPath } from "./paths";

const indexRoots = new AsyncLocalStorage<string[]>();

export function withGuardedIndexReads<T>(
  roots: string[],
  operation: () => Promise<T>
): Promise<T> {
  return indexRoots.run(
    roots.map((root) => absoluteFilesystemPath(root)),
    () => withAiReadCache(roots, operation)
  );
}

function authorizedIndexRoot(path: string): string {
  const root = indexRoots
    .getStore()
    ?.find((candidate) =>
      aiPathWithin(absoluteFilesystemPath(path), candidate)
    );
  if (!root) {
    throw new Error(`Index read has no authorized source root: ${path}`);
  }
  return root;
}

export function indexFile(path: string) {
  if (!indexRoots.getStore()) {
    return Bun.file(path);
  }
  const root = authorizedIndexRoot(path);
  return {
    text: () => readAiText(path, "utf8", root),
    stat: () => aiStatPath(path, root),
    exists: async () => {
      try {
        await aiStatPath(path, root);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw error;
      }
    },
  };
}

type IndexDirent = Pick<Dirent, "name" | "isDirectory" | "isFile">;
export async function indexDirectory(dir: string): Promise<IndexDirent[]> {
  if (!indexRoots.getStore()) {
    return readdir(dir, { withFileTypes: true });
  }
  const root = authorizedIndexRoot(dir);
  const names = await readAiDirectory(dir, root);
  const entries: IndexDirent[] = [];
  for (const name of names) {
    const metadata = await aiStatPath(join(dir, name), root);
    entries.push({
      name,
      isDirectory: () => metadata.isDirectory(),
      isFile: () => metadata.isFile(),
    });
  }
  return entries;
}

export async function* indexFiles(
  glob: Bun.Glob,
  dir: string
): AsyncGenerator<string> {
  if (!indexRoots.getStore()) {
    yield* glob.scan({ cwd: dir, onlyFiles: true });
    return;
  }
  const pending = [{ path: dir, depth: 0 }];
  const seen = new Set<string>();
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    const physical = resolvePhysicalPath(current.path);
    if (seen.has(physical)) {
      continue;
    }
    seen.add(physical);
    for (const entry of await indexDirectory(current.path)) {
      count += 1;
      if (count > 100_000 || current.depth > 32) {
        throw new Error("Guarded index traversal exceeds its limits");
      }
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) {
        pending.push({ path, depth: current.depth + 1 });
      } else if (entry.isFile()) {
        const suffix = relative(dir, path).replaceAll("\\", "/");
        if (glob.match(suffix)) {
          yield suffix;
        }
      }
    }
  }
}
