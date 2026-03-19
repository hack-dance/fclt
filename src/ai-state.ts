import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildIndex } from "./index-builder";
import { facultAiGraphPath, facultAiIndexPath } from "./paths";

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export function legacyAiIndexPath(rootDir: string): string {
  return join(rootDir, "index.json");
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
    return { path: generatedPath, repaired: false, source: "generated" };
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
    return { path: generatedPath, rebuilt: false };
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
