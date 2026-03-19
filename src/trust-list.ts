import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FacultIndex, McpEntry, SkillEntry } from "./index-builder";
import { facultStateDir } from "./paths";
import { parseJsonLenient } from "./util/json";

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

export interface OrgTrustList {
  version: number;
  issuer?: string;
  generatedAt?: string;
  skills: Set<string>;
  mcpServers: Set<string>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortValue(value[key]);
  }
  return out;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function normalizeNameList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return Array.from(
    new Set(
      raw
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter(Boolean)
    )
  ).sort();
}

function normalizeChecksum(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  const value = trimmed.startsWith("sha256:")
    ? trimmed.slice("sha256:".length)
    : trimmed;
  if (!SHA256_HEX_RE.test(value)) {
    return null;
  }
  return value;
}

function buildCanonicalPayload(args: {
  version: number;
  issuer?: string;
  generatedAt?: string;
  skills: string[];
  mcpServers: string[];
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    version: args.version,
    skills: args.skills,
    mcp: args.mcpServers,
  };
  if (args.issuer) {
    payload.issuer = args.issuer;
  }
  if (args.generatedAt) {
    payload.generatedAt = args.generatedAt;
  }
  return payload;
}

function extractTrustLists(obj: Record<string, unknown>): {
  skills: string[];
  mcpServers: string[];
} {
  const topLevelSkills = normalizeNameList(obj.skills);
  const topLevelMcp = normalizeNameList(obj.mcp);

  const trust = isPlainObject(obj.trust)
    ? (obj.trust as Record<string, unknown>)
    : null;
  const nestedSkills = normalizeNameList(trust?.skills);
  const nestedMcp = normalizeNameList(trust?.mcp);

  return {
    skills: topLevelSkills.length ? topLevelSkills : nestedSkills,
    mcpServers: topLevelMcp.length ? topLevelMcp : nestedMcp,
  };
}

function localTrustIsExplicit(entry: { trusted?: boolean }): boolean {
  return typeof entry.trusted === "boolean";
}

function applyTrustOverlay<T extends SkillEntry | McpEntry>(args: {
  entries: Record<string, T>;
  trustedNames: Set<string>;
  trustedBy: string;
  trustedAt?: string;
}): Record<string, T> {
  const next: Record<string, T> = { ...args.entries };
  for (const name of args.trustedNames) {
    const current = next[name];
    if (!current || localTrustIsExplicit(current)) {
      continue;
    }
    const withTrust = {
      ...current,
      trusted: true,
      trustedBy: args.trustedBy,
      trustedAt: current.trustedAt ?? args.trustedAt,
    } as T;
    next[name] = withTrust;
  }
  return next;
}

export async function loadOrgTrustList(opts?: {
  homeDir?: string;
}): Promise<OrgTrustList | null> {
  const home = opts?.homeDir ?? homedir();
  const trustPath = join(facultStateDir(home), "trust", "org-list.json");
  const file = Bun.file(trustPath);
  if (!(await file.exists())) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonLenient(await file.text());
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const version =
    typeof obj.version === "number" && Number.isFinite(obj.version)
      ? Math.floor(obj.version)
      : 1;
  const issuer = typeof obj.issuer === "string" ? obj.issuer.trim() : "";
  const generatedAt =
    typeof obj.generatedAt === "string" ? obj.generatedAt : undefined;
  const { skills, mcpServers } = extractTrustLists(obj);

  const expectedChecksum = normalizeChecksum(obj.checksum);
  if (!expectedChecksum) {
    return null;
  }

  const payload = buildCanonicalPayload({
    version,
    issuer: issuer || undefined,
    generatedAt,
    skills,
    mcpServers,
  });
  const actualChecksum = sha256Hex(stableStringify(payload));
  if (actualChecksum !== expectedChecksum) {
    return null;
  }

  return {
    version,
    issuer: issuer || undefined,
    generatedAt,
    skills: new Set(skills),
    mcpServers: new Set(mcpServers),
  };
}

export async function applyOrgTrustList(
  index: FacultIndex,
  opts?: {
    homeDir?: string;
  }
): Promise<FacultIndex> {
  const orgList = await loadOrgTrustList(opts);
  if (!orgList) {
    return index;
  }

  const trustedBy = orgList.issuer ? `org:${orgList.issuer}` : "org";
  const next: FacultIndex = {
    version: index.version,
    updatedAt: index.updatedAt,
    skills: applyTrustOverlay({
      entries: index.skills,
      trustedNames: orgList.skills,
      trustedBy,
      trustedAt: orgList.generatedAt,
    }),
    mcp: {
      servers: applyTrustOverlay({
        entries: index.mcp?.servers ?? {},
        trustedNames: orgList.mcpServers,
        trustedBy,
        trustedAt: orgList.generatedAt,
      }),
    },
    agents: index.agents ?? {},
    snippets: index.snippets ?? {},
    instructions: index.instructions ?? {},
  };

  return next;
}
