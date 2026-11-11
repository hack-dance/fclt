import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { AgentInventory } from "./inventory";
import { noWriteRequested } from "./no-write";
import {
  facultMachineStateDir,
  facultRootDir,
  preferredGlobalAiRoot,
  resolvePhysicalPath,
} from "./paths";

interface CacheRecord {
  schema: 1;
  key: string;
  dependencies: [string, string][];
  inventory: AgentInventory;
}

async function stamp(path: string): Promise<string> {
  try {
    const metadata = await stat(path);
    return `${metadata.mode}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
  } catch (error) {
    return `missing:${(error as NodeJS.ErrnoException).code}`;
  }
}

/** Record only discovery dependencies, including missing paths and glob directories. */
export class InventoryDependencies {
  private readonly paths = new Map<string, Promise<string>>();
  private readonly trees = new Set<string>();

  async capturePath(path: string): Promise<void> {
    if (!this.paths.has(path)) {
      this.paths.set(path, stamp(path));
    }
    await this.paths.get(path);
  }

  async captureTree(
    path: string,
    ancestors = new Set<string>()
  ): Promise<void> {
    await this.capturePath(path);
    const identity = await realpath(path).catch(() => path);
    if (ancestors.has(identity) || this.trees.has(path)) {
      return;
    }
    this.trees.add(path);
    const nextAncestors = new Set([...ancestors, identity]);
    const entries = await readdir(path, { withFileTypes: true }).catch(
      () => []
    );
    await Promise.all(
      entries.map(async (entry) => {
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === ".facult"
        ) {
          return;
        }
        const child = join(path, entry.name);
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          await this.captureTree(child, nextAncestors);
        } else {
          await this.capturePath(child);
        }
      })
    );
  }

  async fingerprint(identity: string): Promise<string> {
    return createHash("sha256")
      .update(identity)
      .update(JSON.stringify(await this.entries()))
      .digest("hex");
  }

  async entries(): Promise<[string, string][]> {
    return await Promise.all(
      [...this.paths]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(async ([path, value]) => [path, await value] as [string, string])
    );
  }
}

export async function dependenciesMatch(
  dependencies: [string, string][]
): Promise<boolean> {
  // Bound concurrent filesystem work even for large plugin/skill installations.
  for (let offset = 0; offset < dependencies.length; offset += 64) {
    const matches = await Promise.all(
      dependencies
        .slice(offset, offset + 64)
        .map(async ([path, expected]) => (await stamp(path)) === expected)
    );
    if (matches.includes(false)) {
      return false;
    }
  }
  return true;
}

export function inventoryCachePath(
  homeDir: string,
  identity: string,
  rootDir?: string
): string {
  return join(
    facultMachineStateDir(homeDir, rootDir),
    "cache",
    "inventory",
    `${createHash("sha256").update(identity).digest("hex")}.json`
  );
}

export async function readInventoryCache(
  path: string,
  key: string
): Promise<AgentInventory | null> {
  try {
    const record = (await Bun.file(path).json()) as CacheRecord;
    if (
      record.schema !== 1 ||
      record.key !== key ||
      !Array.isArray(record.dependencies) ||
      !(await dependenciesMatch(record.dependencies))
    ) {
      return null;
    }
    return {
      ...record.inventory,
      cache: {
        hit: true,
        generatedAt: record.inventory.generatedAt,
        key: record.inventory.cache!.key,
      },
    };
  } catch {
    return null;
  }
}

export async function writeInventoryCache(args: {
  path: string;
  key: string;
  dependencies: InventoryDependencies;
  inventory: AgentInventory;
  homeDir: string;
}): Promise<void> {
  if (noWriteRequested()) {
    return;
  }
  try {
    const destination = resolvePhysicalPath(args.path);
    for (const root of [
      join(args.homeDir, ".ai"),
      facultRootDir(args.homeDir),
      preferredGlobalAiRoot(args.homeDir),
    ]) {
      const rel = relative(resolvePhysicalPath(root), destination);
      if (
        rel === "" ||
        (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
      ) {
        return;
      }
    }
    const dependencies = await args.dependencies.entries();
    // A concurrent source edit must not produce a reusable mixed snapshot.
    if (!(await dependenciesMatch(dependencies))) {
      return;
    }
    await mkdir(dirname(args.path), { recursive: true, mode: 0o700 });
    const temporary = `${args.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        schema: 1,
        key: args.key,
        dependencies,
        inventory: args.inventory,
      } satisfies CacheRecord),
      { mode: 0o600 }
    );
    await rename(temporary, args.path);
  } catch {
    // A missing/unwritable cache never makes a read command fail.
  }
}
