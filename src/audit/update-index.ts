import { homedir } from "node:os";
import { ensureAiIndexPath } from "../ai-state";
import type { FacultIndex } from "../index-builder";
import { facultAiIndexPath, facultRootDir } from "../paths";
import type { AuditItemResult, Severity } from "./types";
import { SEVERITY_ORDER } from "./types";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function ensureIndexStructure(index: FacultIndex): FacultIndex {
  return {
    version: index.version ?? 1,
    updatedAt: index.updatedAt ?? new Date().toISOString(),
    skills: index.skills ?? {},
    mcp: index.mcp ?? { servers: {} },
    agents: index.agents ?? {},
    snippets: index.snippets ?? {},
  };
}

function computeAuditStatus(
  findings: { severity: Severity; ruleId: string }[]
): "pending" | "passed" | "flagged" {
  if (findings.some((f) => f.ruleId === "agent-error")) {
    return "pending";
  }
  const worst = findings.reduce(
    (m, f) => Math.max(m, SEVERITY_ORDER[f.severity]),
    -1
  );
  return worst >= SEVERITY_ORDER.high ? "flagged" : "passed";
}

async function loadIndex(homeDir: string): Promise<FacultIndex | null> {
  const { path: indexPath } = await ensureAiIndexPath({
    homeDir,
    rootDir: facultRootDir(homeDir),
    repair: true,
  });
  const file = Bun.file(indexPath);
  if (!(await file.exists())) {
    return null;
  }
  try {
    return JSON.parse(await file.text()) as FacultIndex;
  } catch {
    return null;
  }
}

async function writeIndex(homeDir: string, index: FacultIndex) {
  const indexPath = facultAiIndexPath(homeDir);
  await Bun.write(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

export async function updateIndexFromAuditReport(opts: {
  homeDir?: string;
  timestamp: string;
  results: AuditItemResult[];
}): Promise<{ updated: boolean; reason?: string }> {
  const home = opts.homeDir ?? homedir();
  const loaded = await loadIndex(home);
  if (!loaded) {
    return { updated: false, reason: "index-missing" };
  }

  const index = ensureIndexStructure(loaded);
  let changed = false;

  for (const r of opts.results) {
    if (r.type !== "skill" && r.type !== "mcp") {
      continue;
    }
    if (r.type === "skill") {
      const entry = index.skills[r.item] as unknown;
      if (!(entry && isPlainObject(entry))) {
        continue;
      }
      if (typeof entry.path === "string" && entry.path !== r.path) {
        // Only update the canonical instance tracked in the index.
        continue;
      }
      const status = computeAuditStatus(
        r.findings.map((f) => ({ severity: f.severity, ruleId: f.ruleId }))
      );
      entry.auditStatus = status;
      entry.lastAuditAt = opts.timestamp;
      changed = true;
      continue;
    }

    // MCP
    const entry = index.mcp?.servers?.[r.item] as unknown;
    if (!(entry && isPlainObject(entry))) {
      continue;
    }
    if (typeof entry.path === "string" && entry.path !== r.path) {
      continue;
    }
    const status = computeAuditStatus(
      r.findings.map((f) => ({ severity: f.severity, ruleId: f.ruleId }))
    );
    entry.auditStatus = status;
    entry.lastAuditAt = opts.timestamp;
    changed = true;
  }

  if (!changed) {
    return { updated: false, reason: "no-matching-items" };
  }

  index.updatedAt = new Date().toISOString();
  await writeIndex(home, index);
  return { updated: true };
}
