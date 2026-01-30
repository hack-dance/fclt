import { spawnSync } from "node:child_process";
import type { CanonicalMcpServer } from "./schema";

const SHA_SPLIT_REGEX = /\s+/;

export type AutoMode = "keep-newest" | "keep-current" | "keep-incoming";

export type AutoDecision = "keep-current" | "keep-incoming" | "keep-both";

export interface ConflictMeta {
  modified: Date | null;
}

function normalizeLineEndings(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function trimLineWhitespace(input: string): string {
  return input
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortValue(obj[key]);
  }
  return out;
}

/**
 * Normalize text content for comparison.
 *
 * Trims surrounding whitespace, normalizes line endings to LF,
 * and removes trailing whitespace on each line.
 */
export function normalizeText(input: string): string {
  const normalized = normalizeLineEndings(input);
  return trimLineWhitespace(normalized).trim();
}

/**
 * Normalize JSON content for comparison.
 *
 * Parses JSON and stringifies with stable key ordering.
 */
export function normalizeJson(input: string): string {
  const parsed = JSON.parse(input) as unknown;
  const stable = sortValue(parsed);
  return JSON.stringify(stable, null, 2).trim();
}

/**
 * Compute a sha256 hash for normalized content.
 */
export function contentHash(input: string): string {
  if (typeof Bun !== "undefined" && "CryptoHasher" in Bun) {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(input);
    return hasher.digest("hex");
  }

  const res = spawnSync("shasum", ["-a", "256"], {
    input,
    encoding: "utf8",
  });
  if (res.status === 0 && res.stdout) {
    return res.stdout.trim().split(SHA_SPLIT_REGEX)[0] ?? "";
  }

  throw new Error("Unable to compute content hash");
}

export function hashesMatch(
  currentHash: string | null,
  incomingHash: string | null
): boolean {
  return Boolean(currentHash && incomingHash && currentHash === incomingHash);
}

/**
 * Normalize a canonical MCP server entry for hashing.
 *
 * Strips provenance metadata and normalizes JSON key ordering.
 */
export function normalizeMcpServer(entry: CanonicalMcpServer): string {
  const { provenance: _provenance, ...rest } = entry;
  return normalizeJson(JSON.stringify(rest, null, 2));
}

/**
 * Compute a hash for a canonical MCP server entry.
 */
export function mcpServerHash(entry: CanonicalMcpServer): string {
  return contentHash(normalizeMcpServer(entry));
}

/**
 * Decide an automatic conflict resolution based on configured mode.
 */
export function decideAuto(
  mode: AutoMode | undefined,
  currentMeta: ConflictMeta,
  incomingMeta: ConflictMeta
): AutoDecision {
  if (!mode) {
    return "keep-both";
  }
  if (mode === "keep-current") {
    return "keep-current";
  }
  if (mode === "keep-incoming") {
    return "keep-incoming";
  }

  const currentTime = currentMeta.modified?.getTime() ?? null;
  const incomingTime = incomingMeta.modified?.getTime() ?? null;

  if (currentTime !== null && incomingTime !== null) {
    return incomingTime > currentTime ? "keep-incoming" : "keep-current";
  }
  if (incomingTime !== null && currentTime === null) {
    return "keep-incoming";
  }
  return "keep-current";
}
