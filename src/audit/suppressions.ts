import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { type FacultConfig, facultStateDir } from "../paths";
import type { AgentAuditReport } from "./agent";
import { computeStoredAuditStatus, isStoredAuditStatusPassed } from "./status";
import type {
  AuditFinding,
  AuditItemResult,
  Severity,
  StaticAuditReport,
} from "./types";

const RULE_ID_PREFIX_RE = /^(static|agent):/;

export interface AuditSuppressionEntry {
  key: string;
  createdAt: string;
  type: AuditItemResult["type"];
  item: string;
  path: string;
  finding: {
    severity: Severity;
    ruleId: string;
    message: string;
    location?: string;
  };
  note?: string;
}

export interface AuditSuppressionStore {
  version: 1;
  updatedAt: string;
  entries: AuditSuppressionEntry[];
}

function normalizeRuleId(ruleId: string): string {
  return ruleId.replace(RULE_ID_PREFIX_RE, "");
}

function normalizedFindingSignature(args: {
  type: AuditItemResult["type"];
  item: string;
  path: string;
  finding: Pick<AuditFinding, "severity" | "ruleId" | "message" | "location">;
}): string {
  return JSON.stringify({
    type: args.type,
    item: args.item,
    path: args.path,
    severity: args.finding.severity,
    ruleId: normalizeRuleId(args.finding.ruleId),
    message: args.finding.message,
    location: args.finding.location ?? "",
  });
}

function suppressionsPath(
  homeDir: string,
  rootDir?: string,
  config?: FacultConfig | null
): string {
  return join(
    facultStateDir(homeDir, rootDir, config),
    "audit",
    "suppressions.json"
  );
}

function exactSuppressionStorePath(args: {
  config?: FacultConfig | null;
  homeDir: string;
  rootDir?: string;
  storePath?: string;
}): string {
  const path =
    args.storePath ?? suppressionsPath(args.homeDir, args.rootDir, args.config);
  if (!isAbsolute(path) || normalize(resolve(path)) !== path) {
    throw new Error(
      "Audit suppression store path must be canonical and absolute"
    );
  }
  return path;
}

export function createAuditSuppressionEntry(args: {
  result: AuditItemResult;
  finding: AuditFinding;
  createdAt?: string;
  note?: string;
}): AuditSuppressionEntry {
  const createdAt = args.createdAt ?? new Date().toISOString();
  return {
    key: normalizedFindingSignature({
      type: args.result.type,
      item: args.result.item,
      path: args.result.path,
      finding: args.finding,
    }),
    createdAt,
    type: args.result.type,
    item: args.result.item,
    path: args.result.path,
    finding: {
      severity: args.finding.severity,
      ruleId: args.finding.ruleId,
      message: args.finding.message,
      location: args.finding.location,
    },
    note: args.note?.trim() ? args.note.trim() : undefined,
  };
}

async function loadAuditSuppressionStore(
  homeDir: string,
  readOptionalText?: (path: string) => Promise<string | null>,
  rootDir?: string,
  config?: FacultConfig | null,
  storePath?: string
): Promise<AuditSuppressionStore> {
  const path = exactSuppressionStorePath({
    config,
    homeDir,
    rootDir,
    storePath,
  });
  const text = readOptionalText
    ? await readOptionalText(path)
    : (await Bun.file(path).exists())
      ? await Bun.file(path).text()
      : null;
  if (text === null) {
    return {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      entries: [],
    };
  }
  try {
    const parsed = JSON.parse(text) as Partial<AuditSuppressionStore>;
    return {
      version: 1,
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date(0).toISOString(),
      entries: Array.isArray(parsed.entries)
        ? parsed.entries.filter(
            (entry): entry is AuditSuppressionEntry =>
              !!entry &&
              typeof entry === "object" &&
              typeof (entry as AuditSuppressionEntry).key === "string"
          )
        : [],
    };
  } catch {
    return {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      entries: [],
    };
  }
}

async function writeAuditSuppressionStore(
  homeDir: string,
  store: AuditSuppressionStore,
  options?: {
    config?: FacultConfig | null;
    rootDir?: string;
    storePath?: string;
  }
) {
  const path = exactSuppressionStorePath({
    config: options?.config,
    homeDir,
    rootDir: options?.rootDir,
    storePath: options?.storePath,
  });
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(store, null, 2)}\n`);
}

export async function loadAuditSuppressions(
  homeDir = homedir(),
  readOptionalText?: (path: string) => Promise<string | null>,
  rootDir?: string,
  config?: FacultConfig | null,
  storePath?: string
): Promise<AuditSuppressionEntry[]> {
  return (
    await loadAuditSuppressionStore(
      homeDir,
      readOptionalText,
      rootDir,
      config,
      storePath
    )
  ).entries;
}

export async function recordAuditSuppressions(args: {
  selected: { result: AuditItemResult; finding: AuditFinding }[];
  homeDir?: string;
  note?: string;
  storePath?: string;
}): Promise<{ added: number; total: number }> {
  const homeDir = args.homeDir ?? homedir();
  const store = await loadAuditSuppressionStore(
    homeDir,
    undefined,
    undefined,
    undefined,
    args.storePath
  );
  const next = new Map(store.entries.map((entry) => [entry.key, entry]));
  const createdAt = new Date().toISOString();

  for (const selection of args.selected) {
    const entry = createAuditSuppressionEntry({
      result: selection.result,
      finding: selection.finding,
      createdAt,
      note: args.note,
    });
    next.set(entry.key, entry);
  }

  const entries = [...next.values()].sort((a, b) => a.key.localeCompare(b.key));
  await writeAuditSuppressionStore(
    homeDir,
    {
      version: 1,
      updatedAt: createdAt,
      entries,
    },
    { storePath: args.storePath }
  );

  return {
    added: Math.max(0, entries.length - store.entries.length),
    total: entries.length,
  };
}

export function applyAuditSuppressionsToResults(args: {
  results: AuditItemResult[];
  suppressions: AuditSuppressionEntry[];
}): AuditItemResult[] {
  if (args.suppressions.length === 0) {
    return args.results;
  }
  const suppressedKeys = new Set(args.suppressions.map((entry) => entry.key));
  return args.results.map((result) => {
    const findings = result.findings.filter(
      (finding) =>
        !suppressedKeys.has(
          normalizedFindingSignature({
            type: result.type,
            item: result.item,
            path: result.path,
            finding,
          })
        )
    );
    const status = computeStoredAuditStatus(findings);
    return {
      ...result,
      passed: isStoredAuditStatusPassed(status),
      findings,
    };
  });
}

function summarizeResults(results: AuditItemResult[]): {
  totalItems: number;
  totalFindings: number;
  bySeverity: Record<Severity, number>;
  flaggedItems: number;
} {
  const bySeverity: Record<Severity, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  let totalFindings = 0;
  let flaggedItems = 0;

  for (const result of results) {
    totalFindings += result.findings.length;
    if (!result.passed && result.findings.length > 0) {
      flaggedItems += 1;
    }
    for (const finding of result.findings) {
      bySeverity[finding.severity] += 1;
    }
  }

  return {
    totalItems: results.length,
    totalFindings,
    bySeverity,
    flaggedItems,
  };
}

export function applyAuditSuppressionsToStaticReport(
  report: StaticAuditReport,
  suppressions: AuditSuppressionEntry[]
): StaticAuditReport {
  const results = applyAuditSuppressionsToResults({
    results: report.results,
    suppressions,
  });
  return {
    ...report,
    results,
    summary: summarizeResults(results),
  };
}

export function applyAuditSuppressionsToAgentReport(
  report: AgentAuditReport,
  suppressions: AuditSuppressionEntry[]
): AgentAuditReport {
  const results = applyAuditSuppressionsToResults({
    results: report.results,
    suppressions,
  });
  return {
    ...report,
    results,
    summary: summarizeResults(results),
  };
}
