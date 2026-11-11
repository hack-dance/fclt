import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
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
import { extractServersObject } from "./mcp-config";
import { noWriteRequested } from "./no-write";
import {
  facultMachineStateDir,
  facultRootDir,
  preferredGlobalAiRoot,
  resolvePhysicalPath,
} from "./paths";
import { parseJsonLenient } from "./util/json";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortedValue(child)])
  );
}

/** Compare only the MCP data emitted by inventory, never persist config values. */
async function mcpDigest(path: string): Promise<string> {
  try {
    const text = await Bun.file(path).text();
    const parsed: unknown = path.endsWith(".toml")
      ? Bun.TOML.parse(text)
      : parseJsonLenient(text);
    const servers = path.endsWith(".toml")
      ? (parsed as { mcp_servers?: unknown })?.mcp_servers
      : extractServersObject(parsed);
    return digest(sortedValue(servers ?? {}));
  } catch {
    return digest(["unreadable-or-invalid", await stamp(path)]);
  }
}

const DISCOVERY_FILES = new Set([
  "SKILL.md",
  "AGENTS.md",
  "agents.md",
  "CLAUDE.md",
  ".cursorrules",
  "mcp.json",
  "mcp.config.json",
  "claude_desktop_config.json",
  ".claude.json",
]);

async function directoryDigest(
  path: string,
  allEntries = false
): Promise<string> {
  const entries = await readdir(path, { withFileTypes: true });
  return digest(
    entries
      .filter(
        (entry) =>
          allEntries || entry.isDirectory() || DISCOVERY_FILES.has(entry.name)
      )
      .map((entry) => [entry.name, entry.isDirectory(), entry.isSymbolicLink()])
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
  );
}

async function presenceStamp(path: string): Promise<string> {
  try {
    const metadata = await stat(path);
    return metadata.isDirectory()
      ? `directory:${metadata.dev}:${metadata.ino}:${await realpath(path)}`
      : await stamp(path);
  } catch {
    return await stamp(path);
  }
}

async function projectedStamp(
  path: string,
  projection: "mcp" | "directory-scan" | "directory-entries"
): Promise<string> {
  return `${projection}:${JSON.stringify({ metadata: await stamp(path), digest: await (projection === "mcp" ? mcpDigest(path) : directoryDigest(path, projection === "directory-entries")) })}`;
}

async function dependencyMatches(
  path: string,
  expected: string
): Promise<boolean> {
  if (expected.startsWith("directory:")) {
    return (await presenceStamp(path)) === expected;
  }
  const projection = expected.startsWith("mcp:")
    ? "mcp"
    : expected.startsWith("directory-scan:")
      ? "directory-scan"
      : expected.startsWith("directory-entries:")
        ? "directory-entries"
        : null;
  if (!projection) {
    return (await stamp(path)) === expected;
  }
  let saved: {
    metadata: string;
    digest: string;
  };
  try {
    saved = JSON.parse(expected.slice(projection.length + 1));
  } catch {
    return false;
  }
  if (
    !saved ||
    typeof saved.metadata !== "string" ||
    typeof saved.digest !== "string"
  ) {
    return false;
  }
  if ((await stamp(path)) === saved.metadata) {
    return true;
  }
  try {
    return (
      (await (projection === "mcp"
        ? mcpDigest(path)
        : directoryDigest(path, projection === "directory-entries"))) ===
      saved.digest
    );
  } catch {
    return false;
  }
}

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
  private readonly fullDirectories = new Map<string, Promise<string>>();
  private readonly trees = new Set<string>();
  private readonly structures = new Set<string>();
  private readonly projections = new Set<string>();
  private readonly stableReads: boolean;

  constructor(options?: { stableReads?: boolean }) {
    this.stableReads = options?.stableReads === true;
  }

  async capturePath(path: string): Promise<void> {
    if (!this.paths.has(path)) {
      this.paths.set(
        path,
        this.stableReads ? presenceStamp(path) : stamp(path)
      );
    }
    await this.paths.get(path);
  }

  async captureMcpConfig(path: string): Promise<void> {
    if (!this.stableReads || this.projections.has(path)) {
      return;
    }
    this.projections.add(path);
    this.paths.set(path, projectedStamp(path, "mcp"));
    await this.paths.get(path);
  }

  async captureStructure(path: string): Promise<void> {
    if (!this.structures.has(path)) {
      this.structures.add(path);
      this.paths.set(path, stamp(path));
    }
    await this.paths.get(path);
  }

  /** Preserve prior discovery inputs when a recursive asset reader needs every name. */
  async readDirectory(
    path: string,
    options?: { allEntries?: boolean }
  ): Promise<Dirent<string>[]> {
    if (options?.allEntries && !this.structures.has(path)) {
      if (!this.fullDirectories.has(path)) {
        this.fullDirectories.set(
          path,
          projectedStamp(path, "directory-entries")
        );
      }
      await this.fullDirectories.get(path);
    } else if (
      !(
        this.structures.has(path) ||
        this.projections.has(path) ||
        this.fullDirectories.has(path)
      )
    ) {
      this.projections.add(path);
      this.paths.set(path, projectedStamp(path, "directory-scan"));
      await this.paths.get(path);
    }
    return await readdir(path, { withFileTypes: true, encoding: "utf8" });
  }

  async captureTree(
    path: string,
    ancestors = new Set<string>()
  ): Promise<void> {
    if (this.stableReads) {
      await this.captureStructure(path);
    } else {
      await this.capturePath(path);
    }
    await this.paths.get(path);
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
      [...this.paths, ...this.fullDirectories]
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
        .map(
          async ([path, expected]) => await dependencyMatches(path, expected)
        )
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
