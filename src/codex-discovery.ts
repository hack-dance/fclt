import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const MAX_AGE_SECONDS = 3600;
const MAX_EVIDENCE_BYTES = 16_384;
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_PAYLOAD_ENTRIES = 1024;

export interface CodexDiscovery {
  state: "unverified" | "rejected" | "externally_proven";
  installationFingerprint?: string;
  maxAgeSeconds: number;
  reason?:
    | "installation_unavailable"
    | "session_required"
    | "evidence_unreadable"
    | "invalid_evidence"
    | "session_mismatch"
    | "installation_mismatch"
    | "stale_evidence"
    | "future_evidence"
    | "missing_tool_proof";
  proof?: {
    source: "external_session_observer";
    sessionId: string;
    observer: string;
    observedAt: string;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLabel(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 256
  );
}

/** Snapshot the inspected installation, never the host's loaded tool registry. */
async function installationFingerprint(homeDir: string): Promise<string> {
  const pluginRoot = join(homeDir, "plugins", "fclt");
  const files: [string, string][] = [];
  let bytes = 0;
  let entries = 0;
  async function visit(path: string, relative: string): Promise<void> {
    const info = await lstat(path);
    entries += 1;
    if (entries > MAX_PAYLOAD_ENTRIES) {
      throw new Error("Plugin snapshot exceeds entry limit");
    }
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        await visit(join(path, name), relative ? `${relative}/${name}` : name);
      }
      return;
    }
    bytes += info.size;
    if (!info.isFile() || bytes > MAX_PAYLOAD_BYTES) {
      throw new Error("Plugin snapshot is unsupported or exceeds size limit");
    }
    files.push([
      relative,
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    ]);
  }
  await visit(pluginRoot, "");
  const configPath = join(homeDir, ".codex", "config.toml");
  const configInfo = await lstat(configPath);
  if (!configInfo.isFile() || configInfo.size > MAX_EVIDENCE_BYTES * 64) {
    throw new Error("Codex configuration exceeds size limit");
  }
  const configHash = createHash("sha256")
    .update(await readFile(configPath))
    .digest("hex");
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        "fclt-codex-installation-v1",
        resolve(homeDir),
        configHash,
        files,
      ])
    )
    .digest("hex")}`;
}

/** Validate a caller-trusted observation. No evidence is persisted or inferred from MCP calls. */
export async function inspectCodexDiscovery(args: {
  homeDir: string;
  installationReady: boolean;
  evidencePath?: string;
  sessionId?: string;
  now?: number;
}): Promise<CodexDiscovery> {
  const result: CodexDiscovery = {
    state: args.evidencePath ? "rejected" : "unverified",
    maxAgeSeconds: MAX_AGE_SECONDS,
  };
  if (!args.installationReady) {
    return { ...result, reason: "installation_unavailable" };
  }
  try {
    result.installationFingerprint = await installationFingerprint(
      args.homeDir
    );
  } catch {
    return { ...result, reason: "installation_unavailable" };
  }
  if (!args.evidencePath) {
    return result;
  }
  if (!isLabel(args.sessionId)) {
    return { ...result, reason: "session_required" };
  }
  let evidence: unknown;
  try {
    const info = await lstat(args.evidencePath);
    if (!info.isFile() || info.size > MAX_EVIDENCE_BYTES) {
      return { ...result, reason: "invalid_evidence" };
    }
    evidence = JSON.parse(await readFile(args.evidencePath, "utf8"));
  } catch {
    return { ...result, reason: "evidence_unreadable" };
  }
  if (
    !isObject(evidence) ||
    evidence.version !== 1 ||
    evidence.source !== "external_session_observer" ||
    !isLabel(evidence.sessionId) ||
    !isLabel(evidence.observer) ||
    typeof evidence.observedAt !== "string"
  ) {
    return { ...result, reason: "invalid_evidence" };
  }
  if (evidence.sessionId !== args.sessionId) {
    return { ...result, reason: "session_mismatch" };
  }
  if (evidence.installationFingerprint !== result.installationFingerprint) {
    return { ...result, reason: "installation_mismatch" };
  }
  const observedAt = Date.parse(evidence.observedAt);
  if (
    !Number.isFinite(observedAt) ||
    new Date(observedAt).toISOString() !== evidence.observedAt
  ) {
    return { ...result, reason: "invalid_evidence" };
  }
  const age = (args.now ?? Date.now()) - observedAt;
  if (age < 0) {
    return { ...result, reason: "future_evidence" };
  }
  if (age > MAX_AGE_SECONDS * 1000) {
    return { ...result, reason: "stale_evidence" };
  }
  const discoveredTools = evidence.discoveredTools;
  if (
    !(
      Array.isArray(discoveredTools) &&
      ["fclt_status", "fclt_setup"].every((name) =>
        discoveredTools.includes(name)
      ) &&
      Array.isArray(evidence.successfulTools) &&
      evidence.successfulTools.includes("fclt_status")
    )
  ) {
    return { ...result, reason: "missing_tool_proof" };
  }
  return {
    ...result,
    state: "externally_proven",
    proof: {
      source: "external_session_observer",
      sessionId: evidence.sessionId,
      observer: evidence.observer,
      observedAt: evidence.observedAt,
    },
  };
}

export function parseCodexDiscoveryArgs(argv: string[]): {
  argv: string[];
  evidencePath?: string;
  sessionId?: string;
} {
  const rest: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    const flag = arg.split("=", 1)[0];
    if (flag !== "--codex-discovery-evidence" && flag !== "--codex-session") {
      rest.push(arg);
      continue;
    }
    if (flags[flag] !== undefined) {
      throw new Error(`${flag} may only be provided once`);
    }
    const value = arg === flag ? argv[++i] : arg.slice(flag.length + 1);
    if (!value?.trim() || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    flags[flag] = value;
  }
  return {
    argv: rest,
    evidencePath: flags["--codex-discovery-evidence"],
    sessionId: flags["--codex-session"],
  };
}
