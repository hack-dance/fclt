import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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

function looksLikeFacultRoot(root: string): boolean {
  if (!dirExists(root)) {
    return false;
  }
  // Heuristic: treat as a facult store if it contains something we'd create.
  return (
    fileExists(join(root, "index.json")) ||
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

export function facultStateDir(home: string = homedir()): string {
  return join(home, ".facult");
}

export function facultConfigPath(home: string = homedir()): string {
  return join(facultStateDir(home), "config.json");
}

export function readFacultConfig(
  home: string = homedir()
): FacultConfig | null {
  const p = facultConfigPath(home);
  if (!(isSafePathString(p) && fileExists(p))) {
    return null;
  }

  try {
    const txt = readFileSync(p, "utf8");
    const parsed = parseJsonLenient(txt) as unknown;
    if (!isPlainObject(parsed)) {
      return null;
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
    return null;
  }
}

/**
 * Return the canonical facult root directory.
 *
 * Precedence:
 * 1) `FACULT_ROOT_DIR` env var
 * 2) `~/.facult/config.json` { "rootDir": "..." }
 * 3) `~/agents/.facult` (if it looks like a store)
 * 4) a legacy store under `~/agents/` (if it looks like a store)
 * 5) default: `~/agents/.facult`
 */
export function facultRootDir(home: string = homedir()): string {
  const envRoot = process.env.FACULT_ROOT_DIR?.trim();
  if (envRoot) {
    const resolved = resolvePath(envRoot, home);
    return isSafePathString(resolved)
      ? resolved
      : join(home, "agents", ".facult");
  }

  const cfg = readFacultConfig(home);
  const cfgRoot = cfg?.rootDir?.trim();
  if (cfgRoot) {
    const resolved = resolvePath(cfgRoot, home);
    return isSafePathString(resolved)
      ? resolved
      : join(home, "agents", ".facult");
  }

  const preferred = join(home, "agents", ".facult");

  if (looksLikeFacultRoot(preferred)) {
    return preferred;
  }
  const legacy = detectLegacyStoreUnderAgents(home);
  if (legacy) {
    return legacy;
  }
  return preferred;
}
