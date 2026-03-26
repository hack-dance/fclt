import { basename, dirname, join } from "node:path";
import { parseJsonLenient } from "./util/json";

const INLINE_SECRET_PLACEHOLDER_VALUES = new Set(["<set-me>", "<redacted>"]);
const INLINE_SECRET_ENV_REF_RE = /^\$\{[^}]+\}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isInlineMcpSecretValue(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (INLINE_SECRET_PLACEHOLDER_VALUES.has(trimmed)) {
    return false;
  }
  if (INLINE_SECRET_ENV_REF_RE.test(trimmed)) {
    return false;
  }
  return true;
}

export function extractServersObject(
  parsed: unknown
): Record<string, unknown> | null {
  if (!isPlainObject(parsed)) {
    return null;
  }
  const raw = parsed as Record<string, unknown>;
  const servers =
    (raw.servers as Record<string, unknown> | undefined) ??
    (raw.mcpServers as Record<string, unknown> | undefined) ??
    ((raw.mcp as Record<string, unknown> | undefined)?.servers as
      | Record<string, unknown>
      | undefined) ??
    null;
  if (servers && isPlainObject(servers)) {
    return servers;
  }
  return null;
}

function mergeJsonObjects(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      out[key] = mergeJsonObjects(current, value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function canonicalMcpTrackedPath(rootDir: string): string {
  return join(rootDir, "mcp", "servers.json");
}

export function canonicalMcpPaths(
  rootDir: string,
  trackedPath?: string | null
): { trackedPath: string; localPath: string } {
  const resolvedTrackedPath = trackedPath ?? canonicalMcpTrackedPath(rootDir);
  const fileName = basename(resolvedTrackedPath);
  const localFileName =
    fileName === "mcp.json" ? "mcp.local.json" : "servers.local.json";
  return {
    trackedPath: resolvedTrackedPath,
    localPath: join(dirname(resolvedTrackedPath), localFileName),
  };
}

async function loadServersFromPath(
  path: string
): Promise<Record<string, unknown>> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return {};
  }
  try {
    const parsed = parseJsonLenient(await file.text());
    return extractServersObject(parsed) ?? {};
  } catch {
    return {};
  }
}

export async function loadCanonicalMcpState(
  rootDir: string,
  opts?: { includeLocal?: boolean }
): Promise<{
  trackedPath: string;
  localPath: string;
  trackedServers: Record<string, unknown>;
  localServers: Record<string, unknown>;
  servers: Record<string, unknown>;
}> {
  const serversPath = join(rootDir, "mcp", "servers.json");
  const mcpPath = join(rootDir, "mcp", "mcp.json");

  const trackedPath = (await Bun.file(serversPath).exists())
    ? serversPath
    : (await Bun.file(mcpPath).exists())
      ? mcpPath
      : serversPath;
  const { localPath } = canonicalMcpPaths(rootDir, trackedPath);
  const trackedServers = await loadServersFromPath(trackedPath);
  const localServers =
    opts?.includeLocal === true ? await loadServersFromPath(localPath) : {};
  return {
    trackedPath,
    localPath,
    trackedServers,
    localServers,
    servers: mergeJsonObjects(trackedServers, localServers),
  };
}

export function stringifyCanonicalMcpServers(
  servers: Record<string, unknown>
): string {
  return `${JSON.stringify({ servers }, null, 2)}\n`;
}
