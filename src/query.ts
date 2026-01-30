import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentEntry,
  FacultIndex,
  McpEntry,
  SkillEntry,
  SnippetEntry,
} from "./index-builder";
import { tackleboxRootDir } from "./index-builder";

export interface QueryFilters {
  /** Only include entries enabled for this tool name. */
  enabledFor?: string;
  /** Only include entries that are not trusted. */
  untrusted?: boolean;
  /** Only include entries flagged by audit. */
  flagged?: boolean;
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

/**
 * Return the canonical tacklebox root directory (defaults to ~/agents/.tb).
 */
export function tackleboxRootDirPath(home: string = homedir()): string {
  return tackleboxRootDir(home);
}

/**
 * Return the path to the tacklebox index.json file.
 */
export function tackleboxIndexPath(home: string = homedir()): string {
  return join(tackleboxRootDir(home), "index.json");
}

/**
 * Load the tacklebox index.json into memory.
 */
export async function loadIndex(opts?: {
  /** Override the default ~/agents/.tb root (useful for tests). */
  rootDir?: string;
}): Promise<FacultIndex> {
  const root = opts?.rootDir ?? tackleboxRootDir();
  const indexPath = join(root, "index.json");
  const file = Bun.file(indexPath);
  if (!(await file.exists())) {
    throw new Error(`Index not found at ${indexPath}. Run "facult index".`);
  }
  const raw = await file.text();
  return JSON.parse(raw) as FacultIndex;
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
    .filter((entry) => matchesTags(entry, filters?.tags))
    .filter((entry) => matchesText(entry, filters?.text))
    .sort((a, b) => a.name.localeCompare(b.name));
}
