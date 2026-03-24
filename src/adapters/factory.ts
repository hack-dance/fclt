import { basename, extname } from "node:path";
import { renderCanonicalText } from "../agents";
import { generateMcpConfig, parseMcpConfig } from "./mcp";
import { parseSkillsDir } from "./skills";
import type {
  CanonicalMcpConfig,
  CanonicalMcpServer,
  ParsedManagedAgentFile,
  RenderManagedAgentOptions,
  ToolAdapter,
} from "./types";
import { detectExplicitVersion } from "./version";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function escapeTomlMultiline(value: string): string {
  return value.replace(/"""/g, '\\"""');
}

function escapeYamlString(value: string): string {
  return JSON.stringify(value);
}

function stringifyFrontmatter(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}: ${escapeYamlString(value)}`)
    .join("\n");
}

function parseFrontmatterScalar(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const quote = trimmed[0];
    const inner = trimmed.slice(1, -1);
    if (quote === '"') {
      try {
        return JSON.parse(trimmed);
      } catch {
        return inner;
      }
    }
    return inner;
  }
  return trimmed;
}

function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = parseFrontmatterScalar(trimmed.slice(separator + 1));
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

function normalizeFactoryServer(server: CanonicalMcpServer): CanonicalMcpServer {
  if (!isPlainObject(server.vendorExtensions)) {
    return server;
  }

  const vendorExtensions = { ...server.vendorExtensions };
  const type = vendorExtensions.type;
  if (typeof type === "string" && !server.transport) {
    server.transport = type;
  }
  delete vendorExtensions.type;

  if (Object.keys(vendorExtensions).length > 0) {
    server.vendorExtensions = vendorExtensions;
  } else {
    delete server.vendorExtensions;
  }

  return server;
}

function parseFactoryMcp(config: unknown): CanonicalMcpConfig {
  const parsed = parseMcpConfig(config);
  for (const [name, server] of Object.entries(parsed.servers)) {
    parsed.servers[name] = normalizeFactoryServer({ ...server });
  }
  return parsed;
}

function generateFactoryMcp(canonical: CanonicalMcpConfig): Record<string, unknown> {
  const generated = generateMcpConfig(canonical, "mcpServers");
  const servers = generated.mcpServers;
  if (!isPlainObject(servers)) {
    return generated;
  }

  for (const value of Object.values(servers)) {
    if (!isPlainObject(value)) {
      continue;
    }
    const server = value as Record<string, unknown>;
    const transport =
      typeof server.transport === "string" ? server.transport : undefined;
    const inferredType =
      transport ??
      (typeof server.url === "string"
        ? "http"
        : typeof server.command === "string"
          ? "stdio"
          : undefined);
    delete server.transport;
    if (inferredType && typeof server.type !== "string") {
      server.type = inferredType;
    }
    if (typeof server.disabled !== "boolean") {
      server.disabled = false;
    }
  }

  return generated;
}

async function renderFactoryAgent(
  options: RenderManagedAgentOptions
): Promise<string> {
  const parsed = Bun.TOML.parse(options.raw) as Record<string, unknown>;
  const name =
    typeof parsed.name === "string"
      ? parsed.name
      : basename(options.targetPath, extname(options.targetPath));
  const description =
    typeof parsed.description === "string" ? parsed.description : undefined;
  const instructions =
    typeof parsed.developer_instructions === "string"
      ? parsed.developer_instructions
      : "";
  const renderedInstructions = await renderCanonicalText(instructions, {
    homeDir: options.homeDir,
    rootDir: options.rootDir,
    projectRoot: options.projectRoot,
    targetTool: options.tool,
    targetPath: options.targetPath,
  });

  const frontmatter = stringifyFrontmatter({
    name,
    ...(description ? { description } : {}),
    model: "inherit",
  });
  const body = renderedInstructions.trim();

  return body
    ? `---\n${frontmatter}\n---\n\n${body}\n`
    : `---\n${frontmatter}\n---\n`;
}

async function parseFactoryManagedAgentFile(
  path: string
): Promise<ParsedManagedAgentFile | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return null;
  }

  const raw = await file.text();
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return null;
  }

  const [, frontmatterRaw, bodyRaw] = match;
  const frontmatter = parseFrontmatter(frontmatterRaw ?? "");
  const name = frontmatter.name || basename(path, extname(path));
  const description = frontmatter.description || undefined;
  const body = (bodyRaw ?? "").replace(/^\s+/, "").replace(/\s+$/, "");
  const lines = [`name = ${JSON.stringify(name)}`];
  if (description) {
    lines.push(`description = ${JSON.stringify(description)}`);
  }
  lines.push("", 'developer_instructions = """');
  if (body) {
    lines.push(escapeTomlMultiline(body));
  }
  lines.push('"""', "");

  return {
    name,
    raw: lines.join("\n"),
    sourcePath: path,
  };
}

export const factoryAdapter: ToolAdapter = {
  id: "factory",
  name: "Factory",
  versions: ["v1"],
  detectVersion: detectExplicitVersion,
  getDefaultPaths: () => ({
    mcp: "~/.factory/mcp.json",
    skills: ["~/.factory/skills", ".factory/skills"],
    agents: ["~/.factory/droids", ".factory/droids"],
  }),
  parseMcp: (config) => parseFactoryMcp(config),
  generateMcp: (canonical) => generateFactoryMcp(canonical),
  parseSkills: async (skillsDir) => await parseSkillsDir(skillsDir),
  agentFileExtension: ".md",
  renderAgent: async (options) => await renderFactoryAgent(options),
  parseManagedAgentFile: async (path) => await parseFactoryManagedAgentFile(path),
};
