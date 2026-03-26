import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { loadManagedState, syncManagedTools } from "../manage";
import {
  extractServersObject,
  isInlineMcpSecretValue,
  loadCanonicalMcpState,
  stringifyCanonicalMcpServers,
} from "../mcp-config";
import { facultContextRootDir, facultStateDir } from "../paths";
import { getGitPathExposure } from "../util/git";
import { parseJsonLenient } from "../util/json";
import type { AgentAuditReport } from "./agent";
import { computeStoredAuditStatus, isStoredAuditStatusPassed } from "./status";
import {
  applyAuditSuppressionsToAgentReport,
  applyAuditSuppressionsToStaticReport,
} from "./suppressions";
import type { AuditFinding, AuditItemResult, StaticAuditReport } from "./types";
import { updateIndexFromAuditReport } from "./update-index";

type AuditFixSource = "static" | "agent" | "combined";
const RULE_ID_PREFIX_RE = /^(static|agent):/;
const INLINE_SECRET_RULE_ID = "mcp-env-inline-secret";
const ARG_VALUE_SPLIT_RE = /=(.*)/s;

interface AuditFixArgs {
  all: boolean;
  dryRun: boolean;
  itemSelectors: string[];
  json: boolean;
  paths: string[];
  source?: AuditFixSource;
  yes: boolean;
}

interface FindingSelection {
  result: AuditItemResult;
  finding: AuditFinding;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
      arg.startsWith("--source=") ||
      arg.startsWith("--item=") ||
      arg.startsWith("--path=")
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
      } else {
        args.paths.push(value);
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

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function ensureServerRecord(
  servers: Record<string, unknown>,
  serverName: string
): Record<string, unknown> {
  const current = servers[serverName];
  if (isPlainObject(current)) {
    return current;
  }
  const next: Record<string, unknown> = {};
  servers[serverName] = next;
  return next;
}

function readSecretFromServer(
  server: Record<string, unknown> | null,
  envKey: string
): string | null {
  if (!server) {
    return null;
  }
  const env = server.env;
  if (!isPlainObject(env)) {
    return null;
  }
  const value = env[envKey];
  return isInlineMcpSecretValue(value) ? value : null;
}

function scrubTrackedServerEnv(
  server: Record<string, unknown>,
  envKey: string
) {
  const env = server.env;
  if (!isPlainObject(env)) {
    return;
  }
  delete env[envKey];
  if (Object.keys(env).length === 0) {
    server.env = undefined;
  }
}

function setLocalServerEnv(args: {
  localServers: Record<string, unknown>;
  serverName: string;
  envKey: string;
  secretValue: string;
}) {
  const server = ensureServerRecord(args.localServers, args.serverName);
  const env = isPlainObject(server.env)
    ? (server.env as Record<string, unknown>)
    : {};
  env[args.envKey] = args.secretValue;
  server.env = env;
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

function rewriteStaticReportResults(
  report: StaticAuditReport,
  fixedSelections: FindingSelection[]
): StaticAuditReport {
  return applyAuditSuppressionsToStaticReport(
    {
      ...report,
      results: removeFixedInlineSecretFindings({
        results: report.results,
        fixed: fixedSelections,
      }),
    },
    []
  );
}

function rewriteAgentReportResults(
  report: AgentAuditReport,
  fixedSelections: FindingSelection[]
): AgentAuditReport {
  return applyAuditSuppressionsToAgentReport(
    {
      ...report,
      results: removeFixedInlineSecretFindings({
        results: report.results,
        fixed: fixedSelections,
      }),
    },
    []
  );
}

async function rewriteLatestReports(args: {
  homeDir: string;
  staticReport: StaticAuditReport | null;
  agentReport: AgentAuditReport | null;
}) {
  const auditDir = join(facultStateDir(args.homeDir), "audit");
  await mkdir(auditDir, { recursive: true });
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

export async function fixInlineMcpSecrets(args: {
  findings: FindingSelection[];
  homeDir?: string;
  rootDir?: string;
}): Promise<{
  fixed: number;
  fixedSelections: FindingSelection[];
  localPath: string | null;
  riskyManagedOutputs: { path: string; state: "tracked" | "untracked" }[];
  skipped: { label: string; reason: string }[];
  syncedTools: string[];
  trackedPath: string | null;
}> {
  const homeDir = args.homeDir ?? homedir();
  const rootDir =
    args.rootDir ?? facultContextRootDir({ home: homeDir, cwd: process.cwd() });
  const selected = args.findings.filter(
    ({ result, finding }) =>
      result.type === "mcp" &&
      normalizeRuleId(finding.ruleId) === INLINE_SECRET_RULE_ID &&
      typeof finding.location === "string"
  );
  if (selected.length === 0) {
    return {
      fixed: 0,
      fixedSelections: [],
      localPath: null,
      riskyManagedOutputs: [],
      skipped: [],
      syncedTools: [],
      trackedPath: null,
    };
  }

  const managedState = await loadManagedState(homeDir, rootDir);
  const managedToolsByPath = new Map<string, string>();
  for (const [tool, entry] of Object.entries(managedState.tools)) {
    if (entry.mcpConfig) {
      managedToolsByPath.set(entry.mcpConfig, tool);
    }
  }

  const canonical = await loadCanonicalMcpState(rootDir, {
    includeLocal: true,
  });
  const trackedServers = cloneRecord(canonical.trackedServers);
  const localServers = cloneRecord(canonical.localServers);
  const touchedTools = new Set<string>();
  const fixedSelections: FindingSelection[] = [];
  const skipped: { label: string; reason: string }[] = [];

  for (const selection of selected) {
    const parsed = selection.finding.location
      ? parseInlineSecretLocation(selection.finding.location)
      : null;
    const label = `${selection.result.item}:${selection.finding.location ?? selection.result.path}`;
    if (!parsed) {
      skipped.push({ label, reason: "could-not-parse-location" });
      continue;
    }

    const trackedServer = isPlainObject(trackedServers[parsed.serverName])
      ? (trackedServers[parsed.serverName] as Record<string, unknown>)
      : null;
    const localServer = isPlainObject(localServers[parsed.serverName])
      ? (localServers[parsed.serverName] as Record<string, unknown>)
      : null;

    let secretValue =
      readSecretFromServer(trackedServer, parsed.envKey) ??
      readSecretFromServer(localServer, parsed.envKey);

    if (!secretValue) {
      const selectedPathRaw = await Bun.file(selection.result.path)
        .text()
        .catch(() => null);
      if (selectedPathRaw) {
        try {
          const parsedConfig = parseJsonLenient(selectedPathRaw);
          const servers = extractServersObject(parsedConfig);
          const selectedServer = servers?.[parsed.serverName];
          secretValue = isPlainObject(selectedServer)
            ? readSecretFromServer(selectedServer, parsed.envKey)
            : null;
        } catch {
          secretValue = null;
        }
      }
    }

    if (!secretValue) {
      skipped.push({ label, reason: "no-inline-secret-value-found" });
      continue;
    }

    if (!trackedServer) {
      skipped.push({ label, reason: "server-not-found-in-canonical-store" });
      continue;
    }

    scrubTrackedServerEnv(trackedServer, parsed.envKey);
    setLocalServerEnv({
      localServers,
      serverName: parsed.serverName,
      envKey: parsed.envKey,
      secretValue,
    });

    const managedTool = managedToolsByPath.get(selection.result.path);
    if (managedTool) {
      touchedTools.add(managedTool);
    }
    fixedSelections.push(selection);
  }

  if (fixedSelections.length === 0) {
    return {
      fixed: 0,
      fixedSelections: [],
      localPath: null,
      riskyManagedOutputs: [],
      skipped,
      syncedTools: [],
      trackedPath: null,
    };
  }

  await mkdir(dirname(canonical.trackedPath), { recursive: true });
  await Bun.write(
    canonical.trackedPath,
    stringifyCanonicalMcpServers(trackedServers)
  );
  await Bun.write(
    canonical.localPath,
    stringifyCanonicalMcpServers(localServers)
  );

  if (Object.keys(managedState.tools).length > 0) {
    await syncManagedTools({ homeDir, rootDir });
  }

  const riskyManagedOutputs = (
    await Promise.all(
      [...touchedTools]
        .map((tool) => managedState.tools[tool]?.mcpConfig)
        .filter((path): path is string => typeof path === "string")
        .map(async (pathValue) => {
          const exposure = await getGitPathExposure(pathValue);
          if (
            exposure.insideRepo &&
            (exposure.state === "tracked" || exposure.state === "untracked")
          ) {
            return {
              path: pathValue,
              state: exposure.state,
            };
          }
          return null;
        })
    )
  ).filter(Boolean) as { path: string; state: "tracked" | "untracked" }[];

  return {
    fixed: uniqueByKey(fixedSelections, (selection) => findingKey(selection))
      .length,
    fixedSelections,
    localPath: canonical.localPath,
    riskyManagedOutputs,
    skipped,
    syncedTools: [...touchedTools].sort(),
    trackedPath: canonical.trackedPath,
  };
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

  const staticReport = await loadLatestStaticReport(homeDir);
  const agentReport = await loadLatestAgentReport(homeDir);
  if (!(staticReport || agentReport)) {
    throw new Error(
      "No latest audit reports found. Run `fclt audit` first, then fix the flagged secrets."
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
  });

  const nextStaticReport =
    staticReport && fixed.fixedSelections.length > 0
      ? rewriteStaticReportResults(staticReport, fixed.fixedSelections)
      : staticReport;
  const nextAgentReport =
    agentReport && fixed.fixedSelections.length > 0
      ? rewriteAgentReportResults(agentReport, fixed.fixedSelections)
      : agentReport;

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
  console.log(`fclt audit fix — remediate fixable audit findings

Usage:
  fclt audit fix <item>
  fclt audit fix --item <item> [--path <path>] [--source <static|agent|combined>]
  fclt audit fix --all [--source <static|agent|combined>] [--yes]
  fclt audit fix --dry-run ...

Notes:
  - Currently fixes inline MCP secrets by moving them into a local canonical overlay.
  - Tracked canonical MCP config is scrubbed and managed tool MCP configs are re-synced.
  - Managed tool copies continue to work, but the canonical secret now lives in *.local.json.
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

    console.log(
      `Fixed ${result.fixed} inline MCP secret finding${result.fixed === 1 ? "" : "s"} in the ${result.source} audit view.`
    );
    if (result.trackedPath && result.localPath) {
      console.log(`Tracked canonical MCP config: ${result.trackedPath}`);
      console.log(`Local MCP overlay: ${result.localPath}`);
    }
    if (result.syncedTools.length > 0) {
      console.log(`Re-synced managed tools: ${result.syncedTools.join(", ")}`);
    }
    if (result.riskyManagedOutputs.length > 0) {
      for (const output of result.riskyManagedOutputs) {
        console.warn(
          `Warning: ${output.path} is ${output.state === "tracked" ? "git-tracked" : "repo-local and not gitignored"}.`
        );
      }
    }
    if (result.skipped.length > 0) {
      console.log(
        `Skipped ${result.skipped.length} finding${result.skipped.length === 1 ? "" : "s"} that could not be fixed automatically.`
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
