import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildIndex } from "./index-builder";
import {
  facultAiGraphPath,
  facultAiIndexPath,
  legacyFacultStateDirForRoot,
} from "./paths";

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function newestPathMtime(path: string): Promise<number> {
  try {
    const st = await stat(path);
    if (st.isFile()) {
      return st.mtimeMs;
    }
    if (!st.isDirectory()) {
      return 0;
    }
  } catch {
    return 0;
  }

  let newest = 0;
  let entries: Awaited<ReturnType<typeof readdir>> = [];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isFile()) {
      try {
        const st = await stat(child);
        newest = Math.max(newest, st.mtimeMs);
      } catch {
        // ignore unreadable children
      }
      continue;
    }
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestPathMtime(child));
    }
  }
  return newest;
}

async function canonicalAssetsNewerThanIndex(args: {
  rootDir: string;
  indexPath: string;
}): Promise<boolean> {
  let indexMtimeMs = 0;
  try {
    indexMtimeMs = (await stat(args.indexPath)).mtimeMs;
  } catch {
    return true;
  }

  const watchRoots = [
    "AGENTS.global.md",
    "agents",
    "instructions",
    "skills",
    "snippets",
    "mcp",
  ].map((rel) => join(args.rootDir, rel));

  for (const watchRoot of watchRoots) {
    if ((await newestPathMtime(watchRoot)) > indexMtimeMs) {
      return true;
    }
  }

  return false;
}

export function legacyAiIndexPath(rootDir: string): string {
  return join(rootDir, "index.json");
}

function legacyGeneratedAiIndexPath(homeDir: string, rootDir: string): string {
  return join(
    legacyFacultStateDirForRoot(rootDir, homeDir),
    "ai",
    "index.json"
  );
}

function legacyGeneratedAiGraphPath(homeDir: string, rootDir: string): string {
  return join(
    legacyFacultStateDirForRoot(rootDir, homeDir),
    "ai",
    "graph.json"
  );
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
  const generatedPath = facultAiIndexPath(args.homeDir, args.rootDir);
  if (await fileExists(generatedPath)) {
    if (
      args.repair !== false &&
      (await canonicalAssetsNewerThanIndex({
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

  const legacyGeneratedPath = legacyGeneratedAiIndexPath(
    args.homeDir,
    args.rootDir
  );
  if (await fileExists(legacyGeneratedPath)) {
    if (args.repair !== false) {
      await mkdir(dirname(generatedPath), { recursive: true });
      await copyFile(legacyGeneratedPath, generatedPath);
    }
    return {
      path: generatedPath,
      repaired: args.repair !== false,
      source: "legacy",
    };
  }

  const legacyPath = legacyAiIndexPath(args.rootDir);
  if (await fileExists(legacyPath)) {
    if (args.repair !== false) {
      await mkdir(dirname(generatedPath), { recursive: true });
      await copyFile(legacyPath, generatedPath);
    }
    return {
      path: generatedPath,
      repaired: args.repair !== false,
      source: "legacy",
    };
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

export async function ensureAiGraphPath(args: {
  homeDir: string;
  rootDir: string;
  repair?: boolean;
}): Promise<{
  path: string;
  rebuilt: boolean;
}> {
  const generatedPath = facultAiGraphPath(args.homeDir, args.rootDir);
  if (await fileExists(generatedPath)) {
    const generatedIndexPath = facultAiIndexPath(args.homeDir, args.rootDir);
    const freshnessAnchor = (await fileExists(generatedIndexPath))
      ? generatedIndexPath
      : generatedPath;
    if (
      args.repair !== false &&
      (await canonicalAssetsNewerThanIndex({
        rootDir: args.rootDir,
        indexPath: freshnessAnchor,
      }))
    ) {
      const { graphPath } = await buildIndex({
        rootDir: args.rootDir,
        homeDir: args.homeDir,
        force: false,
      });
      return { path: graphPath, rebuilt: true };
    }
    return { path: generatedPath, rebuilt: false };
  }

  const legacyGeneratedPath = legacyGeneratedAiGraphPath(
    args.homeDir,
    args.rootDir
  );
  if (await fileExists(legacyGeneratedPath)) {
    if (args.repair !== false) {
      await mkdir(dirname(generatedPath), { recursive: true });
      await copyFile(legacyGeneratedPath, generatedPath);
    }
    return { path: generatedPath, rebuilt: args.repair !== false };
  }

  if (args.repair !== false) {
    const { graphPath } = await buildIndex({
      rootDir: args.rootDir,
      homeDir: args.homeDir,
      force: false,
    });
    return { path: graphPath, rebuilt: true };
  }

  return { path: generatedPath, rebuilt: false };
}
