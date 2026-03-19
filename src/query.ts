import { homedir } from "node:os";
import { ensureAiIndexPath } from "./ai-state";
import type { AssetScope, AssetSourceKind } from "./graph";
import type {
  AgentEntry,
  FacultIndex,
  InstructionEntry,
  McpEntry,
  SkillEntry,
  SnippetEntry,
} from "./index-builder";
import {
  facultAiIndexPath,
  facultContextRootDir,
  facultRootDir,
} from "./paths";
import { applyOrgTrustList } from "./trust-list";

export interface QueryFilters {
  /** Only include entries enabled for this tool name. */
  enabledFor?: string;
  /** Only include entries that are not trusted. */
  untrusted?: boolean;
  /** Only include entries flagged by audit. */
  flagged?: boolean;
  /** Only include entries pending audit. */
  pending?: boolean;
  /** Only include entries with all of these tags. */
  tags?: string[];
  /** Full-text search query (case-insensitive). */
  text?: string;
  /** Only include entries from a specific source layer. */
  sourceKind?: AssetSourceKind;
  /** Only include entries from a specific asset scope. */
  scope?: AssetScope;
}

interface IndexEntry {
  name: string;
  description?: string;
  tags?: string[];
  enabledFor?: string[];
  trusted?: boolean;
  auditStatus?: string;
  sourceKind?: AssetSourceKind;
  scope?: AssetScope;
}

export interface CapabilityMatch {
  kind: "skills" | "mcp" | "agents" | "snippets" | "instructions";
  name: string;
  path: string;
  description?: string;
  tags?: string[];
  sourceKind?: string;
  scope?: string;
}

const WHITESPACE_RE = /\s+/;

function normalizeText(v: string): string {
  return v.trim().toLowerCase();
}

function matchesEnabledFor(entry: IndexEntry, tool?: string): boolean {
  if (!tool) {
    return true;
  }
  const enabledFor = entry.enabledFor;
  if (!Array.isArray(enabledFor)) {
    return true;
  }
  const target = normalizeText(tool);
  return enabledFor.some((t) => normalizeText(t) === target);
}

function matchesUntrusted(entry: IndexEntry, untrusted?: boolean): boolean {
  if (!untrusted) {
    return true;
  }
  return entry.trusted !== true;
}

function matchesFlagged(entry: IndexEntry, flagged?: boolean): boolean {
  if (!flagged) {
    return true;
  }
  return normalizeText(entry.auditStatus ?? "") === "flagged";
}

function matchesPending(entry: IndexEntry, pending?: boolean): boolean {
  if (!pending) {
    return true;
  }
  const status = normalizeText(entry.auditStatus ?? "");
  // Treat missing auditStatus as pending for backward compatibility.
  return !status || status === "pending";
}

function matchesTags(entry: IndexEntry, tags?: string[]): boolean {
  if (!tags || tags.length === 0) {
    return true;
  }
  const entryTags = entry.tags ?? [];
  return tags.every((tag) =>
    entryTags.some((t) => normalizeText(t) === normalizeText(tag))
  );
}

function matchesText(entry: IndexEntry, text?: string): boolean {
  if (!text) {
    return true;
  }
  const haystack = `${entry.name} ${entry.description ?? ""} ${
    entry.tags?.join(" ") ?? ""
  }`.toLowerCase();
  const terms = text
    .split(WHITESPACE_RE)
    .map((t) => t.trim())
    .filter(Boolean);
  return terms.every((term) => haystack.includes(term.toLowerCase()));
}

function matchesSourceKind(
  entry: IndexEntry,
  sourceKind?: AssetSourceKind
): boolean {
  if (!sourceKind) {
    return true;
  }
  return entry.sourceKind === sourceKind;
}

function matchesScope(entry: IndexEntry, scope?: AssetScope): boolean {
  if (!scope) {
    return true;
  }
  return entry.scope === scope;
}

/** Return the canonical fclt root directory. */
export function facultRootDirPath(home: string = homedir()): string {
  return facultRootDir(home);
}

export function facultContextRootDirPath(home: string = homedir()): string {
  return facultContextRootDir({ home, cwd: process.cwd() });
}

/**
 * Return the path to the fclt index.json file.
 */
export function facultIndexPath(home: string = homedir()): string {
  return facultAiIndexPath(
    home,
    facultContextRootDir({ home, cwd: process.cwd() })
  );
}

/**
 * Load the fclt index.json into memory.
 */
export async function loadIndex(opts?: {
  /** Override the default canonical root dir (useful for tests). */
  rootDir?: string;
  /** Override home directory for org trust-list loading (useful for tests). */
  homeDir?: string;
}): Promise<FacultIndex> {
  const homeDir = opts?.homeDir;
  const resolvedHome = homeDir ?? process.env.HOME;
  if (!resolvedHome) {
    throw new Error("HOME is not set.");
  }
  const rootDir =
    opts?.rootDir ??
    facultContextRootDir({ home: resolvedHome, cwd: process.cwd() });
  const { path: indexPath } = await ensureAiIndexPath({
    homeDir: resolvedHome,
    rootDir,
    repair: true,
  });
  const file = Bun.file(indexPath);
  if (!(await file.exists())) {
    throw new Error(`Index not found at ${indexPath}. Run "fclt index".`);
  }
  const raw = await file.text();
  const parsed = JSON.parse(raw) as FacultIndex;
  return await applyOrgTrustList(parsed, { homeDir: resolvedHome });
}

/**
 * Filter skill entries using query filters.
 */
export function filterSkills(
  entries: Record<string, SkillEntry>,
  filters?: QueryFilters
): SkillEntry[] {
  return filterEntries(entries, filters);
}

/**
 * Filter MCP server entries using query filters.
 */
export function filterMcp(
  entries: Record<string, McpEntry>,
  filters?: QueryFilters
): McpEntry[] {
  return filterEntries(entries, filters);
}

/**
 * Filter agent entries using query filters.
 */
export function filterAgents(
  entries: Record<string, AgentEntry>,
  filters?: QueryFilters
): AgentEntry[] {
  return filterEntries(entries, filters);
}

/**
 * Filter snippet entries using query filters.
 */
export function filterSnippets(
  entries: Record<string, SnippetEntry>,
  filters?: QueryFilters
): SnippetEntry[] {
  return filterEntries(entries, filters);
}

/**
 * Filter instruction entries using query filters.
 */
export function filterInstructions(
  entries: Record<string, InstructionEntry>,
  filters?: QueryFilters
): InstructionEntry[] {
  return filterEntries(entries, filters);
}

export function findCapabilities(
  index: FacultIndex,
  filters: Pick<QueryFilters, "text" | "sourceKind" | "scope">
): CapabilityMatch[] {
  const results: CapabilityMatch[] = [];

  for (const entry of filterSkills(index.skills, filters)) {
    results.push({
      kind: "skills",
      name: entry.name,
      path: entry.path,
      description: entry.description,
      tags: entry.tags,
      sourceKind: entry.sourceKind,
      scope: entry.scope,
    });
  }

  for (const entry of filterMcp(index.mcp?.servers ?? {}, filters)) {
    results.push({
      kind: "mcp",
      name: entry.name,
      path: entry.path,
      sourceKind: entry.sourceKind,
      scope: entry.scope,
    });
  }

  for (const entry of filterAgents(index.agents ?? {}, filters)) {
    results.push({
      kind: "agents",
      name: entry.name,
      path: entry.path,
      description: entry.description,
      sourceKind: entry.sourceKind,
      scope: entry.scope,
    });
  }

  for (const entry of filterSnippets(index.snippets ?? {}, filters)) {
    results.push({
      kind: "snippets",
      name: entry.name,
      path: entry.path,
      description: entry.description,
      tags: entry.tags,
      sourceKind: entry.sourceKind,
      scope: entry.scope,
    });
  }

  for (const entry of filterInstructions(index.instructions ?? {}, filters)) {
    results.push({
      kind: "instructions",
      name: entry.name,
      path: entry.path,
      description: entry.description,
      tags: entry.tags,
      sourceKind: entry.sourceKind,
      scope: entry.scope,
    });
  }

  return results.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind.localeCompare(b.kind);
    }
    return a.name.localeCompare(b.name);
  });
}

function filterEntries<T extends IndexEntry>(
  entries: Record<string, T>,
  filters?: QueryFilters
): T[] {
  return Object.values(entries)
    .filter((entry) => matchesEnabledFor(entry, filters?.enabledFor))
    .filter((entry) => matchesUntrusted(entry, filters?.untrusted))
    .filter((entry) => matchesFlagged(entry, filters?.flagged))
    .filter((entry) => matchesPending(entry, filters?.pending))
    .filter((entry) => matchesSourceKind(entry, filters?.sourceKind))
    .filter((entry) => matchesScope(entry, filters?.scope))
    .filter((entry) => matchesTags(entry, filters?.tags))
    .filter((entry) => matchesText(entry, filters?.text))
    .sort((a, b) => a.name.localeCompare(b.name));
}
