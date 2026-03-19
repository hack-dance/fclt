import { homedir } from "node:os";
import { join } from "node:path";
import { ensureAiIndexPath } from "./ai-state";
import type { FacultIndex } from "./index-builder";
import { loadManagedState, syncManagedTools } from "./manage";
import { facultAiIndexPath, facultRootDir } from "./paths";

type EntryKind = "skills" | "mcp";

type CommandMode = "enable" | "disable";

const TOOL_LIST_SEPARATOR = ",";

function parseToolList(raw: string): string[] {
  return raw
    .split(TOOL_LIST_SEPARATOR)
    .map((tool) => tool.trim())
    .filter(Boolean);
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function parseEntryName(raw: string): { kind: EntryKind; name: string } {
  if (raw.startsWith("mcp:")) {
    return { kind: "mcp", name: raw.slice("mcp:".length) };
  }
  return { kind: "skills", name: raw };
}

function ensureIndexStructure(index: FacultIndex): FacultIndex {
  return {
    version: index.version ?? 1,
    updatedAt: index.updatedAt ?? new Date().toISOString(),
    skills: index.skills ?? {},
    mcp: index.mcp ?? { servers: {} },
    agents: index.agents ?? {},
    snippets: index.snippets ?? {},
    instructions: index.instructions ?? {},
  };
}

function computeNextEnabledFor({
  current,
  allTools,
  targetTools,
  mode,
}: {
  current: unknown;
  allTools: string[];
  targetTools: string[];
  mode: CommandMode;
}): string[] {
  const base = Array.isArray(current)
    ? current.map((t) => String(t))
    : mode === "disable"
      ? [...allTools]
      : [];
  if (mode === "enable") {
    return uniqueSorted([...base, ...targetTools]);
  }
  return uniqueSorted(base.filter((tool) => !targetTools.includes(tool)));
}

async function loadIndex(homeDir: string): Promise<FacultIndex> {
  const { path: indexPath } = await ensureAiIndexPath({
    homeDir,
    rootDir: facultRootDir(homeDir),
    repair: true,
  });
  const file = Bun.file(indexPath);
  if (!(await file.exists())) {
    throw new Error(`Index not found at ${indexPath}. Run "facult index".`);
  }
  const raw = await file.text();
  return JSON.parse(raw) as FacultIndex;
}

async function writeIndex(homeDir: string, index: FacultIndex) {
  const indexPath = facultAiIndexPath(homeDir);
  await Bun.write(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

function extractServersObject(parsed: Record<string, unknown>): {
  servers: Record<string, unknown>;
  set: (servers: Record<string, unknown>) => void;
} {
  if (parsed.servers && typeof parsed.servers === "object") {
    return {
      servers: parsed.servers as Record<string, unknown>,
      set: (servers) => {
        parsed.servers = servers;
      },
    };
  }
  if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
    return {
      servers: parsed.mcpServers as Record<string, unknown>,
      set: (servers) => {
        parsed.mcpServers = servers;
      },
    };
  }
  if (
    parsed.mcp &&
    typeof parsed.mcp === "object" &&
    (parsed.mcp as Record<string, unknown>).servers &&
    typeof (parsed.mcp as Record<string, unknown>).servers === "object"
  ) {
    return {
      servers: (parsed.mcp as Record<string, unknown>).servers as Record<
        string,
        unknown
      >,
      set: (servers) => {
        (parsed.mcp as Record<string, unknown>).servers = servers;
      },
    };
  }
  parsed.servers = {};
  return {
    servers: parsed.servers as Record<string, unknown>,
    set: (servers) => {
      parsed.servers = servers;
    },
  };
}

async function updateCanonicalServers({
  rootDir,
  updates,
  allTools,
  targetTools,
  mode,
}: {
  rootDir: string;
  updates: string[];
  allTools: string[];
  targetTools: string[];
  mode: CommandMode;
}) {
  if (updates.length === 0) {
    return;
  }

  const serversPath = join(rootDir, "mcp", "servers.json");
  const mcpPath = join(rootDir, "mcp", "mcp.json");
  let sourcePath: string | null = null;

  if (await Bun.file(serversPath).exists()) {
    sourcePath = serversPath;
  } else if (await Bun.file(mcpPath).exists()) {
    sourcePath = mcpPath;
  }

  if (!sourcePath) {
    throw new Error("No canonical MCP servers.json or mcp.json found.");
  }

  const raw = await Bun.file(sourcePath).text();
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const container = extractServersObject(parsed);

  for (const name of updates) {
    const entry = container.servers[name];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const next = computeNextEnabledFor({
      current: (entry as Record<string, unknown>).enabledFor,
      allTools,
      targetTools,
      mode,
    });
    (entry as Record<string, unknown>).enabledFor = next;
  }

  container.set(container.servers);
  await Bun.write(sourcePath, `${JSON.stringify(parsed, null, 2)}\n`);
}

export async function applyEnableDisable({
  names,
  mode,
  tools,
  homeDir,
  rootDir,
}: {
  names: string[];
  mode: CommandMode;
  tools?: string[];
  homeDir?: string;
  rootDir?: string;
}) {
  const home = homeDir ?? homedir();
  const root = rootDir ?? facultRootDir(home);
  const managedState = await loadManagedState(home);
  const managedTools = Object.keys(managedState.tools).sort();
  const targetTools =
    tools && tools.length > 0 ? uniqueSorted(tools) : managedTools;

  if (!targetTools.length) {
    throw new Error("No tools specified (and no managed tools found).");
  }

  const allTools = managedTools.length ? managedTools : targetTools;

  const index = ensureIndexStructure(await loadIndex(home));
  const missing: string[] = [];
  const mcpUpdates: string[] = [];

  for (const raw of names) {
    const { kind, name } = parseEntryName(raw);
    if (kind === "skills") {
      const entry = index.skills[name] as Record<string, unknown> | undefined;
      if (!entry) {
        missing.push(raw);
        continue;
      }
      entry.enabledFor = computeNextEnabledFor({
        current: entry.enabledFor,
        allTools,
        targetTools,
        mode,
      });
    } else {
      const entry = index.mcp?.servers?.[name] as
        | Record<string, unknown>
        | undefined;
      if (!entry) {
        missing.push(raw);
        continue;
      }
      entry.enabledFor = computeNextEnabledFor({
        current: entry.enabledFor,
        allTools,
        targetTools,
        mode,
      });
      mcpUpdates.push(name);
    }
  }

  if (missing.length) {
    throw new Error(`Entries not found: ${missing.join(", ")}`);
  }

  index.updatedAt = new Date().toISOString();
  await writeIndex(home, index);

  await updateCanonicalServers({
    rootDir: root,
    updates: mcpUpdates,
    allTools,
    targetTools,
    mode,
  });

  const toolsToSync = targetTools.filter((tool) => managedState.tools[tool]);
  if (toolsToSync.length) {
    for (const tool of toolsToSync) {
      await syncManagedTools({
        homeDir: home,
        rootDir: root,
        tool,
        dryRun: false,
      });
    }
  }
}

function parseEnableDisableArgs(argv: string[]): {
  names: string[];
  tools?: string[];
} {
  const names: string[] = [];
  let tools: string[] | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === "--for") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--for requires a comma-separated list of tools");
      }
      tools = parseToolList(next);
      i += 1;
      continue;
    }
    if (arg.startsWith("--for=")) {
      tools = parseToolList(arg.slice("--for=".length));
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    names.push(arg);
  }

  if (!names.length) {
    throw new Error("At least one name is required.");
  }

  return { names, tools };
}

export async function enableCommand(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(`facult enable — enable skills or MCP servers for tools

Usage:
  facult enable <name> [moreNames...] [--for <tool1,tool2,...>]
  facult enable mcp:<name> [--for <tools>]

Options:
  --for   Comma-separated list of tools (defaults to all managed tools)
`);
    return;
  }
  try {
    const { names, tools } = parseEnableDisableArgs(argv);
    await applyEnableDisable({ names, tools, mode: "enable" });
    console.log(`Enabled ${names.join(", ")}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function disableCommand(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(`facult disable — disable skills or MCP servers for tools

Usage:
  facult disable <name> [moreNames...] [--for <tool1,tool2,...>]
  facult disable mcp:<name> [--for <tools>]

Options:
  --for   Comma-separated list of tools (defaults to all managed tools)
`);
    return;
  }
  try {
    const { names, tools } = parseEnableDisableArgs(argv);
    await applyEnableDisable({ names, tools, mode: "disable" });
    console.log(`Disabled ${names.join(", ")}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
