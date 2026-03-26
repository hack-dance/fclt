import { homedir } from "node:os";
import { basename, join } from "node:path";
import { facultStateDir } from "../paths";
import type { AgentAuditReport } from "./agent";
import {
  applyAuditSuppressionsToAgentReport,
  applyAuditSuppressionsToStaticReport,
  loadAuditSuppressions,
  recordAuditSuppressions,
} from "./suppressions";
import type {
  AuditFinding,
  AuditItemResult,
  Severity,
  StaticAuditReport,
} from "./types";
import { updateIndexFromAuditReport } from "./update-index";

type AuditSafeSource = "static" | "agent" | "combined";
const ARG_VALUE_SPLIT_RE = /=(.*)/s;

interface AuditSafeArgs {
  all: boolean;
  dryRun: boolean;
  itemSelectors: string[];
  json: boolean;
  locations: string[];
  messages: string[];
  note?: string;
  paths: string[];
  rules: string[];
  severity?: Severity;
  source?: AuditSafeSource;
  yes: boolean;
}

interface FindingSelection {
  result: AuditItemResult;
  finding: AuditFinding;
}

const RULE_ID_PREFIX_RE = /^(static|agent):/;

function normalizeRuleId(ruleId: string): string {
  return ruleId.replace(RULE_ID_PREFIX_RE, "");
}

function parseSource(value: string): AuditSafeSource {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "static" ||
    normalized === "agent" ||
    normalized === "combined"
  ) {
    return normalized;
  }
  throw new Error(`Unknown audit safe source: ${value}`);
}

function parseSeverity(value: string): Severity {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "critical"
  ) {
    return normalized;
  }
  throw new Error(`Unknown severity: ${value}`);
}

function parseAuditSafeArgs(argv: string[]): AuditSafeArgs {
  const args: AuditSafeArgs = {
    all: false,
    dryRun: false,
    itemSelectors: [],
    json: false,
    locations: [],
    messages: [],
    paths: [],
    rules: [],
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

    if (arg === "--source" || arg === "--item" || arg === "--path") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--source") {
        args.source = parseSource(next);
      } else if (arg === "--item") {
        args.itemSelectors.push(next);
      } else {
        args.paths.push(next);
      }
      i += 1;
      continue;
    }

    if (
      arg === "--rule" ||
      arg === "--location" ||
      arg === "--message" ||
      arg === "--note" ||
      arg === "--severity"
    ) {
      const next = argv[i + 1];
      if (!next) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--rule") {
        args.rules.push(next);
      } else if (arg === "--location") {
        args.locations.push(next);
      } else if (arg === "--message") {
        args.messages.push(next);
      } else if (arg === "--note") {
        args.note = next;
      } else {
        args.severity = parseSeverity(next);
      }
      i += 1;
      continue;
    }

    if (
      arg.startsWith("--source=") ||
      arg.startsWith("--item=") ||
      arg.startsWith("--path=") ||
      arg.startsWith("--rule=") ||
      arg.startsWith("--location=") ||
      arg.startsWith("--message=") ||
      arg.startsWith("--note=") ||
      arg.startsWith("--severity=")
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
      } else if (flag === "--rule") {
        args.rules.push(value);
      } else if (flag === "--location") {
        args.locations.push(value);
      } else if (flag === "--message") {
        args.messages.push(value);
      } else if (flag === "--note") {
        args.note = value;
      } else if (flag === "--severity") {
        args.severity = parseSeverity(value);
      }
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    args.itemSelectors.push(arg);
  }

  if (
    !args.all &&
    args.itemSelectors.length === 0 &&
    args.paths.length === 0 &&
    args.rules.length === 0 &&
    args.locations.length === 0 &&
    args.messages.length === 0 &&
    !args.severity
  ) {
    throw new Error(
      "Specify what to suppress with --item, --rule, --path, --location, --message, --severity, or use --all."
    );
  }

  return args;
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

async function loadLatestStaticReport(
  homeDir: string
): Promise<StaticAuditReport | null> {
  const path = join(facultStateDir(homeDir), "audit", "static-latest.json");
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return null;
  }
  return (await file.json()) as StaticAuditReport;
}

async function loadLatestAgentReport(
  homeDir: string
): Promise<AgentAuditReport | null> {
  const path = join(facultStateDir(homeDir), "audit", "agent-latest.json");
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return null;
  }
  return (await file.json()) as AgentAuditReport;
}

function inferSource(args: {
  requested?: AuditSafeSource;
  staticReport: StaticAuditReport | null;
  agentReport: AgentAuditReport | null;
}): AuditSafeSource {
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
    result.type === "skill" ? `skill:${result.item}` : null,
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

function matchesFinding(args: {
  result: AuditItemResult;
  finding: AuditFinding;
  filters: AuditSafeArgs;
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

  if (
    args.filters.rules.length > 0 &&
    !args.filters.rules.some((rule) => {
      const normalizedRule = rule.trim().toLowerCase();
      return (
        args.finding.ruleId.toLowerCase() === normalizedRule ||
        normalizeRuleId(args.finding.ruleId).toLowerCase() === normalizedRule
      );
    })
  ) {
    return false;
  }

  if (
    args.filters.locations.length > 0 &&
    !args.filters.locations.some((location) =>
      (args.finding.location ?? "")
        .toLowerCase()
        .includes(location.toLowerCase())
    )
  ) {
    return false;
  }

  if (
    args.filters.messages.length > 0 &&
    !args.filters.messages.some((message) =>
      args.finding.message.toLowerCase().includes(message.toLowerCase())
    )
  ) {
    return false;
  }

  if (
    args.filters.severity &&
    args.finding.severity.toLowerCase() !== args.filters.severity
  ) {
    return false;
  }

  return true;
}

async function rewriteLatestReports(args: {
  homeDir: string;
  staticReport: StaticAuditReport | null;
  agentReport: AgentAuditReport | null;
}) {
  const auditDir = join(facultStateDir(args.homeDir), "audit");
  if (args.staticReport) {
    await Bun.write(
      join(auditDir, "static-latest.json"),
      `${JSON.stringify(args.staticReport, null, 2)}\n`
    );
  }
  if (args.agentReport) {
    await Bun.write(
      join(auditDir, "agent-latest.json"),
      `${JSON.stringify(args.agentReport, null, 2)}\n`
    );
  }
}

export async function runAuditSafe(args: {
  argv: string[];
  homeDir?: string;
}): Promise<{
  added: number;
  matched: number;
  source: AuditSafeSource;
  totalSuppressions: number;
}> {
  const parsed = parseAuditSafeArgs(args.argv);
  const homeDir = args.homeDir ?? homedir();
  const staticReport = await loadLatestStaticReport(homeDir);
  const agentReport = await loadLatestAgentReport(homeDir);

  if (!(staticReport || agentReport)) {
    throw new Error(
      "No latest audit reports found. Run `fclt audit` first, then mark findings safe."
    );
  }

  const source = inferSource({
    requested: parsed.source,
    staticReport,
    agentReport,
  });
  const reportResults =
    source === "static"
      ? (staticReport?.results ?? [])
      : source === "agent"
        ? (agentReport?.results ?? [])
        : mergeStaticAndAgentResults({
            static: staticReport?.results ?? [],
            agent: agentReport?.results ?? [],
          });

  const selections = reportResults.flatMap((result) =>
    result.findings
      .filter((finding) =>
        parsed.all
          ? true
          : matchesFinding({
              result,
              finding,
              filters: parsed,
            })
      )
      .map((finding) => ({ result, finding }))
  );

  const uniqueSelections = uniqueByKey(
    selections,
    ({ result, finding }) =>
      `${result.type}\0${result.item}\0${result.path}\0${finding.severity}\0${normalizeRuleId(finding.ruleId)}\0${finding.message}\0${finding.location ?? ""}`
  );

  if (uniqueSelections.length === 0) {
    throw new Error("No findings matched the requested filters.");
  }

  if (parsed.dryRun) {
    const totalSuppressions = (await loadAuditSuppressions(homeDir)).length;
    return {
      added: 0,
      matched: uniqueSelections.length,
      source,
      totalSuppressions,
    };
  }

  const saved = await recordAuditSuppressions({
    homeDir,
    selected: uniqueSelections,
    note: parsed.note,
  });
  const suppressions = await loadAuditSuppressions(homeDir);
  const nextStaticReport = staticReport
    ? applyAuditSuppressionsToStaticReport(staticReport, suppressions)
    : null;
  const nextAgentReport = agentReport
    ? applyAuditSuppressionsToAgentReport(agentReport, suppressions)
    : null;

  await rewriteLatestReports({
    homeDir,
    staticReport: nextStaticReport,
    agentReport: nextAgentReport,
  });

  await updateIndexFromAuditReport({
    homeDir,
    timestamp: new Date().toISOString(),
    results: uniqueByKey(
      mergeStaticAndAgentResults({
        static: nextStaticReport?.results ?? [],
        agent: nextAgentReport?.results ?? [],
      }),
      keyForResult
    ),
  });

  return {
    added: saved.added,
    matched: uniqueSelections.length,
    source,
    totalSuppressions: saved.total,
  };
}

function printHelp() {
  console.log(`fclt audit safe — suppress reviewed findings for future audits

Usage:
  fclt audit safe <item> [--rule <id>] [--location <text>] [--message <text>]
  fclt audit safe --item <item> [--path <path>] [--severity <level>] [--note <text>]
  fclt audit safe --all --source <static|agent|combined> [--note <text>] [--yes]
  fclt audit safe --dry-run ...

Notes:
  - Reads the latest saved audit reports from ~/.ai/.facult/audit/.
  - Matching is non-interactive and agent-safe.
  - Combined review suppressions also match future raw static/agent findings.
`);
}

export async function auditSafeCommand(
  argv: string[],
  opts?: { homeDir?: string }
) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printHelp();
    return;
  }

  try {
    const result = await runAuditSafe({
      argv,
      homeDir: opts?.homeDir,
    });

    if (argv.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (argv.includes("--dry-run")) {
      console.log(
        `Matched ${result.matched} finding${result.matched === 1 ? "" : "s"} in the ${result.source} audit view.`
      );
      return;
    }

    console.log(
      `Marked ${result.matched} finding${result.matched === 1 ? "" : "s"} safe in the ${result.source} audit view.`
    );
    console.log(
      `Saved ${result.added} new suppression${result.added === 1 ? "" : "s"} (${result.totalSuppressions} total).`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
