import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancel,
  confirm,
  group,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { buildIndex } from "../index-builder";
import { facultRootDir, facultStateDir, readFacultConfig } from "../paths";
import { type QuarantineMode, quarantineItems } from "../quarantine";
import { type AgentAuditReport, runAgentAudit } from "./agent";
import { fixInlineMcpSecrets, removeFixedInlineSecretFindings } from "./fix";
import { runStaticAudit } from "./static";
import {
  applyAuditSuppressionsToAgentReport,
  applyAuditSuppressionsToStaticReport,
  loadAuditSuppressions,
  recordAuditSuppressions,
} from "./suppressions";
import {
  type AuditFinding,
  type AuditItemResult,
  SEVERITY_ORDER,
  type Severity,
  type StaticAuditReport,
} from "./types";
import { updateIndexFromAuditReport } from "./update-index";

type InteractiveReviewerTool = "codex" | "claude";
const AUDIT_RULE_PREFIX_RE = /^(static|agent):/;

function parseFromFlags(argv: string[]): string[] {
  const from: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === "--from") {
      const next = argv[i + 1];
      if (next) {
        from.push(next);
      }
      i += 1;
      continue;
    }
    if (arg.startsWith("--from=")) {
      const value = arg.slice("--from=".length);
      if (value) {
        from.push(value);
      }
    }
  }
  return from;
}

function maxSeverity(findings: { severity: Severity }[]): Severity | null {
  if (!findings.length) {
    return null;
  }
  let best: Severity = "low";
  for (const f of findings) {
    if (SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[best]) {
      best = f.severity;
    }
  }
  return best;
}

function labelForResult(r: AuditItemResult): string {
  const sev = maxSeverity(r.findings);
  const sevLabel = sev ? sev.toUpperCase() : "OK";
  const n = r.findings.length;
  const status = n === 0 ? "OK" : r.passed ? "WARN" : "FAIL";
  const kind =
    r.type === "mcp"
      ? `mcp:${r.item}`
      : r.type === "asset"
        ? `asset:${r.item}`
        : r.type === "mcp-config"
          ? `mcp-config:${r.item}`
          : r.item;
  return `[${status} ${sevLabel}] ${kind} (${n} finding${n === 1 ? "" : "s"})`;
}

function hintForResult(r: AuditItemResult): string {
  return r.path;
}

function summarizeReportStatic(report: StaticAuditReport): string {
  const s = report.summary.bySeverity;
  return `flagged=${report.summary.flaggedItems} findings=${report.summary.totalFindings} (critical=${s.critical}, high=${s.high}, medium=${s.medium}, low=${s.low})`;
}

function summarizeReportAgent(report: AgentAuditReport): string {
  const s = report.summary.bySeverity;
  const model = report.agent.model ? ` (${report.agent.model})` : "";
  return `agent=${report.agent.tool}${model} flagged=${report.summary.flaggedItems} findings=${report.summary.totalFindings} (critical=${s.critical}, high=${s.high}, medium=${s.medium}, low=${s.low})`;
}

function uniqueByKey<T>(items: T[], key: (v: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = key(it);
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    out.push(it);
  }
  return out;
}

function keyForResult(r: AuditItemResult): string {
  return `${r.type}\0${r.item}\0${r.path}`;
}

function prefixRuleId(
  f: AuditFinding,
  prefix: "static" | "agent"
): AuditFinding {
  const want = `${prefix}:`;
  if (f.ruleId.startsWith(want)) {
    return f;
  }
  return { ...f, ruleId: `${want}${f.ruleId}` };
}

function mergeStaticAndAgentResults(args: {
  static: AuditItemResult[];
  agent: AuditItemResult[];
}): AuditItemResult[] {
  const byKey = new Map<
    string,
    { static?: AuditItemResult; agent?: AuditItemResult }
  >();

  for (const r of args.static) {
    const k = keyForResult(r);
    const prev = byKey.get(k) ?? {};
    byKey.set(k, { ...prev, static: r });
  }
  for (const r of args.agent) {
    const k = keyForResult(r);
    const prev = byKey.get(k) ?? {};
    byKey.set(k, { ...prev, agent: r });
  }

  const out: AuditItemResult[] = [];
  for (const k of [...byKey.keys()].sort()) {
    const ent = byKey.get(k);
    if (!ent) {
      continue;
    }
    const a = ent.agent;
    const s = ent.static;
    if (a && s) {
      out.push({
        ...a,
        // If either side failed, the combined view should be a failure.
        passed: a.passed && s.passed,
        findings: [
          ...a.findings.map((f) => prefixRuleId(f, "agent")),
          ...s.findings.map((f) => prefixRuleId(f, "static")),
        ],
      });
      continue;
    }
    out.push(a ?? s!);
  }
  return out;
}

function viewFindingDetails(r: AuditItemResult) {
  const lines: string[] = [];
  lines.push(`Path: ${r.path}`);
  lines.push(`Type: ${r.type}`);
  if (r.sourceId) {
    lines.push(`Source: ${r.sourceId}`);
  }
  if (r.notes) {
    lines.push("");
    lines.push("Notes:");
    lines.push(r.notes);
  }
  lines.push("");
  if (r.findings.length) {
    for (const f of r.findings) {
      const loc = f.location ? ` @ ${f.location}` : "";
      lines.push(`[${f.severity.toUpperCase()}] ${f.ruleId}${loc}`);
      lines.push(`  ${f.message}`);
      if (f.evidence) {
        lines.push(`  evidence: ${f.evidence}`);
      }
      lines.push("");
    }
  } else {
    lines.push("No findings.");
  }
  note(lines.join("\n"), "Findings");
}

function availableInteractiveReviewerTools(): InteractiveReviewerTool[] {
  return [
    ...(Bun.which("codex") ? (["codex"] as const) : []),
    ...(Bun.which("claude") ? (["claude"] as const) : []),
  ];
}

function findingsSummary(findings: AuditFinding[]): string {
  return findings
    .map((finding) => {
      const location = finding.location ? ` @ ${finding.location}` : "";
      return `- [${finding.severity}] ${finding.ruleId}${location}: ${finding.message}`;
    })
    .join("\n");
}

function buildReviewerPrompt(args: {
  items: AuditItemResult[];
  reviewMode: "static" | "agent" | "combined";
  cwd: string;
}): string {
  const itemBlocks = args.items.map((item, index) =>
    [
      `${index + 1}. ${item.type}:${item.item}`,
      `Path: ${item.path}`,
      `Passed: ${item.passed ? "yes" : "no"}`,
      item.sourceId ? `Source: ${item.sourceId}` : "",
      item.notes ? `Notes: ${item.notes}` : "",
      "Findings:",
      findingsSummary(item.findings),
    ]
      .filter(Boolean)
      .join("\n")
  );

  return [
    "Review these audit findings and help reconcile them.",
    "These findings came from `fclt audit`.",
    `Current repo: ${args.cwd}`,
    `Audit view: ${args.reviewMode}`,
    "",
    "What to do:",
    "- Inspect the listed files directly.",
    "- Validate whether each finding is real, stale, or acceptable.",
    "- Group related issues when the same fix addresses multiple findings.",
    "- Propose the safest order to handle them.",
    "- If a fix is straightforward, suggest or implement it in this session.",
    "- Prefer fixing the canonical `.ai` source once when the same MCP issue appears in multiple tool configs.",
    "- If an MCP secret needs remediation, use the `fclt audit fix ...` flow before suggesting manual edits.",
    "",
    "Useful `fclt` commands in this repo:",
    "- `fclt show mcp:<name>` to inspect the canonical MCP entry.",
    "- `fclt audit fix <item>` to move inline MCP secrets into the local canonical overlay.",
    "- `fclt audit safe ...` to suppress a reviewed false positive.",
    "- `fclt manage <tool>` or `fclt sync [tool]` when a managed tool config needs to be re-rendered.",
    "",
    "Selected findings:",
    ...itemBlocks,
  ].join("\n");
}

async function launchInteractiveReviewer(args: {
  tool: InteractiveReviewerTool;
  prompt: string;
  cwd: string;
}): Promise<number> {
  const promptDir = await mkdtemp(join(tmpdir(), "facult-audit-review-"));
  const promptPath = join(promptDir, "prompt.md");
  await Bun.write(promptPath, `${args.prompt}\n`);
  const promptText = await Bun.file(promptPath).text();

  const cmd =
    args.tool === "codex"
      ? ["codex", "--no-alt-screen", "-C", args.cwd, promptText]
      : ["claude", promptText];

  const proc = Bun.spawn({
    cmd,
    cwd: args.cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  return await proc.exited;
}

function viewMultipleFindingDetails(items: AuditItemResult[]) {
  const blocks = items.map((item) => {
    const lines: string[] = [];
    lines.push(`${item.type}:${item.item}`);
    lines.push(`Path: ${item.path}`);
    if (item.sourceId) {
      lines.push(`Source: ${item.sourceId}`);
    }
    lines.push(
      ...item.findings.map((finding) => {
        const location = finding.location ? ` @ ${finding.location}` : "";
        return `- [${finding.severity}] ${finding.ruleId}${location}: ${finding.message}`;
      })
    );
    return lines.join("\n");
  });

  note(blocks.join("\n\n"), "Selected findings");
}

function inlineSecretSelectionLabel(selection: {
  result: AuditItemResult;
  finding: AuditFinding;
}): string {
  const location = selection.finding.location
    ? ` @ ${selection.finding.location}`
    : "";
  return `[${selection.finding.severity.toUpperCase()}] ${selection.result.item}${location}`;
}

function labelForFindingSelection(args: {
  result: AuditItemResult;
  finding: AuditFinding;
}): string {
  const location = args.finding.location ? ` @ ${args.finding.location}` : "";
  return `[${args.finding.severity.toUpperCase()}] ${args.result.type}:${args.result.item} — ${args.finding.ruleId}${location}`;
}

function hintForFindingSelection(args: {
  result: AuditItemResult;
  finding: AuditFinding;
}): string {
  return `${args.result.path} — ${args.finding.message}`;
}

function sortReviewQueue(results: AuditItemResult[]): AuditItemResult[] {
  return results
    .filter((result) => result.findings.length > 0)
    .sort((a, b) => {
      const sa = SEVERITY_ORDER[maxSeverity(a.findings) ?? "low"];
      const sb = SEVERITY_ORDER[maxSeverity(b.findings) ?? "low"];
      return (
        sb - sa || a.type.localeCompare(b.type) || a.item.localeCompare(b.item)
      );
    });
}

function summarizeRoots(args: {
  includeConfigFrom: boolean;
  from: string[];
  cfgRoots: string[];
}): string {
  const parts: string[] = [];
  if (args.includeConfigFrom && args.cfgRoots.length > 0) {
    parts.push("configured scanFrom roots");
  }
  if (args.from.length > 0) {
    parts.push(args.from.join(", "));
  }
  if (parts.length === 0) {
    return "tool defaults only";
  }
  return parts.join(" + ");
}

const AUDIT_TUI_CANCELLED = "audit-tui-cancelled";

function printHelp() {
  console.log(`fclt audit tui — interactive security audit + quarantine

Usage:
  fclt audit tui
  fclt audit tui --from <path> [--from <path> ...]
  fclt audit tui --no-config-from

Notes:
  - This is an interactive wizard (TTY required).
  - Quarantine will move/copy files into ~/.ai/.facult/quarantine/<timestamp>/ and write a manifest.json.
  - For non-interactive runs, use: fclt audit --non-interactive ...
`);
}

export async function auditTuiCommand(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printHelp();
    return;
  }

  const noConfigFrom = argv.includes("--no-config-from");
  const parsedFrom = parseFromFlags(argv);

  const cfg = noConfigFrom ? null : readFacultConfig();
  const cfgRoots = cfg?.scanFrom ?? [];

  intro("fclt audit");

  if (cfgRoots.length) {
    log.info(
      `Loaded ${cfgRoots.length} configured scan root${cfgRoots.length === 1 ? "" : "s"} from ~/.ai/.facult/config.json.`
    );
  }

  const availableAgentTools = [
    ...(Bun.which("claude") ? ["claude" as const] : []),
    ...(Bun.which("codex") ? ["codex" as const] : []),
  ];

  let setup:
    | {
        mode?: unknown;
        scope?: unknown;
        roots?: unknown;
        includeGitHooks?: unknown;
        minSeverity?: unknown;
        agentTool?: unknown;
        maxItems?: unknown;
      }
    | undefined;

  try {
    setup = await group(
      {
        mode: () =>
          select({
            message: "What kind of audit do you want to run?",
            options: [
              {
                value: "static",
                label: "Static only",
                hint: "fast regex and structured checks",
              },
              ...(availableAgentTools.length
                ? [
                    {
                      value: "both",
                      label: "Static + agent",
                      hint: "best coverage",
                    },
                    {
                      value: "agent",
                      label: "Agent only",
                      hint: "slower LLM review",
                    },
                  ]
                : []),
            ],
          }),
        scope: () =>
          select({
            message: "Where should the audit look?",
            options: [
              {
                value: "defaults",
                label: "Defaults only",
                hint: "fastest",
              },
              {
                value: "home",
                label: "Home directory (~)",
                hint: "broad local discovery",
              },
              {
                value: "custom",
                label: "Custom roots",
                hint: "enter a comma-separated list",
              },
              ...(cfgRoots.length
                ? [
                    {
                      value: "config",
                      label: "Configured scanFrom roots",
                      hint: "from ~/.ai/.facult/config.json",
                    },
                  ]
                : []),
            ],
          }),
        roots: ({ results }) =>
          results.scope === "custom"
            ? text({
                message: "Roots to scan",
                placeholder: parsedFrom.length
                  ? parsedFrom.join(", ")
                  : "~, ~/dev",
              })
            : undefined,
        includeGitHooks: () =>
          confirm({
            message: "Include git hooks (.husky and .git/hooks)?",
            initialValue: false,
            active: "Include",
            inactive: "Skip",
          }),
        minSeverity: ({ results }) =>
          results.mode === "static" || results.mode === "both"
            ? select({
                message: "Minimum severity to review",
                options: [
                  { value: "high", label: "high", hint: "recommended" },
                  {
                    value: "critical",
                    label: "critical",
                    hint: "critical only",
                  },
                  {
                    value: "medium",
                    label: "medium",
                    hint: "medium and above",
                  },
                  { value: "low", label: "low", hint: "show everything" },
                ],
                initialValue: "high",
              })
            : undefined,
        agentTool: ({ results }) => {
          if (results.mode !== "agent" && results.mode !== "both") {
            return undefined;
          }
          if (availableAgentTools.length === 0) {
            return undefined;
          }
          if (availableAgentTools.length === 1) {
            return Promise.resolve(availableAgentTools[0]);
          }
          return select({
            message: "Which agent tool should review the items?",
            options: availableAgentTools.map((tool) => ({
              value: tool,
              label: tool,
            })),
          });
        },
        maxItems: ({ results }) =>
          results.mode === "agent" || results.mode === "both"
            ? text({
                message: "Max items to send to the agent",
                placeholder: "50 (or all)",
                defaultValue: "50",
              })
            : undefined,
      },
      {
        onCancel: () => {
          cancel("Cancelled.");
          throw new Error(AUDIT_TUI_CANCELLED);
        },
      }
    );
  } catch (err) {
    if (err instanceof Error && err.message === AUDIT_TUI_CANCELLED) {
      return;
    }
    throw err;
  }

  const mode = setup?.mode as "static" | "agent" | "both";
  const scope = setup?.scope as "defaults" | "home" | "custom" | "config";
  const includeGitHooks = setup?.includeGitHooks === true;

  let includeConfigFrom = !noConfigFrom;
  let from: string[] = [];
  if (scope === "defaults") {
    includeConfigFrom = false;
  } else if (scope === "home") {
    from = parsedFrom.length ? parsedFrom : ["~"];
  } else if (scope === "config") {
    from = parsedFrom;
  } else {
    from = String(setup?.roots ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  let minSeverity: Severity = "high";
  if (
    (setup?.minSeverity === "critical" ||
      setup?.minSeverity === "high" ||
      setup?.minSeverity === "medium" ||
      setup?.minSeverity === "low") &&
    (mode === "static" || mode === "both")
  ) {
    minSeverity = setup.minSeverity;
  }

  let agentTool: "claude" | "codex" | null = null;
  if (setup?.agentTool === "claude" || setup?.agentTool === "codex") {
    agentTool = setup.agentTool;
  }

  let maxItems = 50;
  if (mode === "agent" || mode === "both") {
    if (availableAgentTools.length === 0) {
      log.warn(
        'No agent tool found. Install "claude" or "codex" to run an agent audit.'
      );
    }
    const raw = String(setup?.maxItems ?? "")
      .trim()
      .toLowerCase();
    if (raw === "all" || raw === "0") {
      maxItems = 0;
    } else {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxItems = Math.floor(parsed);
      }
    }
  }

  note(
    [
      `Mode: ${mode}`,
      `Roots: ${summarizeRoots({ includeConfigFrom, from, cfgRoots })}`,
      `Git hooks: ${includeGitHooks ? "included" : "skipped"}`,
      ...(mode === "static" || mode === "both"
        ? [`Minimum severity: ${minSeverity}`]
        : []),
      ...(mode === "agent" || mode === "both"
        ? [
            `Agent tool: ${agentTool ?? "not available"}`,
            `Agent max items: ${maxItems === 0 ? "all" : String(maxItems)}`,
          ]
        : []),
    ].join("\n"),
    "Plan"
  );

  const reports: { static?: StaticAuditReport; agent?: AgentAuditReport } = {};

  if (mode === "static" || mode === "both") {
    const sp = spinner();
    sp.start("Running static audit...");
    try {
      reports.static = await runStaticAudit({
        argv: [],
        homeDir: homedir(),
        minSeverity,
        includeConfigFrom,
        includeGitHooks: includeGitHooks === true,
        from,
      });
      sp.stop("Static audit complete.");
      if (reports.static) {
        log.success(`Static summary: ${summarizeReportStatic(reports.static)}`);
      }
    } catch (err) {
      sp.stop("Static audit failed.");
      outro(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  }

  if ((mode === "agent" || mode === "both") && agentTool) {
    const sp = spinner();
    sp.start("Running agent audit...");
    try {
      reports.agent = await runAgentAudit({
        argv: [],
        homeDir: homedir(),
        cwd: process.cwd(),
        includeConfigFrom,
        includeGitHooks: includeGitHooks === true,
        from,
        withTool: agentTool,
        maxItems,
        onProgress: (p) => {
          if (p.phase !== "start") {
            return;
          }
          const name = `${p.type}:${p.item}`;
          const short =
            name.length > 60 ? `${name.slice(0, 57).trimEnd()}...` : name;
          sp.message(`Agent audit (${p.current}/${p.total}) ${short}`);
        },
      });
      sp.stop("Agent audit complete.");
      if (reports.agent) {
        log.success(`Agent summary: ${summarizeReportAgent(reports.agent)}`);
      }
    } catch (err) {
      sp.stop("Agent audit failed.");
      outro(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  }

  if (reports.static) {
    log.info(
      `Static report saved to ${join(facultStateDir(homedir()), "audit", "static-latest.json")}`
    );
  }
  if (reports.agent) {
    log.info(
      `Agent report saved to ${join(facultStateDir(homedir()), "audit", "agent-latest.json")}`
    );
  }

  let review: "static" | "agent" | "combined" = reports.agent
    ? "agent"
    : "static";
  if (reports.agent && reports.static) {
    const chosen = await select({
      message: "Which results do you want to review?",
      options: [
        { value: "agent", label: "Agent findings", hint: "LLM-scored items" },
        {
          value: "static",
          label: "Static findings",
          hint: "regex + structured checks",
        },
        { value: "combined", label: "Combined", hint: "agent + static merged" },
      ],
      initialValue: "agent",
    });
    if (!isCancel(chosen)) {
      review = chosen as "static" | "agent" | "combined";
    }
  }

  const suppressions = await loadAuditSuppressions(homedir());
  let staticReport = reports.static
    ? applyAuditSuppressionsToStaticReport(reports.static, suppressions)
    : undefined;
  let agentReport = reports.agent
    ? applyAuditSuppressionsToAgentReport(reports.agent, suppressions)
    : undefined;

  let results: AuditItemResult[] = [];
  let withFindings: AuditItemResult[] = [];
  const refreshReviewState = () => {
    const combined = uniqueByKey(
      mergeStaticAndAgentResults({
        static: staticReport?.results ?? [],
        agent: agentReport?.results ?? [],
      }),
      keyForResult
    );
    results =
      review === "combined"
        ? combined
        : review === "agent"
          ? (agentReport?.results ?? [])
          : (staticReport?.results ?? []);
    withFindings = sortReviewQueue(results);
  };
  refreshReviewState();

  if (withFindings.length === 0) {
    outro("No findings above the selected threshold.");
    return;
  }

  const failCount = withFindings.filter((r) => !r.passed).length;
  const warnCount = withFindings.length - failCount;
  log.warn(`Review queue: ${failCount} fail, ${warnCount} warn.`);

  while (true) {
    const action = await select({
      message: "What do you want to do next?",
      options: [
        {
          value: "quarantine",
          label: "Quarantine items",
          hint: "move/copy to ~/.ai/.facult/quarantine",
        },
        {
          value: "view",
          label: "Inspect one item",
          hint: "open finding details",
        },
        {
          value: "view-many",
          label: "Inspect several items",
          hint: "review multiple findings together",
        },
        {
          value: "review-ai",
          label: "Review with AI",
          hint: "hand off selected findings to Codex or Claude",
        },
        {
          value: "fix-inline-secrets",
          label: "Fix inline MCP secrets",
          hint: "move secrets into local canonical overlay and re-sync",
        },
        {
          value: "mark-safe",
          label: "Mark findings safe",
          hint: "suppress reviewed false positives in future audits",
        },
        { value: "exit", label: "Exit", hint: "leave files unchanged" },
      ],
    });
    if (isCancel(action) || action === "exit") {
      outro("Done.");
      return;
    }

    if (action === "view") {
      const viewList = withFindings.slice(0, 200);
      const chosen = await select({
        message: "Pick an item to inspect",
        options: viewList.map((r, idx) => ({
          value: String(idx),
          label: labelForResult(r),
          hint: hintForResult(r),
        })),
      });
      if (isCancel(chosen)) {
        continue;
      }
      const idx = Number(String(chosen));
      const r = viewList[idx];
      if (r) {
        await viewFindingDetails(r);
      }
      continue;
    }

    if (action === "view-many") {
      const viewList = withFindings.slice(0, 100);
      const picked = await multiselect({
        message: "Select findings to inspect together",
        options: viewList.map((r, idx) => ({
          value: String(idx),
          label: labelForResult(r),
          hint: hintForResult(r),
        })),
        required: true,
      });
      if (isCancel(picked)) {
        continue;
      }
      const selected = (picked as string[])
        .map((value) => viewList[Number(value)])
        .filter(Boolean) as AuditItemResult[];
      if (selected.length === 0) {
        continue;
      }
      viewMultipleFindingDetails(selected);
      continue;
    }

    if (action === "review-ai") {
      const tools = availableInteractiveReviewerTools();
      if (tools.length === 0) {
        log.warn('No interactive reviewer found. Install "codex" or "claude".');
        continue;
      }

      const reviewList = withFindings.slice(0, 100);
      const picked = await multiselect({
        message: "Select findings to review with AI",
        options: reviewList.map((r, idx) => ({
          value: String(idx),
          label: labelForResult(r),
          hint: hintForResult(r),
        })),
        initialValues: reviewList
          .slice(0, Math.min(reviewList.length, 8))
          .map((_, idx) => String(idx)),
        required: true,
      });
      if (isCancel(picked)) {
        continue;
      }
      const selected = (picked as string[])
        .map((value) => reviewList[Number(value)])
        .filter(Boolean) as AuditItemResult[];
      if (selected.length === 0) {
        continue;
      }

      const tool =
        tools.length === 1
          ? tools[0]
          : ((await select({
              message: "Which reviewer should take this handoff?",
              options: tools.map((candidate) => ({
                value: candidate,
                label: candidate,
                hint:
                  candidate === "codex"
                    ? "interactive code-focused review"
                    : "interactive Claude review",
              })),
            })) as InteractiveReviewerTool | symbol);
      if (isCancel(tool) || !tool) {
        continue;
      }

      const prompt = buildReviewerPrompt({
        items: selected,
        reviewMode: review,
        cwd: process.cwd(),
      });

      const ok = await confirm({
        message: `Start an interactive ${tool} session with ${selected.length} selected finding${selected.length === 1 ? "" : "s"}?`,
        initialValue: true,
        active: "Start session",
        inactive: "Cancel",
      });
      if (isCancel(ok) || ok !== true) {
        continue;
      }

      log.step(`Launching ${tool} with the selected audit context...`);
      const exitCode = await launchInteractiveReviewer({
        tool,
        prompt,
        cwd: process.cwd(),
      });
      if (exitCode === 0) {
        outro(
          `Returned from ${tool}. Re-run audit when you want a fresh review queue.`
        );
      } else {
        outro(`${tool} exited with code ${exitCode}.`);
      }
      return;
    }

    if (action === "fix-inline-secrets") {
      const candidates = withFindings
        .flatMap((result) =>
          result.findings.map((finding) => ({
            result,
            finding,
          }))
        )
        .filter(
          (selection) =>
            selection.result.type === "mcp" &&
            selection.finding.ruleId.replace(AUDIT_RULE_PREFIX_RE, "") ===
              "mcp-env-inline-secret"
        )
        .slice(0, 300);
      if (candidates.length === 0) {
        log.info("No fixable inline MCP secret findings in the current queue.");
        continue;
      }

      const picked = await multiselect({
        message: "Select inline MCP secret findings to fix",
        options: candidates.map((candidate, idx) => ({
          value: String(idx),
          label: inlineSecretSelectionLabel(candidate),
          hint: hintForFindingSelection(candidate),
        })),
        required: true,
      });
      if (isCancel(picked)) {
        continue;
      }

      const selected = (picked as string[])
        .map((value) => candidates[Number(value)])
        .filter(Boolean) as {
        result: AuditItemResult;
        finding: AuditFinding;
      }[];
      if (selected.length === 0) {
        continue;
      }

      const ok = await confirm({
        message: `Fix ${selected.length} selected inline MCP secret finding${selected.length === 1 ? "" : "s"}?`,
        initialValue: true,
        active: "Fix now",
        inactive: "Cancel",
      });
      if (isCancel(ok) || ok !== true) {
        continue;
      }

      const fixResult = await fixInlineMcpSecrets({
        findings: selected,
        homeDir: homedir(),
      });
      if (fixResult.fixed === 0) {
        log.warn("No selected findings could be fixed automatically.");
        for (const skipped of fixResult.skipped.slice(0, 6)) {
          log.info(`${skipped.label}: ${skipped.reason}`);
        }
        continue;
      }

      staticReport = staticReport
        ? applyAuditSuppressionsToStaticReport(
            {
              ...staticReport,
              results: removeFixedInlineSecretFindings({
                results: staticReport.results,
                fixed: fixResult.fixedSelections,
              }),
            },
            []
          )
        : undefined;
      agentReport = agentReport
        ? applyAuditSuppressionsToAgentReport(
            {
              ...agentReport,
              results: removeFixedInlineSecretFindings({
                results: agentReport.results,
                fixed: fixResult.fixedSelections,
              }),
            },
            []
          )
        : undefined;
      refreshReviewState();

      if (staticReport) {
        await Bun.write(
          join(facultStateDir(homedir()), "audit", "static-latest.json"),
          `${JSON.stringify(staticReport, null, 2)}\n`
        );
      }
      if (agentReport) {
        await Bun.write(
          join(facultStateDir(homedir()), "audit", "agent-latest.json"),
          `${JSON.stringify(agentReport, null, 2)}\n`
        );
      }

      await updateIndexFromAuditReport({
        homeDir: homedir(),
        timestamp: new Date().toISOString(),
        results: uniqueByKey(
          mergeStaticAndAgentResults({
            static: staticReport?.results ?? [],
            agent: agentReport?.results ?? [],
          }),
          keyForResult
        ),
      });

      log.success(
        `Fixed ${fixResult.fixed} inline MCP secret finding${fixResult.fixed === 1 ? "" : "s"}.`
      );
      if (fixResult.trackedPath && fixResult.localPath) {
        log.info(`Tracked MCP config: ${fixResult.trackedPath}`);
        log.info(`Local MCP overlay: ${fixResult.localPath}`);
      }
      if (fixResult.syncedTools.length > 0) {
        log.info(
          `Re-synced managed tools: ${fixResult.syncedTools.join(", ")}`
        );
      }
      if (fixResult.riskyManagedOutputs.length > 0) {
        for (const output of fixResult.riskyManagedOutputs) {
          log.warn(
            `${output.path} is ${output.state === "tracked" ? "git-tracked" : "repo-local and not gitignored"}.`
          );
        }
      }
      if (fixResult.skipped.length > 0) {
        log.warn(
          `Skipped ${fixResult.skipped.length} finding${fixResult.skipped.length === 1 ? "" : "s"} that still need manual review.`
        );
      }
      continue;
    }

    if (action === "mark-safe") {
      const candidates = withFindings
        .flatMap((result) =>
          result.findings.map((finding) => ({
            result,
            finding,
          }))
        )
        .slice(0, 300);
      const picked = await multiselect({
        message: "Select findings to mark safe",
        options: candidates.map((candidate, idx) => ({
          value: String(idx),
          label: labelForFindingSelection(candidate),
          hint: hintForFindingSelection(candidate),
        })),
        required: true,
      });
      if (isCancel(picked)) {
        continue;
      }

      const selected = (picked as string[])
        .map((value) => candidates[Number(value)])
        .filter(Boolean) as {
        result: AuditItemResult;
        finding: AuditFinding;
      }[];
      if (selected.length === 0) {
        continue;
      }

      const why = await text({
        message: "Why is this safe?",
        placeholder: "optional note for future reviews",
      });
      if (isCancel(why)) {
        continue;
      }

      const ok = await confirm({
        message: `Suppress ${selected.length} selected finding${selected.length === 1 ? "" : "s"} in future audits?`,
        initialValue: true,
        active: "Mark safe",
        inactive: "Cancel",
      });
      if (isCancel(ok) || ok !== true) {
        continue;
      }

      const saved = await recordAuditSuppressions({
        homeDir: homedir(),
        selected,
        note: String(why ?? ""),
      });
      const nextSuppressions = await loadAuditSuppressions(homedir());
      staticReport = staticReport
        ? applyAuditSuppressionsToStaticReport(staticReport, nextSuppressions)
        : undefined;
      agentReport = agentReport
        ? applyAuditSuppressionsToAgentReport(agentReport, nextSuppressions)
        : undefined;
      refreshReviewState();

      await updateIndexFromAuditReport({
        homeDir: homedir(),
        timestamp: new Date().toISOString(),
        results: uniqueByKey(
          mergeStaticAndAgentResults({
            static: staticReport?.results ?? [],
            agent: agentReport?.results ?? [],
          }),
          keyForResult
        ),
      });

      log.success(
        `Marked ${selected.length} finding${selected.length === 1 ? "" : "s"} safe. Saved ${saved.added} new suppression${saved.added === 1 ? "" : "s"}.`
      );
      if (withFindings.length === 0) {
        outro("All reviewed findings are now suppressed.");
        return;
      }

      const failCount = withFindings.filter((result) => !result.passed).length;
      const warnCount = withFindings.length - failCount;
      log.info(`Updated review queue: ${failCount} fail, ${warnCount} warn.`);
      continue;
    }

    // quarantine
    const quarantineList = withFindings.slice(0, 500);
    const picked = await multiselect({
      message: "Select items to quarantine",
      options: quarantineList.map((r, idx) => ({
        value: String(idx),
        label: labelForResult(r),
        hint: hintForResult(r),
      })),
      initialValues: quarantineList
        .map((r, idx) => (r.passed ? null : String(idx)))
        .filter(Boolean) as string[],
      required: false,
    });
    if (isCancel(picked)) {
      continue;
    }

    const indices = (picked as string[]).map((v) => Number(v));
    const selected = indices
      .map((i) => quarantineList[i])
      .filter(Boolean) as AuditItemResult[];
    if (selected.length === 0) {
      log.info("Quarantine: no items selected.");
      continue;
    }

    const modeChoice = await select({
      message: "How should quarantine behave?",
      options: [
        {
          value: "move",
          label: "Move",
          hint: "removes from original location",
        },
        { value: "copy", label: "Copy", hint: "non-destructive snapshot" },
      ],
    });
    if (isCancel(modeChoice)) {
      continue;
    }

    const qMode = modeChoice as QuarantineMode;

    // Deduplicate by path to avoid double-moving shared config files.
    const uniquePaths = uniqueByKey(selected, (r) => r.path);
    const items = uniquePaths.map((r) => ({
      path: r.path,
      kind: r.type,
      item:
        r.type === "mcp"
          ? `mcp:${r.item}`
          : r.type === "asset"
            ? `asset:${r.item}`
            : r.type === "mcp-config"
              ? `mcp-config:${r.item}`
              : r.item,
    }));

    const ts = new Date().toISOString();
    const stamp = ts.replace(/[:.]/g, "-");
    const destDir = join(facultStateDir(homedir()), "quarantine", stamp);

    const plan = await quarantineItems({
      items,
      mode: qMode,
      dryRun: true,
      timestamp: ts,
      destDir,
    });

    const preview = plan.manifest.entries
      .slice(0, 12)
      .map(
        (e) =>
          `${qMode.toUpperCase()} ${e.originalPath} -> ${e.quarantinedPath}`
      )
      .join("\n");
    note(
      `${preview}${plan.manifest.entries.length > 12 ? `\n... (${plan.manifest.entries.length - 12} more)` : ""}`,
      "Quarantine plan"
    );

    const ok = await confirm({
      message: "Proceed with quarantine?",
      initialValue: false,
      active: "Proceed",
      inactive: "Cancel",
    });
    if (isCancel(ok) || ok === false) {
      continue;
    }

    const sp = spinner();
    sp.start("Quarantining...");
    try {
      const res = await quarantineItems({
        items,
        mode: qMode,
        timestamp: ts,
        destDir,
      });
      sp.stop("Quarantine complete.");
      log.success(`Quarantine directory: ${res.quarantineDir}`);
      log.info(`Manifest: ${join(res.quarantineDir, "manifest.json")}`);

      // If we quarantined canonical-store paths, offer to rebuild the index so list/show stay accurate.
      if (qMode === "move") {
        const root = facultRootDir();
        const touchedCanonical = res.manifest.entries.some(
          (e) =>
            e.originalPath === root || e.originalPath.startsWith(`${root}/`)
        );
        if (touchedCanonical) {
          const rebuild = await confirm({
            message: "Rebuild canonical index.json now?",
            initialValue: true,
          });
          if (!isCancel(rebuild) && rebuild === true) {
            const isp = spinner();
            isp.start("Rebuilding index...");
            try {
              const { outputPath } = await buildIndex({ force: false });
              isp.stop("Index rebuilt.");
              log.success(`Index rebuilt: ${outputPath}`);
            } catch (e: unknown) {
              isp.stop("Index rebuild failed.");
              log.error(
                `Index rebuild failed: ${e instanceof Error ? e.message : String(e)}`
              );
            }
          }
        }
      }

      outro("Done.");
      return;
    } catch (err) {
      sp.stop("Quarantine failed.");
      outro(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  }
}
