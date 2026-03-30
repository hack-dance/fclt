import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { projectRootFromAiRoot } from "./paths";

type ProjectSyncNamedSurface = "skills" | "agents" | "mcpServers";
type ProjectSyncToolSurface = "globalDocs" | "toolRules" | "toolConfig";

interface ProjectSyncToolPolicy {
  skills: string[];
  agents: string[];
  mcpServers: string[];
  globalDocs: boolean;
  toolRules: boolean;
  toolConfig: boolean;
}

interface ProjectSyncConfig {
  tools: Record<string, ProjectSyncToolPolicy>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readTomlObject(
  pathValue: string
): Promise<Record<string, unknown> | null> {
  const file = Bun.file(pathValue);
  if (!(await file.exists())) {
    return null;
  }
  const parsed = Bun.TOML.parse(await file.text());
  return isPlainObject(parsed) ? parsed : null;
}

function mergeTomlObjects(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      merged[key] = mergeTomlObjects(current, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(value.map((entry) => String(entry).trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
}

function parseBoolean(value: unknown): boolean {
  return value === true;
}

function projectSyncToolPolicyFromObject(
  value: unknown
): ProjectSyncToolPolicy {
  const table = isPlainObject(value) ? value : {};
  return {
    skills: parseStringList(table.skills),
    agents: parseStringList(table.agents),
    mcpServers: parseStringList(table.mcp_servers ?? table.mcp),
    globalDocs: parseBoolean(table.global_docs ?? table.docs),
    toolRules: parseBoolean(table.tool_rules ?? table.rules),
    toolConfig: parseBoolean(table.tool_config ?? table.config),
  };
}

function parseProjectSyncConfig(
  data: Record<string, unknown> | null
): ProjectSyncConfig {
  const raw = isPlainObject(data?.project_sync) ? data.project_sync : {};
  const tools: Record<string, ProjectSyncToolPolicy> = {};

  for (const [tool, value] of Object.entries(raw)) {
    tools[tool] = projectSyncToolPolicyFromObject(value);
  }

  return { tools };
}

async function loadProjectSyncConfig(args: {
  rootDir: string;
}): Promise<ProjectSyncConfig> {
  const [tracked, local] = await Promise.all([
    readTomlObject(join(args.rootDir, "config.toml")),
    readTomlObject(join(args.rootDir, "config.local.toml")),
  ]);
  const merged = mergeTomlObjects(tracked ?? {}, local ?? {});
  return parseProjectSyncConfig(merged);
}

function emptyPolicy(): ProjectSyncToolPolicy {
  return {
    skills: [],
    agents: [],
    mcpServers: [],
    globalDocs: false,
    toolRules: false,
    toolConfig: false,
  };
}

function includesExplicitName(allowed: string[], name: string): boolean {
  return allowed.includes("*") || allowed.includes(name);
}

export function isProjectManagedRoot(args: {
  homeDir: string;
  rootDir: string;
}): boolean {
  return projectRootFromAiRoot(args.rootDir, args.homeDir) != null;
}

export async function loadProjectToolSyncPolicy(args: {
  homeDir: string;
  rootDir: string;
  tool: string;
}): Promise<ProjectSyncToolPolicy | null> {
  if (!isProjectManagedRoot(args)) {
    return null;
  }
  const config = await loadProjectSyncConfig({ rootDir: args.rootDir });
  return config.tools[args.tool] ?? emptyPolicy();
}

export async function projectSyncAllowsNamedAsset(args: {
  homeDir: string;
  rootDir: string;
  tool: string;
  surface: ProjectSyncNamedSurface;
  name: string;
}): Promise<boolean> {
  const policy = await loadProjectToolSyncPolicy(args);
  if (!policy) {
    return true;
  }
  const allowed =
    args.surface === "skills"
      ? policy.skills
      : args.surface === "agents"
        ? policy.agents
        : policy.mcpServers;
  return includesExplicitName(allowed, args.name);
}

export async function projectSyncAllowsToolSurface(args: {
  homeDir: string;
  rootDir: string;
  tool: string;
  surface: ProjectSyncToolSurface;
}): Promise<boolean> {
  const policy = await loadProjectToolSyncPolicy(args);
  if (!policy) {
    return true;
  }
  if (args.surface === "globalDocs") {
    return policy.globalDocs;
  }
  if (args.surface === "toolRules") {
    return policy.toolRules;
  }
  return policy.toolConfig;
}

export async function loadConfiguredProjectSyncTools(args: {
  rootDir: string;
}): Promise<string[]> {
  const config = await loadProjectSyncConfig({ rootDir: args.rootDir });
  return Object.keys(config.tools).sort((a, b) => a.localeCompare(b));
}

function escapeTomlString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function formatTomlValue(value: unknown): string {
  if (typeof value === "string") {
    return `"${escapeTomlString(value)}"`;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => formatTomlValue(entry)).join(", ")}]`;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  throw new Error(`Unsupported TOML value: ${typeof value}`);
}

function stringifyTomlObject(obj: Record<string, unknown>): string {
  const lines: string[] = [];

  function emitTable(table: Record<string, unknown>, pathParts: string[] = []) {
    const scalars: [string, unknown][] = [];
    const subtables: [string, Record<string, unknown>][] = [];

    for (const [key, value] of Object.entries(table)) {
      if (isPlainObject(value)) {
        subtables.push([key, value]);
      } else {
        scalars.push([key, value]);
      }
    }

    if (pathParts.length > 0) {
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push(`[${pathParts.join(".")}]`);
    }

    for (const [key, value] of scalars) {
      lines.push(`${key} = ${formatTomlValue(value)}`);
    }

    for (const [key, subtable] of subtables) {
      emitTable(subtable, [...pathParts, key]);
    }
  }

  emitTable(obj);
  return `${lines.join("\n")}\n`;
}

export async function writeProjectSyncPolicy(args: {
  rootDir: string;
  toolPolicies: Record<string, Partial<ProjectSyncToolPolicy>>;
  targetFile?: "config.toml" | "config.local.toml";
}): Promise<{ path: string; changed: boolean }> {
  const targetFile = args.targetFile ?? "config.local.toml";
  const targetPath = join(args.rootDir, targetFile);
  const current = (await readTomlObject(targetPath)) ?? {};
  const next = mergeTomlObjects(current, {});
  const projectSync = isPlainObject(next.project_sync)
    ? { ...next.project_sync }
    : {};

  for (const [tool, partialPolicy] of Object.entries(args.toolPolicies)) {
    const previousPolicy = projectSyncToolPolicyFromObject(projectSync[tool]);
    const mergedPolicy: ProjectSyncToolPolicy = {
      skills: parseStringList(partialPolicy.skills ?? previousPolicy.skills),
      agents: parseStringList(partialPolicy.agents ?? previousPolicy.agents),
      mcpServers: parseStringList(
        partialPolicy.mcpServers ?? previousPolicy.mcpServers
      ),
      globalDocs: partialPolicy.globalDocs ?? previousPolicy.globalDocs,
      toolRules: partialPolicy.toolRules ?? previousPolicy.toolRules,
      toolConfig: partialPolicy.toolConfig ?? previousPolicy.toolConfig,
    };

    projectSync[tool] = {
      skills: mergedPolicy.skills,
      agents: mergedPolicy.agents,
      mcp_servers: mergedPolicy.mcpServers,
      global_docs: mergedPolicy.globalDocs,
      tool_rules: mergedPolicy.toolRules,
      tool_config: mergedPolicy.toolConfig,
    };
  }

  next.project_sync = projectSync;
  const rendered = stringifyTomlObject(next);
  const currentText = (await Bun.file(targetPath).exists())
    ? await Bun.file(targetPath).text()
    : null;
  if (currentText === rendered) {
    return { path: targetPath, changed: false };
  }
  await mkdir(dirname(targetPath), { recursive: true });
  await Bun.write(targetPath, rendered);
  return { path: targetPath, changed: true };
}
