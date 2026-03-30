#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const NEWLINE_PATTERN = /\r?\n/;

function parseArgs(argv) {
  const options = {
    file: "autoresearch.jsonl",
    limit: 12,
    watch: false,
    intervalMs: 1000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file" || arg === "-f") {
      options.file = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg?.startsWith("--file=")) {
      options.file = arg.slice("--file=".length);
      continue;
    }
    if (arg === "--limit" || arg === "-n") {
      options.limit = Number(argv[index + 1] ?? options.limit);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--limit=")) {
      options.limit = Number(arg.slice("--limit=".length));
      continue;
    }
    if (arg === "--watch" || arg === "-w") {
      options.watch = true;
      continue;
    }
    if (arg === "--interval") {
      options.intervalMs = Number(argv[index + 1] ?? options.intervalMs);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--interval=")) {
      options.intervalMs = Number(arg.slice("--interval=".length));
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(options.limit) || options.limit <= 0) {
    throw new Error("--limit must be a positive number");
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error("--interval must be a positive number");
  }
  return options;
}

function printHelp() {
  console.log(`autoresearch-dashboard

Usage:
  autoresearch-dashboard.js [--file autoresearch.jsonl] [--limit 12] [--watch] [--interval 1000]
`);
}

function readJsonl(filePath) {
  const absolutePath = path.resolve(filePath);
  const raw = fs.readFileSync(absolutePath, "utf8");
  return raw
    .split(NEWLINE_PATTERN)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function enrichEntries(entries) {
  let segment = -1;
  return entries.map((entry) => {
    if (entry.type === "config") {
      segment += 1;
      return { ...entry, segment };
    }
    return {
      ...entry,
      segment: typeof entry.segment === "number" ? entry.segment : segment,
    };
  });
}

function getCurrentSegment(entries) {
  const configs = entries.filter((entry) => entry.type === "config");
  const latestConfig = configs.at(-1);
  if (!latestConfig) {
    throw new Error("No config entry found in autoresearch.jsonl");
  }
  const segment = latestConfig.segment;
  const runs = entries.filter(
    (entry) => entry.type !== "config" && entry.segment === segment
  );
  return { config: latestConfig, runs, segment };
}

function compareMetric(left, right, direction) {
  return direction === "higher" ? right - left : left - right;
}

function selectBestRun(runs, direction) {
  const candidates = runs.filter(
    (run) => run.status === "keep" && Number.isFinite(run.metric)
  );
  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((best, candidate) => {
    if (!best) {
      return candidate;
    }
    return compareMetric(candidate.metric, best.metric, direction) < 0
      ? candidate
      : best;
  }, null);
}

function formatNumber(value, digits = 0) {
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function metricDigits(unit) {
  return unit === "ms" || unit === "s" ? 3 : 0;
}

function formatMetric(value, unit) {
  const digits = metricDigits(unit);
  const rendered = formatNumber(value, digits);
  return unit ? `${rendered}${unit}` : rendered;
}

function formatDelta(baseline, value) {
  if (!Number.isFinite(baseline) || baseline === 0 || !Number.isFinite(value)) {
    return "n/a";
  }
  const ratio = ((value - baseline) / baseline) * 100;
  const sign = ratio > 0 ? "+" : "";
  return `${sign}${ratio.toFixed(1)}%`;
}

function computeSummary(config, runs) {
  const direction = config.bestDirection ?? "lower";
  const baseline = runs[0] ?? null;
  const best = selectBestRun(runs, direction);
  const counts = {
    total: runs.length,
    keep: runs.filter((run) => run.status === "keep").length,
    discard: runs.filter((run) => run.status === "discard").length,
    crash: runs.filter((run) => run.status === "crash").length,
    checksFailed: runs.filter((run) => run.status === "checks_failed").length,
  };
  return { direction, baseline, best, counts };
}

function collectSecondaryMetrics(runs) {
  const keys = [];
  const seen = new Set();
  for (const run of runs) {
    const metrics = run.metrics ?? {};
    for (const key of Object.keys(metrics)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys;
}

function color(text, code) {
  if (!process.stdout.isTTY) {
    return text;
  }
  return `\u001b[${code}m${text}\u001b[0m`;
}

function statusColor(status) {
  switch (status) {
    case "keep":
      return 32;
    case "discard":
      return 33;
    case "crash":
    case "checks_failed":
      return 31;
    default:
      return 0;
  }
}

function truncate(text, width) {
  if (width <= 0) {
    return "";
  }
  if (text.length <= width) {
    return text;
  }
  if (width <= 1) {
    return text.slice(0, width);
  }
  return `${text.slice(0, width - 1)}…`;
}

function pad(text, width, align = "left") {
  const value = truncate(String(text), width);
  return align === "right" ? value.padStart(width) : value.padEnd(width);
}

function renderTable(config, runs, baselineMetric) {
  const secondaryKeys = collectSecondaryMetrics(runs).slice(0, 3);
  const width = process.stdout.columns ?? 160;
  const columns = [
    { key: "run", label: "#", width: 4, align: "right" },
    { key: "commit", label: "commit", width: 8 },
    {
      key: "metric",
      label: config.metricName ?? "metric",
      width: 14,
      align: "right",
    },
    { key: "delta", label: "delta", width: 9, align: "right" },
    ...secondaryKeys.map((key) => ({
      key,
      label: key,
      width: 16,
      align: "right",
    })),
    { key: "status", label: "status", width: 13 },
  ];
  const usedWidth =
    columns.reduce((sum, column) => sum + column.width, 0) +
    (columns.length - 1) * 2;
  const descriptionWidth = Math.max(24, width - usedWidth - 2);
  const headers = [
    ...columns.map((column) => pad(column.label, column.width, column.align)),
    pad("description", descriptionWidth),
  ];

  const lines = [
    headers.join("  "),
    "-".repeat(Math.min(width, headers.join("  ").length)),
  ];
  for (const run of runs) {
    const row = [
      pad(run.run ?? "", 4, "right"),
      pad(run.commit ?? "", 8),
      pad(formatMetric(run.metric, config.metricUnit ?? ""), 14, "right"),
      pad(formatDelta(baselineMetric, run.metric), 9, "right"),
      ...secondaryKeys.map((key) =>
        pad(
          key in (run.metrics ?? {}) ? formatNumber(run.metrics[key], 0) : "—",
          16,
          "right"
        )
      ),
      color(pad(run.status, 13), statusColor(run.status)),
      pad(run.description ?? "", descriptionWidth),
    ];
    lines.push(row.join("  "));
  }
  return lines;
}

function renderDashboard(entries, options) {
  const { config, runs, segment } = getCurrentSegment(entries);
  const { baseline, best, counts } = computeSummary(config, runs);
  const recentRuns = runs.slice(-options.limit);
  const width = process.stdout.columns ?? 160;

  const lines = [];
  lines.push(color("autoresearch", "1;36"));
  lines.push(
    [
      `session: ${config.name}`,
      `segment: ${segment}`,
      `runs: ${counts.total}`,
      color(`${counts.keep} kept`, "32"),
      color(`${counts.discard} discarded`, "33"),
      counts.crash ? color(`${counts.crash} crashed`, "31") : null,
      counts.checksFailed
        ? color(`${counts.checksFailed} checks_failed`, "31")
        : null,
    ]
      .filter(Boolean)
      .join("  ")
  );
  if (baseline) {
    lines.push(
      `baseline: ${formatMetric(baseline.metric, config.metricUnit ?? "")} (#${baseline.run})`
    );
  }
  if (best && baseline) {
    lines.push(
      `best: ${formatMetric(best.metric, config.metricUnit ?? "")} (#${best.run})  ` +
        `delta: ${formatDelta(baseline.metric, best.metric)}`
    );
  }
  const latest = runs.at(-1);
  if (latest?.asi?.next_action_hint) {
    lines.push(`next: ${latest.asi.next_action_hint}`);
  }
  lines.push("-".repeat(width > 120 ? 120 : width));
  lines.push(...renderTable(config, recentRuns, baseline?.metric));
  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const renderOnce = () => {
    const entries = enrichEntries(readJsonl(options.file));
    const output = renderDashboard(entries, options);
    if (options.watch && process.stdout.isTTY) {
      process.stdout.write("\u001bc");
    }
    process.stdout.write(`${output}\n`);
  };

  renderOnce();
  if (!options.watch) {
    return;
  }

  setInterval(() => {
    try {
      renderOnce();
    } catch (error) {
      if (process.stdout.isTTY) {
        process.stdout.write("\u001bc");
      }
      process.stdout.write(`${String(error)}\n`);
    }
  }, options.intervalMs);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
