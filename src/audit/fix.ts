import { homedir } from "node:os";
import { basename } from "node:path";
import {
  LEGACY_MANAGED_MUTATION_FLAG,
  legacyManagedMutationApproved,
} from "../legacy-mutation-policy";
import { facultContextRootDir } from "../paths";
import type { AgentAuditReport } from "./agent";
import { loadVerifiedAuditReport } from "./report-persistence";
import { computeStoredAuditStatus, isStoredAuditStatusPassed } from "./status";
import type { AuditFinding, AuditItemResult, StaticAuditReport } from "./types";

type AuditFixSource = "static" | "agent" | "combined";
const RULE_ID_PREFIX_RE = /^(static|agent):/;
const INLINE_SECRET_RULE_ID = "mcp-env-inline-secret";
const ARG_VALUE_SPLIT_RE = /=(.*)/s;
export const AUDIT_FIX_MUTATION_DISABLED_MESSAGE =
  "Audit fix mutation is disabled until a durable two-file recovery protocol is available. Run audit fix --dry-run to review matches; no files were changed.";

interface AuditFixArgs {
  all: boolean;
  dryRun: boolean;
  itemSelectors: string[];
  json: boolean;
  paths: string[];
  reportPaths: string[];
  source?: AuditFixSource;
  yes: boolean;
}

interface FindingSelection {
  result: AuditItemResult;
  finding: AuditFinding;
}

function normalizeRuleId(ruleId: string): string {
  return ruleId.replace(RULE_ID_PREFIX_RE, "");
}

function parseSource(value: string): AuditFixSource {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "static" ||
    normalized === "agent" ||
    normalized === "combined"
  ) {
    return normalized;
  }
  throw new Error(`Unknown audit fix source: ${value}`);
}

function parseAuditFixArgs(argv: string[]): AuditFixArgs {
  const args: AuditFixArgs = {
    all: false,
    dryRun: false,
    itemSelectors: [],
    json: false,
    paths: [],
    reportPaths: [],
    yes: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }

    if (arg === "--all") {
      args.all = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      args.yes = true;
      continue;
    }
    if (arg === LEGACY_MANAGED_MUTATION_FLAG) {
      continue;
    }

    if (
      arg === "--source" ||
      arg === "--item" ||
      arg === "--path" ||
      arg === "--report"
    ) {
      const next = argv[i + 1];
      if (!next) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--source") {
        args.source = parseSource(next);
      } else if (arg === "--item") {
        args.itemSelectors.push(next);
      } else if (arg === "--path") {
        args.paths.push(next);
      } else {
        args.reportPaths.push(next);
      }
      i += 1;
      continue;
    }

    if (
      arg.startsWith("--source=") ||
      arg.startsWith("--item=") ||
      arg.startsWith("--path=") ||
      arg.startsWith("--report=")
    ) {
      const [flag, rawValue] = arg.split(ARG_VALUE_SPLIT_RE, 2);
      const value = rawValue ?? "";
      if (!value) {
        throw new Error(`${flag} requires a value`);
      }
      if (flag === "--source") {
        args.source = parseSource(value);
      } else if (flag === "--item") {
        args.itemSelectors.push(value);
      } else if (flag === "--path") {
        args.paths.push(value);
      } else {
        args.reportPaths.push(value);
      }
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    args.itemSelectors.push(arg);
  }

  if (!args.all && args.itemSelectors.length === 0 && args.paths.length === 0) {
    throw new Error("Specify what to fix with --item, --path, or use --all.");
  }
  if (args.reportPaths.length === 0) {
    throw new Error(
      "audit fix requires --report <exact persisted report path>; legacy latest reports are not trusted"
    );
  }

  return args;
}

function parseInlineSecretLocation(location: string): {
  configPath: string;
  serverName: string;
  envKey: string;
} | null {
  const envMarker = location.lastIndexOf(":env:");
  if (envMarker <= 0) {
    return null;
  }
  const envKey = location.slice(envMarker + ":env:".length).trim();
  const left = location.slice(0, envMarker);
  const serverMarker = left.lastIndexOf(":");
  if (serverMarker <= 0 || !envKey) {
    return null;
  }
  const configPath = left.slice(0, serverMarker);
  const serverName = left.slice(serverMarker + 1).trim();
  if (!(configPath && serverName)) {
    return null;
  }
  return { configPath, serverName, envKey };
}

function findingKey(args: {
  result: AuditItemResult;
  finding: AuditFinding;
}): string {
  const parsed = args.finding.location
    ? parseInlineSecretLocation(args.finding.location)
    : null;
  return [
    args.result.type,
    args.result.item,
    parsed?.serverName ?? "",
    parsed?.envKey ?? "",
    normalizeRuleId(args.finding.ruleId),
  ].join("\0");
}

function keyForResult(result: AuditItemResult): string {
  return `${result.type}\0${result.item}\0${result.path}`;
}

function prefixRuleId(
  finding: AuditFinding,
  prefix: "static" | "agent"
): AuditFinding {
  return finding.ruleId.startsWith(`${prefix}:`)
    ? finding
    : { ...finding, ruleId: `${prefix}:${finding.ruleId}` };
}

function uniqueByKey<T>(items: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const itemKey = key(item);
    if (seen.has(itemKey)) {
      continue;
    }
    seen.add(itemKey);
    out.push(item);
  }
  return out;
}

function mergeStaticAndAgentResults(args: {
  static: AuditItemResult[];
  agent: AuditItemResult[];
}): AuditItemResult[] {
  const byKey = new Map<
    string,
    { static?: AuditItemResult; agent?: AuditItemResult }
  >();

  for (const result of args.static) {
    const key = keyForResult(result);
    const previous = byKey.get(key) ?? {};
    byKey.set(key, { ...previous, static: result });
  }
  for (const result of args.agent) {
    const key = keyForResult(result);
    const previous = byKey.get(key) ?? {};
    byKey.set(key, { ...previous, agent: result });
  }

  const out: AuditItemResult[] = [];
  for (const key of [...byKey.keys()].sort()) {
    const entry = byKey.get(key);
    if (!entry) {
      continue;
    }
    if (entry.static && entry.agent) {
      out.push({
        ...entry.agent,
        passed: entry.static.passed && entry.agent.passed,
        findings: [
          ...entry.agent.findings.map((finding) =>
            prefixRuleId(finding, "agent")
          ),
          ...entry.static.findings.map((finding) =>
            prefixRuleId(finding, "static")
          ),
        ],
      });
      continue;
    }
    out.push(entry.agent ?? entry.static!);
  }
  return out;
}

function matchesItemSelector(
  result: AuditItemResult,
  selector: string
): boolean {
  const normalized = selector.trim();
  if (!normalized) {
    return false;
  }
  const labels = [
    result.item,
    `${result.type}:${result.item}`,
    result.type === "mcp" ? `mcp:${result.item}` : null,
    basename(result.path),
  ].filter(Boolean) as string[];
  return labels.some(
    (label) => label.toLowerCase() === normalized.toLowerCase()
  );
}

function matchesPath(result: AuditItemResult, candidate: string): boolean {
  const normalized = candidate.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const path = result.path.toLowerCase();
  return path === normalized || path.endsWith(`/${normalized}`);
}

function matchesSelection(args: {
  result: AuditItemResult;
  filters: AuditFixArgs;
}): boolean {
  if (
    args.filters.itemSelectors.length > 0 &&
    !args.filters.itemSelectors.some((selector) =>
      matchesItemSelector(args.result, selector)
    )
  ) {
    return false;
  }

  if (
    args.filters.paths.length > 0 &&
    !args.filters.paths.some((candidate) => matchesPath(args.result, candidate))
  ) {
    return false;
  }

  return true;
}

function inferSource(args: {
  requested?: AuditFixSource;
  staticReport: StaticAuditReport | null;
  agentReport: AgentAuditReport | null;
}): AuditFixSource {
  if (args.requested) {
    return args.requested;
  }
  if (args.staticReport && args.agentReport) {
    return "combined";
  }
  if (args.agentReport) {
    return "agent";
  }
  return "static";
}

function selectFixableFindings(args: {
  results: AuditItemResult[];
  filters: AuditFixArgs;
}): FindingSelection[] {
  return uniqueByKey(
    args.results.flatMap((result) =>
      result.findings
        .filter(
          (finding) =>
            normalizeRuleId(finding.ruleId) === INLINE_SECRET_RULE_ID &&
            result.type === "mcp" &&
            matchesSelection({ result, filters: args.filters })
        )
        .map((finding) => ({ result, finding }))
    ),
    (selection) => findingKey(selection)
  );
}

export function fixInlineMcpSecrets(args: {
  findings: FindingSelection[];
  homeDir?: string;
  rootDir?: string;
  allowLegacyManagedMutation?: boolean;
}): Promise<{
  fixed: number;
  fixedSelections: FindingSelection[];
  localPath: string | null;
  riskyManagedOutputs: { path: string; state: "tracked" | "untracked" }[];
  skipped: { label: string; reason: string }[];
  syncedTools: string[];
  trackedPath: string | null;
}> {
  const selected = args.findings.filter(
    ({ result, finding }) =>
      result.type === "mcp" &&
      normalizeRuleId(finding.ruleId) === INLINE_SECRET_RULE_ID &&
      typeof finding.location === "string"
  );
  if (selected.length === 0) {
    return Promise.resolve({
      fixed: 0,
      fixedSelections: [],
      localPath: null,
      riskyManagedOutputs: [],
      skipped: [],
      syncedTools: [],
      trackedPath: null,
    });
  }

  return Promise.reject(new Error(AUDIT_FIX_MUTATION_DISABLED_MESSAGE));
}

export function removeFixedInlineSecretFindings(args: {
  results: AuditItemResult[];
  fixed: FindingSelection[];
}): AuditItemResult[] {
  const fixedKeys = new Set(
    args.fixed.map((selection) => findingKey(selection))
  );
  if (fixedKeys.size === 0) {
    return args.results;
  }

  return args.results.map((result) => {
    const findings = result.findings.filter((finding) => {
      if (normalizeRuleId(finding.ruleId) !== INLINE_SECRET_RULE_ID) {
        return true;
      }
      const parsed = finding.location
        ? parseInlineSecretLocation(finding.location)
        : null;
      if (!parsed) {
        return true;
      }
      return !fixedKeys.has(
        [
          result.type,
          result.item,
          parsed.serverName,
          parsed.envKey,
          INLINE_SECRET_RULE_ID,
        ].join("\0")
      );
    });
    const status = computeStoredAuditStatus(findings);
    return {
      ...result,
      findings,
      passed: isStoredAuditStatusPassed(status),
    };
  });
}

export async function runAuditFix(args: {
  argv: string[];
  homeDir?: string;
  cwd?: string;
}): Promise<{
  fixed: number;
  localPath: string | null;
  matched: number;
  riskyManagedOutputs: { path: string; state: "tracked" | "untracked" }[];
  skipped: { label: string; reason: string }[];
  source: AuditFixSource;
  syncedTools: string[];
  trackedPath: string | null;
}> {
  const parsed = parseAuditFixArgs(args.argv);
  const homeDir = args.homeDir ?? homedir();
  const cwd = args.cwd ?? process.cwd();
  const rootDir = facultContextRootDir({ home: homeDir, cwd });

  let staticReport: StaticAuditReport | null = null;
  let agentReport: AgentAuditReport | null = null;
  for (const reportPath of parsed.reportPaths) {
    const report = await loadVerifiedAuditReport<
      StaticAuditReport | AgentAuditReport
    >({ reportPath });
    if (report.mode === "static") {
      if (staticReport) {
        throw new Error("Only one exact static audit report may be supplied");
      }
      staticReport = report;
    } else {
      if (agentReport) {
        throw new Error("Only one exact agent audit report may be supplied");
      }
      agentReport = report;
    }
  }

  const source = inferSource({
    requested: parsed.source,
    staticReport,
    agentReport,
  });
  if (
    (source === "static" && !staticReport) ||
    (source === "agent" && !agentReport) ||
    (source === "combined" && !(staticReport && agentReport))
  ) {
    throw new Error(`Exact report input does not satisfy --source ${source}`);
  }
  const reportResults =
    source === "static"
      ? (staticReport?.results ?? [])
      : source === "agent"
        ? (agentReport?.results ?? [])
        : mergeStaticAndAgentResults({
            static: staticReport?.results ?? [],
            agent: agentReport?.results ?? [],
          });

  const selections = selectFixableFindings({
    results: reportResults,
    filters: parsed,
  });
  if (selections.length === 0) {
    throw new Error(
      "No inline MCP secret findings matched the requested filters."
    );
  }

  if (parsed.dryRun) {
    return {
      fixed: 0,
      localPath: null,
      matched: selections.length,
      riskyManagedOutputs: [],
      skipped: [],
      source,
      syncedTools: [],
      trackedPath: null,
    };
  }
  const fixed = await fixInlineMcpSecrets({
    findings: selections,
    homeDir,
    rootDir,
    allowLegacyManagedMutation: legacyManagedMutationApproved({
      argv: args.argv,
    }),
  });

  return {
    fixed: fixed.fixed,
    localPath: fixed.localPath,
    matched: selections.length,
    riskyManagedOutputs: fixed.riskyManagedOutputs,
    skipped: fixed.skipped,
    source,
    syncedTools: fixed.syncedTools,
    trackedPath: fixed.trackedPath,
  };
}

function printHelp() {
  console.log(`fclt audit fix — preview inline-secret findings

Usage:
  fclt audit fix <item> --report <exact-report.json> --dry-run
  fclt audit fix --item <item> --report <exact-report.json> [--path <path>] [--source <static|agent|combined>] --dry-run
  fclt audit fix --all --report <exact-report.json> [--report <second-report.json>] [--source <static|agent|combined>] --dry-run

Notes:
  - Mutation is temporarily disabled pending a durable two-file recovery protocol.
  - --dry-run still verifies exact reports and lists matching findings without writing.
  - Requires a fresh, content-hashed report-and-receipt envelope created by --report-root.
  - Legacy static-latest.json and agent-latest.json files never authorize mutation.
  - --yes and direct internal fix calls fail closed without writing; the TUI does not offer a Fix action.
`);
}

export async function auditFixCommand(
  argv: string[],
  opts?: { cwd?: string; homeDir?: string }
) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printHelp();
    return;
  }

  try {
    const result = await runAuditFix({
      argv,
      cwd: opts?.cwd,
      homeDir: opts?.homeDir,
    });

    if (argv.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (argv.includes("--dry-run")) {
      console.log(
        `Matched ${result.matched} inline MCP secret finding${result.matched === 1 ? "" : "s"} in the ${result.source} audit view.`
      );
      return;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
