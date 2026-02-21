import { homedir } from "node:os";
import { join } from "node:path";
import {
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { buildIndex } from "../index-builder";
import { facultRootDir, readFacultConfig } from "../paths";
import { type QuarantineMode, quarantineItems } from "../quarantine";
import { type AgentAuditReport, runAgentAudit } from "./agent";
import { runStaticAudit } from "./static";
import {
  type AuditFinding,
  type AuditItemResult,
  SEVERITY_ORDER,
  type Severity,
  type StaticAuditReport,
} from "./types";

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

function printHelp() {
  console.log(`facult audit tui — interactive security audit + quarantine

Usage:
  facult audit tui
  facult audit tui --from <path> [--from <path> ...]
  facult audit tui --no-config-from

Notes:
  - This is an interactive wizard (TTY required).
  - Quarantine will move/copy files into ~/.facult/quarantine/<timestamp>/ and write a manifest.json.
  - For non-interactive runs, use: facult audit --non-interactive ...
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

  intro("facult audit");

  if (cfgRoots.length) {
    note(
      `Configured scanFrom roots:\n- ${cfgRoots.join("\n- ")}`,
      "~/.facult/config.json"
    );
  }

  const availableAgentTools = [
    ...(Bun.which("claude") ? ["claude" as const] : []),
    ...(Bun.which("codex") ? ["codex" as const] : []),
  ];

  const mode = await select({
    message: "What should we run?",
    options: [
      {
        value: "static",
        label: "Static audit (fast)",
        hint: "regex + structured checks",
      },
      ...(availableAgentTools.length
        ? [
            {
              value: "both",
              label: "Static + agent audit",
              hint: "best coverage",
            },
            {
              value: "agent",
              label: "Agent audit (slower)",
              hint: "LLM review",
            },
          ]
        : []),
    ],
  });
  if (isCancel(mode)) {
    outro("Cancelled.");
    return;
  }

  const scope = await select({
    message: "Audit scope",
    options: [
      {
        value: "defaults",
        label: "Defaults only",
        hint: "tool defaults; fastest",
      },
      {
        value: "home",
        label: "Home directory (~)",
        hint: "broad project discovery",
      },
      { value: "custom", label: "Custom roots", hint: "comma-separated list" },
      ...(cfgRoots.length
        ? [
            {
              value: "config",
              label: "Use configured scanFrom",
              hint: "from ~/.facult/config.json",
            },
          ]
        : []),
    ],
  });
  if (isCancel(scope)) {
    outro("Cancelled.");
    return;
  }

  let includeConfigFrom = !noConfigFrom;
  let from: string[] = [];
  if (scope === "defaults") {
    includeConfigFrom = false;
    from = [];
  } else if (scope === "home") {
    from = parsedFrom.length ? parsedFrom : ["~"];
  } else if (scope === "config") {
    from = parsedFrom;
  } else {
    const raw = await text({
      message: "Roots to scan (comma-separated)",
      placeholder: parsedFrom.length ? parsedFrom.join(", ") : "~, ~/dev",
    });
    if (isCancel(raw)) {
      outro("Cancelled.");
      return;
    }
    from = String(raw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const includeGitHooks = await confirm({
    message: "Include git hooks (husky + .git/hooks)?",
    initialValue: false,
  });
  if (isCancel(includeGitHooks)) {
    outro("Cancelled.");
    return;
  }

  let minSeverity: Severity = "high";
  if (mode === "static" || mode === "both") {
    const sev = await select({
      message: "Minimum severity to show",
      options: [
        { value: "critical", label: "critical", hint: "only critical" },
        { value: "high", label: "high", hint: "high + critical" },
        { value: "medium", label: "medium", hint: "medium + above" },
        { value: "low", label: "low", hint: "everything" },
      ],
    });
    if (isCancel(sev)) {
      outro("Cancelled.");
      return;
    }
    minSeverity = sev as Severity;
  }

  let agentTool: "claude" | "codex" | null = null;
  let maxItems = 50;
  if (mode === "agent" || mode === "both") {
    if (availableAgentTools.length === 0) {
      note('No agent tool found. Install "claude" or "codex".', "Agent audit");
    } else if (availableAgentTools.length === 1) {
      agentTool = availableAgentTools[0] ?? null;
    } else {
      const chosen = await select({
        message: "Agent tool",
        options: availableAgentTools.map((t) => ({
          value: t,
          label: t,
        })),
      });
      if (isCancel(chosen)) {
        outro("Cancelled.");
        return;
      }
      agentTool = chosen as "claude" | "codex";
    }

    const rawMax = await text({
      message: "Max items to send to the agent",
      placeholder: "50 (or 'all')",
      defaultValue: String(maxItems),
    });
    if (isCancel(rawMax)) {
      outro("Cancelled.");
      return;
    }
    const raw = String(rawMax).trim().toLowerCase();
    if (raw === "all" || raw === "0") {
      maxItems = 0;
    } else {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) {
        maxItems = Math.floor(n);
      }
    }
  }

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
    } catch (err) {
      sp.stop("Agent audit failed.");
      outro(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  }

  const summaries: string[] = [];
  if (reports.static) {
    summaries.push(`Static: ${summarizeReportStatic(reports.static)}`);
    summaries.push(
      `Wrote ${join(homedir(), ".facult", "audit", "static-latest.json")}`
    );
  }
  if (reports.agent) {
    summaries.push(`Agent: ${summarizeReportAgent(reports.agent)}`);
    summaries.push(
      `Wrote ${join(homedir(), ".facult", "audit", "agent-latest.json")}`
    );
  }
  if (summaries.length) {
    note(summaries.join("\n"), "Summary");
  }

  const combined = uniqueByKey(
    mergeStaticAndAgentResults({
      static: reports.static?.results ?? [],
      agent: reports.agent?.results ?? [],
    }),
    keyForResult
  );

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

  const results =
    review === "combined"
      ? combined
      : review === "agent"
        ? (reports.agent?.results ?? [])
        : (reports.static?.results ?? []);

  const withFindings = results
    .filter((r) => r.findings.length > 0)
    .sort((a, b) => {
      const sa = SEVERITY_ORDER[maxSeverity(a.findings) ?? "low"];
      const sb = SEVERITY_ORDER[maxSeverity(b.findings) ?? "low"];
      return (
        sb - sa || a.type.localeCompare(b.type) || a.item.localeCompare(b.item)
      );
    });

  if (withFindings.length === 0) {
    outro("No findings.");
    return;
  }

  const failCount = withFindings.filter((r) => !r.passed).length;
  const warnCount = withFindings.length - failCount;
  note(`fail=${failCount} warn=${warnCount}`, "Review");

  while (true) {
    const action = await select({
      message: "Next action",
      options: [
        {
          value: "quarantine",
          label: "Quarantine items",
          hint: "move/copy to ~/.facult/quarantine",
        },
        { value: "view", label: "View item details", hint: "inspect findings" },
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
        message: "Pick an item to view",
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
      note("No items selected.", "Quarantine");
      continue;
    }

    const modeChoice = await select({
      message: "Quarantine mode",
      options: [
        {
          value: "move",
          label: "Move (quarantine)",
          hint: "removes from original location",
        },
        { value: "copy", label: "Copy (snapshot)", hint: "non-destructive" },
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
    const destDir = join(homedir(), ".facult", "quarantine", stamp);

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
      "Planned quarantine"
    );

    const ok = await confirm({
      message: "Proceed with quarantine?",
      initialValue: false,
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
      note(
        `Quarantine directory:\n${res.quarantineDir}\n\nManifest:\n${join(
          res.quarantineDir,
          "manifest.json"
        )}`,
        "Quarantine"
      );

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
              note(`Index written to:\n${outputPath}`, "Index");
            } catch (e: unknown) {
              isp.stop("Index rebuild failed.");
              note(e instanceof Error ? e.message : String(e), "Index");
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
