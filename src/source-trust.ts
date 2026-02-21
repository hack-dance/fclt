import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { facultStateDir } from "./paths";
import { parseJsonLenient } from "./util/json";

export type SourceTrustLevel = "trusted" | "review" | "blocked";

export interface SourceTrustPolicy {
  level: SourceTrustLevel;
  note?: string;
  updatedAt: string;
  updatedBy: "user";
}

export interface SourceTrustState {
  version: 1;
  updatedAt: string;
  sources: Record<string, SourceTrustPolicy>;
}

const SOURCE_TRUST_VERSION = 1;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function sourceTrustPath(home: string): string {
  return join(facultStateDir(home), "trust", "sources.json");
}

function normalizeSourceName(name: string): string {
  return name.trim();
}

function parseTrustLevel(raw: unknown): SourceTrustLevel | null {
  if (raw !== "trusted" && raw !== "review" && raw !== "blocked") {
    return null;
  }
  return raw;
}

function parsePolicy(raw: unknown): SourceTrustPolicy | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const level = parseTrustLevel(raw.level);
  if (!level) {
    return null;
  }
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : "";
  if (!updatedAt) {
    return null;
  }
  const updatedBy = raw.updatedBy === "user" ? "user" : "user";
  const note = typeof raw.note === "string" ? raw.note.trim() : undefined;
  return {
    level,
    note: note || undefined,
    updatedAt,
    updatedBy,
  };
}

export function defaultSourceTrustLevel(args: {
  sourceName: string;
}): SourceTrustLevel {
  // Builtin templates are local/offline and safe as a trusted base.
  if (args.sourceName === "facult") {
    return "trusted";
  }
  // External and custom sources default to review.
  return "review";
}

export function sourceTrustLevelFor(args: {
  sourceName: string;
  state: SourceTrustState;
}): {
  level: SourceTrustLevel;
  explicit: boolean;
  policy?: SourceTrustPolicy;
} {
  const name = normalizeSourceName(args.sourceName);
  const policy = args.state.sources[name];
  if (policy) {
    return {
      level: policy.level,
      explicit: true,
      policy,
    };
  }
  return {
    level: defaultSourceTrustLevel({ sourceName: name }),
    explicit: false,
  };
}

export async function loadSourceTrustState(opts?: {
  homeDir?: string;
}): Promise<SourceTrustState> {
  const home = opts?.homeDir ?? homedir();
  const path = sourceTrustPath(home);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = parseJsonLenient(raw);
    if (!isPlainObject(parsed)) {
      throw new Error("invalid");
    }

    const version =
      typeof parsed.version === "number" && Number.isFinite(parsed.version)
        ? Math.floor(parsed.version)
        : SOURCE_TRUST_VERSION;
    const updatedAt =
      typeof parsed.updatedAt === "string"
        ? parsed.updatedAt
        : new Date(0).toISOString();
    const sourcesRaw = isPlainObject(parsed.sources)
      ? (parsed.sources as Record<string, unknown>)
      : {};

    const sources: Record<string, SourceTrustPolicy> = {};
    for (const [name, value] of Object.entries(sourcesRaw)) {
      const normalized = normalizeSourceName(name);
      if (!normalized) {
        continue;
      }
      const policy = parsePolicy(value);
      if (!policy) {
        continue;
      }
      sources[normalized] = policy;
    }

    return {
      version: version === 1 ? 1 : SOURCE_TRUST_VERSION,
      updatedAt,
      sources,
    };
  } catch {
    return {
      version: SOURCE_TRUST_VERSION,
      updatedAt: new Date(0).toISOString(),
      sources: {},
    };
  }
}

export async function saveSourceTrustState(args: {
  state: SourceTrustState;
  homeDir?: string;
}): Promise<void> {
  const home = args.homeDir ?? homedir();
  const path = sourceTrustPath(home);
  await mkdir(join(facultStateDir(home), "trust"), { recursive: true });
  await Bun.write(path, `${JSON.stringify(args.state, null, 2)}\n`);
}

export async function setSourceTrustPolicy(args: {
  sourceName: string;
  level: SourceTrustLevel;
  note?: string;
  homeDir?: string;
  now?: () => Date;
}): Promise<SourceTrustState> {
  const home = args.homeDir ?? homedir();
  const now = args.now ? args.now() : new Date();
  const state = await loadSourceTrustState({ homeDir: home });
  const sourceName = normalizeSourceName(args.sourceName);
  if (!sourceName) {
    throw new Error("Source name cannot be empty.");
  }

  state.sources[sourceName] = {
    level: args.level,
    note: args.note?.trim() || undefined,
    updatedAt: now.toISOString(),
    updatedBy: "user",
  };
  state.updatedAt = now.toISOString();
  await saveSourceTrustState({ state, homeDir: home });
  return state;
}

export async function clearSourceTrustPolicy(args: {
  sourceName: string;
  homeDir?: string;
  now?: () => Date;
}): Promise<SourceTrustState> {
  const home = args.homeDir ?? homedir();
  const now = args.now ? args.now() : new Date();
  const state = await loadSourceTrustState({ homeDir: home });
  const sourceName = normalizeSourceName(args.sourceName);
  if (!sourceName) {
    throw new Error("Source name cannot be empty.");
  }

  delete state.sources[sourceName];
  state.updatedAt = now.toISOString();
  await saveSourceTrustState({ state, homeDir: home });
  return state;
}
