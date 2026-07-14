import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  facultConfigPath,
  facultRootDir,
  legacyExternalFacultStateDir,
  parseFacultConfigText,
} from "../paths";
import type { AssetFile, ScanResult } from "../scan";
import { scan, scanDiscoveryIdentity } from "../scan";
import {
  extractCodexTomlMcpServerBlocks,
  sanitizeCodexTomlMcpText,
} from "../util/codex-toml";
import { parseJsonLenient } from "../util/json";
import {
  type AuditEvaluation,
  auditedRootsFromScan,
  auditPathsOverlap,
  parseReportRootFlag,
  persistAuditReport,
} from "./report-persistence";
import {
  AuditSourceTracker,
  validateAuditSourceSnapshot,
} from "./source-provenance";
import {
  applyAuditSuppressionsToAgentReport,
  loadAuditSuppressions,
} from "./suppressions";
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
    if (
      arg === "--with" ||
      arg === "--from" ||
      arg === "--max-items" ||
      arg === "--report-root"
    ) {
      i += 1;
      continue;
    }
    if (
      arg.startsWith("--with=") ||
      arg.startsWith("--from=") ||
      arg.startsWith("--max-items=") ||
      arg.startsWith("--report-root=")
    ) {
      continue;
    }
    if (arg === "--json" || arg === "--update-index") {
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

const SUPPORT_ROOTS = ["assets", "references", "scripts"] as const;
const MAX_SUPPORT_DEPTH = 8;
const MAX_SUPPORT_ENTRIES = 2048;
const MAX_SUPPORT_FILES = 12;
const MAX_SUPPORT_FILE_BYTES = 50_000;

async function readSkillBundle(
  skillDir: string,
  sourceTracker: AuditSourceTracker
): Promise<string> {
  const skillMd = join(skillDir, "SKILL.md");
  const skillText = await sourceTracker.readOptionalText(skillMd);
  if (skillText === null) {
    return "";
  }
  let text = skillText;
  text = sanitizeEnvAssignments(redactPossibleSecrets(text));

  await sourceTracker.readDirectory(skillDir);
  const candidates: { path: string; rel: string }[] = [];
  let visited = 0;
  const visit = async (
    directory: string,
    relativeParts: string[]
  ): Promise<void> => {
    if (relativeParts.length > MAX_SUPPORT_DEPTH) {
      throw new Error(`Skill supporting files exceed depth limit: ${skillDir}`);
    }
    const entries = await sourceTracker.readDirectory(directory);
    if (entries === null) {
      return;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_SUPPORT_ENTRIES) {
        throw new Error(
          `Skill supporting files exceed entry limit: ${skillDir}`
        );
      }
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      const parts = [...relativeParts, entry.name];
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink() || !(entry.isDirectory() || entry.isFile())) {
        throw new Error(
          `Skill supporting path must be a regular file or directory: ${absolute}`
        );
      }
      if (entry.isDirectory()) {
        await visit(absolute, parts);
        continue;
      }
      candidates.push({ path: absolute, rel: parts.join("/") });
    }
  };
  for (const root of SUPPORT_ROOTS) {
    await visit(join(skillDir, root), [root]);
  }

  const included: { rel: string; content: string }[] = [];
  for (const candidate of candidates
    .sort((a, b) => a.rel.localeCompare(b.rel))
    .slice(0, MAX_SUPPORT_FILES)) {
    const rawBytes = await sourceTracker.read(candidate.path, {
      maxBytes: MAX_SUPPORT_FILE_BYTES,
    });
    const raw = rawBytes.toString("utf8");
    included.push({
      rel: candidate.rel,
      content: sanitizeEnvAssignments(redactPossibleSecrets(raw)),
    });
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

async function readAssetBundle(
  asset: AssetFile,
  sourceTracker: AuditSourceTracker
): Promise<string> {
  const trackedText = await sourceTracker.readOptionalText(asset.path);
  if (trackedText === null) {
    return "";
  }
  let text = trackedText;
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

const AUTH_FAILURE_RE =
  /(?:not logged in|authentication (?:failed|required)|unauthorized|login required|please (?:log|sign) in|missing (?:api key|credentials)|invalid (?:api key|credentials|token))/i;

const AUTH_ENV_BY_TOOL = {
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  codex: ["OPENAI_API_KEY"],
} as const satisfies Record<AgentTool, readonly string[]>;

// Keep child configuration non-persisting and non-ambient. In particular, do
// not pass service credentials, proxy/Git overrides, or execution-hook vars.
const OPERATIONAL_ENV_NAMES = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "NO_COLOR",
] as const;
const MAX_SUBPROCESS_OUTPUT_BYTES = 1_000_000;
const AGENT_SUBPROCESS_TIMEOUT_MS = 10 * 60 * 1000;

class AgentAuditPreconditionError extends Error {}

type AgentAuditRunnerFailureCode =
  | "agent-subprocess-exit"
  | "agent-subprocess-failed"
  | "agent-subprocess-interrupted"
  | "agent-subprocess-invalid-output"
  | "agent-subprocess-output-limit"
  | "agent-subprocess-timeout";

class AgentAuditRunnerError extends Error {
  readonly code: AgentAuditRunnerFailureCode;

  constructor(code: AgentAuditRunnerFailureCode) {
    super(`Agent audit runner failed (${code}).`);
    this.name = "AgentAuditRunnerError";
    this.code = code;
  }
}

const SENSITIVE_ENV_NAME_RE =
  /(?:AUTH|BEARER|COOKIE|CREDENTIAL|DATABASE_URL|DSN|KEY|PASS|SECRET|TOKEN)/i;

function sensitiveEnvironmentValues(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  return [
    ...new Set(
      Object.entries(env)
        .filter(([name]) => SENSITIVE_ENV_NAME_RE.test(name))
        .map(([, value]) => value ?? "")
        .filter((value) => value.length > 0)
    ),
  ].sort((a, b) => b.length - a.length);
}

function sanitizeHostileChildText(
  value: string,
  sensitiveValues: readonly string[]
): string {
  if (
    sensitiveValues.some(
      (sensitiveValue) =>
        sensitiveValue.length <= 4 && value.includes(sensitiveValue)
    )
  ) {
    // Tiny credentials are too collision-prone for substring replacement.
    // Redact the complete child-controlled field instead of corrupting text.
    return "<redacted>";
  }
  let sanitized = value;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue.length <= 4) {
      continue;
    }
    sanitized = sanitized.replaceAll(sensitiveValue, "<redacted>");
  }
  return sanitizeEnvAssignments(redactPossibleSecrets(sanitized));
}

function normalizePerItemOutput(
  value: unknown,
  sensitiveValues: readonly string[]
): PerItemOutput {
  if (!isPlainObject(value) || typeof value.passed !== "boolean") {
    throw new AgentAuditRunnerError("agent-subprocess-invalid-output");
  }
  if (!Array.isArray(value.findings) || value.findings.length > 500) {
    throw new AgentAuditRunnerError("agent-subprocess-invalid-output");
  }
  const findings: PerItemOutput["findings"] = value.findings.map((finding) => {
    if (
      !isPlainObject(finding) ||
      typeof finding.severity !== "string" ||
      !parseSeverity(finding.severity) ||
      typeof finding.category !== "string" ||
      typeof finding.message !== "string" ||
      (finding.recommendation !== undefined &&
        typeof finding.recommendation !== "string") ||
      (finding.location !== undefined && typeof finding.location !== "string")
    ) {
      throw new AgentAuditRunnerError("agent-subprocess-invalid-output");
    }
    return {
      severity: finding.severity as Severity,
      category: sanitizeHostileChildText(finding.category, sensitiveValues),
      message: sanitizeHostileChildText(finding.message, sensitiveValues),
      recommendation:
        typeof finding.recommendation === "string"
          ? sanitizeHostileChildText(finding.recommendation, sensitiveValues)
          : undefined,
      location:
        typeof finding.location === "string"
          ? sanitizeHostileChildText(finding.location, sensitiveValues)
          : undefined,
    };
  });
  if (value.notes !== undefined && typeof value.notes !== "string") {
    throw new AgentAuditRunnerError("agent-subprocess-invalid-output");
  }
  return {
    passed: value.passed,
    findings,
    notes:
      typeof value.notes === "string"
        ? sanitizeHostileChildText(value.notes, sensitiveValues)
        : undefined,
  };
}

function profileCredentialPath(
  tool: AgentTool,
  homeDir: string,
  honorEnvironmentOverrides: boolean
): string {
  if (tool === "codex") {
    const codexHome =
      (honorEnvironmentOverrides ? process.env.CODEX_HOME?.trim() : "") ||
      join(homeDir, ".codex");
    return join(codexHome, "auth.json");
  }
  const claudeConfig =
    (honorEnvironmentOverrides ? process.env.CLAUDE_CONFIG_DIR?.trim() : "") ||
    join(homeDir, ".claude");
  return join(claudeConfig, ".credentials.json");
}

function hasEnvironmentAuthentication(tool: AgentTool): boolean {
  return AUTH_ENV_BY_TOOL[tool].some(
    (name) => typeof process.env[name] === "string" && process.env[name]!.trim()
  );
}

async function assertSupportedAuthenticationMode(args: {
  homeDir: string;
  honorEnvironmentOverrides: boolean;
  tool: AgentTool;
}): Promise<void> {
  // Environment credentials do not require any profile access. Native credential
  // services remain available to the child process despite its isolated HOME.
  if (hasEnvironmentAuthentication(args.tool)) {
    return;
  }

  const sourcePath = profileCredentialPath(
    args.tool,
    args.homeDir,
    args.honorEnvironmentOverrides
  );
  const profileEntry = await lstat(sourcePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new AgentAuditPreconditionError(
      `Agent audit ${args.tool} profile authentication cannot be used safely in isolated non-persisting mode`
    );
  });
  if (!profileEntry) {
    return;
  }
  throw new AgentAuditPreconditionError(
    `Agent audit ${args.tool} file-backed profile authentication is unsupported in isolated non-persisting mode; use ${AUTH_ENV_BY_TOOL[args.tool].join(" or ")} or native authentication`
  );
}

function isolatedAgentEnvironment(
  tool: AgentTool,
  runtimeDir: string
): NodeJS.ProcessEnv {
  const home = join(runtimeDir, "home");
  const env: NodeJS.ProcessEnv = {
    CLAUDE_CONFIG_DIR: join(runtimeDir, "claude-config"),
    CODEX_HOME: join(runtimeDir, "codex-home"),
    HOME: home,
    TEMP: runtimeDir,
    TMP: runtimeDir,
    TMPDIR: runtimeDir,
    XDG_CACHE_HOME: join(runtimeDir, "xdg-cache"),
    XDG_CONFIG_HOME: join(runtimeDir, "xdg-config"),
    XDG_STATE_HOME: join(runtimeDir, "xdg-state"),
  };
  for (const name of OPERATIONAL_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  for (const name of AUTH_ENV_BY_TOOL[tool]) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

type CapturedStream = { text: string; truncated: boolean };

async function drainBoundedStream(
  stream: ReadableStream<Uint8Array>,
  limit: number
): Promise<CapturedStream> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let captured = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const remaining = Math.max(0, limit - captured);
      if (captured < limit) {
        const kept =
          value.byteLength <= remaining ? value : value.slice(0, remaining);
        chunks.push(kept);
        captured += kept.byteLength;
      }
      if (value.byteLength > remaining) {
        truncated = true;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return {
    text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
      "utf8"
    ),
    truncated,
  };
}

async function collectProcessOutput(proc: {
  exited: Promise<number>;
  kill: (signal?: number | NodeJS.Signals) => void;
  stderr: ReadableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
}): Promise<{ code: number; stderr: string; stdout: string }> {
  const stdoutPromise = drainBoundedStream(
    proc.stdout,
    MAX_SUBPROCESS_OUTPUT_BYTES
  );
  const stderrPromise = drainBoundedStream(
    proc.stderr,
    MAX_SUBPROCESS_OUTPUT_BYTES
  );
  try {
    const [stdout, stderr, code] = await Promise.all([
      stdoutPromise,
      stderrPromise,
      proc.exited,
    ]);
    if (stdout.truncated || stderr.truncated) {
      throw new AgentAuditRunnerError("agent-subprocess-output-limit");
    }
    return { code, stderr: stderr.text, stdout: stdout.text };
  } catch (error) {
    try {
      proc.kill();
    } catch {
      // The process may already have exited or been terminated by its AbortSignal.
    }
    await Promise.allSettled([stdoutPromise, stderrPromise, proc.exited]);
    throw error;
  }
}

async function readBoundedChildOutput(path: string): Promise<string> {
  const pathBefore = await lstat(path);
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
    throw new AgentAuditRunnerError("agent-subprocess-invalid-output");
  }
  const handle = await open(
    path,
    constants.O_RDONLY + (constants.O_NOFOLLOW ?? 0)
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== pathBefore.dev ||
      before.ino !== pathBefore.ino ||
      before.mode !== pathBefore.mode ||
      before.size !== pathBefore.size
    ) {
      throw new AgentAuditRunnerError("agent-subprocess-invalid-output");
    }
    if (before.size > MAX_SUBPROCESS_OUTPUT_BYTES) {
      throw new AgentAuditRunnerError("agent-subprocess-output-limit");
    }
    const buffer = Buffer.alloc(before.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.byteLength - bytesRead,
        null
      );
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino ||
      pathAfter.mode !== after.mode ||
      pathAfter.size !== after.size ||
      pathAfter.mtimeMs !== after.mtimeMs ||
      pathAfter.ctimeMs !== after.ctimeMs ||
      bytesRead !== before.size
    ) {
      throw new AgentAuditRunnerError("agent-subprocess-invalid-output");
    }
    if (bytesRead > MAX_SUBPROCESS_OUTPUT_BYTES) {
      throw new AgentAuditRunnerError("agent-subprocess-output-limit");
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function runnerSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function normalizeRunnerError(args: {
  error: unknown;
  externalSignal?: AbortSignal;
  subprocessSignal: AbortSignal;
}): never {
  if (args.error instanceof AgentAuditPreconditionError) {
    throw args.error;
  }
  if (args.externalSignal?.aborted) {
    throw new AgentAuditRunnerError("agent-subprocess-interrupted");
  }
  if (args.subprocessSignal.aborted) {
    throw new AgentAuditRunnerError("agent-subprocess-timeout");
  }
  if (args.error instanceof AgentAuditRunnerError) {
    throw args.error;
  }
  throw new AgentAuditRunnerError("agent-subprocess-failed");
}

async function makeAgentRuntimeDir(tempRoot?: string): Promise<string> {
  const root = tempRoot ?? tmpdir();
  await mkdir(root, { recursive: true });
  const runtimeDir = await mkdtemp(join(root, "facult-agent-audit-"));
  await Promise.all([
    mkdir(join(runtimeDir, "home"), { recursive: true }),
    mkdir(join(runtimeDir, "claude-config"), { recursive: true }),
    mkdir(join(runtimeDir, "codex-home"), { recursive: true }),
  ]);
  return runtimeDir;
}

async function runClaude(
  prompt: string,
  profileHome: string,
  honorEnvironmentOverrides: boolean,
  tempRoot?: string,
  signal?: AbortSignal,
  timeoutMs = AGENT_SUBPROCESS_TIMEOUT_MS
): Promise<{ output: PerItemOutput; model?: string }> {
  const runtimeDir = await makeAgentRuntimeDir(tempRoot);
  const subprocessSignal = runnerSignal(signal, timeoutMs);
  try {
    await assertSupportedAuthenticationMode({
      homeDir: profileHome,
      honorEnvironmentOverrides,
      tool: "claude",
    });
    const childEnvironment = isolatedAgentEnvironment("claude", runtimeDir);
    const childSensitiveValues = sensitiveEnvironmentValues(childEnvironment);
    const proc = Bun.spawn({
      cmd: [
        "claude",
        "-p",
        "--no-session-persistence",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(PER_ITEM_SCHEMA),
        "--tools",
        "",
      ],
      cwd: runtimeDir,
      env: childEnvironment,
      signal: subprocessSignal,
      stdin: new Blob([prompt]),
      stdout: "pipe",
      stderr: "pipe",
    });

    const { code, stderr, stdout } = await collectProcessOutput(proc);
    if (code !== 0) {
      if (AUTH_FAILURE_RE.test(`${stderr}\n${stdout}`)) {
        throw new AgentAuditPreconditionError(
          "Agent audit Claude authentication is unavailable in isolated non-persisting mode"
        );
      }
      throw new AgentAuditRunnerError("agent-subprocess-exit");
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      throw new AgentAuditRunnerError("agent-subprocess-invalid-output");
    }
    const structured = parsed.structured_output as unknown;
    if (!structured || typeof structured !== "object") {
      throw new AgentAuditRunnerError("agent-subprocess-invalid-output");
    }
    const modelUsage = parsed.modelUsage;
    return {
      output: normalizePerItemOutput(structured, childSensitiveValues),
      model:
        modelUsage && typeof modelUsage === "object"
          ? sanitizeHostileChildText(
              Object.keys(modelUsage)[0] ?? "",
              childSensitiveValues
            ) || undefined
          : undefined,
    };
  } catch (error) {
    normalizeRunnerError({
      error,
      externalSignal: signal,
      subprocessSignal,
    });
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

async function runCodex(
  prompt: string,
  profileHome: string,
  honorEnvironmentOverrides: boolean,
  tempRoot?: string,
  signal?: AbortSignal,
  timeoutMs = AGENT_SUBPROCESS_TIMEOUT_MS
): Promise<{ output: PerItemOutput; model?: string }> {
  const dir = await makeAgentRuntimeDir(tempRoot);
  const subprocessSignal = runnerSignal(signal, timeoutMs);
  const schemaPath = join(dir, "schema.json");
  const outPath = join(dir, "last-message.txt");
  try {
    await assertSupportedAuthenticationMode({
      homeDir: profileHome,
      honorEnvironmentOverrides,
      tool: "codex",
    });
    await Bun.write(
      schemaPath,
      `${JSON.stringify(PER_ITEM_SCHEMA, null, 2)}\n`
    );

    const childEnvironment = isolatedAgentEnvironment("codex", dir);
    const childSensitiveValues = sensitiveEnvironmentValues(childEnvironment);
    const proc = Bun.spawn({
      cmd: [
        "codex",
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outPath,
        "-",
      ],
      cwd: dir,
      env: childEnvironment,
      signal: subprocessSignal,
      stdin: new Blob([prompt]),
      stdout: "pipe",
      stderr: "pipe",
    });

    const { code, stderr, stdout } = await collectProcessOutput(proc);
    if (code !== 0) {
      if (AUTH_FAILURE_RE.test(`${stderr}\n${stdout}`)) {
        throw new AgentAuditPreconditionError(
          "Agent audit Codex authentication is unavailable in isolated non-persisting mode"
        );
      }
      throw new AgentAuditRunnerError("agent-subprocess-exit");
    }

    const raw = await readBoundedChildOutput(outPath);
    const trimmed = raw.trim();
    const jsonStart = trimmed.indexOf("{");
    const jsonEnd = trimmed.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd < 0 || jsonEnd <= jsonStart) {
      throw new AgentAuditRunnerError("agent-subprocess-invalid-output");
    }
    let parsed: PerItemOutput;
    try {
      parsed = JSON.parse(
        trimmed.slice(jsonStart, jsonEnd + 1)
      ) as PerItemOutput;
    } catch {
      throw new AgentAuditRunnerError("agent-subprocess-invalid-output");
    }
    return {
      output: normalizePerItemOutput(parsed, childSensitiveValues),
    };
  } catch (error) {
    normalizeRunnerError({
      error,
      externalSignal: signal,
      subprocessSignal,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

export async function evaluateAgentAudit(opts?: {
  argv?: string[];
  homeDir?: string;
  cwd?: string;
  from?: string[];
  includeConfigFrom?: boolean;
  includeGitHooks?: boolean;
  requested?: string | null;
  withTool?: AgentTool;
  maxItems?: number;
  runtimeTempRoot?: string;
  signal?: AbortSignal;
  subprocessTimeoutMs?: number;
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
}): Promise<AuditEvaluation<AgentAuditReport>> {
  const argv = opts?.argv ?? [];
  const evaluationSensitiveValues = sensitiveEnvironmentValues();
  const home = opts?.homeDir ?? homedir();
  const cwd = opts?.cwd ?? process.cwd();
  const sourceTracker = new AuditSourceTracker();

  const includeConfigFrom =
    opts?.includeConfigFrom ?? !argv.includes("--no-config-from");
  let from = opts?.from ?? parseFromFlags(argv);
  const preferredConfigText = await sourceTracker.readOptionalText(
    facultConfigPath(home)
  );
  const legacyConfigText = await sourceTracker.readOptionalText(
    join(legacyExternalFacultStateDir(home), "config.json")
  );
  const exactConfig =
    (preferredConfigText === null
      ? null
      : parseFacultConfigText(preferredConfigText)) ??
    (legacyConfigText === null
      ? null
      : parseFacultConfigText(legacyConfigText));
  if (
    includeConfigFrom &&
    from.length === 0 &&
    !(exactConfig?.scanFrom && exactConfig.scanFrom.length > 0)
  ) {
    from = ["~"];
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

  const canonicalRoot = facultRootDir(home, exactConfig);
  const scanOptions: NonNullable<Parameters<typeof scan>[1]> = {
    homeDir: home,
    cwd,
    includeConfigFrom,
    configFrom: exactConfig,
    canonicalRoot,
    includeGitHooks:
      opts?.includeGitHooks ?? argv.includes("--include-git-hooks"),
    from,
    readText: (path) => sourceTracker.readText(path),
    tracking: {
      capturePath: (path) => sourceTracker.capture(path),
      captureTree: (path, options) => sourceTracker.captureTree(path, options),
      readDirectory: (path) => sourceTracker.readDirectory(path),
    },
  };
  const scanRes: ScanResult = await scan(argv, scanOptions);
  const discoveryIdentity = scanDiscoveryIdentity(scanRes);
  const auditedRoots = auditedRootsFromScan(scanRes);
  await sourceTracker.protect(auditedRoots);
  for (const source of scanRes.sources) {
    for (const pathValue of [
      ...source.evidence,
      ...source.skills.roots,
      ...source.skills.entries,
    ]) {
      await sourceTracker.capture(pathValue);
    }
  }
  const runtimeTempRoot = await realpath(
    opts?.runtimeTempRoot ?? tmpdir()
  ).catch(() => null);
  if (!runtimeTempRoot) {
    throw new Error(
      "Agent audit runtime temp root could not be resolved safely"
    );
  }
  if (!opts?.runner) {
    const canonicalAuditedRoots = await Promise.all(
      auditedRoots.map((root) => realpath(root).catch(() => null))
    );
    const runtimeOverlap = canonicalAuditedRoots.find(
      (root): root is string =>
        typeof root === "string" && auditPathsOverlap(root, runtimeTempRoot)
    );
    if (runtimeOverlap) {
      throw new Error(
        `Agent audit runtime temp root overlaps audited source: ${runtimeTempRoot} <-> ${runtimeOverlap}`
      );
    }
  }

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
          txt = await sourceTracker.readText(cfg.path);
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
        const txt = await sourceTracker.readText(cfg.path);
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
      const content = await readSkillBundle(s.path, sourceTracker);
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
      const content = await readAssetBundle(a.file, sourceTracker);
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
        return await runClaude(
          prompt,
          home,
          opts?.homeDir === undefined,
          runtimeTempRoot,
          opts?.signal,
          opts?.subprocessTimeoutMs
        );
      }
      return await runCodex(
        prompt,
        home,
        opts?.homeDir === undefined,
        runtimeTempRoot,
        opts?.signal,
        opts?.subprocessTimeoutMs
      );
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
      out = normalizePerItemOutput(res.output, evaluationSensitiveValues);
      model =
        model ??
        (typeof res.model === "string"
          ? sanitizeHostileChildText(res.model, evaluationSensitiveValues)
          : undefined);
    } catch (e: unknown) {
      if (e instanceof AgentAuditPreconditionError) {
        throw e;
      }
      if (opts?.signal?.aborted) {
        throw new AgentAuditRunnerError("agent-subprocess-interrupted");
      }
      const failureCode =
        e instanceof AgentAuditRunnerError ? e.code : "agent-subprocess-failed";
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
            evidence: failureCode,
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

  let report: AgentAuditReport = {
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
      totalFindings: results.reduce(
        (sum, result) => sum + result.findings.length,
        0
      ),
      bySeverity: results.reduce<Record<Severity, number>>(
        (acc, result) => {
          for (const finding of result.findings) {
            acc[finding.severity] += 1;
          }
          return acc;
        },
        { low: 0, medium: 0, high: 0, critical: 0 }
      ),
      flaggedItems: results.filter(
        (result) => !result.passed && result.findings.length > 0
      ).length,
    },
  };

  report = applyAuditSuppressionsToAgentReport(
    report,
    await loadAuditSuppressions(
      home,
      (path) => sourceTracker.readOptionalText(path),
      canonicalRoot,
      exactConfig
    )
  );

  const finalScan = await scan(argv, scanOptions);
  if (scanDiscoveryIdentity(finalScan) !== discoveryIdentity) {
    throw new Error("Audit source discovery changed during evaluation");
  }
  const sourceSnapshot = sourceTracker.snapshot();
  await validateAuditSourceSnapshot(sourceSnapshot);
  return { auditedRoots, report, sourceSnapshot };
}

export async function runAgentAudit(
  opts?: Parameters<typeof evaluateAgentAudit>[0]
) {
  return (await evaluateAgentAudit(opts)).report;
}

function printHuman(report: AgentAuditReport, reportPath?: string) {
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
    reportPath
      ? `Wrote ${reportPath}`
      : "Read-only: no report or index state written."
  );
}

export async function agentAuditCommand(argv: string[]) {
  const json = argv.includes("--json");
  const reportRoot = parseReportRootFlag(argv);
  const updateIndex = argv.includes("--update-index");

  let evaluation: AuditEvaluation<AgentAuditReport>;
  let reportPath: string | undefined;
  try {
    evaluation = await evaluateAgentAudit({ argv });
    if (reportRoot) {
      reportPath = await persistAuditReport({
        auditedRoots: evaluation.auditedRoots,
        mode: "agent",
        report: evaluation.report,
        reportRoot,
        sourceSnapshot: evaluation.sourceSnapshot,
      });
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const report = evaluation.report;
  if (updateIndex) {
    await updateIndexFromAuditReport({
      timestamp: report.timestamp,
      results: report.results,
    });
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printHuman(report, reportPath);
}
