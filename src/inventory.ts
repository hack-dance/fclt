import { homedir } from "node:os";
import { join } from "node:path";
import { extractServersObject } from "./mcp-config";
import { facultRootDir, readFacultConfig } from "./paths";
import type { AssetFile, McpConfig, ScanResult, SourceResult } from "./scan";
import { scan } from "./scan";
import { parseJsonLenient } from "./util/json";
import { computeSkillOccurrences } from "./util/skills";

export interface InventoryAuthSummary {
  state: "none" | "env" | "inline-secret" | "external";
  envKeys: string[];
  envRefs: string[];
  inlineSecretKeys: string[];
  hasInlineSecrets: boolean;
  notes: string[];
}

export interface InventoryMcpServer {
  name: string;
  sourceId: string;
  sourceName: string;
  configPath: string;
  configFormat: McpConfig["format"];
  transport?: string;
  command?: string;
  args?: string[];
  url?: string;
  auth: InventoryAuthSummary;
  definition: unknown;
}

export interface InventoryMcpCapability {
  name: string;
  occurrences: number;
  sourceIds: string[];
  sourceNames: string[];
  configPaths: string[];
  variants: number;
  authStates: InventoryAuthSummary["state"][];
  hasInlineSecrets: boolean;
  preferred: InventoryMcpServer;
}

export interface InventorySkill {
  name: string;
  path: string;
  sourceIds: string[];
  sourceNames: string[];
  occurrences: number;
}

export interface InventoryInstruction {
  kind: string;
  path: string;
  sourceId: string;
  sourceName: string;
  format: AssetFile["format"];
  summary?: Record<string, unknown>;
}

export interface InventorySource {
  id: string;
  name: string;
  found: boolean;
  roots: string[];
  evidence: string[];
  warnings?: string[];
  truncated?: boolean;
}

export interface AgentInventory {
  version: 1;
  generatedAt: string;
  cwd: string;
  canonicalRoot: string;
  scanFrom: string[];
  sources: InventorySource[];
  mcpCapabilities: InventoryMcpCapability[];
  mcpServers: InventoryMcpServer[];
  skills: InventorySkill[];
  instructions: InventoryInstruction[];
  summary: {
    sourceCount: number;
    mcpCapabilityCount: number;
    mcpServerCount: number;
    skillCount: number;
    instructionCount: number;
    warningCount: number;
    truncatedSourceCount: number;
  };
}

interface InventoryOptions {
  cwd?: string;
  homeDir?: string;
  from?: string[];
  includeConfigFrom?: boolean;
  includeGitHooks?: boolean;
  showSecrets?: boolean;
  sourceMode?: "machine" | "global" | "project";
  tool?: string;
}

const SECRET_KEY_RE = /(TOKEN|KEY|SECRET|PASSWORD|PASS|BEARER|AUTH)/i;
const ENV_REF_RE = /^\$?\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
const SECRETY_STRING_RE =
  /\b(sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g;
const SECRET_ASSIGNMENT_RE =
  /\b([A-Za-z0-9_-]*(?:TOKEN|KEY|SECRET|PASSWORD|PASS|BEARER|AUTH)[A-Za-z0-9_-]*)\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'&]+)/gi;
const SECRET_URL_PARAM_RE =
  /([?&][A-Za-z0-9_.-]*(?:token|key|secret|password|pass|bearer|auth)[A-Za-z0-9_.-]*=)([^&#\s"']+)/gi;
const BEARER_RE = /\bBearer\s+([A-Za-z0-9._~+/=-]{10,})\b/gi;
const URL_QUERY_KEY_PREFIX_RE = /^[?&]/;
const TRAILING_EQUALS_RE = /=$/;

function isPlaceholderSecretValue(value: string): boolean {
  const trimmed = value.trim();
  return (
    !trimmed ||
    trimmed === "<redacted>" ||
    trimmed === "<set-me>" ||
    extractEnvRef(trimmed) !== null
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function redactPossibleSecrets(value: string): string {
  return value
    .replace(SECRET_ASSIGNMENT_RE, (_match, key: string, rawValue: string) => {
      const quote =
        rawValue.startsWith('"') || rawValue.startsWith("'") ? rawValue[0] : "";
      return `${key}=${quote}<redacted>${quote}`;
    })
    .replace(SECRET_URL_PARAM_RE, "$1<redacted>")
    .replace(BEARER_RE, "Bearer <redacted>")
    .replace(SECRETY_STRING_RE, "<redacted>");
}

function sanitizeDefinition(value: unknown): unknown {
  if (typeof value === "string") {
    return redactPossibleSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeDefinition);
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = "<redacted>";
      continue;
    }
    out[key] = sanitizeDefinition(inner);
  }
  return out;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((entry) => String(entry));
}

function safeStringArray(value: unknown, opts: { showSecrets: boolean }) {
  const values = stringArray(value);
  if (!values) {
    return undefined;
  }
  return opts.showSecrets ? values : values.map(redactPossibleSecrets);
}

function extractEnvRef(value: string): string | null {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("$") || trimmed.startsWith("${"))) {
    return null;
  }
  const match = ENV_REF_RE.exec(trimmed);
  return match?.[1] ?? null;
}

function addStringSecretFindings(args: {
  value: string;
  location: string;
  inlineSecretKeys: Set<string>;
}) {
  const { value, location, inlineSecretKeys } = args;
  for (const match of value.matchAll(SECRET_ASSIGNMENT_RE)) {
    const key = match[1]?.trim();
    const rawValue = (match[3] ?? match[4] ?? match[2] ?? "").trim();
    if (key && !isPlaceholderSecretValue(rawValue)) {
      inlineSecretKeys.add(`${location}:${key}`);
    }
  }

  for (const match of value.matchAll(SECRET_URL_PARAM_RE)) {
    const rawKey = match[1] ?? "";
    const rawValue = match[2] ?? "";
    const key = rawKey
      .replace(URL_QUERY_KEY_PREFIX_RE, "")
      .replace(TRAILING_EQUALS_RE, "");
    if (key && !isPlaceholderSecretValue(rawValue)) {
      inlineSecretKeys.add(`${location}:${key}`);
    }
  }

  if (BEARER_RE.test(value) || SECRETY_STRING_RE.test(value)) {
    inlineSecretKeys.add(location);
  }
  BEARER_RE.lastIndex = 0;
  SECRETY_STRING_RE.lastIndex = 0;
}

function summarizeAuth(definition: unknown): InventoryAuthSummary {
  const envKeys = new Set<string>();
  const envRefs = new Set<string>();
  const inlineSecretKeys = new Set<string>();
  const notes: string[] = [];

  if (!isPlainObject(definition)) {
    return {
      state: "none",
      envKeys: [],
      envRefs: [],
      inlineSecretKeys: [],
      hasInlineSecrets: false,
      notes,
    };
  }

  const env = definition.env;
  if (isPlainObject(env)) {
    for (const [key, value] of Object.entries(env)) {
      envKeys.add(key);
      if (typeof value !== "string") {
        continue;
      }
      const ref = extractEnvRef(value);
      if (ref) {
        envRefs.add(ref);
        continue;
      }
      if (SECRET_KEY_RE.test(key) && !isPlaceholderSecretValue(value)) {
        inlineSecretKeys.add(key);
      }
    }
  }

  const inspectValue = (value: unknown, location: string) => {
    if (typeof value === "string") {
      addStringSecretFindings({ value, location, inlineSecretKeys });
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) {
        inspectValue(entry, `${location}[${index}]`);
      }
      return;
    }
    if (!isPlainObject(value)) {
      return;
    }
    for (const [key, inner] of Object.entries(value)) {
      const childLocation = location ? `${location}.${key}` : key;
      if (typeof inner === "string") {
        const ref = extractEnvRef(inner);
        if (ref) {
          envRefs.add(ref);
        } else if (
          SECRET_KEY_RE.test(key) &&
          !isPlaceholderSecretValue(inner)
        ) {
          inlineSecretKeys.add(childLocation);
        }
      }
      inspectValue(inner, childLocation);
    }
  };
  inspectValue(definition, "");

  const command =
    typeof definition.command === "string" ? definition.command : "";
  if (envKeys.size === 0 && command && inlineSecretKeys.size === 0) {
    notes.push(
      "No explicit MCP env auth found; server may rely on external CLI/session auth."
    );
  }

  const uniqueEnvKeys = [...envKeys].sort();
  const uniqueEnvRefs = [...envRefs].sort();
  const uniqueInlineSecretKeys = [...inlineSecretKeys].sort();
  const hasInlineSecrets = uniqueInlineSecretKeys.length > 0;
  const state = hasInlineSecrets
    ? "inline-secret"
    : uniqueEnvKeys.length || uniqueEnvRefs.length
      ? "env"
      : command
        ? "external"
        : "none";

  return {
    state,
    envKeys: uniqueEnvKeys,
    envRefs: uniqueEnvRefs,
    inlineSecretKeys: uniqueInlineSecretKeys,
    hasInlineSecrets,
    notes,
  };
}

async function loadMcpServerDefinitions(
  config: McpConfig
): Promise<Record<string, unknown>> {
  try {
    const raw = await Bun.file(config.path).text();
    if (config.format === "toml") {
      const parsed = Bun.TOML.parse(raw) as Record<string, unknown>;
      const servers = parsed.mcp_servers;
      return isPlainObject(servers) ? servers : {};
    }
    const parsed = parseJsonLenient(raw);
    return extractServersObject(parsed) ?? {};
  } catch {
    return {};
  }
}

async function inventoryMcpServers(
  result: ScanResult,
  opts: { showSecrets: boolean }
): Promise<InventoryMcpServer[]> {
  const out: InventoryMcpServer[] = [];
  for (const source of result.sources) {
    for (const config of source.mcp.configs) {
      const definitions = await loadMcpServerDefinitions(config);
      for (const name of Object.keys(definitions).sort()) {
        const rawDefinition = definitions[name];
        const definition = opts.showSecrets
          ? rawDefinition
          : sanitizeDefinition(rawDefinition);
        const obj = isPlainObject(rawDefinition) ? rawDefinition : {};
        out.push({
          name,
          sourceId: source.id,
          sourceName: source.name,
          configPath: config.path,
          configFormat: config.format,
          transport:
            typeof obj.transport === "string" ? obj.transport : undefined,
          command:
            typeof obj.command === "string"
              ? opts.showSecrets
                ? obj.command
                : redactPossibleSecrets(obj.command)
              : undefined,
          args: safeStringArray(obj.args, opts),
          url:
            typeof obj.url === "string"
              ? opts.showSecrets
                ? obj.url
                : redactPossibleSecrets(obj.url)
              : undefined,
          auth: summarizeAuth(rawDefinition),
          definition,
        });
      }
    }
  }
  return out.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.sourceId.localeCompare(b.sourceId) ||
      a.configPath.localeCompare(b.configPath)
  );
}

function inventorySourceRank(sourceId: string): number {
  if (sourceId === "facult") {
    return 0;
  }
  if (sourceId === "codex") {
    return 1;
  }
  if (sourceId.endsWith("-project")) {
    return 2;
  }
  if (sourceId === "claude" || sourceId === "factory") {
    return 3;
  }
  if (sourceId.startsWith("from-")) {
    return 9;
  }
  return 5;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (!isPlainObject(value)) {
    return JSON.stringify(value);
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function preferredMcpServer(servers: InventoryMcpServer[]): InventoryMcpServer {
  return [...servers].sort((a, b) => {
    const sourceDiff =
      inventorySourceRank(a.sourceId) - inventorySourceRank(b.sourceId);
    if (sourceDiff !== 0) {
      return sourceDiff;
    }
    return a.configPath.localeCompare(b.configPath);
  })[0]!;
}

function inventoryMcpCapabilities(
  servers: InventoryMcpServer[]
): InventoryMcpCapability[] {
  const byName = new Map<string, InventoryMcpServer[]>();
  for (const server of servers) {
    byName.set(server.name, [...(byName.get(server.name) ?? []), server]);
  }

  return [...byName.entries()]
    .map(([name, entries]) => ({
      name,
      occurrences: entries.length,
      sourceIds: [...new Set(entries.map((entry) => entry.sourceId))].sort(),
      sourceNames: [
        ...new Set(entries.map((entry) => entry.sourceName)),
      ].sort(),
      configPaths: [
        ...new Set(entries.map((entry) => entry.configPath)),
      ].sort(),
      variants: new Set(entries.map((entry) => stableJson(entry.definition)))
        .size,
      authStates: [...new Set(entries.map((entry) => entry.auth.state))].sort(),
      hasInlineSecrets: entries.some((entry) => entry.auth.hasInlineSecrets),
      preferred: preferredMcpServer(entries),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function sourceMatchesInventoryOptions(
  sourceId: string,
  opts: Pick<InventoryOptions, "sourceMode" | "tool">
): boolean {
  if (opts.tool) {
    return sourceId === opts.tool || sourceId === `${opts.tool}-project`;
  }
  if (opts.sourceMode === "global") {
    return !(sourceId.endsWith("-project") || sourceId.startsWith("from-"));
  }
  if (opts.sourceMode === "project") {
    return sourceId.endsWith("-project") || sourceId.startsWith("from-");
  }
  return true;
}

function filterInventoryBySource(
  inventory: AgentInventory,
  opts: Pick<InventoryOptions, "sourceMode" | "tool">
): AgentInventory {
  if (!((opts.sourceMode && opts.sourceMode !== "machine") || opts.tool)) {
    return inventory;
  }

  const sources = inventory.sources.filter((source) =>
    sourceMatchesInventoryOptions(source.id, opts)
  );
  const sourceIds = new Set(sources.map((source) => source.id));
  const mcpServers = inventory.mcpServers.filter((server) =>
    sourceIds.has(server.sourceId)
  );
  const skills = inventory.skills
    .map((skill) => {
      const keptSourceIds = skill.sourceIds.filter((id) => sourceIds.has(id));
      if (keptSourceIds.length === 0) {
        return null;
      }
      return {
        ...skill,
        sourceIds: keptSourceIds,
        sourceNames: skill.sourceNames.filter((name) =>
          sources.some((source) => source.name === name)
        ),
        occurrences: keptSourceIds.length,
      };
    })
    .filter((skill): skill is InventorySkill => skill !== null);
  const instructions = inventory.instructions.filter((instruction) =>
    sourceIds.has(instruction.sourceId)
  );
  const mcpCapabilities = inventoryMcpCapabilities(mcpServers);
  const warningCount = sources.reduce(
    (count, source) => count + (source.warnings?.length ?? 0),
    0
  );

  return {
    ...inventory,
    sources,
    mcpCapabilities,
    mcpServers,
    skills,
    instructions,
    summary: {
      sourceCount: sources.filter((source) => source.found).length,
      mcpCapabilityCount: mcpCapabilities.length,
      mcpServerCount: mcpServers.length,
      skillCount: skills.length,
      instructionCount: instructions.length,
      warningCount,
      truncatedSourceCount: sources.filter((source) => source.truncated).length,
    },
  };
}

function inventorySkills(result: ScanResult): InventorySkill[] {
  const occurrences = computeSkillOccurrences(result);
  return occurrences
    .map((entry) => {
      const sourceIds = new Set<string>();
      const sourceNames = new Set<string>();
      for (const location of entry.locations) {
        const i = location.indexOf(":");
        if (i <= 0) {
          continue;
        }
        const sourceId = location.slice(0, i);
        sourceIds.add(sourceId);
        const source = result.sources.find(
          (candidate) => candidate.id === sourceId
        );
        if (source) {
          sourceNames.add(source.name);
        }
      }
      return {
        name: entry.name,
        path:
          entry.locations[0]?.slice(entry.locations[0].indexOf(":") + 1) ?? "",
        sourceIds: [...sourceIds].sort(),
        sourceNames: [...sourceNames].sort(),
        occurrences: entry.count,
      };
    })
    .sort(
      (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
    );
}

function isInstructionAsset(kind: string): boolean {
  return (
    kind.includes("instruction") ||
    kind.includes("rule") ||
    kind === "claude-settings" ||
    kind === "cursor-hook"
  );
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  try {
    const stat = await Bun.file(root).stat();
    if (!stat.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const out: string[] = [];
  const glob = new Bun.Glob("**/*.md");
  for await (const rel of glob.scan({ cwd: root, onlyFiles: true })) {
    out.push(join(root, rel));
  }
  return out.sort();
}

async function canonicalInstructionAssets(
  source: SourceResult
): Promise<InventoryInstruction[]> {
  const out: InventoryInstruction[] = [];
  for (const root of source.roots) {
    const candidates = [
      ...(await listMarkdownFiles(join(root, "instructions"))).map((path) => ({
        kind: "canonical-instruction",
        path,
      })),
      { kind: "agents-instructions", path: join(root, "AGENTS.global.md") },
      {
        kind: "agents-instructions",
        path: join(root, "AGENTS.override.global.md"),
      },
    ];
    for (const candidate of candidates) {
      try {
        const stat = await Bun.file(candidate.path).stat();
        if (!stat.isFile()) {
          continue;
        }
      } catch {
        continue;
      }
      out.push({
        kind: candidate.kind,
        path: candidate.path,
        sourceId: source.id,
        sourceName: source.name,
        format: "markdown",
      });
    }
  }
  return out;
}

async function inventoryInstructions(
  result: ScanResult
): Promise<InventoryInstruction[]> {
  const out: InventoryInstruction[] = [];
  for (const source of result.sources) {
    for (const asset of source.assets.files) {
      if (!isInstructionAsset(asset.kind)) {
        continue;
      }
      out.push({
        kind: asset.kind,
        path: asset.path,
        sourceId: source.id,
        sourceName: source.name,
        format: asset.format,
        summary: asset.summary,
      });
    }
    if (source.id === "facult" || source.id.endsWith("-project")) {
      out.push(...(await canonicalInstructionAssets(source)));
    }
  }

  const seen = new Set<string>();
  return out
    .filter((entry) => {
      const key = `${entry.kind}\0${entry.path}\0${entry.sourceId}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        a.sourceId.localeCompare(b.sourceId) ||
        a.path.localeCompare(b.path)
    );
}

function configuredScanFrom(homeDir: string): string[] {
  const config = readFacultConfig(homeDir);
  return [...(config?.scanFrom ?? [])].sort();
}

export async function buildAgentInventory(
  opts?: InventoryOptions
): Promise<AgentInventory> {
  const homeDir = opts?.homeDir ?? homedir();
  const cwd = opts?.cwd ?? process.cwd();
  const includeConfigFrom = opts?.includeConfigFrom ?? true;
  const configuredFrom = includeConfigFrom ? configuredScanFrom(homeDir) : [];
  const explicitFrom = opts?.from ?? [];
  const effectiveFrom =
    configuredFrom.length === 0 && explicitFrom.length === 0
      ? opts?.sourceMode === "project"
        ? [cwd]
        : ["~"]
      : explicitFrom;
  const scanResult = await scan([], {
    cwd,
    homeDir,
    includeConfigFrom,
    includeGitHooks: opts?.includeGitHooks,
    from: effectiveFrom,
  });
  const [mcpServers, skills, instructions] = await Promise.all([
    inventoryMcpServers(scanResult, {
      showSecrets: opts?.showSecrets ?? false,
    }),
    Promise.resolve(inventorySkills(scanResult)),
    inventoryInstructions(scanResult),
  ]);
  const mcpCapabilities = inventoryMcpCapabilities(mcpServers);
  const sources = scanResult.sources.map((source) => ({
    id: source.id,
    name: source.name,
    found: source.found,
    roots: source.roots,
    evidence: source.evidence,
    warnings: source.warnings,
    truncated: source.truncated,
  }));
  const warningCount = sources.reduce(
    (count, source) => count + (source.warnings?.length ?? 0),
    0
  );

  const inventory: AgentInventory = {
    version: 1,
    generatedAt: new Date().toISOString(),
    cwd,
    canonicalRoot: facultRootDir(homeDir),
    scanFrom: [...new Set([...configuredFrom, ...effectiveFrom])].sort(),
    sources,
    mcpCapabilities,
    mcpServers,
    skills,
    instructions,
    summary: {
      sourceCount: sources.filter((source) => source.found).length,
      mcpCapabilityCount: mcpCapabilities.length,
      mcpServerCount: mcpServers.length,
      skillCount: skills.length,
      instructionCount: instructions.length,
      warningCount,
      truncatedSourceCount: sources.filter((source) => source.truncated).length,
    },
  };
  return filterInventoryBySource(inventory, {
    sourceMode: opts?.sourceMode,
    tool: opts?.tool,
  });
}

function printHelp() {
  console.log(`fclt inventory — machine-readable agent capability inventory

Usage:
  fclt inventory --json
  fclt inventory --from <path> --json

Options:
  --json              Print JSON. This command is JSON-first.
  --from              Add one or more scan roots (repeatable)
  --show-secrets      Include raw MCP definitions instead of redacted definitions
  --include-git-hooks Include git hooks and Husky hooks in instruction assets
  --no-config-from    Disable scanFrom roots from ~/.ai/.facult/config.json
  --global            Show global/non-project sources only
  --project           Show project-local sources only
  --tool <name>       Show sources for one tool id, such as codex or claude
`);
}

export function parseInventoryArgs(argv: string[]): {
  json: boolean;
  showSecrets: boolean;
  includeGitHooks: boolean;
  includeConfigFrom: boolean;
  sourceMode: "machine" | "global" | "project";
  tool?: string;
  from: string[];
} {
  let json = false;
  let showSecrets = false;
  let includeGitHooks = false;
  let includeConfigFrom = true;
  let sourceMode: "machine" | "global" | "project" = "machine";
  let tool: string | undefined;
  const from: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--show-secrets") {
      showSecrets = true;
      continue;
    }
    if (arg === "--include-git-hooks") {
      includeGitHooks = true;
      continue;
    }
    if (arg === "--no-config-from") {
      includeConfigFrom = false;
      continue;
    }
    if (arg === "--global") {
      if (sourceMode === "project") {
        throw new Error("Conflicting scope flags");
      }
      sourceMode = "global";
      continue;
    }
    if (arg === "--project") {
      if (sourceMode === "global") {
        throw new Error("Conflicting scope flags");
      }
      sourceMode = "project";
      continue;
    }
    if (arg === "--tool") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--tool requires a name");
      }
      tool = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("--tool=")) {
      const value = arg.slice("--tool=".length);
      if (!value) {
        throw new Error("--tool requires a name");
      }
      tool = value;
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
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return {
    json,
    showSecrets,
    includeGitHooks,
    includeConfigFrom,
    sourceMode,
    tool,
    from,
  };
}

export async function inventoryCommand(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printHelp();
    return;
  }

  let opts: ReturnType<typeof parseInventoryArgs>;
  try {
    opts = parseInventoryArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
    return;
  }

  const inventory = await buildAgentInventory({
    from: opts.from,
    showSecrets: opts.showSecrets,
    includeGitHooks: opts.includeGitHooks,
    includeConfigFrom: opts.includeConfigFrom,
    sourceMode: opts.sourceMode,
    tool: opts.tool,
  });

  console.log(`${JSON.stringify(inventory, null, 2)}\n`);
}
