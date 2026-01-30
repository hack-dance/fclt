import type { CanonicalMcpConfig, CanonicalMcpServer } from "./types";

type McpContainer = "mcpServers" | "servers" | "mcp";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === "string");
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!isPlainObject(v)) {
    return false;
  }
  return Object.values(v).every((val) => typeof val === "string");
}

const SERVER_KNOWN_KEYS = new Set([
  "transport",
  "command",
  "args",
  "url",
  "env",
]);

function normalizeArgs(value: unknown): string[] | undefined {
  if (isStringArray(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return undefined;
}

function normalizeEnv(value: unknown): Record<string, string> | undefined {
  if (isStringRecord(value)) {
    return value;
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    ([, v]) => typeof v === "string"
  );
  if (!entries.length) {
    return undefined;
  }
  return Object.fromEntries(entries.map(([k, v]) => [k, String(v)]));
}

function setKnownServerField(
  out: CanonicalMcpServer,
  key: string,
  value: unknown
): boolean {
  switch (key) {
    case "transport":
      out.transport = typeof value === "string" ? value : out.transport;
      return true;
    case "command":
      out.command = typeof value === "string" ? value : out.command;
      return true;
    case "args":
      out.args = normalizeArgs(value);
      return true;
    case "url":
      out.url = typeof value === "string" ? value : out.url;
      return true;
    case "env":
      out.env = normalizeEnv(value);
      return true;
    default:
      return false;
  }
}

function canonicalizeServer(config: unknown): CanonicalMcpServer {
  if (!isPlainObject(config)) {
    return {
      vendorExtensions: { raw: config },
    };
  }

  const out: CanonicalMcpServer = {};
  const vendor: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(config)) {
    if (!(SERVER_KNOWN_KEYS.has(k) && setKnownServerField(out, k, v))) {
      vendor[k] = v;
    }
  }

  if (Object.keys(vendor).length) {
    out.vendorExtensions = vendor;
  }

  return out;
}

function detectContainer(
  obj: Record<string, unknown>
): { container: McpContainer; servers: Record<string, unknown> } | null {
  if (isPlainObject(obj.mcpServers)) {
    return { container: "mcpServers", servers: obj.mcpServers };
  }
  if (isPlainObject(obj.mcp)) {
    const mcp = obj.mcp as Record<string, unknown>;
    if (isPlainObject(mcp.servers)) {
      return { container: "mcp", servers: mcp.servers };
    }
  }
  if (isPlainObject(obj.servers)) {
    return { container: "servers", servers: obj.servers };
  }
  return null;
}

function extractMcpVendorExtensions(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    return { mcp: value };
  }
  const { servers: _servers, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length) {
    return { mcp: rest };
  }
  return {};
}

function extractServers(config: unknown): {
  servers: Record<string, unknown>;
  vendorExtensions: Record<string, unknown>;
  container: McpContainer | null;
} {
  if (!isPlainObject(config)) {
    return { servers: {}, vendorExtensions: {}, container: null };
  }

  const obj = config as Record<string, unknown>;
  const detected = detectContainer(obj);
  const container = detected?.container ?? null;
  const servers = detected?.servers ?? {};

  const vendorExtensions: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(obj)) {
    if (container === "mcpServers" && k === "mcpServers") {
      continue;
    }
    if (container === "servers" && k === "servers") {
      continue;
    }
    if (container === "mcp" && k === "mcp") {
      Object.assign(vendorExtensions, extractMcpVendorExtensions(v));
      continue;
    }
    vendorExtensions[k] = v;
  }

  return { servers, vendorExtensions, container };
}

export function parseMcpConfig(config: unknown): CanonicalMcpConfig {
  const { servers, vendorExtensions } = extractServers(config);
  const canonical: CanonicalMcpConfig = {
    servers: {},
  };

  for (const [name, cfg] of Object.entries(servers)) {
    canonical.servers[name] = canonicalizeServer(cfg);
  }

  if (Object.keys(vendorExtensions).length) {
    canonical.vendorExtensions = vendorExtensions;
  }

  return canonical;
}

function generateServerConfig(server: CanonicalMcpServer): unknown {
  const known: Record<string, unknown> = {};
  const hasKnownKeys = (key: keyof CanonicalMcpServer) =>
    server[key] !== undefined;

  if (hasKnownKeys("transport")) {
    known.transport = server.transport;
  }
  if (hasKnownKeys("command")) {
    known.command = server.command;
  }
  if (hasKnownKeys("args")) {
    known.args = server.args;
  }
  if (hasKnownKeys("url")) {
    known.url = server.url;
  }
  if (hasKnownKeys("env")) {
    known.env = server.env;
  }

  const vendor = isPlainObject(server.vendorExtensions)
    ? (server.vendorExtensions as Record<string, unknown>)
    : null;

  if (vendor && "raw" in vendor && Object.keys(known).length === 0) {
    const rawValue = vendor.raw;
    if (Object.keys(vendor).length === 1) {
      return rawValue;
    }
  }

  if (vendor) {
    for (const [k, v] of Object.entries(vendor)) {
      if (!(k in known)) {
        known[k] = v;
      }
    }
  }

  return known;
}

export function generateMcpConfig(
  canonical: CanonicalMcpConfig,
  container: McpContainer = "mcpServers"
): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(canonical.servers ?? {})) {
    servers[name] = generateServerConfig(server);
  }

  const vendor = isPlainObject(canonical.vendorExtensions)
    ? (canonical.vendorExtensions as Record<string, unknown>)
    : {};

  const out: Record<string, unknown> = {};

  if (container === "mcp") {
    const mcpObj: Record<string, unknown> = { servers };
    if (isPlainObject(vendor.mcp)) {
      Object.assign(mcpObj, vendor.mcp as Record<string, unknown>);
    }
    out.mcp = mcpObj;
  } else if (container === "servers") {
    out.servers = servers;
  } else {
    out.mcpServers = servers;
  }

  for (const [k, v] of Object.entries(vendor)) {
    if (k === "mcp" && container === "mcp") {
      continue;
    }
    if (k === "servers" && container === "servers") {
      continue;
    }
    if (k === "mcpServers" && container === "mcpServers") {
      continue;
    }
    out[k] = v;
  }

  return out;
}

export function isPlainObjectValue(v: unknown): v is Record<string, unknown> {
  return isPlainObject(v);
}
