#!/usr/bin/env bun

import { join } from "node:path";
import { getAllAdapters } from "./adapters";
import { auditCommand } from "./audit";
import { consolidateCommand } from "./consolidate";
import { disableCommand, enableCommand } from "./enable-disable";
import type {
  AgentEntry,
  FacultIndex,
  McpEntry,
  SkillEntry,
  SnippetEntry,
} from "./index-builder";
import { indexCommand } from "./index-builder";
import {
  manageCommand,
  managedCommand,
  syncCommand,
  unmanageCommand,
} from "./manage";
import { migrateCommand } from "./migrate";
import type { QueryFilters } from "./query";
import {
  filterAgents,
  filterMcp,
  filterSkills,
  filterSnippets,
  loadIndex,
} from "./query";
import {
  installCommand,
  searchCommand,
  sourcesCommand,
  templatesCommand,
  updateCommand,
} from "./remote";
import { scanCommand } from "./scan";
import { snippetsCommand } from "./snippets-cli";
import { trustCommand, untrustCommand } from "./trust";
import { parseJsonLenient } from "./util/json";

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
  facult scan [--json] [--show-duplicates] [--tui] [--from <path>]
  facult audit [--from <path>]
  facult audit --non-interactive [name|mcp:<name>] [--severity <level>] [--rules <path>] [--from <path>] [--json]
  facult audit --non-interactive [name|mcp:<name>] --with <claude|codex> [--from <path>] [--max-items <n|all>] [--json]
  facult migrate [--from <path>] [--dry-run] [--move] [--write-config]
  facult consolidate [--force] [--auto <mode>] [scan options]
  facult index [--force]
  facult list [skills|mcp|agents|snippets] [--enabled-for TOOL] [--untrusted] [--flagged] [--pending] [--json]
  facult show <name>
  facult show mcp:<name> [--show-secrets]
  facult adapters
  facult trust <name> [moreNames...]
  facult untrust <name> [moreNames...]
  facult manage <tool>
  facult unmanage <tool>
  facult managed
  facult enable <name> [moreNames...] [--for <tools>]
  facult disable <name> [moreNames...] [--for <tools>]
  facult sync [tool] [--dry-run]
  facult search <query> [--index <name>] [--limit <n>]
  facult install <index:item> [--as <name>] [--dry-run] [--force] [--strict-source-trust]
  facult update [--apply] [--strict-source-trust]
  facult sources <cmd> [args...]
  facult templates <cmd> [args...]
  facult snippets <cmd> [args...]
  facult --show-duplicates

Commands:
  scan         Scan common config locations (Cursor, Claude, Claude Desktop, etc.)
  audit        Security audits (interactive by default; use --non-interactive for scripts)
  migrate      Copy/move a legacy canonical store to ~/agents/.facult
  consolidate  Deduplicate and copy skills + MCP configs (interactive or --auto)
  index        Build a queryable index from the canonical store (see FACULT_ROOT_DIR)
  list         List indexed skills, MCP servers, agents, or snippets
  show         Show a single indexed entry, including file contents
  adapters     List registered tool adapters
  trust        Mark a skill or MCP server as trusted (annotation only)
  untrust      Remove trusted annotation
  manage       Back up tool config and enter managed mode
  unmanage     Restore backups and exit managed mode
  managed      List tools in managed mode
  enable       Enable skills or MCP servers for tools
  disable      Disable skills or MCP servers for tools
  sync         Sync managed tools with canonical configs
  search       Search remote indices (builtin + provider aliases + configured)
  install      Install an item from a remote index
  update       Check/apply updates for remotely installed items
  sources      Manage source trust policy for remote indices
  templates    Scaffold DX-first templates (skills/instructions/MCP/snippets)
  snippets     Sync reusable snippet blocks into config files

Options:
  --json              Print full JSON (ScanResult or list output)
  --show-duplicates   Print duplicates for skills, MCP servers, and hook assets
  --tui               Render scan output in an interactive TUI (skills list)
  --from              Add one or more additional scan roots (repeatable): --from ~/dev
  --from-ignore       (scan) Ignore directories by basename under --from roots (repeatable)
  --from-no-default-ignore  (scan) Disable the default ignore list for --from scans
  --from-max-visits   (scan) Max directories visited per --from root before truncating
  --from-max-results  (scan) Max discovered paths per --from root before truncating
  --non-interactive   (audit) Run static/agent audit non-interactively (for scripts)
  --severity          Minimum severity to include in audit output (low|medium|high|critical)
  --rules             Path to an audit rules YAML file (default: ~/.facult/audit-rules.yaml)
  --with              (audit) Agent tool: claude|codex
  --max-items         (audit) Max items to send to the agent (n|all)
  --force             Re-copy items already consolidated OR rebuild index from scratch
  --auto              Auto-resolve consolidate conflicts: keep-newest, keep-current, keep-incoming
  --enabled-for       Filter list to entries enabled for a specific tool
  --untrusted         Filter list to entries that are not trusted
  --flagged           Filter list to entries flagged by audit
  --pending           Filter list to entries pending audit
  --for               Comma-separated list of tools for enable/disable
  --dry-run           Show what sync would change
  --as                Install/scaffold target name override
  --limit             Max results for search
  --apply             Apply updates (update command)
  --strict-source-trust  Enforce trust-only remote install/update actions
  --show-secrets      (show) Print raw secret values (unsafe)
`);
}

function printListHelp() {
  console.log(`facult list — list indexed entries from the canonical store

Usage:
  facult list [skills|mcp|agents|snippets] [options]

Options:
  --enabled-for TOOL  Only include entries enabled for a tool
  --untrusted         Only include entries that are not trusted
  --flagged           Only include entries flagged by audit
  --pending           Only include entries pending audit
  --json              Print JSON array
`);
}

function printShowHelp() {
  console.log(`facult show — show a single indexed entry (and file contents)

Usage:
  facult show <name>
  facult show mcp:<name> [--show-secrets]

Options:
  --show-secrets      (mcp) Print raw secret values (unsafe)
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
    if (arg === "--pending") {
      filters.pending = true;
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
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printListHelp();
    return;
  }

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
      const meta = skill as SkillEntry & {
        trusted?: boolean;
        auditStatus?: string;
      };
      const trustedLabel = meta.trusted === true ? "trusted" : "untrusted";
      const auditLabel = (meta.auditStatus ?? "pending").trim().toLowerCase();
      console.log(
        `${skill.name}${desc}\t[${trustedLabel}; audit=${auditLabel}]`
      );
    } else if (opts.kind === "mcp") {
      const meta = entry as McpEntry & {
        trusted?: boolean;
        auditStatus?: string;
      };
      const trustedLabel = meta.trusted === true ? "trusted" : "untrusted";
      const auditLabel = (meta.auditStatus ?? "pending").trim().toLowerCase();
      console.log(`${entry.name}\t[${trustedLabel}; audit=${auditLabel}]`);
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

const SECRET_KEY_RE = /(TOKEN|KEY|SECRET|PASSWORD|PASS|BEARER)/i;
const SECRETY_STRING_RE =
  /\b(sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g;

function redactPossibleSecrets(value: string): string {
  return value.replace(SECRETY_STRING_RE, "<redacted>");
}

function sanitizeForDisplay(value: unknown): unknown {
  if (typeof value === "string") {
    return redactPossibleSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeForDisplay);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = "<redacted>";
    } else {
      out[k] = sanitizeForDisplay(v);
    }
  }
  return out;
}

async function showCommand(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printShowHelp();
    return;
  }

  let showSecrets = false;
  let raw: string | null = null;
  for (const arg of argv) {
    if (!arg) {
      continue;
    }
    if (arg === "--show-secrets") {
      showSecrets = true;
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}`);
      process.exitCode = 1;
      return;
    }
    if (raw) {
      console.error("show accepts a single name");
      process.exitCode = 1;
      return;
    }
    raw = arg;
  }
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

  const displayEntry =
    kind === "mcp" && !showSecrets ? sanitizeForDisplay(entry) : entry;
  let displayContents = contents;
  if (kind === "mcp" && !showSecrets) {
    if (contentPath.endsWith(".json")) {
      try {
        const parsed = parseJsonLenient(contents);
        displayContents = `${JSON.stringify(sanitizeForDisplay(parsed), null, 2)}\n`;
      } catch {
        displayContents = redactPossibleSecrets(contents);
      }
    } else {
      displayContents = redactPossibleSecrets(contents);
    }
  }

  console.log(`${kind}:${entry.name}`);
  console.log(JSON.stringify(displayEntry, null, 2));
  console.log("\n---\n");
  console.log(displayContents);
}

function adaptersCommand(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(
      "facult adapters — list registered tool adapters\n\nUsage:\n  facult adapters\n"
    );
    return;
  }
  const adapters = getAllAdapters();
  if (!adapters.length) {
    console.log("No adapters registered.");
    return;
  }
  for (const adapter of adapters) {
    const versions = adapter.versions.join(", ");
    console.log(`${adapter.id}\t${versions}`);
  }
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
    case "audit":
      await auditCommand(rest);
      return;
    case "migrate":
      await migrateCommand(rest);
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
    case "adapters":
      await adaptersCommand(rest);
      return;
    case "trust":
      await trustCommand(rest);
      return;
    case "untrust":
      await untrustCommand(rest);
      return;
    case "manage":
      await manageCommand(rest);
      return;
    case "unmanage":
      await unmanageCommand(rest);
      return;
    case "managed":
      await managedCommand(rest);
      return;
    case "enable":
      await enableCommand(rest);
      return;
    case "disable":
      await disableCommand(rest);
      return;
    case "sync":
      await syncCommand(rest);
      return;
    case "search":
      await searchCommand(rest);
      return;
    case "install":
      await installCommand(rest);
      return;
    case "update":
      await updateCommand(rest);
      return;
    case "templates":
      await templatesCommand(rest);
      return;
    case "sources":
      await sourcesCommand(rest);
      return;
    case "snippets":
      await snippetsCommand(rest);
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
