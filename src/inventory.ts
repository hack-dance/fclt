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
  mcpServers: InventoryMcpServer[];
  skills: InventorySkill[];
  instructions: InventoryInstruction[];
  summary: {
    sourceCount: number;
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
}

const SECRET_KEY_RE = /(TOKEN|KEY|SECRET|PASSWORD|PASS|BEARER|AUTH)/i;
const ENV_REF_RE = /^\$?\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
const SECRETY_STRING_RE =
  /\b(sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function redactPossibleSecrets(value: string): string {
  return value.replace(SECRETY_STRING_RE, "<redacted>");
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

function extractEnvRef(value: string): string | null {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("$") || trimmed.startsWith("${"))) {
    return null;
  }
  const match = ENV_REF_RE.exec(trimmed);
  return match?.[1] ?? null;
}

function summarizeAuth(definition: unknown): InventoryAuthSummary {
  const envKeys: string[] = [];
  const envRefs: string[] = [];
  const inlineSecretKeys: string[] = [];
  const notes: string[] = [];

  if (!isPlainObject(definition)) {
    return {
      state: "none",
      envKeys,
      envRefs,
      inlineSecretKeys,
      hasInlineSecrets: false,
      notes,
    };
  }

  const env = definition.env;
  if (isPlainObject(env)) {
    for (const [key, value] of Object.entries(env)) {
      envKeys.push(key);
      if (typeof value !== "string") {
        continue;
      }
      const ref = extractEnvRef(value);
      if (ref) {
        envRefs.push(ref);
        continue;
      }
      if (SECRET_KEY_RE.test(key) && value.trim() && value !== "<redacted>") {
        inlineSecretKeys.push(key);
      }
    }
  }

  const command =
    typeof definition.command === "string" ? definition.command : "";
  if (!envKeys.length && command) {
    notes.push(
      "No explicit MCP env auth found; server may rely on external CLI/session auth."
    );
  }

  const uniqueEnvKeys = [...new Set(envKeys)].sort();
  const uniqueEnvRefs = [...new Set(envRefs)].sort();
  const uniqueInlineSecretKeys = [...new Set(inlineSecretKeys)].sort();
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
          command: typeof obj.command === "string" ? obj.command : undefined,
          args: stringArray(obj.args),
          url: typeof obj.url === "string" ? obj.url : undefined,
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
      ? ["~"]
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

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    cwd,
    canonicalRoot: facultRootDir(homeDir),
    scanFrom: [...new Set([...configuredFrom, ...effectiveFrom])].sort(),
    sources,
    mcpServers,
    skills,
    instructions,
    summary: {
      sourceCount: sources.filter((source) => source.found).length,
      mcpServerCount: mcpServers.length,
      skillCount: skills.length,
      instructionCount: instructions.length,
      warningCount,
      truncatedSourceCount: sources.filter((source) => source.truncated).length,
    },
  };
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
`);
}

export function parseInventoryArgs(argv: string[]): {
  json: boolean;
  showSecrets: boolean;
  includeGitHooks: boolean;
  includeConfigFrom: boolean;
  from: string[];
} {
  let json = false;
  let showSecrets = false;
  let includeGitHooks = false;
  let includeConfigFrom = true;
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
  return { json, showSecrets, includeGitHooks, includeConfigFrom, from };
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
  });

  console.log(`${JSON.stringify(inventory, null, 2)}\n`);
}
