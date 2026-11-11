import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { withGeneratedStateLock } from "./generated-state-io";
import { buildIndex } from "./index-builder";
import {
  facultAiGraphPath,
  facultAiIndexPath,
  legacyFacultAiIndexPaths,
  preferredGlobalAiRoot,
  projectRootFromAiRoot,
} from "./paths";

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function newestPathMtime(
  path: string,
  ancestors = new Set<string>()
): Promise<number> {
  try {
    const st = await stat(path);
    if (st.isFile()) {
      return st.mtimeMs;
    }
    if (!st.isDirectory()) {
      return 0;
    }
    const identity = await realpath(path);
    if (ancestors.has(identity)) {
      return 0;
    }
    const nextAncestors = new Set([...ancestors, identity]);
    let newest = st.mtimeMs;
    let entries: Dirent<string>[] = [];
    try {
      entries = await readdir(path, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return newest;
    }

    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isFile()) {
        try {
          const childStat = await stat(child);
          newest = Math.max(newest, childStat.mtimeMs);
        } catch {
          // ignore unreadable children
        }
        continue;
      }
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        newest = Math.max(newest, await newestPathMtime(child, nextAncestors));
      }
    }
    return newest;
  } catch {
    return 0;
  }
}

async function watchedPathMtime(path: string): Promise<number> {
  return await newestPathMtime(path);
}

export async function canonicalAssetsNewerThanIndex(args: {
  homeDir: string;
  rootDir: string;
  indexPath: string;
  /** Read snapshots also verify deletions; explicit repair retains its existing policy. */
  checkRemovedPaths?: boolean;
}): Promise<boolean> {
  let indexMtimeMs = 0;
  try {
    indexMtimeMs = (await stat(args.indexPath)).mtimeMs;
  } catch {
    return true;
  }

  const watchedRelPaths = [
    "AGENTS.global.md",
    "AGENTS.override.global.md",
    "agents",
    "automations",
    "config.toml",
    "instructions",
    "mcp",
    "skills",
    "snippets",
    "tools",
  ];
  const watchedRoots = [args.rootDir];

  if (projectRootFromAiRoot(args.rootDir, args.homeDir)) {
    const globalRoot = preferredGlobalAiRoot(args.homeDir);
    if (globalRoot !== args.rootDir) {
      watchedRoots.push(globalRoot);
    }
  }

  for (const root of watchedRoots) {
    // Removing an entire watched path changes only its parent's mtime.
    if (args.checkRemovedPaths) {
      try {
        if ((await stat(root)).mtimeMs > indexMtimeMs) {
          return true;
        }
      } catch {
        if (root === args.rootDir) {
          return true;
        }
      }
    }
    for (const rel of watchedRelPaths) {
      const watchedMtime = await watchedPathMtime(join(root, rel));
      // A same-tick edit cannot be distinguished from a fresh source by mtime.
      // Reads rebuild conservatively; explicit repair retains its existing policy.
      if (
        watchedMtime > indexMtimeMs ||
        (args.checkRemovedPaths &&
          watchedMtime > 0 &&
          watchedMtime === indexMtimeMs)
      ) {
        return true;
      }
    }
  }

  if (!args.checkRemovedPaths) {
    return false;
  }
  // Filesystem timestamps may tie within one clock tick. Confirm that paths
  // recorded by a real index/graph still exist, so deletions cannot hide in a tie.
  try {
    const saved = (await Bun.file(args.indexPath).json()) as Record<
      string,
      unknown
    >;
    const collections = [
      saved.skills,
      saved.agents,
      saved.automations,
      saved.snippets,
      saved.instructions,
      saved.nodes,
    ];
    const mcp = saved.mcp as { servers?: unknown } | undefined;
    collections.push(mcp?.servers);
    const paths = new Set<string>();
    for (const collection of collections) {
      if (!collection || typeof collection !== "object") {
        continue;
      }
      for (const entry of Object.values(
        collection as Record<string, unknown>
      )) {
        if (
          !entry ||
          typeof entry !== "object" ||
          !("path" in entry) ||
          typeof entry.path !== "string"
        ) {
          continue;
        }
        const path = entry.path;
        if (
          watchedRoots.some((root) => {
            const rel = relative(root, path);
            return (
              rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
            );
          })
        ) {
          paths.add(path);
        }
      }
    }
    for (const path of paths) {
      try {
        await stat(path);
      } catch {
        return true;
      }
    }
  } catch {
    return true;
  }
  return false;
}

export function legacyAiIndexPath(rootDir: string): string {
  return join(rootDir, "index.json");
}

function legacyGeneratedAiIndexPaths(
  homeDir: string,
  rootDir: string
): string[] {
  return legacyFacultAiIndexPaths(homeDir, rootDir);
}

function legacyGeneratedAiGraphPaths(
  homeDir: string,
  rootDir: string
): string[] {
  return legacyFacultAiIndexPaths(homeDir, rootDir)
    .filter((path) => path !== legacyAiIndexPath(rootDir))
    .map((path) => join(dirname(path), "graph.json"));
}

export async function ensureAiIndexPath(args: {
  homeDir: string;
  rootDir: string;
  repair?: boolean;
}): Promise<{
  path: string;
  repaired: boolean;
  source: "generated" | "legacy" | "rebuilt" | "missing";
}> {
  if (args.repair !== false) {
    const generatedPath = facultAiIndexPath(args.homeDir, args.rootDir);
    if (
      (await fileExists(generatedPath)) &&
      !(await canonicalAssetsNewerThanIndex({
        homeDir: args.homeDir,
        rootDir: args.rootDir,
        indexPath: generatedPath,
      }))
    ) {
      return { path: generatedPath, repaired: false, source: "generated" };
    }
    return await withGeneratedStateLock({
      directory: dirname(facultAiIndexPath(args.homeDir, args.rootDir)),
      operation: () => ensureAiIndexPathInternal(args),
    });
  }
  return await ensureAiIndexPathInternal(args);
}

async function ensureAiIndexPathInternal(args: {
  homeDir: string;
  rootDir: string;
  repair?: boolean;
}): ReturnType<typeof ensureAiIndexPath> {
  const generatedPath = facultAiIndexPath(args.homeDir, args.rootDir);
  if (await fileExists(generatedPath)) {
    if (
      args.repair !== false &&
      (await canonicalAssetsNewerThanIndex({
        homeDir: args.homeDir,
        rootDir: args.rootDir,
        indexPath: generatedPath,
      }))
    ) {
      const { outputPath } = await buildIndex({
        rootDir: args.rootDir,
        homeDir: args.homeDir,
        force: false,
      });
      return { path: outputPath, repaired: true, source: "rebuilt" };
    }
    return { path: generatedPath, repaired: false, source: "generated" };
  }

  for (const legacyPath of legacyGeneratedAiIndexPaths(
    args.homeDir,
    args.rootDir
  )) {
    if (await fileExists(legacyPath)) {
      if (args.repair !== false) {
        // Legacy snapshots can carry absolute paths from another checkout.
        // Import matching metadata, but always regenerate locations and scope.
        const { outputPath } = await buildIndex({
          rootDir: args.rootDir,
          homeDir: args.homeDir,
          force: false,
        });
        return { path: outputPath, repaired: true, source: "rebuilt" };
      }
      return {
        path: legacyPath,
        repaired: false,
        source: "legacy",
      };
    }
  }

  if (args.repair !== false) {
    const { outputPath } = await buildIndex({
      rootDir: args.rootDir,
      homeDir: args.homeDir,
      force: false,
    });
    return { path: outputPath, repaired: true, source: "rebuilt" };
  }

  return { path: generatedPath, repaired: false, source: "missing" };
}

async function graphAssetsNewerThanSnapshot(args: {
  homeDir: string;
  rootDir: string;
  graphPath: string;
}): Promise<boolean> {
  const indexPath = facultAiIndexPath(args.homeDir, args.rootDir);
  return await canonicalAssetsNewerThanIndex({
    homeDir: args.homeDir,
    rootDir: args.rootDir,
    indexPath: (await fileExists(indexPath)) ? indexPath : args.graphPath,
  });
}

export async function ensureAiGraphPath(args: {
  homeDir: string;
  rootDir: string;
  repair?: boolean;
  rebuild?: () => Promise<{ graphPath: string }>;
}): Promise<{
  path: string;
  rebuilt: boolean;
}> {
  if (args.repair !== false) {
    const generatedPath = facultAiGraphPath(args.homeDir, args.rootDir);
    if (
      (await fileExists(generatedPath)) &&
      !(await graphAssetsNewerThanSnapshot({
        ...args,
        graphPath: generatedPath,
      }))
    ) {
      return { path: generatedPath, rebuilt: false };
    }
    return await withGeneratedStateLock({
      directory: dirname(facultAiGraphPath(args.homeDir, args.rootDir)),
      operation: () => ensureAiGraphPathInternal(args),
    });
  }
  return await ensureAiGraphPathInternal(args);
}

async function ensureAiGraphPathInternal(args: {
  homeDir: string;
  rootDir: string;
  repair?: boolean;
  rebuild?: () => Promise<{ graphPath: string }>;
}): ReturnType<typeof ensureAiGraphPath> {
  const generatedPath = facultAiGraphPath(args.homeDir, args.rootDir);
  if (await fileExists(generatedPath)) {
    if (
      args.repair !== false &&
      (await graphAssetsNewerThanSnapshot({
        ...args,
        graphPath: generatedPath,
      }))
    ) {
      const { graphPath } = await (args.rebuild
        ? args.rebuild()
        : buildIndex({
            rootDir: args.rootDir,
            homeDir: args.homeDir,
            force: false,
          }));
      return { path: graphPath, rebuilt: true };
    }
    return { path: generatedPath, rebuilt: false };
  }

  for (const legacyGeneratedPath of legacyGeneratedAiGraphPaths(
    args.homeDir,
    args.rootDir
  )) {
    if (await fileExists(legacyGeneratedPath)) {
      if (args.repair !== false) {
        const { graphPath } = await (args.rebuild
          ? args.rebuild()
          : buildIndex({
              rootDir: args.rootDir,
              homeDir: args.homeDir,
              force: false,
            }));
        return { path: graphPath, rebuilt: true };
      }
      return {
        path: legacyGeneratedPath,
        rebuilt: false,
      };
    }
  }

  if (args.repair !== false) {
    const { graphPath } = await (args.rebuild
      ? args.rebuild()
      : buildIndex({
          rootDir: args.rootDir,
          homeDir: args.homeDir,
          force: false,
        }));
    return { path: graphPath, rebuilt: true };
  }

  return { path: generatedPath, rebuilt: false };
}
