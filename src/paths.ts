import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseJsonLenient } from "./util/json";

export interface FacultConfig {
  /**
   * Override the canonical root directory.
   *
   * This is where facult stores the consolidated "canonical" skill + MCP state
   * (skills/, mcp/, snippets/, index.json, ...).
   */
  rootDir?: string;

  /**
   * Default scan roots (equivalent to passing `facult scan --from <path>`).
   * Example: ["~", "~/dev", "~/work"]
   */
  scanFrom?: string[];

  /**
   * Extra ignore directory basenames applied under `scanFrom` roots.
   * Example: ["vendor", ".venv"]
   */
  scanFromIgnore?: string[];

  /** Disable the default ignore list for `scanFrom` roots. */
  scanFromNoDefaultIgnore?: boolean;

  /** Default max directories visited per scanFrom root (same as --from-max-visits). */
  scanFromMaxVisits?: number;

  /** Default max discovered paths per scanFrom root (same as --from-max-results). */
  scanFromMaxResults?: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isSafePathString(p: string): boolean {
  // Protect filesystem APIs from null-byte paths.
  return !p.includes("\0");
}

function defaultHomeDir(): string {
  const fromEnv = process.env.HOME?.trim();
  return fromEnv || homedir();
}

function expandHomePath(p: string, home: string): string {
  if (p === "~") {
    return home;
  }
  if (p.startsWith("~/")) {
    return join(home, p.slice(2));
  }
  return p;
}

function resolvePath(p: string, home: string): string {
  const expanded = expandHomePath(p, home);
  return expanded.startsWith("/") ? expanded : resolve(expanded);
}

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function legacyPreferredRoot(home: string): string {
  return join(home, "agents", ".facult");
}

export function preferredGlobalAiRoot(home: string = defaultHomeDir()): string {
  return join(home, ".ai");
}

export function preferredGlobalFacultStateDir(
  home: string = defaultHomeDir()
): string {
  return join(preferredGlobalAiRoot(home), ".facult");
}

export function legacyExternalFacultStateDir(
  home: string = defaultHomeDir()
): string {
  return join(home, ".facult");
}

function isLegacyConfiguredRoot(root: string, home: string): boolean {
  return resolve(root) === resolve(legacyPreferredRoot(home));
}

function looksLikeFacultRoot(root: string): boolean {
  if (!dirExists(root)) {
    return false;
  }
  // Heuristic: treat as a facult store if it contains something we'd create.
  return (
    dirExists(join(root, "rules")) ||
    dirExists(join(root, "instructions")) ||
    dirExists(join(root, "agents")) ||
    dirExists(join(root, "skills")) ||
    dirExists(join(root, "mcp")) ||
    dirExists(join(root, "snippets"))
  );
}

function detectLegacyStoreUnderAgents(home: string): string | null {
  const agentsDir = join(home, "agents");
  let entries: any[];
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates: string[] = [];
  for (const ent of entries) {
    if (!ent?.isDirectory?.()) {
      continue;
    }
    const name = String(ent.name ?? "");
    if (!name || name === ".facult") {
      continue;
    }
    const abs = join(agentsDir, name);
    if (looksLikeFacultRoot(abs)) {
      candidates.push(abs);
    }
  }

  // Only auto-select when there is exactly one candidate.
  // If there are multiple, require explicit config/env to choose.
  candidates.sort();
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

export function legacyFacultStateDirForRoot(
  rootDir: string,
  home: string = defaultHomeDir()
): string {
  const projectRoot = projectRootFromAiRoot(rootDir, home);
  return projectRoot
    ? join(projectRoot, ".facult")
    : legacyExternalFacultStateDir(home);
}

function shouldUsePreferredGlobalStateDir(
  rootDir: string,
  home: string
): boolean {
  const resolved = resolve(rootDir);
  if (projectRootFromAiRoot(resolved, home)) {
    return false;
  }
  if (resolved === resolve(preferredGlobalAiRoot(home))) {
    return true;
  }
  if (resolved === resolve(legacyPreferredRoot(home))) {
    return true;
  }
  return resolved.startsWith(`${resolve(join(home, "agents"))}/`);
}

export function facultStateDir(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  const resolvedRoot = rootDir ?? facultRootDir(home);
  if (shouldUsePreferredGlobalStateDir(resolvedRoot, home)) {
    return preferredGlobalFacultStateDir(home);
  }
  return join(resolvedRoot, ".facult");
}

export function projectRootFromAiRoot(
  rootDir: string,
  home: string = defaultHomeDir()
): string | null {
  const resolved = resolve(rootDir);
  if (resolved === resolve(join(home, ".ai"))) {
    return null;
  }
  if (resolved === resolve(legacyPreferredRoot(home))) {
    return null;
  }
  return resolved.endsWith("/.ai") ? dirname(resolved) : null;
}

export function projectSlugFromAiRoot(
  rootDir: string,
  home: string = defaultHomeDir()
): string | null {
  const projectRoot = projectRootFromAiRoot(rootDir, home);
  if (!projectRoot) {
    return null;
  }
  const base = basename(projectRoot).trim().toLowerCase();
  const slug = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "project";
}

export function facultGeneratedStateDir(args?: {
  home?: string;
  rootDir?: string;
}): string {
  const home = args?.home ?? defaultHomeDir();
  return facultStateDir(home, args?.rootDir);
}

export function facultAiStateDir(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(facultGeneratedStateDir({ home, rootDir }), "ai");
}

export function facultAiIndexPath(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(facultAiStateDir(home, rootDir), "index.json");
}

export function facultAiGraphPath(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(facultAiStateDir(home, rootDir), "graph.json");
}

export function facultAiRuntimeScopeDir(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(
    facultAiStateDir(home, rootDir),
    projectRootFromAiRoot(rootDir ?? facultRootDir(home), home)
      ? "project"
      : "global"
  );
}

export function facultAiJournalPath(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(
    facultAiRuntimeScopeDir(home, rootDir),
    "journal",
    "events.jsonl"
  );
}

export function facultAiWritebackQueuePath(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(
    facultAiRuntimeScopeDir(home, rootDir),
    "writeback",
    "queue.jsonl"
  );
}

export function facultAiProposalDir(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(facultAiRuntimeScopeDir(home, rootDir), "evolution", "proposals");
}

export function facultAiDraftDir(
  home: string = defaultHomeDir(),
  rootDir?: string
): string {
  return join(facultAiRuntimeScopeDir(home, rootDir), "evolution", "drafts");
}

export function facultConfigPath(home: string = defaultHomeDir()): string {
  return join(preferredGlobalFacultStateDir(home), "config.json");
}

export function readFacultConfig(
  home: string = defaultHomeDir()
): FacultConfig | null {
  const candidates = [
    facultConfigPath(home),
    join(legacyExternalFacultStateDir(home), "config.json"),
  ];

  for (const p of candidates) {
    if (!(isSafePathString(p) && fileExists(p))) {
      continue;
    }

    try {
      const txt = readFileSync(p, "utf8");
      const parsed = parseJsonLenient(txt) as unknown;
      if (!isPlainObject(parsed)) {
        continue;
      }
      const rootDir =
        typeof parsed.rootDir === "string" ? parsed.rootDir : undefined;

      const scanFromRaw = (parsed as Record<string, unknown>).scanFrom;
      const scanFrom = Array.isArray(scanFromRaw)
        ? scanFromRaw
            .filter((v) => typeof v === "string")
            .map((v) => v.trim())
            .filter(Boolean)
        : undefined;

      const scanFromIgnoreRaw = (parsed as Record<string, unknown>)
        .scanFromIgnore;
      const scanFromIgnore = Array.isArray(scanFromIgnoreRaw)
        ? scanFromIgnoreRaw
            .filter((v) => typeof v === "string")
            .map((v) => v.trim())
            .filter(Boolean)
        : undefined;

      const scanFromNoDefaultIgnore =
        typeof (parsed as Record<string, unknown>).scanFromNoDefaultIgnore ===
        "boolean"
          ? ((parsed as Record<string, unknown>)
              .scanFromNoDefaultIgnore as boolean)
          : undefined;

      const scanFromMaxVisitsRaw = (parsed as Record<string, unknown>)
        .scanFromMaxVisits;
      const scanFromMaxVisits =
        typeof scanFromMaxVisitsRaw === "number" &&
        Number.isFinite(scanFromMaxVisitsRaw) &&
        scanFromMaxVisitsRaw > 0
          ? Math.floor(scanFromMaxVisitsRaw)
          : undefined;

      const scanFromMaxResultsRaw = (parsed as Record<string, unknown>)
        .scanFromMaxResults;
      const scanFromMaxResults =
        typeof scanFromMaxResultsRaw === "number" &&
        Number.isFinite(scanFromMaxResultsRaw) &&
        scanFromMaxResultsRaw > 0
          ? Math.floor(scanFromMaxResultsRaw)
          : undefined;

      return {
        rootDir,
        scanFrom,
        scanFromIgnore,
        scanFromNoDefaultIgnore,
        scanFromMaxVisits,
        scanFromMaxResults,
      };
    } catch {
      // Ignore invalid config files and continue to the next fallback path.
    }
  }

  return null;
}

/**
 * Return the canonical facult root directory.
 *
 * Precedence:
 * 1) `FACULT_ROOT_DIR` env var
 * 2) `~/.ai/.facult/config.json` { "rootDir": "..." } (falls back to legacy `~/.facult/config.json`)
 * 3) `~/.ai` (if it looks like a store)
 * 4) `~/agents/.facult` (if it looks like a store)
 * 5) a legacy store under `~/agents/` (if it looks like a store)
 * 6) default: `~/.ai`
 */
export function facultRootDir(home: string = defaultHomeDir()): string {
  const envRoot = process.env.FACULT_ROOT_DIR?.trim();
  const preferred = join(home, ".ai");

  if (envRoot) {
    const resolved = resolvePath(envRoot, home);
    return isSafePathString(resolved) ? resolved : preferred;
  }

  const cfg = readFacultConfig(home);
  const cfgRoot = cfg?.rootDir?.trim();
  if (cfgRoot) {
    const resolved = resolvePath(cfgRoot, home);
    if (!isSafePathString(resolved)) {
      return preferred;
    }
    if (
      isLegacyConfiguredRoot(resolved, home) &&
      looksLikeFacultRoot(preferred)
    ) {
      return preferred;
    }
    return resolved;
  }

  if (looksLikeFacultRoot(preferred)) {
    return preferred;
  }
  const legacyPreferred = legacyPreferredRoot(home);
  if (looksLikeFacultRoot(legacyPreferred)) {
    return legacyPreferred;
  }
  const legacy = detectLegacyStoreUnderAgents(home);
  if (legacy) {
    return legacy;
  }
  return preferred;
}

export function findNearestProjectAiRoot(start: string): string | null {
  let current = resolve(start);
  while (true) {
    const candidate = join(current, ".ai");
    if (looksLikeFacultRoot(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function facultContextRootDir(args?: {
  home?: string;
  cwd?: string;
}): string {
  const home = args?.home ?? defaultHomeDir();
  const envRoot = process.env.FACULT_ROOT_DIR?.trim();
  if (envRoot) {
    const resolved = resolvePath(envRoot, home);
    return isSafePathString(resolved) ? resolved : join(home, ".ai");
  }

  const cwd = args?.cwd?.trim() || process.cwd();
  const projectRoot = findNearestProjectAiRoot(cwd);
  if (projectRoot) {
    return projectRoot;
  }

  return facultRootDir(home);
}
