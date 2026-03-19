import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { facultStateDir, readFacultConfig } from "../paths";
import type { ScanResult } from "../scan";
import { scan } from "../scan";
import {
  extractCodexTomlMcpServerBlocks,
  sanitizeCodexTomlMcpText,
} from "../util/codex-toml";
import { parseJsonLenient } from "../util/json";
import {
  type AuditFinding,
  type AuditItemResult,
  type AuditRule,
  type CompiledAuditRule,
  isAtLeastSeverity,
  parseSeverity,
  SEVERITY_ORDER,
  type Severity,
  type StaticAuditReport,
} from "./types";
import { updateIndexFromAuditReport } from "./update-index";

const SECRET_ENV_KEY_RE = /(TOKEN|KEY|SECRET|PASSWORD|PASS|BEARER)/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function requestedNameFromArgv(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === "--severity") {
      i += 1; // skip its value
      continue;
    }
    if (arg.startsWith("--severity=")) {
      continue;
    }
    if (arg === "--from") {
      i += 1; // skip its value
      continue;
    }
    if (arg.startsWith("--from=")) {
      continue;
    }
    if (arg === "--rules") {
      i += 1; // skip its value
      continue;
    }
    if (arg.startsWith("--rules=")) {
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

function parseSeverityFlag(argv: string[]): Severity | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === "--severity") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--severity requires low|medium|high|critical");
      }
      const sev = parseSeverity(next);
      if (!sev) {
        throw new Error(`Unknown severity: ${next}`);
      }
      return sev;
    }
    if (arg.startsWith("--severity=")) {
      const raw = arg.slice("--severity=".length);
      const sev = parseSeverity(raw);
      if (!sev) {
        throw new Error(`Unknown severity: ${raw}`);
      }
      return sev;
    }
  }
  return null;
}

function parseRulesPathFlag(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === "--rules") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--rules requires a file path");
      }
      return next;
    }
    if (arg.startsWith("--rules=")) {
      const raw = arg.slice("--rules=".length);
      if (!raw) {
        throw new Error("--rules requires a file path");
      }
      return raw;
    }
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

function redactInlineSecrets(text: string): string {
  // Minimal redaction to avoid writing obvious tokens to audit output.
  return text
    .replace(/\b(sk-[A-Za-z0-9]{10,})\b/g, "sk-<redacted>")
    .replace(/\b(ghp_[A-Za-z0-9]{10,})\b/g, "ghp_<redacted>")
    .replace(/\b(github_pat_[A-Za-z0-9_]{10,})\b/g, "github_pat_<redacted>");
}

function lineOfOffset(text: string, offset: number): number {
  if (offset <= 0) {
    return 1;
  }
  let lines = 1;
  for (let i = 0; i < text.length && i < offset; i += 1) {
    if (text.charCodeAt(i) === 10) {
      lines += 1;
    }
  }
  return lines;
}

function summarizeEvidence(text: string, offset: number): string {
  const start = Math.max(0, offset - 80);
  const end = Math.min(text.length, offset + 160);
  const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  return redactInlineSecrets(snippet);
}

function compileRules(rules: AuditRule[]): CompiledAuditRule[] {
  const compiled: CompiledAuditRule[] = [];
  for (const r of rules) {
    try {
      compiled.push({
        ...r,
        regex: new RegExp(r.pattern, "gi"),
      });
    } catch {
      // Skip invalid patterns; treat as user config error rather than hard-fail.
    }
  }
  return compiled;
}

const DEFAULT_RULES: AuditRule[] = [
  {
    id: "exfil-instruction",
    severity: "high",
    target: "skill",
    pattern:
      "\\b(send|upload|post|exfiltrat\\w*)\\b.{0,160}\\b(external|server|webhook|pastebin|requestbin|http)\\b",
    message: "Possible data exfiltration instruction",
  },
  {
    id: "credential-access",
    severity: "critical",
    target: "skill",
    pattern:
      "\\b(read|cat|copy|dump|steal)\\b.{0,160}\\b(\\.ssh|id_rsa|credentials|secrets?|api\\s*key|tokens?)\\b",
    message: "Possible credential/secret access instruction",
  },
  {
    id: "sensitive-paths",
    severity: "high",
    target: "skill",
    pattern: "\\b(/etc/shadow|/etc/passwd|~/?\\.ssh/id_rsa)\\b",
    message: "Mentions a sensitive file path",
  },
  {
    id: "tmp-binary",
    severity: "critical",
    target: "mcp",
    pattern: "\\/tmp\\/",
    message: "MCP server references an executable under /tmp",
  },
  {
    id: "non-https-url",
    severity: "medium",
    target: "mcp",
    pattern: "\\bhttp:\\/\\/",
    message: "MCP server URL uses http:// (non-TLS)",
  },
  {
    id: "curl-pipe-shell",
    severity: "critical",
    target: "skill",
    pattern:
      "\\b(curl|wget)\\b[^\\r\\n]{0,200}\\|[^\\r\\n]{0,60}\\b(bash|sh|zsh)\\b",
    message:
      "Possible download-and-execute pattern (curl/wget piped into a shell).",
  },
  {
    id: "shell-process-subst-curl",
    severity: "critical",
    target: "skill",
    pattern: "\\b(bash|sh|zsh)\\b\\s*<\\s*\\(\\s*(curl|wget)\\b",
    message:
      "Possible download-and-execute pattern (shell reading from curl/wget process substitution).",
  },
  {
    id: "shell-cmd-subst-curl",
    severity: "high",
    target: "skill",
    pattern: "\\b(bash|sh|zsh)\\b[^\\r\\n]{0,80}\\$\\(\\s*(curl|wget)\\b",
    message:
      "Possible download-and-execute pattern (shell executing curl/wget output via command substitution).",
  },
  {
    id: "base64-pipe-shell",
    severity: "high",
    target: "skill",
    pattern:
      "\\bbase64\\b[^\\r\\n]{0,120}(-d|--decode)\\b[^\\r\\n]{0,200}\\|[^\\r\\n]{0,60}\\b(bash|sh|zsh)\\b",
    message:
      "Possible obfuscated execution pattern (base64 decode piped into a shell).",
  },
  {
    id: "eval-cmd-subst",
    severity: "high",
    target: "skill",
    pattern: "\\beval\\b[^\\r\\n]{0,40}(\\$\\(|`)",
    message:
      "Use of eval with command substitution (risky; may execute attacker-controlled text).",
  },
  {
    id: "chmod-tmp-exec",
    severity: "high",
    target: "skill",
    pattern: "\\bchmod\\b[^\\r\\n]{0,80}\\+x\\b[^\\r\\n]{0,200}\\b\\/tmp\\/",
    message: "Marks a /tmp path executable (risky executable location).",
  },
  {
    id: "powershell-invoke-expression",
    severity: "critical",
    target: "skill",
    pattern:
      "\\b(powershell|pwsh)\\b[^\\r\\n]{0,200}\\b(iex|invoke-expression)\\b",
    message:
      "PowerShell Invoke-Expression usage (risky; may execute attacker-controlled text).",
  },
  {
    id: "curl-insecure",
    severity: "medium",
    target: "skill",
    pattern: "\\bcurl\\b[^\\r\\n]{0,80}\\s(--insecure|-k)\\b",
    message: "curl disables TLS verification (MITM risk).",
  },
  {
    id: "download-non-https-url",
    severity: "medium",
    target: "skill",
    pattern: "\\b(curl|wget)\\b[^\\r\\n]{0,200}\\bhttp:\\/\\/",
    message: "Download command uses http:// (non-TLS).",
  },
];

function mergeRules(base: AuditRule[], overrides: AuditRule[]): AuditRule[] {
  const byId = new Map<string, AuditRule>();
  for (const r of base) {
    byId.set(r.id, r);
  }
  for (const r of overrides) {
    byId.set(r.id, r);
  }
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

async function loadRuleOverrides(path: string): Promise<AuditRule[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return [];
  }

  const txt = await file.text();
  const parsed = parseYaml(txt) as unknown;
  if (!isPlainObject(parsed)) {
    return [];
  }

  const rulesValue = (parsed as Record<string, unknown>).rules;
  if (!Array.isArray(rulesValue)) {
    return [];
  }

  const out: AuditRule[] = [];
  for (const r of rulesValue) {
    if (!isPlainObject(r)) {
      continue;
    }
    const id = typeof r.id === "string" ? r.id : null;
    const severity =
      typeof r.severity === "string" ? parseSeverity(r.severity) : null;
    const pattern = typeof r.pattern === "string" ? r.pattern : null;
    const message = typeof r.message === "string" ? r.message : null;
    const target =
      typeof r.target === "string" &&
      (r.target === "skill" || r.target === "mcp" || r.target === "any")
        ? (r.target as "skill" | "mcp" | "any")
        : undefined;

    if (!(id && severity && pattern && message)) {
      continue;
    }

    out.push({ id, severity, pattern, message, target });
  }

  return out;
}

function shouldApplyRule(
  rule: CompiledAuditRule,
  target: "skill" | "mcp"
): boolean {
  const t = rule.target ?? "any";
  if (t === "any") {
    return true;
  }
  return t === target;
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

function mcpSafeAuditText(definition: unknown): string {
  if (!isPlainObject(definition)) {
    return String(definition);
  }

  const obj = definition as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (typeof obj.name === "string") {
    out.name = obj.name;
  }
  if (typeof obj.transport === "string") {
    out.transport = obj.transport;
  }
  if (typeof obj.command === "string") {
    out.command = obj.command;
  }
  if (Array.isArray(obj.args)) {
    out.args = obj.args.map(String);
  }
  if (typeof obj.url === "string") {
    out.url = obj.url;
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

function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEY_RE.test(key);
}

function structuredMcpChecks({
  serverName,
  configPath,
  definition,
}: {
  serverName: string;
  configPath: string;
  definition: unknown;
}): AuditFinding[] {
  const findings: AuditFinding[] = [];

  if (!isPlainObject(definition)) {
    return findings;
  }

  const obj = definition as Record<string, unknown>;

  const command = typeof obj.command === "string" ? obj.command : null;
  if (command && command.includes("/tmp/")) {
    findings.push({
      severity: "critical",
      ruleId: "mcp-command-tmp",
      message:
        "MCP server command references /tmp (risky executable location).",
      location: `${configPath}:${serverName}:command`,
      evidence: command,
    });
  }

  const url = typeof obj.url === "string" ? obj.url : null;
  if (url && url.startsWith("http://")) {
    findings.push({
      severity: "medium",
      ruleId: "mcp-url-non-https",
      message: "MCP server URL uses http:// (non-TLS).",
      location: `${configPath}:${serverName}:url`,
      evidence: url,
    });
  }

  const args = Array.isArray(obj.args) ? obj.args.map(String) : [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a) {
      continue;
    }
    if (a === "--allow-write" && args[i + 1] === "/") {
      findings.push({
        severity: "high",
        ruleId: "mcp-allow-write-root",
        message: "MCP server args allow write access to '/'.",
        location: `${configPath}:${serverName}:args`,
        evidence: "--allow-write /",
      });
    }
    if (
      a.startsWith("--allow-write=") &&
      a.slice("--allow-write=".length) === "/"
    ) {
      findings.push({
        severity: "high",
        ruleId: "mcp-allow-write-root",
        message: "MCP server args allow write access to '/'.",
        location: `${configPath}:${serverName}:args`,
        evidence: a,
      });
    }
  }

  if (isPlainObject(obj.env)) {
    const env = obj.env as Record<string, unknown>;
    const secretKeys = Object.keys(env).filter((k) => isSecretEnvKey(k));
    for (const k of secretKeys) {
      const v = env[k];
      if (typeof v === "string" && v.trim()) {
        findings.push({
          severity: "high",
          ruleId: "mcp-env-inline-secret",
          message:
            "MCP server env includes what looks like a secret value (consider using indirection instead of inlining).",
          location: `${configPath}:${serverName}:env:${k}`,
          evidence: `${k}=<redacted>`,
        });
      }
    }
  }

  return findings;
}

function applyRulesToText({
  rules,
  target,
  itemName,
  path,
  text,
}: {
  rules: CompiledAuditRule[];
  target: "skill" | "mcp";
  itemName: string;
  path: string;
  text: string;
}): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const rule of rules) {
    if (!shouldApplyRule(rule, target)) {
      continue;
    }
    for (const match of text.matchAll(rule.regex)) {
      const idx = match.index ?? 0;
      const line = lineOfOffset(text, idx);
      const location =
        target === "skill" ? `${path}:SKILL.md:${line}` : `${path}:${itemName}`;
      findings.push({
        severity: rule.severity,
        ruleId: rule.id,
        message: rule.message,
        location,
        evidence: summarizeEvidence(text, idx),
      });
    }
  }

  // Prefer deterministic output: sort by severity desc, then ruleId, then location.
  return findings.sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity];
    const sb = SEVERITY_ORDER[b.severity];
    return (
      sb - sa ||
      a.ruleId.localeCompare(b.ruleId) ||
      (a.location ?? "").localeCompare(b.location ?? "")
    );
  });
}

function applyRulesToFileText({
  rules,
  filePath,
  text,
}: {
  rules: CompiledAuditRule[];
  filePath: string;
  text: string;
}): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const rule of rules) {
    // Treat assets like instruction/config text rather than MCP server definitions.
    if (!shouldApplyRule(rule, "skill")) {
      continue;
    }
    for (const match of text.matchAll(rule.regex)) {
      const idx = match.index ?? 0;
      const line = lineOfOffset(text, idx);
      findings.push({
        severity: rule.severity,
        ruleId: rule.id,
        message: rule.message,
        location: `${filePath}:${line}`,
        evidence: summarizeEvidence(text, idx),
      });
    }
  }

  return findings.sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity];
    const sb = SEVERITY_ORDER[b.severity];
    return (
      sb - sa ||
      a.ruleId.localeCompare(b.ruleId) ||
      (a.location ?? "").localeCompare(b.location ?? "")
    );
  });
}

function computeAuditStatus(findings: AuditFinding[]): "passed" | "flagged" {
  const hasHighOrCritical = findings.some(
    (f) => f.severity === "high" || f.severity === "critical"
  );
  return hasHighOrCritical ? "flagged" : "passed";
}

function filterFindingsByMinSeverity(
  findings: AuditFinding[],
  min?: Severity
): AuditFinding[] {
  if (!min) {
    return findings;
  }
  return findings.filter((f) => isAtLeastSeverity(f.severity, min));
}

async function ensureDir(p: string) {
  await mkdir(p, { recursive: true });
}

export async function runStaticAudit(opts?: {
  argv?: string[];
  homeDir?: string;
  cwd?: string;
  rulesPath?: string;
  minSeverity?: Severity;
  from?: string[];
  name?: string;
  includeConfigFrom?: boolean;
  includeGitHooks?: boolean;
}): Promise<StaticAuditReport> {
  const argv = opts?.argv ?? [];
  const home = opts?.homeDir ?? homedir();
  const rulesPath =
    opts?.rulesPath ?? join(facultStateDir(home), "audit-rules.yaml");

  const overrides = await loadRuleOverrides(rulesPath);
  const rules = compileRules(mergeRules(DEFAULT_RULES, overrides));

  const includeConfigFrom =
    opts?.includeConfigFrom ?? !argv.includes("--no-config-from");
  let from = opts?.from ?? parseFromFlags(argv);
  if (includeConfigFrom && from.length === 0) {
    const cfg = readFacultConfig(home);
    if (!(cfg?.scanFrom && cfg.scanFrom.length > 0)) {
      from = ["~"];
    }
  }
  const res: ScanResult = await scan(argv, {
    homeDir: home,
    cwd: opts?.cwd,
    includeConfigFrom,
    includeGitHooks:
      opts?.includeGitHooks ?? argv.includes("--include-git-hooks"),
    from,
  });

  const skillInstances: { name: string; path: string; sourceId: string }[] = [];
  for (const src of res.sources) {
    for (const dir of src.skills.entries) {
      skillInstances.push({ name: basename(dir), path: dir, sourceId: src.id });
    }
  }

  // De-duplicate skill instances by (sourceId, path).
  const uniqSkills = new Map<
    string,
    { name: string; path: string; sourceId: string }
  >();
  for (const s of skillInstances) {
    uniqSkills.set(`${s.sourceId}\0${s.path}`, s);
  }

  const mcpConfigs: { path: string; sourceId: string; format: string }[] = [];
  for (const src of res.sources) {
    for (const cfg of src.mcp.configs) {
      mcpConfigs.push({ path: cfg.path, sourceId: src.id, format: cfg.format });
    }
  }

  const uniqMcpConfigs = new Map<
    string,
    { path: string; sourceId: string; format: string }
  >();
  for (const c of mcpConfigs) {
    // Prefer a deterministic sourceId if the same path appears multiple times.
    const prev = uniqMcpConfigs.get(c.path);
    if (!prev || c.sourceId.localeCompare(prev.sourceId) < 0) {
      uniqMcpConfigs.set(c.path, c);
    }
  }

  const nameArg = opts?.name ?? requestedNameFromArgv(argv);
  const requested: { kind: "skill" | "mcp"; name: string } | null = nameArg
    ? nameArg.startsWith("mcp:")
      ? { kind: "mcp", name: nameArg.slice("mcp:".length) }
      : { kind: "skill", name: nameArg }
    : null;

  const results: AuditItemResult[] = [];

  for (const skill of Array.from(uniqSkills.values()).sort(
    (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
  )) {
    if (
      requested &&
      requested.kind === "skill" &&
      requested.name !== skill.name
    ) {
      continue;
    }
    const skillMdPath = join(skill.path, "SKILL.md");
    const file = Bun.file(skillMdPath);
    if (!(await file.exists())) {
      continue;
    }
    const text = await file.text();
    const findings = applyRulesToText({
      rules,
      target: "skill",
      itemName: skill.name,
      path: skill.path,
      text,
    });
    const status = computeAuditStatus(findings);
    results.push({
      item: skill.name,
      type: "skill",
      sourceId: skill.sourceId,
      path: skill.path,
      passed: status === "passed",
      findings: filterFindingsByMinSeverity(findings, opts?.minSeverity),
    });
  }

  // Audit hook/rules assets (Claude/Cursor hooks, .claude settings, husky scripts, etc).
  // Skip when the user requested a single skill/mcp item.
  if (!requested) {
    const assetInstances: {
      item: string;
      path: string;
      sourceId: string;
      format: string;
      kind: string;
    }[] = [];

    for (const src of res.sources) {
      for (const f of src.assets.files) {
        assetInstances.push({
          item: `${f.kind}:${basename(f.path)}`,
          path: f.path,
          sourceId: src.id,
          format: f.format,
          kind: f.kind,
        });
      }
    }

    const uniqAssets = new Map<
      string,
      {
        item: string;
        path: string;
        sourceId: string;
        format: string;
        kind: string;
      }
    >();
    for (const a of assetInstances) {
      uniqAssets.set(`${a.sourceId}\0${a.path}`, a);
    }

    const sanitizeJsonForAudit = (value: unknown): unknown => {
      if (typeof value === "string") {
        return redactInlineSecrets(value);
      }
      if (Array.isArray(value)) {
        return value.slice(0, 200).map(sanitizeJsonForAudit);
      }
      if (!isPlainObject(value)) {
        return value;
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (SECRET_ENV_KEY_RE.test(k)) {
          out[k] = "<redacted>";
        } else {
          out[k] = sanitizeJsonForAudit(v);
        }
      }
      return out;
    };

    for (const asset of Array.from(uniqAssets.values()).sort(
      (a, b) => a.item.localeCompare(b.item) || a.path.localeCompare(b.path)
    )) {
      const file = Bun.file(asset.path);
      if (!(await file.exists())) {
        continue;
      }

      let text: string;
      try {
        text = await file.text();
      } catch {
        continue;
      }

      let auditText = text;
      if (asset.format === "json") {
        try {
          const parsed = parseJsonLenient(text);
          auditText = JSON.stringify(sanitizeJsonForAudit(parsed), null, 2);
        } catch {
          // keep raw text if parse fails; findings should still be redacted in evidence.
        }
      }

      // Avoid huge blobs in output. Most config assets are small.
      const MAX_CHARS = 200_000;
      if (auditText.length > MAX_CHARS) {
        auditText = auditText.slice(0, MAX_CHARS);
      }

      const findings = applyRulesToFileText({
        rules,
        filePath: asset.path,
        text: auditText,
      });

      const status = computeAuditStatus(findings);
      results.push({
        item: asset.item,
        type: "asset",
        sourceId: asset.sourceId,
        path: asset.path,
        passed: status === "passed",
        findings: filterFindingsByMinSeverity(findings, opts?.minSeverity),
      });
    }
  }

  for (const cfg of Array.from(uniqMcpConfigs.values()).sort((a, b) =>
    a.path.localeCompare(b.path)
  )) {
    const isToml = cfg.format === "toml" || cfg.path.endsWith(".toml");

    if (isToml) {
      let txt: string;
      try {
        txt = await Bun.file(cfg.path).text();
      } catch (e: unknown) {
        const err = e as { message?: string } | null;
        results.push({
          item: basename(cfg.path),
          type: "mcp-config",
          sourceId: cfg.sourceId,
          path: cfg.path,
          passed: false,
          findings: filterFindingsByMinSeverity(
            [
              {
                severity: "medium",
                ruleId: "mcp-config-read-error",
                message: "Failed to read MCP config; review manually.",
                location: cfg.path,
                evidence: String(err?.message ?? e),
              },
            ],
            opts?.minSeverity
          ),
        });
        continue;
      }

      const blocks = extractCodexTomlMcpServerBlocks(txt);
      const names = Object.keys(blocks).sort();
      for (const serverName of names) {
        if (
          requested &&
          requested.kind === "mcp" &&
          requested.name !== serverName
        ) {
          continue;
        }

        const safeText = sanitizeCodexTomlMcpText(blocks[serverName] ?? "");
        const findings = applyRulesToText({
          rules,
          target: "mcp",
          itemName: serverName,
          path: cfg.path,
          text: safeText,
        });

        const status = computeAuditStatus(findings);
        results.push({
          item: serverName,
          type: "mcp",
          sourceId: cfg.sourceId,
          path: cfg.path,
          passed: status === "passed",
          findings: filterFindingsByMinSeverity(findings, opts?.minSeverity),
        });
      }
      continue;
    }

    // Default: JSON config file parsing.
    let parsed: unknown;
    try {
      const txt = await Bun.file(cfg.path).text();
      parsed = parseJsonLenient(txt);
    } catch (e: unknown) {
      const err = e as { message?: string } | null;
      results.push({
        item: basename(cfg.path),
        type: "mcp-config",
        sourceId: cfg.sourceId,
        path: cfg.path,
        passed: false,
        findings: filterFindingsByMinSeverity(
          [
            {
              severity: "medium",
              ruleId: "mcp-config-parse-error",
              message: "Failed to parse MCP config; review manually.",
              location: cfg.path,
              evidence: String(err?.message ?? e),
            },
          ],
          opts?.minSeverity
        ),
      });
      continue;
    }

    const serversObj = extractMcpServersObject(parsed);
    if (!serversObj) {
      continue;
    }

    for (const [serverName, definition] of Object.entries(serversObj).sort(
      ([a], [b]) => a.localeCompare(b)
    )) {
      if (
        requested &&
        requested.kind === "mcp" &&
        requested.name !== serverName
      ) {
        continue;
      }

      const safeText = mcpSafeAuditText(definition);
      const ruleFindings = applyRulesToText({
        rules,
        target: "mcp",
        itemName: serverName,
        path: cfg.path,
        text: safeText,
      });

      const structured = structuredMcpChecks({
        serverName,
        configPath: cfg.path,
        definition,
      });

      const findings = [...ruleFindings, ...structured].sort((a, b) => {
        const sa = SEVERITY_ORDER[a.severity];
        const sb = SEVERITY_ORDER[b.severity];
        return (
          sb - sa ||
          a.ruleId.localeCompare(b.ruleId) ||
          (a.location ?? "").localeCompare(b.location ?? "")
        );
      });

      const status = computeAuditStatus(findings);
      results.push({
        item: serverName,
        type: "mcp",
        sourceId: cfg.sourceId,
        path: cfg.path,
        passed: status === "passed",
        findings: filterFindingsByMinSeverity(findings, opts?.minSeverity),
      });
    }
  }

  const minSeverity = opts?.minSeverity ?? undefined;
  const bySeverity: Record<Severity, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  let totalFindings = 0;
  let flaggedItems = 0;

  for (const r of results) {
    const all = r.findings;
    totalFindings += all.length;
    if (!r.passed) {
      flaggedItems += 1;
    }
    for (const f of all) {
      bySeverity[f.severity] += 1;
    }
  }

  const report: StaticAuditReport = {
    timestamp: new Date().toISOString(),
    mode: "static",
    minSeverity,
    rulesPath: (await Bun.file(rulesPath).exists()) ? rulesPath : null,
    results,
    summary: {
      totalItems: results.length,
      totalFindings,
      bySeverity,
      flaggedItems,
    },
  };

  const auditDir = join(facultStateDir(home), "audit");
  await ensureDir(auditDir);
  await Bun.write(
    join(auditDir, "static-latest.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );

  return report;
}

function printHuman(report: StaticAuditReport) {
  console.log("Static Security Audit");
  console.log("=====================");
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
    if (count) {
      for (const f of r.findings) {
        const loc = f.location ? ` @ ${f.location}` : "";
        console.log(`  [${f.severity.toUpperCase()}] ${f.ruleId}${loc}`);
        console.log(`    ${f.message}`);
      }
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
    `Wrote ${join(facultStateDir(homedir()), "audit", "static-latest.json")}`
  );
}

export async function staticAuditCommand(argv: string[]) {
  const json = argv.includes("--json");
  const minSeverity = parseSeverityFlag(argv) ?? undefined;
  const rulesPath = parseRulesPathFlag(argv) ?? undefined;
  const from = parseFromFlags(argv);

  let report: StaticAuditReport;
  try {
    report = await runStaticAudit({
      argv,
      rulesPath,
      minSeverity,
      from,
    });
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
