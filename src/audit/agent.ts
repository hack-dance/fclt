import { mkdir, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { facultRootDir, facultStateDir, readFacultConfig } from "../paths";
import type { AssetFile, ScanResult } from "../scan";
import { scan } from "../scan";
import {
  extractCodexTomlMcpServerBlocks,
  sanitizeCodexTomlMcpText,
} from "../util/codex-toml";
import { parseJsonLenient } from "../util/json";
import {
  type AuditFinding,
  type AuditItemResult,
  parseSeverity,
  SEVERITY_ORDER,
  type Severity,
} from "./types";
import { updateIndexFromAuditReport } from "./update-index";

type AgentTool = "claude" | "codex";

export interface AgentAuditReport {
  timestamp: string;
  mode: "agent";
  agent: {
    tool: AgentTool;
    model?: string;
  };
  scope: {
    from: string[];
    maxItems: number;
    requested?: string | null;
  };
  results: AuditItemResult[];
  summary: {
    totalItems: number;
    totalFindings: number;
    bySeverity: Record<Severity, number>;
    flaggedItems: number;
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const SECRETY_STRING_RE =
  /\b(sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g;
const SECRET_KEY_RE = /(TOKEN|KEY|SECRET|PASSWORD|PASS|BEARER)/i;

function redactPossibleSecrets(value: string): string {
  return value.replace(SECRETY_STRING_RE, "<redacted>");
}

function sanitizeEnvAssignments(text: string): string {
  // Redact common KEY=... patterns for secret-ish keys.
  return text.replace(
    /^([A-Z0-9_]*(TOKEN|KEY|SECRET|PASSWORD|PASS|BEARER)[A-Z0-9_]*)\s*=\s*.*$/gim,
    "$1=<redacted>"
  );
}

function requestedNameFromArgv(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === "--with" || arg === "--from" || arg === "--max-items") {
      i += 1;
      continue;
    }
    if (
      arg.startsWith("--with=") ||
      arg.startsWith("--from=") ||
      arg.startsWith("--max-items=")
    ) {
      continue;
    }
    if (arg === "--json") {
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return arg;
  }
  return null;
}

function parseFromFlags(argv: string[]): string[] {
  const from: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === "--from") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--from requires a path");
      }
      from.push(next);
      i += 1;
      continue;
    }
    if (arg.startsWith("--from=")) {
      const value = arg.slice("--from=".length);
      if (!value) {
        throw new Error("--from requires a path");
      }
      from.push(value);
    }
  }
  return from;
}

function parseWithFlag(argv: string[]): AgentTool | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === "--with") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--with requires claude|codex");
      }
      const v = next.trim().toLowerCase();
      if (v === "claude" || v === "codex") {
        return v;
      }
      throw new Error(`Unknown agent tool: ${next}`);
    }
    if (arg.startsWith("--with=")) {
      const raw = arg.slice("--with=".length).trim().toLowerCase();
      if (raw === "claude" || raw === "codex") {
        return raw;
      }
      throw new Error(`Unknown agent tool: ${raw}`);
    }
  }
  return null;
}

function parseMaxItemsFlag(argv: string[]): number | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === "--max-items") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--max-items requires a number");
      }
      const raw = next.trim().toLowerCase();
      if (raw === "all" || raw === "0") {
        return 0;
      }
      const n = Number(next);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`Invalid --max-items value: ${next}`);
      }
      return Math.floor(n);
    }
    if (arg.startsWith("--max-items=")) {
      const raw = arg.slice("--max-items=".length);
      const trimmed = raw.trim().toLowerCase();
      if (trimmed === "all" || trimmed === "0") {
        return 0;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`Invalid --max-items value: ${raw}`);
      }
      return Math.floor(n);
    }
  }
  return null;
}

function extractMcpServersObject(
  parsed: unknown
): Record<string, unknown> | null {
  if (!isPlainObject(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (isPlainObject(obj.mcpServers)) {
    return obj.mcpServers as Record<string, unknown>;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k.endsWith(".mcpServers") && isPlainObject(v)) {
      return v as Record<string, unknown>;
    }
  }
  if (isPlainObject(obj["mcp.servers"])) {
    return obj["mcp.servers"] as Record<string, unknown>;
  }
  if (isPlainObject(obj.servers)) {
    return obj.servers as Record<string, unknown>;
  }
  if (isPlainObject(obj.mcp)) {
    const mcp = obj.mcp as Record<string, unknown>;
    if (isPlainObject(mcp.servers)) {
      return mcp.servers as Record<string, unknown>;
    }
  }
  return null;
}

function mcpSafeText(definition: unknown): string {
  if (!isPlainObject(definition)) {
    return redactPossibleSecrets(String(definition));
  }

  const obj = definition as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (typeof obj.transport === "string") {
    out.transport = obj.transport;
  }
  if (typeof obj.command === "string") {
    out.command = redactPossibleSecrets(obj.command);
  }
  if (Array.isArray(obj.args)) {
    out.args = obj.args.map((v) => redactPossibleSecrets(String(v)));
  }
  if (typeof obj.url === "string") {
    out.url = redactPossibleSecrets(obj.url);
  }
  if (isPlainObject(obj.env)) {
    out.envKeys = Object.keys(obj.env as Record<string, unknown>).sort();
  }
  if (isPlainObject(obj.vendorExtensions)) {
    out.vendorKeys = Object.keys(
      obj.vendorExtensions as Record<string, unknown>
    ).sort();
  }

  return JSON.stringify(out, null, 2);
}

function sanitizeJsonSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return redactPossibleSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 500).map(sanitizeJsonSecrets);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = "<redacted>";
    } else {
      out[k] = sanitizeJsonSecrets(v);
    }
  }
  return out;
}

function computeAuditStatus(findings: AuditFinding[]): "passed" | "flagged" {
  const bad = findings.some(
    (f) => f.severity === "high" || f.severity === "critical"
  );
  return bad ? "flagged" : "passed";
}

function selectPreferredSkillInstance(
  items: { name: string; path: string; sourceId: string }[],
  canonicalRoot: string
): { name: string; path: string; sourceId: string }[] {
  const byName = new Map<
    string,
    { name: string; path: string; sourceId: string }
  >();

  const score = (p: string): number => {
    if (p.startsWith(canonicalRoot)) {
      return 100;
    }
    return 0;
  };

  for (const it of items) {
    const prev = byName.get(it.name);
    if (!prev) {
      byName.set(it.name, it);
      continue;
    }
    const sp = score(prev.path);
    const si = score(it.path);
    if (si > sp) {
      byName.set(it.name, it);
      continue;
    }
    if (si === sp && it.path.length < prev.path.length) {
      byName.set(it.name, it);
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function readSkillBundle(skillDir: string): Promise<string> {
  const skillMd = join(skillDir, "SKILL.md");
  const file = Bun.file(skillMd);
  if (!(await file.exists())) {
    return "";
  }

  let text = await file.text();
  text = sanitizeEnvAssignments(redactPossibleSecrets(text));

  // Optionally include small supporting scripts/references; keep bounded.
  const included: { rel: string; content: string }[] = [];
  const glob = new Bun.Glob("**/*");
  for await (const rel of glob.scan({ cwd: skillDir, onlyFiles: true })) {
    const parts = rel.split(sep);
    if (parts.includes("node_modules") || parts.includes(".git")) {
      continue;
    }
    // Always include SKILL.md only once.
    if (rel === "SKILL.md") {
      continue;
    }
    // Prefer common subdirs. Skip other files to avoid sending huge bundles.
    const root = parts[0] ?? "";
    if (root !== "scripts" && root !== "references" && root !== "assets") {
      continue;
    }
    const abs = join(skillDir, rel);
    const st = await Bun.file(abs)
      .stat()
      .catch(() => null);
    if (!st?.isFile()) {
      continue;
    }
    if (st.size > 50_000) {
      continue;
    }
    const raw = await Bun.file(abs)
      .text()
      .catch(() => "");
    if (!raw) {
      continue;
    }
    included.push({
      rel,
      content: sanitizeEnvAssignments(redactPossibleSecrets(raw)),
    });
    if (included.length >= 12) {
      break;
    }
  }

  let bundle = `SKILL.md:\n${text}\n`;
  for (const f of included) {
    bundle += `\nFILE: ${f.rel}\n${f.content}\n`;
  }

  // Keep bundle size bounded.
  const MAX_CHARS = 200_000;
  if (bundle.length > MAX_CHARS) {
    bundle = bundle.slice(0, MAX_CHARS);
  }

  return bundle;
}

async function readAssetBundle(asset: AssetFile): Promise<string> {
  const file = Bun.file(asset.path);
  if (!(await file.exists())) {
    return "";
  }
  let text = await file.text();
  if (text.length > 200_000) {
    text = text.slice(0, 200_000);
  }
  if (asset.format === "json") {
    try {
      const parsed = parseJsonLenient(text);
      text = JSON.stringify(sanitizeJsonSecrets(parsed), null, 2);
    } catch {
      // keep raw
    }
  }
  text = sanitizeEnvAssignments(redactPossibleSecrets(text));
  return text;
}

type PerItemOutput = {
  passed: boolean;
  findings: {
    severity: Severity;
    category: string;
    message: string;
    recommendation?: string;
    location?: string;
  }[];
  notes?: string;
};

const PER_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    passed: { type: "boolean" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: {
            type: "string",
            enum: ["low", "medium", "high", "critical"],
          },
          category: { type: "string" },
          message: { type: "string" },
          recommendation: { type: "string" },
          location: { type: "string" },
        },
        // Codex output-schema validation is strict: required must include all keys in properties.
        // Use empty strings for fields that don't apply.
        required: [
          "severity",
          "category",
          "message",
          "recommendation",
          "location",
        ],
      },
    },
    notes: { type: "string" },
  },
  // Codex output-schema validation is strict: required must include all keys in properties.
  // Use empty string for notes if there is nothing to add.
  required: ["passed", "findings", "notes"],
} as const;

async function runClaude(
  prompt: string
): Promise<{ output: PerItemOutput; model?: string }> {
  const proc = Bun.spawn({
    cmd: [
      "claude",
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(PER_ITEM_SCHEMA),
      "--tools",
      "",
    ],
    stdin: new Blob([prompt]),
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`claude exited with code ${code}: ${stderr || stdout}`);
  }

  const parsed = JSON.parse(stdout) as any;
  const structured = parsed?.structured_output as unknown;
  if (!structured || typeof structured !== "object") {
    throw new Error("claude did not return structured_output");
  }
  return {
    output: structured as PerItemOutput,
    model: Object.keys(parsed?.modelUsage ?? {})[0],
  };
}

async function runCodex(
  prompt: string
): Promise<{ output: PerItemOutput; model?: string }> {
  const dir = await mkdtemp(join(tmpdir(), "facult-agent-audit-"));
  const schemaPath = join(dir, "schema.json");
  const outPath = join(dir, "last-message.txt");
  await Bun.write(schemaPath, `${JSON.stringify(PER_ITEM_SCHEMA, null, 2)}\n`);

  const proc = Bun.spawn({
    cmd: [
      "codex",
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outPath,
      "-",
    ],
    stdin: new Blob([prompt]),
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`codex exited with code ${code}: ${stderr || stdout}`);
  }

  const raw = await Bun.file(outPath).text();
  const trimmed = raw.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < 0 || jsonEnd <= jsonStart) {
    throw new Error("codex output did not contain JSON object");
  }
  const parsed = JSON.parse(
    trimmed.slice(jsonStart, jsonEnd + 1)
  ) as PerItemOutput;
  return { output: parsed };
}

function promptForItem(args: {
  kind: "skill" | "mcp" | "asset";
  name: string;
  path: string;
  content: string;
}): string {
  return `You are auditing local coding-assistant configuration assets for security risks.

Goals:
- Find security issues (credential access, data exfiltration, destructive commands, privilege escalation, persistence).
- Flag risky patterns and suggest concrete mitigations.
- Be conservative: if it's unclear, mark as medium and explain.
- Do not invent file contents; only analyze what is provided.
- Do not output secrets; if you see something that looks like a secret, refer to it as "<redacted>".

Return ONLY JSON that matches the provided schema.
Schema notes:
- All fields are required.
- If a field does not apply, use an empty string (e.g. recommendation/location/notes).

Item:
  type: ${args.kind}
  name: ${args.name}
  path: ${args.path}

Content (sanitized):
${args.content}
`;
}

export async function runAgentAudit(opts?: {
  argv?: string[];
  homeDir?: string;
  cwd?: string;
  from?: string[];
  includeConfigFrom?: boolean;
  includeGitHooks?: boolean;
  requested?: string | null;
  withTool?: AgentTool;
  maxItems?: number;
  // Test hook: inject a runner by tool name.
  runner?: (
    tool: AgentTool,
    prompt: string
  ) => Promise<{ output: PerItemOutput; model?: string }>;
  onProgress?: (p: {
    phase: "start" | "done";
    current: number;
    total: number;
    type: "skill" | "mcp" | "asset";
    item: string;
    path: string;
  }) => void;
}): Promise<AgentAuditReport> {
  const argv = opts?.argv ?? [];
  const home = opts?.homeDir ?? homedir();
  const cwd = opts?.cwd ?? process.cwd();

  const includeConfigFrom =
    opts?.includeConfigFrom ?? !argv.includes("--no-config-from");
  let from = opts?.from ?? parseFromFlags(argv);
  if (includeConfigFrom && from.length === 0) {
    const cfg = readFacultConfig(home);
    if (!(cfg?.scanFrom && cfg.scanFrom.length > 0)) {
      from = ["~"];
    }
  }
  const requested = opts?.requested ?? requestedNameFromArgv(argv);
  const tool =
    opts?.withTool ??
    parseWithFlag(argv) ??
    (Bun.which("claude") ? "claude" : Bun.which("codex") ? "codex" : null);
  if (!tool) {
    throw new Error(
      'No agent tool found. Install "claude" or "codex", or pass --with.'
    );
  }

  const maxItems = opts?.maxItems ?? parseMaxItemsFlag(argv) ?? 50;

  const scanRes: ScanResult = await scan(argv, {
    homeDir: home,
    cwd,
    includeConfigFrom,
    includeGitHooks:
      opts?.includeGitHooks ?? argv.includes("--include-git-hooks"),
    from,
  });
  const canonicalRoot = facultRootDir(home);

  // Collect skill instances and prefer canonical copies when available.
  const skillInstances: { name: string; path: string; sourceId: string }[] = [];
  for (const src of scanRes.sources) {
    for (const dir of src.skills.entries) {
      skillInstances.push({ name: basename(dir), path: dir, sourceId: src.id });
    }
  }
  const skills = selectPreferredSkillInstance(skillInstances, canonicalRoot);

  // Collect MCP servers from all configs (best-effort), but prefer canonical store definitions.
  const mcpByName = new Map<
    string,
    { name: string; sourceId: string; path: string; definition: unknown }
  >();
  const mcpScore = (configPath: string): number => {
    if (configPath.startsWith(join(canonicalRoot, "mcp"))) {
      return 100;
    }
    if (configPath.startsWith(canonicalRoot)) {
      return 90;
    }
    return 0;
  };

  for (const src of scanRes.sources) {
    for (const cfg of src.mcp.configs) {
      if (cfg.format === "toml" || cfg.path.endsWith(".toml")) {
        let txt: string;
        try {
          txt = await Bun.file(cfg.path).text();
        } catch {
          continue;
        }
        const blocks = extractCodexTomlMcpServerBlocks(txt);
        for (const [name, blockText] of Object.entries(blocks)) {
          const definition = sanitizeCodexTomlMcpText(blockText);
          const existing = mcpByName.get(name);
          if (!existing) {
            mcpByName.set(name, {
              name,
              sourceId: src.id,
              path: cfg.path,
              definition,
            });
            continue;
          }
          const curScore = mcpScore(existing.path);
          const nextScore = mcpScore(cfg.path);
          if (nextScore > curScore) {
            mcpByName.set(name, {
              name,
              sourceId: src.id,
              path: cfg.path,
              definition,
            });
          }
        }
        continue;
      }

      if (cfg.format !== "json") {
        continue;
      }
      let parsed: unknown;
      try {
        const txt = await Bun.file(cfg.path).text();
        parsed = parseJsonLenient(txt);
      } catch {
        continue;
      }
      const serversObj = extractMcpServersObject(parsed);
      if (!serversObj) {
        continue;
      }
      for (const [name, definition] of Object.entries(serversObj)) {
        const existing = mcpByName.get(name);
        if (!existing) {
          mcpByName.set(name, {
            name,
            sourceId: src.id,
            path: cfg.path,
            definition,
          });
          continue;
        }
        const curScore = mcpScore(existing.path);
        const nextScore = mcpScore(cfg.path);
        if (nextScore > curScore) {
          mcpByName.set(name, {
            name,
            sourceId: src.id,
            path: cfg.path,
            definition,
          });
        }
      }
    }
  }

  const assets: {
    item: string;
    path: string;
    sourceId: string;
    file: AssetFile;
  }[] = [];
  for (const src of scanRes.sources) {
    for (const f of src.assets.files) {
      // Avoid noisy default sample hooks when scanning many repos.
      if (f.kind === "git-hook" && f.path.endsWith(".sample")) {
        continue;
      }
      assets.push({
        item: `${f.kind}:${basename(f.path)}`,
        path: f.path,
        sourceId: src.id,
        file: f,
      });
    }
  }

  const requestedParsed: { kind: "skill" | "mcp"; name: string } | null =
    requested
      ? requested.startsWith("mcp:")
        ? { kind: "mcp", name: requested.slice("mcp:".length) }
        : { kind: "skill", name: requested }
      : null;

  const items: {
    type: "skill" | "mcp" | "asset";
    item: string;
    path: string;
    sourceId: string;
    content: string;
  }[] = [];

  if (!requestedParsed || requestedParsed.kind === "skill") {
    for (const s of skills) {
      if (requestedParsed && requestedParsed.name !== s.name) {
        continue;
      }
      const content = await readSkillBundle(s.path);
      if (!content) {
        continue;
      }
      items.push({
        type: "skill",
        item: s.name,
        path: s.path,
        sourceId: s.sourceId,
        content,
      });
    }
  }

  if (!requestedParsed || requestedParsed.kind === "mcp") {
    for (const [name, entry] of [...mcpByName.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      if (requestedParsed && requestedParsed.name !== name) {
        continue;
      }
      const content = mcpSafeText(entry.definition);
      items.push({
        type: "mcp",
        item: name,
        path: entry.path,
        sourceId: entry.sourceId,
        content,
      });
    }
  }

  if (!requestedParsed) {
    for (const a of assets.sort(
      (x, y) => x.item.localeCompare(y.item) || x.path.localeCompare(y.path)
    )) {
      const content = await readAssetBundle(a.file);
      if (!content) {
        continue;
      }
      items.push({
        type: "asset",
        item: a.item,
        path: a.path,
        sourceId: a.sourceId,
        content,
      });
    }
  }

  const limit = maxItems === 0 ? items.length : maxItems;
  const limited = items.slice(0, limit);
  const runner =
    opts?.runner ??
    (async (t: AgentTool, prompt: string) => {
      if (t === "claude") {
        return await runClaude(prompt);
      }
      return await runCodex(prompt);
    });

  const results: AuditItemResult[] = [];
  let model: string | undefined;

  for (let i = 0; i < limited.length; i += 1) {
    const it = limited[i]!;
    opts?.onProgress?.({
      phase: "start",
      current: i + 1,
      total: limited.length,
      type: it.type,
      item: it.item,
      path: it.path,
    });

    const prompt = promptForItem({
      kind: it.type,
      name: it.type === "mcp" ? `mcp:${it.item}` : it.item,
      path: it.path,
      content: it.content,
    });

    let out: PerItemOutput | null = null;
    try {
      const res = await runner(tool, prompt);
      out = res.output;
      model = model ?? res.model;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        item: it.item,
        type: it.type,
        sourceId: it.sourceId,
        path: it.path,
        passed: false,
        findings: [
          {
            severity: "medium",
            ruleId: "agent-error",
            message: "Agent audit failed; review manually.",
            location: it.path,
            evidence: redactPossibleSecrets(msg),
          },
        ],
      });
      opts?.onProgress?.({
        phase: "done",
        current: i + 1,
        total: limited.length,
        type: it.type,
        item: it.item,
        path: it.path,
      });
      continue;
    }

    const findings: AuditFinding[] = [];
    for (const f of out.findings ?? []) {
      const sev = parseSeverity(f.severity);
      if (!sev) {
        continue;
      }
      const loc =
        typeof f.location === "string" && f.location.trim()
          ? f.location.trim()
          : undefined;
      const rec =
        typeof f.recommendation === "string" && f.recommendation.trim()
          ? f.recommendation.trim()
          : undefined;
      findings.push({
        severity: sev,
        ruleId: f.category || "agent",
        message: f.message,
        location: loc,
        evidence: rec,
      });
    }

    const status = computeAuditStatus(findings);
    results.push({
      item: it.item,
      type: it.type,
      sourceId: it.sourceId,
      path: it.path,
      passed: status === "passed",
      findings,
      notes:
        typeof out.notes === "string"
          ? (() => {
              const txt = out.notes.trim();
              if (!txt) {
                return undefined;
              }
              return sanitizeEnvAssignments(redactPossibleSecrets(txt));
            })()
          : undefined,
    });

    opts?.onProgress?.({
      phase: "done",
      current: i + 1,
      total: limited.length,
      type: it.type,
      item: it.item,
      path: it.path,
    });
  }

  // Summary
  const bySeverity: Record<Severity, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  let totalFindings = 0;
  let flaggedItems = 0;

  for (const r of results) {
    totalFindings += r.findings.length;
    if (!r.passed && r.findings.length > 0) {
      flaggedItems += 1;
    }
    for (const f of r.findings) {
      bySeverity[f.severity] += 1;
    }
  }

  const report: AgentAuditReport = {
    timestamp: new Date().toISOString(),
    mode: "agent",
    agent: { tool, model },
    scope: {
      from,
      maxItems,
      requested,
    },
    results: results.sort((a, b) => {
      const aBad = a.findings.reduce(
        (m, f) => Math.max(m, SEVERITY_ORDER[f.severity]),
        -1
      );
      const bBad = b.findings.reduce(
        (m, f) => Math.max(m, SEVERITY_ORDER[f.severity]),
        -1
      );
      return (
        bBad - aBad ||
        a.type.localeCompare(b.type) ||
        a.item.localeCompare(b.item)
      );
    }),
    summary: {
      totalItems: results.length,
      totalFindings,
      bySeverity,
      flaggedItems,
    },
  };

  const auditDir = join(facultStateDir(home), "audit");
  await mkdir(auditDir, { recursive: true });
  await Bun.write(
    join(auditDir, "agent-latest.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );

  return report;
}

function printHuman(report: AgentAuditReport) {
  console.log("Agent Security Audit");
  console.log("====================");
  console.log("");
  console.log(
    `Agent: ${report.agent.tool}${report.agent.model ? ` (${report.agent.model})` : ""}`
  );
  console.log(
    `Max items: ${report.scope.maxItems === 0 ? "all" : report.scope.maxItems}`
  );
  if (report.scope.from.length) {
    console.log(`From: ${report.scope.from.join(", ")}`);
  }
  if (report.scope.requested) {
    console.log(`Requested: ${report.scope.requested}`);
  }
  console.log("");

  const failures = report.results.filter(
    (r) => !r.passed && r.findings.length > 0
  );
  const passes = report.results.filter(
    (r) => r.passed || r.findings.length === 0
  );

  for (const r of [...failures, ...passes]) {
    const status = r.findings.length === 0 ? "OK" : r.passed ? "WARN" : "FAIL";
    const label =
      r.type === "mcp"
        ? `mcp:${r.item}`
        : r.type === "asset"
          ? `asset:${r.item}`
          : r.item;
    const count = r.findings.length;
    console.log(
      `${status} ${label} (${count} finding${count === 1 ? "" : "s"})`
    );
    for (const f of r.findings) {
      const loc = f.location ? ` @ ${f.location}` : "";
      console.log(`  [${f.severity.toUpperCase()}] ${f.ruleId}${loc}`);
      console.log(`    ${f.message}`);
    }
  }

  console.log("");
  console.log(
    `Summary: ${report.summary.totalFindings} findings across ${report.summary.totalItems} items (flagged: ${report.summary.flaggedItems}).`
  );
  console.log(
    `By severity: critical=${report.summary.bySeverity.critical}, high=${report.summary.bySeverity.high}, medium=${report.summary.bySeverity.medium}, low=${report.summary.bySeverity.low}`
  );
  console.log(
    `Wrote ${join(facultStateDir(homedir()), "audit", "agent-latest.json")}`
  );
}

export async function agentAuditCommand(argv: string[]) {
  const json = argv.includes("--json");

  let report: AgentAuditReport;
  try {
    report = await runAgentAudit({ argv });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  // Best-effort: update index.json auditStatus/lastAuditAt for canonical items.
  await updateIndexFromAuditReport({
    timestamp: report.timestamp,
    results: report.results,
  });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printHuman(report);
}
