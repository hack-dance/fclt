#!/usr/bin/env bun

import { join } from "node:path";
import { consolidateCommand } from "./consolidate";
import type {
  AgentEntry,
  FacultIndex,
  McpEntry,
  SkillEntry,
  SnippetEntry,
} from "./index-builder";
import { indexCommand } from "./index-builder";
import { manageCommand, managedCommand, unmanageCommand } from "./manage";
import type { QueryFilters } from "./query";
import {
  filterAgents,
  filterMcp,
  filterSkills,
  filterSnippets,
  loadIndex,
} from "./query";
import { scanCommand } from "./scan";

type ListKind = "skills" | "mcp" | "agents" | "snippets";

const LIST_KINDS: ListKind[] = ["skills", "mcp", "agents", "snippets"];

export interface ListCommandOptions {
  kind: ListKind;
  filters: QueryFilters;
  json: boolean;
}

function printHelp() {
  console.log(`facult — inspect local agent configs for skills + MCP servers

Usage:
  facult scan [--json] [--show-duplicates] [--tui]
  facult consolidate [--force] [--auto <mode>]
  facult index [--force]
  facult list [skills|mcp|agents|snippets] [--enabled-for TOOL] [--untrusted] [--flagged] [--json]
  facult show <name>
  facult show mcp:<name>
  facult manage <tool>
  facult unmanage <tool>
  facult managed
  facult --show-duplicates

Commands:
  scan         Scan common config locations (Cursor, Claude, Claude Desktop, etc.)
  consolidate  Interactively deduplicate and copy skills + MCP configs
  index        Build a queryable index from ~/agents/.tb/
  list         List indexed skills, MCP servers, agents, or snippets
  show         Show a single indexed entry, including file contents
  manage       Back up tool config and enter managed mode
  unmanage     Restore backups and exit managed mode
  managed      List tools in managed mode

Options:
  --json              Print full JSON (ScanResult or list output)
  --show-duplicates   Print only duplicate skills as a table (skill, count, sources)
  --tui               Render scan output in an interactive TUI (skills list)
  --force             Re-copy items already consolidated OR rebuild index from scratch
  --auto              Auto-resolve consolidate conflicts: keep-newest, keep-current, keep-incoming
  --enabled-for       Filter list to entries enabled for a specific tool
  --untrusted         Filter list to entries that are not trusted
  --flagged           Filter list to entries flagged by audit
`);
}

function parseListKind(argv: string[]): { kind: ListKind; startIndex: number } {
  const first = argv[0];
  if (!first || first.startsWith("-")) {
    return { kind: "skills", startIndex: 0 };
  }
  if (LIST_KINDS.includes(first as ListKind)) {
    return { kind: first as ListKind, startIndex: 1 };
  }
  throw new Error(`Unknown list type: ${first}`);
}

function parseEnabledForArg(
  arg: string,
  nextArg?: string
): { tool: string; advance: number } | null {
  if (arg === "--enabled-for") {
    if (!nextArg) {
      throw new Error("--enabled-for requires a tool name");
    }
    return { tool: nextArg, advance: 1 };
  }
  if (arg.startsWith("--enabled-for=")) {
    const tool = arg.slice("--enabled-for=".length);
    if (!tool) {
      throw new Error("--enabled-for requires a tool name");
    }
    return { tool, advance: 0 };
  }
  return null;
}

export function parseListArgs(argv: string[]): ListCommandOptions {
  const { kind, startIndex } = parseListKind(argv);
  const filters: QueryFilters = {};
  let json = false;

  for (let i = startIndex; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--untrusted") {
      filters.untrusted = true;
      continue;
    }
    if (arg === "--flagged") {
      filters.flagged = true;
      continue;
    }

    const enabledFor = parseEnabledForArg(arg, argv[i + 1]);
    if (enabledFor) {
      filters.enabledFor = enabledFor.tool;
      i += enabledFor.advance;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return { kind, filters, json };
}

async function listCommand(argv: string[]) {
  let opts: ListCommandOptions;
  try {
    opts = parseListArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  let index: FacultIndex;
  try {
    index = await loadIndex();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  let entries: SkillEntry[] | McpEntry[] | AgentEntry[] | SnippetEntry[] = [];

  switch (opts.kind) {
    case "skills":
      entries = filterSkills(index.skills, opts.filters);
      break;
    case "mcp":
      entries = filterMcp(index.mcp?.servers ?? {}, opts.filters);
      break;
    case "agents":
      entries = filterAgents(index.agents ?? {}, opts.filters);
      break;
    case "snippets":
      entries = filterSnippets(index.snippets ?? {}, opts.filters);
      break;
    default:
      entries = [];
      break;
  }

  if (opts.json) {
    console.log(`${JSON.stringify(entries, null, 2)}`);
    return;
  }

  for (const entry of entries) {
    if (opts.kind === "skills") {
      const skill = entry as SkillEntry;
      const desc = skill.description ? `\t${skill.description}` : "";
      console.log(`${skill.name}${desc}`);
    } else {
      console.log(entry.name);
    }
  }
}

async function readEntryContents(entryPath: string): Promise<string> {
  const file = Bun.file(entryPath);
  if (!(await file.exists())) {
    throw new Error(`File not found: ${entryPath}`);
  }
  return file.text();
}

async function showCommand(argv: string[]) {
  const raw = argv[0];
  if (!raw) {
    console.error("show requires a name");
    process.exitCode = 1;
    return;
  }

  let index: FacultIndex;
  try {
    index = await loadIndex();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  let kind: ListKind | "mcp" = "skills";
  let name = raw;

  if (raw.startsWith("mcp:")) {
    kind = "mcp";
    name = raw.slice("mcp:".length);
  }

  let entry: SkillEntry | McpEntry | AgentEntry | SnippetEntry | null = null;
  const skill = index.skills[name];
  const mcpServer = index.mcp?.servers?.[name];
  const agent = index.agents?.[name];
  const snippet = index.snippets?.[name];

  if (kind === "skills" && skill) {
    entry = skill;
  } else if (kind === "mcp" && mcpServer) {
    entry = mcpServer;
  } else if (kind === "skills" && agent) {
    kind = "agents";
    entry = agent;
  } else if (kind === "skills" && snippet) {
    kind = "snippets";
    entry = snippet;
  } else if (kind === "skills" && mcpServer) {
    kind = "mcp";
    entry = mcpServer;
  }

  if (!entry) {
    console.error(`Entry not found: ${raw}`);
    process.exitCode = 1;
    return;
  }

  let contentPath = entry.path;
  if (kind === "skills") {
    contentPath = join(entry.path, "SKILL.md");
  }

  let contents = "";
  try {
    contents = await readEntryContents(contentPath);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  console.log(`${kind}:${entry.name}`);
  console.log(JSON.stringify(entry, null, 2));
  console.log("\n---\n");
  console.log(contents);
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    printHelp();
    return;
  }

  // Convenience: allow `facult --show-duplicates` as shorthand for `facult scan --show-duplicates`.
  if (cmd === "--show-duplicates") {
    await scanCommand([cmd, ...rest]);
    return;
  }

  switch (cmd) {
    case "scan":
      await scanCommand(rest);
      return;
    case "consolidate":
      await consolidateCommand(rest);
      return;
    case "index":
      await indexCommand(rest);
      return;
    case "list":
      await listCommand(rest);
      return;
    case "show":
      await showCommand(rest);
      return;
    case "manage":
      await manageCommand(rest);
      return;
    case "unmanage":
      await unmanageCommand(rest);
      return;
    case "managed":
      await managedCommand();
      return;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exitCode = 1;
      return;
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
