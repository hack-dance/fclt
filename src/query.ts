import { homedir } from "node:os";
import { ensureAiIndexPath } from "./ai-state";
import type {
  AgentEntry,
  FacultIndex,
  McpEntry,
  SkillEntry,
  SnippetEntry,
} from "./index-builder";
import { facultAiIndexPath, facultRootDir } from "./paths";
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
}

interface IndexEntry {
  name: string;
  description?: string;
  tags?: string[];
  enabledFor?: string[];
  trusted?: boolean;
  auditStatus?: string;
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
    return false;
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

/** Return the canonical facult root directory. */
export function facultRootDirPath(home: string = homedir()): string {
  return facultRootDir(home);
}

/**
 * Return the path to the facult index.json file.
 */
export function facultIndexPath(home: string = homedir()): string {
  return facultAiIndexPath(home);
}

/**
 * Load the facult index.json into memory.
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
  const rootDir = opts?.rootDir ?? facultRootDir(resolvedHome);
  const { path: indexPath } = await ensureAiIndexPath({
    homeDir: resolvedHome,
    rootDir,
    repair: true,
  });
  const file = Bun.file(indexPath);
  if (!(await file.exists())) {
    throw new Error(`Index not found at ${indexPath}. Run "facult index".`);
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

function filterEntries<T extends IndexEntry>(
  entries: Record<string, T>,
  filters?: QueryFilters
): T[] {
  return Object.values(entries)
    .filter((entry) => matchesEnabledFor(entry, filters?.enabledFor))
    .filter((entry) => matchesUntrusted(entry, filters?.untrusted))
    .filter((entry) => matchesFlagged(entry, filters?.flagged))
    .filter((entry) => matchesPending(entry, filters?.pending))
    .filter((entry) => matchesTags(entry, filters?.tags))
    .filter((entry) => matchesText(entry, filters?.text))
    .sort((a, b) => a.name.localeCompare(b.name));
}
