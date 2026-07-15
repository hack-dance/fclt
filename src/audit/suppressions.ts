import { closeSync, fstatSync, lstatSync, type Stats } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";
import { type FacultConfig, facultStateDir } from "../paths";
import type { AgentAuditReport } from "./agent";
import {
  auditReportPersistenceSupported,
  openOrCreatePrivateDirectory,
  replacePrivateFileAt,
} from "./safe-openat";
import { computeStoredAuditStatus, isStoredAuditStatusPassed } from "./status";
import type {
  AuditFinding,
  AuditItemResult,
  Severity,
  StaticAuditReport,
} from "./types";

const RULE_ID_PREFIX_RE = /^(static|agent):/;
const SUPPRESSION_STORE_MAX_BYTES = 4 * 1024 * 1024;

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
  return parseAuditSuppressionStore(text);
}

function parseAuditSuppressionStore(text: string): AuditSuppressionStore {
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

function privateDirectoryIsSafe(metadata: Stats): boolean {
  const expectedOwner = process.getuid?.();
  const permissions = metadata.mode % 0o1000;
  const group = Math.floor(permissions / 8) % 8;
  const other = permissions % 8;
  const groupOrOtherWritable =
    Math.floor(group / 2) % 2 === 1 || Math.floor(other / 2) % 2 === 1;
  return (
    metadata.isDirectory() &&
    !metadata.isSymbolicLink() &&
    expectedOwner !== undefined &&
    metadata.uid === expectedOwner &&
    !groupOrOtherWritable
  );
}

async function canonicalDirectoryForCreation(path: string): Promise<string> {
  let ancestor = path;
  while (true) {
    try {
      lstatSync(ancestor);
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw new Error("Audit suppression directory has no safe ancestor");
      }
      ancestor = parent;
    }
  }
  const canonicalAncestor = await realpath(ancestor);
  return resolve(canonicalAncestor, relative(ancestor, path));
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
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeStoreCommit?: () => Promise<void>;
  expectedPriorSha256?: string | null;
  selected: { result: AuditItemResult; finding: AuditFinding }[];
  homeDir?: string;
  note?: string;
  storePath?: string;
}): Promise<{ added: number; total: number }> {
  if (!auditReportPersistenceSupported()) {
    throw new Error(
      `Audit suppression persistence is unavailable on ${process.platform}`
    );
  }
  const homeDir = args.homeDir ?? homedir();
  const storePath = exactSuppressionStorePath({
    homeDir,
    storePath: args.storePath,
  });
  const storeDirectory = dirname(storePath);
  const canonicalPath = await canonicalDirectoryForCreation(storeDirectory);
  const directoryFd = openOrCreatePrivateDirectory(canonicalPath);
  const pathMetadata = lstatSync(canonicalPath);
  const lexicalCanonicalPath = await realpath(storeDirectory).catch(() => null);
  if (
    !privateDirectoryIsSafe(pathMetadata) ||
    lexicalCanonicalPath !== canonicalPath
  ) {
    throw new Error("Audit suppression directory is unsafe");
  }
  const assertDirectoryBinding = async (): Promise<void> => {
    const opened = fstatSync(directoryFd);
    const current = (() => {
      try {
        return lstatSync(canonicalPath);
      } catch {
        return null;
      }
    })();
    const [currentCanonical, currentLexicalCanonical] = await Promise.all([
      realpath(canonicalPath).catch(() => null),
      realpath(storeDirectory).catch(() => null),
    ]);
    const currentIsSafe = current !== null && privateDirectoryIsSafe(current);
    if (
      !(privateDirectoryIsSafe(opened) && currentIsSafe) ||
      opened.dev !== pathMetadata.dev ||
      opened.ino !== pathMetadata.ino ||
      current?.dev !== pathMetadata.dev ||
      current?.ino !== pathMetadata.ino ||
      currentCanonical !== canonicalPath ||
      currentLexicalCanonical !== canonicalPath
    ) {
      throw new Error("Audit suppression directory changed during update");
    }
  };
  let added = 0;
  let total = 0;
  try {
    await assertDirectoryBinding();
    await replacePrivateFileAt({
      beforeCommit: async () => {
        await args.beforeStoreCommit?.();
        await assertDirectoryBinding();
      },
      directoryFd,
      expectedPriorSha256: args.expectedPriorSha256,
      fileName: "suppressions.json",
      maxBytes: SUPPRESSION_STORE_MAX_BYTES,
      transform: (contents) => {
        const store = contents
          ? parseAuditSuppressionStore(contents)
          : {
              version: 1 as const,
              updatedAt: new Date(0).toISOString(),
              entries: [],
            };
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
        const entries = [...next.values()].sort((a, b) =>
          a.key.localeCompare(b.key)
        );
        added = Math.max(0, entries.length - store.entries.length);
        total = entries.length;
        return `${JSON.stringify(
          { version: 1, updatedAt: createdAt, entries },
          null,
          2
        )}\n`;
      },
    });
    return { added, total };
  } finally {
    closeSync(directoryFd);
  }
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
