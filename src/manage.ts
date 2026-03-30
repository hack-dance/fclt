import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getAdapter } from "./adapters";
import { renderCanonicalText } from "./agents";
import { ensureAiIndexPath } from "./ai-state";
import { builtinSyncDefaultsEnabled, facultBuiltinPackRoot } from "./builtin";
import { parseCliContextArgs, resolveCliContextRoot } from "./cli-context";
import { renderBullets, renderCode, renderPage } from "./cli-ui";
import { contentHash, normalizeText } from "./conflicts";
import {
  globalDocTargetPaths,
  planToolConfigSync,
  planToolGlobalDocsSync,
  planToolRulesSync,
  syncToolConfig,
  syncToolGlobalDocs,
  syncToolRules,
} from "./global-docs";
import {
  type AgentEntry,
  buildIndex,
  type FacultIndex,
  type SkillEntry,
} from "./index-builder";
import {
  extractServersObject,
  loadCanonicalMcpState,
  stringifyCanonicalMcpServers,
} from "./mcp-config";
import {
  facultMachineStateDir,
  facultRootDir,
  legacyFacultStateDirForRoot,
  projectRootFromAiRoot,
} from "./paths";

export interface ManagedToolState {
  tool: string;
  managedAt: string;
  skillsDir?: string;
  mcpConfig?: string;
  agentsDir?: string;
  pluginsDir?: string;
  pluginMarketplacePath?: string;
  automationDir?: string;
  toolHome?: string;
  globalAgentsPath?: string;
  globalAgentsOverridePath?: string;
  rulesDir?: string;
  toolConfig?: string;
  skillsBackup?: string | null;
  mcpBackup?: string | null;
  agentsBackup?: string | null;
  pluginsBackup?: string | null;
  pluginMarketplaceBackup?: string | null;
  globalAgentsBackup?: string | null;
  globalAgentsOverrideBackup?: string | null;
  rulesBackup?: string | null;
  toolConfigBackup?: string | null;
  renderedTargets?: Record<string, ManagedRenderedTargetState>;
}

interface ManagedRenderedTargetState {
  hash: string;
  sourcePath: string;
  sourceKind: "builtin" | "canonical";
}

export interface ManagedState {
  version: 1;
  tools: Record<string, ManagedToolState>;
}

export interface ToolPaths {
  tool: string;
  skillsDir?: string;
  mcpConfig?: string;
  agentsDir?: string;
  pluginsDir?: string;
  pluginMarketplacePath?: string;
  automationDir?: string;
  toolHome?: string;
  rulesDir?: string;
  toolConfig?: string;
}

export interface ManageOptions {
  homeDir?: string;
  rootDir?: string;
  toolPaths?: Record<string, ToolPaths>;
  now?: () => Date;
  dryRun?: boolean;
  adoptExisting?: boolean;
  existingConflictMode?: "keep-canonical" | "keep-existing";
  builtinConflictMode?: "warn" | "overwrite";
}

export interface SyncOptions {
  homeDir?: string;
  rootDir?: string;
  tool?: string;
  dryRun?: boolean;
  builtinConflictMode?: "warn" | "overwrite";
}

const MANAGED_VERSION = 1 as const;

function nowIso(now?: () => Date): string {
  return (now ? now() : new Date()).toISOString();
}

function homePath(home: string, ...parts: string[]): string {
  return join(home, ...parts);
}

function codexLiveRoot(home: string, rootDir?: string): string {
  const projectRoot = rootDir ? projectRootFromAiRoot(rootDir, home) : null;
  return projectRoot ?? home;
}

function codexPluginsDir(home: string, rootDir?: string): string {
  return join(codexLiveRoot(home, rootDir), "plugins");
}

function codexSkillsDir(home: string, rootDir?: string): string {
  return join(codexLiveRoot(home, rootDir), ".agents", "skills");
}

function codexPluginMarketplacePath(home: string, rootDir?: string): string {
  return join(
    codexLiveRoot(home, rootDir),
    ".agents",
    "plugins",
    "marketplace.json"
  );
}

function codexLegacySkillsDir(home: string, rootDir?: string): string {
  return join(codexLiveRoot(home, rootDir), ".codex", "skills");
}

function codexLegacyPluginsDir(home: string, rootDir?: string): string {
  return join(codexLiveRoot(home, rootDir), ".codex", "plugins");
}

function codexCanonicalPluginsRoot(rootDir: string): string {
  return join(rootDir, "tools", "codex", "plugins");
}

function codexCanonicalPluginMarketplacePath(rootDir: string): string {
  return join(codexCanonicalPluginsRoot(rootDir), "marketplace.json");
}

function expandHomePath(pathValue: string, home: string): string {
  if (pathValue === "~") {
    return home;
  }
  if (pathValue.startsWith("~/")) {
    return join(home, pathValue.slice(2));
  }
  return pathValue;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await Bun.file(p).stat();
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(p: string) {
  await mkdir(p, { recursive: true });
}

function renderedSourceKindForPath(
  sourcePath: string
): ManagedRenderedTargetState["sourceKind"] {
  return sourcePath.startsWith(facultBuiltinPackRoot())
    ? "builtin"
    : "canonical";
}

function renderedHash(text: string): string {
  return contentHash(normalizeText(text));
}

type ManagedTargetContent = string | Uint8Array;

function byteHash(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function targetContentHash(
  content: ManagedTargetContent,
  options?: { normalizeText?: boolean }
): string {
  if (typeof content === "string") {
    return options?.normalizeText === false
      ? byteHash(Buffer.from(content))
      : renderedHash(content);
  }
  return byteHash(content);
}

async function readTargetHash(
  pathValue: string,
  options?: { normalizeText?: boolean }
): Promise<string | null> {
  if (!(await fileExists(pathValue))) {
    return null;
  }
  if (options?.normalizeText === false) {
    return byteHash(await Bun.file(pathValue).bytes());
  }
  return renderedHash(await Bun.file(pathValue).text());
}

function normalizeCodexMarketplaceText(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isPlainObject(parsed)) {
      return text.endsWith("\n") ? text : `${text}\n`;
    }
    const plugins = Array.isArray(parsed.plugins) ? parsed.plugins : null;
    if (plugins) {
      parsed.plugins = plugins.map((entry) => {
        if (!isPlainObject(entry)) {
          return entry;
        }
        const source = isPlainObject(entry.source) ? { ...entry.source } : null;
        if (
          source?.source === "local" &&
          typeof source.path === "string" &&
          source.path.startsWith("./.codex/plugins/")
        ) {
          source.path = source.path.replace("./.codex/plugins/", "./plugins/");
        }
        return source ? { ...entry, source } : entry;
      });
    }
    return `${JSON.stringify(parsed, null, 2)}\n`;
  } catch {
    return text.endsWith("\n") ? text : `${text}\n`;
  }
}

function defaultToolPaths(
  home: string,
  rootDir?: string
): Record<string, ToolPaths> {
  const projectRoot = rootDir ? projectRootFromAiRoot(rootDir, home) : null;
  const toolBase = (...parts: string[]) =>
    projectRoot ? join(projectRoot, ...parts) : homePath(home, ...parts);
  const defaults: Record<string, ToolPaths> = {
    cursor: {
      tool: "cursor",
      skillsDir: toolBase(".cursor", "skills"),
      toolHome: toolBase(".cursor"),
      mcpConfig: toolBase(".cursor", "mcp.json"),
    },
    codex: {
      tool: "codex",
      skillsDir: codexSkillsDir(home, rootDir),
      mcpConfig: toolBase(".codex", "mcp.json"),
      agentsDir: toolBase(".codex", "agents"),
      pluginsDir: projectRoot ? undefined : codexPluginsDir(home, rootDir),
      pluginMarketplacePath: projectRoot
        ? undefined
        : codexPluginMarketplacePath(home, rootDir),
      automationDir: homePath(home, ".codex", "automations"),
      toolHome: toolBase(".codex"),
      rulesDir: toolBase(".codex", "rules"),
      toolConfig: toolBase(".codex", "config.toml"),
    },
    claude: {
      tool: "claude",
      skillsDir: toolBase(".claude", "skills"),
      toolHome: toolBase(".claude"),
      mcpConfig: projectRoot
        ? toolBase(".claude", "mcp.json")
        : homePath(home, ".claude.json"),
    },
    "claude-desktop": {
      tool: "claude-desktop",
      mcpConfig: homePath(
        home,
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json"
      ),
    },
    clawdbot: {
      tool: "clawdbot",
      skillsDir: toolBase(".clawdbot", "skills"),
      mcpConfig: toolBase(".clawdbot", "mcp.json"),
    },
    gemini: {
      tool: "gemini",
      skillsDir: toolBase(".gemini", "skills"),
      mcpConfig: toolBase(".gemini", "mcp.json"),
    },
    antigravity: {
      tool: "antigravity",
      skillsDir: toolBase(".antigravity", "skills"),
      mcpConfig: toolBase(".antigravity", "mcp.json"),
    },
    factory: {
      tool: "factory",
      skillsDir: projectRoot
        ? join(projectRoot, ".factory", "skills")
        : homePath(home, ".factory", "skills"),
      mcpConfig: projectRoot
        ? join(projectRoot, ".factory", "mcp.json")
        : homePath(home, ".factory", "mcp.json"),
      agentsDir: projectRoot
        ? join(projectRoot, ".factory", "droids")
        : homePath(home, ".factory", "droids"),
      toolHome: projectRoot ? undefined : homePath(home, ".factory"),
    },
  };

  const adapterDefaults = (tool: string): ToolPaths | null => {
    if (projectRoot) {
      return null;
    }
    const adapter = getAdapter(tool);
    if (!adapter?.getDefaultPaths) {
      return null;
    }
    const paths = adapter.getDefaultPaths();
    const rawSkills = paths?.skills;
    const rawAgents = paths?.agents;
    const skillsDir = Array.isArray(rawSkills)
      ? rawSkills[0]
      : (rawSkills ?? undefined);
    const agentsDir = Array.isArray(rawAgents)
      ? rawAgents[0]
      : (rawAgents ?? undefined);

    return {
      tool,
      skillsDir: skillsDir ? expandHomePath(skillsDir, home) : undefined,
      agentsDir: agentsDir ? expandHomePath(agentsDir, home) : undefined,
      mcpConfig: paths?.mcp ? expandHomePath(paths.mcp, home) : undefined,
    };
  };

  for (const tool of ["cursor", "codex"]) {
    const adapterPath = adapterDefaults(tool);
    if (adapterPath) {
      defaults[tool] = {
        ...defaults[tool],
        ...adapterPath,
      };
    }
  }

  return defaults;
}

async function resolveToolPaths(
  tool: string,
  home: string,
  rootDir?: string,
  override?: Record<string, ToolPaths>
): Promise<ToolPaths | null> {
  const defaults = defaultToolPaths(home, rootDir);
  const projectRoot = rootDir ? projectRootFromAiRoot(rootDir, home) : null;
  if (override?.[tool]) {
    const base = defaults[tool] ?? null;
    return base ? { ...base, ...override[tool] } : (override[tool] ?? null);
  }
  const base = defaults[tool] ?? null;
  if (!base) {
    return null;
  }
  if (tool !== "codex") {
    // Codex has built-in default global-doc, rules, and tool-config
    // locations. Claude and Cursor have built-in global doc locations through
    // the base defaults above. Other tools can still opt into additional
    // file-backed surfaces explicitly via toolPaths overrides.
    return base;
  }

  if (projectRoot) {
    return base;
  }

  const adapterPaths = getAdapter("codex")?.getDefaultPaths?.();
  const adapterConfig = adapterPaths?.config
    ? expandHomePath(adapterPaths.config, home)
    : null;

  const candidates = [
    adapterConfig,
    homePath(home, ".config", "openai", "codex.json"),
    homePath(home, ".codex", "config.json"),
    homePath(home, ".codex", "mcp.json"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return { ...base, mcpConfig: candidate };
    }
  }

  return base;
}

export function managedStatePath(home: string = homedir()): string {
  return managedStatePathForRoot(home);
}

export function managedStatePathForRoot(
  home: string = homedir(),
  rootDir?: string
): string {
  return join(facultMachineStateDir(home, rootDir), "managed.json");
}

function legacyManagedStatePathForRoot(
  home: string = homedir(),
  rootDir?: string
): string {
  return join(
    legacyFacultStateDirForRoot(rootDir ?? facultRootDir(home), home),
    "managed.json"
  );
}

export async function loadManagedState(
  home: string = homedir(),
  rootDir?: string
): Promise<ManagedState> {
  const candidates = [
    managedStatePathForRoot(home, rootDir),
    legacyManagedStatePathForRoot(home, rootDir),
  ];
  for (const p of candidates) {
    if (!(await fileExists(p))) {
      continue;
    }
    try {
      const txt = await Bun.file(p).text();
      const data = JSON.parse(txt) as Partial<ManagedState> | null;
      if (data?.version === MANAGED_VERSION && data.tools) {
        return { version: MANAGED_VERSION, tools: data.tools };
      }
    } catch {
      // fallthrough
    }
  }
  return { version: MANAGED_VERSION, tools: {} };
}

export async function saveManagedState(
  state: ManagedState,
  home: string = homedir(),
  rootDir?: string
) {
  const dir = facultMachineStateDir(home, rootDir);
  await ensureDir(dir);
  await Bun.write(
    managedStatePathForRoot(home, rootDir),
    `${JSON.stringify(state, null, 2)}\n`
  );
}

async function nextBackupPath(base: string, now?: () => Date): Promise<string> {
  const first = `${base}.bak`;
  if (!(await fileExists(first))) {
    return first;
  }
  const stamp = nowIso(now).replace(/[:.]/g, "-");
  return `${first}.${stamp}`;
}

async function backupPath(
  base: string,
  now?: () => Date
): Promise<string | null> {
  if (!(await fileExists(base))) {
    return null;
  }
  const backup = await nextBackupPath(base, now);
  await rename(base, backup);
  if (!(await fileExists(backup))) {
    throw new Error(`Backup failed for ${base}`);
  }
  return backup;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

async function readTextIfExists(p: string): Promise<string | null> {
  if (!(await fileExists(p))) {
    return null;
  }
  return await Bun.file(p).text();
}

async function readTomlFile(
  pathValue: string
): Promise<Record<string, unknown> | null> {
  const text = await readTextIfExists(pathValue);
  if (text == null) {
    return null;
  }
  const parsed = Bun.TOML.parse(text);
  return isPlainObject(parsed) ? parsed : null;
}

async function loadAgentsFromRoot(
  agentsRoot: string
): Promise<{ name: string; sourcePath: string; raw: string }[]> {
  const entries = await readdir(agentsRoot, { withFileTypes: true }).catch(
    () => [] as import("node:fs").Dirent[]
  );
  const out: { name: string; sourcePath: string; raw: string }[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const sourcePath = entry.isDirectory()
      ? homePath(agentsRoot, entry.name, "agent.toml")
      : entry.isFile() && entry.name.endsWith(".toml")
        ? homePath(agentsRoot, entry.name)
        : null;
    if (!sourcePath) {
      continue;
    }
    const raw = await readTextIfExists(sourcePath);
    if (raw == null) {
      continue;
    }
    const name = entry.isDirectory()
      ? entry.name
      : basename(entry.name, ".toml");
    out.push({
      name,
      sourcePath,
      raw,
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function loadCanonicalAgents(
  rootDir: string
): Promise<{ name: string; sourcePath: string; raw: string }[]> {
  return await loadAgentsFromRoot(homePath(rootDir, "agents"));
}

function managedAgentFileExtension(tool: string): string {
  return getAdapter(tool)?.agentFileExtension ?? ".toml";
}

async function renderManagedAgentFile(args: {
  agent: { name: string; sourcePath: string; raw: string };
  homeDir: string;
  rootDir: string;
  tool: string;
  targetPath: string;
}): Promise<string> {
  const adapter = getAdapter(args.tool);
  if (adapter?.renderAgent) {
    return await adapter.renderAgent({
      raw: args.agent.raw,
      homeDir: args.homeDir,
      rootDir: args.rootDir,
      projectRoot:
        projectRootFromAiRoot(args.rootDir, args.homeDir) ?? undefined,
      tool: args.tool,
      targetPath: args.targetPath,
    });
  }

  return await renderCanonicalText(args.agent.raw, {
    homeDir: args.homeDir,
    rootDir: args.rootDir,
    projectRoot: projectRootFromAiRoot(args.rootDir, args.homeDir) ?? undefined,
    targetTool: args.tool,
    targetPath: args.targetPath,
  });
}

async function loadManagedAgentsFromTool(args: {
  tool: string;
  agentsDir: string;
}): Promise<{ name: string; sourcePath: string; raw: string }[]> {
  const adapter = getAdapter(args.tool);
  if (!adapter?.parseManagedAgentFile) {
    return await loadAgentsFromRoot(args.agentsDir);
  }

  const extension = managedAgentFileExtension(args.tool);
  const entries = await readdir(args.agentsDir, { withFileTypes: true }).catch(
    () => [] as import("node:fs").Dirent[]
  );
  const out: { name: string; sourcePath: string; raw: string }[] = [];

  for (const entry of entries) {
    if (!(entry.isFile() && entry.name.endsWith(extension))) {
      continue;
    }
    const sourcePath = join(args.agentsDir, entry.name);
    const parsed = await adapter.parseManagedAgentFile(sourcePath);
    if (!parsed) {
      continue;
    }
    out.push(parsed);
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

interface AutomationEntry {
  name: string;
  sourceDir: string;
  files: Map<string, string>;
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const out: string[] = [];

  async function visit(currentDir: string, prefix = ""): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true }).catch(
      () => [] as import("node:fs").Dirent[]
    );
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const relPath = prefix ? join(prefix, entry.name) : entry.name;
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath, relPath);
        continue;
      }
      if (entry.isFile()) {
        out.push(relPath);
      }
    }
  }

  await visit(root);
  return out.sort();
}

async function loadAutomationEntries(
  automationsRoot: string
): Promise<AutomationEntry[]> {
  const entries = await readdir(automationsRoot, { withFileTypes: true }).catch(
    () => [] as import("node:fs").Dirent[]
  );
  const out: AutomationEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const sourceDir = join(automationsRoot, entry.name);
    const relativeFiles = await listRelativeFiles(sourceDir);
    const files = new Map<string, string>();
    for (const relPath of relativeFiles) {
      const raw = await readTextIfExists(join(sourceDir, relPath));
      if (raw == null) {
        continue;
      }
      files.set(relPath, raw);
    }
    if (!files.has("automation.toml")) {
      continue;
    }
    out.push({
      name: entry.name,
      sourceDir,
      files,
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function loadCanonicalAutomations(
  rootDir: string
): Promise<AutomationEntry[]> {
  return await loadAutomationEntries(join(rootDir, "automations"));
}

function isAutomationRuntimeRelativePath(relPath: string): boolean {
  return relPath === "memory.md";
}

function isAutomationRuntimeTargetPath(targetPath: string): boolean {
  return basename(targetPath) === "memory.md";
}

function automationEntriesEqual(
  left: AutomationEntry,
  right: AutomationEntry
): boolean {
  const leftFiles = new Map(
    [...left.files.entries()].filter(
      ([relPath]) => !isAutomationRuntimeRelativePath(relPath)
    )
  );
  const rightFiles = new Map(
    [...right.files.entries()].filter(
      ([relPath]) => !isAutomationRuntimeRelativePath(relPath)
    )
  );

  if (leftFiles.size !== rightFiles.size) {
    return false;
  }
  for (const [relPath, leftRaw] of leftFiles.entries()) {
    if (rightFiles.get(relPath) !== leftRaw) {
      return false;
    }
  }
  return true;
}

async function canonicalAutomationsExist(rootDir: string): Promise<boolean> {
  try {
    const automations = await loadCanonicalAutomations(rootDir);
    return automations.length > 0;
  } catch {
    return false;
  }
}

interface CanonicalPluginEntry {
  name: string;
  sourceDir: string;
  files: Map<string, Uint8Array>;
}

async function listRelativeFilesWithDotfiles(root: string): Promise<string[]> {
  const out: string[] = [];

  async function visit(currentDir: string, prefix = ""): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true }).catch(
      () => [] as import("node:fs").Dirent[]
    );
    for (const entry of entries) {
      const relPath = prefix ? join(prefix, entry.name) : entry.name;
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath, relPath);
        continue;
      }
      if (entry.isFile()) {
        out.push(relPath);
      }
    }
  }

  await visit(root);
  return out.sort();
}

async function loadCanonicalCodexPlugins(
  rootDir: string
): Promise<CanonicalPluginEntry[]> {
  const pluginsRoot = codexCanonicalPluginsRoot(rootDir);
  const entries = await readdir(pluginsRoot, { withFileTypes: true }).catch(
    () => [] as import("node:fs").Dirent[]
  );
  const out: CanonicalPluginEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const sourceDir = join(pluginsRoot, entry.name);
    if (!(await fileExists(join(sourceDir, ".codex-plugin", "plugin.json")))) {
      continue;
    }
    const files = new Map<string, Uint8Array>();
    for (const relPath of await listRelativeFilesWithDotfiles(sourceDir)) {
      files.set(relPath, await Bun.file(join(sourceDir, relPath)).bytes());
    }
    out.push({ name: entry.name, sourceDir, files });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function canonicalCodexPluginsExist(rootDir: string): Promise<boolean> {
  if (await fileExists(codexCanonicalPluginMarketplacePath(rootDir))) {
    return true;
  }
  return (await loadCanonicalCodexPlugins(rootDir)).length > 0;
}

async function loadCanonicalCodexMarketplaceText(
  rootDir: string
): Promise<{ text: string | null; sourcePath: string }> {
  const sourcePath = codexCanonicalPluginMarketplacePath(rootDir);
  const raw = await readTextOrNull(sourcePath);
  return {
    text: raw == null ? null : normalizeCodexMarketplaceText(raw),
    sourcePath,
  };
}

async function hashDirectoryTree(root: string): Promise<string | null> {
  if (!(await fileExists(root))) {
    return null;
  }
  const files = await listRelativeFilesWithDotfiles(root);
  const hash = createHash("sha256");
  for (const relPath of files) {
    hash.update(relPath);
    hash.update("\0");
    hash.update(await Bun.file(join(root, relPath)).bytes());
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function loadMergedIndex(
  homeDir: string,
  rootDir: string
): Promise<FacultIndex> {
  const { path: indexPath } = await ensureAiIndexPath({
    homeDir,
    rootDir,
    repair: true,
  });
  if (!(await fileExists(indexPath))) {
    await buildIndex({ homeDir, rootDir, force: false });
  }
  return JSON.parse(await Bun.file(indexPath).text()) as FacultIndex;
}

async function loadEnabledSkillEntries(args: {
  homeDir: string;
  rootDir: string;
  tool: string;
}): Promise<{ name: string; path: string }[]> {
  const index = await loadMergedIndex(args.homeDir, args.rootDir);
  const useBuiltinDefaults = await builtinSyncDefaultsEnabled(
    args.rootDir,
    args.homeDir
  );
  const out: { name: string; path: string }[] = [];

  for (const [name, entry] of Object.entries(index.skills)) {
    const skill = entry as SkillEntry;
    if (
      !useBuiltinDefaults &&
      skill.sourceKind === "builtin" &&
      skill.sourceRoot?.includes("facult-operating-model")
    ) {
      continue;
    }
    if (
      Array.isArray(skill.enabledFor) &&
      !skill.enabledFor.includes(args.tool)
    ) {
      continue;
    }
    out.push({ name, path: skill.path });
  }

  if (out.length > 0) {
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  return (await listSkillDirs(join(args.rootDir, "skills"))).map((name) => ({
    name,
    path: join(args.rootDir, "skills", name),
  }));
}

async function loadManagedAgentEntries(args: {
  homeDir: string;
  rootDir: string;
}): Promise<{ name: string; sourcePath: string; raw: string }[]> {
  const index = await loadMergedIndex(args.homeDir, args.rootDir);
  const useBuiltinDefaults = await builtinSyncDefaultsEnabled(
    args.rootDir,
    args.homeDir
  );
  const out: { name: string; sourcePath: string; raw: string }[] = [];

  for (const [name, entry] of Object.entries(index.agents)) {
    const agent = entry as AgentEntry;
    if (
      !useBuiltinDefaults &&
      agent.sourceKind === "builtin" &&
      agent.sourceRoot?.includes("facult-operating-model")
    ) {
      continue;
    }
    const raw = await readTextIfExists(agent.path);
    if (raw == null) {
      continue;
    }
    out.push({ name, sourcePath: agent.path, raw });
  }

  if (out.length > 0) {
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  return await loadCanonicalAgents(args.rootDir);
}

async function planAgentFileChanges({
  agentsDir,
  homeDir,
  rootDir,
  tool,
}: {
  agentsDir: string;
  homeDir: string;
  rootDir: string;
  tool: string;
}): Promise<{
  add: string[];
  remove: string[];
  contents: Map<string, string>;
  sources: Map<string, string>;
}> {
  const agents = await loadManagedAgentEntries({ homeDir, rootDir });
  const contents = new Map<string, string>();
  const sources = new Map<string, string>();
  const desiredPaths = new Set<string>();
  const extension = managedAgentFileExtension(tool);

  for (const agent of agents) {
    const target = homePath(agentsDir, `${agent.name}${extension}`);
    const rendered = await renderManagedAgentFile({
      agent,
      homeDir,
      rootDir,
      tool,
      targetPath: target,
    });
    desiredPaths.add(target);
    contents.set(target, rendered);
    sources.set(target, agent.sourcePath);
  }

  const existing = await readdir(agentsDir, { withFileTypes: true }).catch(
    () => [] as import("node:fs").Dirent[]
  );
  const add = new Set<string>();
  const remove = new Set<string>();

  for (const entry of existing) {
    if (!(entry.isFile() && entry.name.endsWith(extension))) {
      continue;
    }
    const p = homePath(agentsDir, entry.name);
    if (!desiredPaths.has(p)) {
      remove.add(p);
      continue;
    }
    const desired = contents.get(p);
    const current = await readTextIfExists(p);
    if (desired != null && current !== desired) {
      add.add(p);
    }
  }

  for (const p of desiredPaths) {
    const current = await readTextIfExists(p);
    const desired = contents.get(p);
    if (desired != null && current !== desired) {
      add.add(p);
    }
  }

  return {
    add: Array.from(add).sort(),
    remove: Array.from(remove).sort(),
    contents,
    sources,
  };
}

async function syncAgentFiles({
  agentsDir,
  homeDir,
  rootDir,
  tool,
  dryRun,
}: {
  agentsDir: string;
  homeDir: string;
  rootDir: string;
  tool: string;
  dryRun?: boolean;
}): Promise<{ add: string[]; remove: string[] }> {
  const plan = await planAgentFileChanges({
    agentsDir,
    homeDir,
    rootDir,
    tool,
  });
  if (dryRun) {
    return { add: plan.add, remove: plan.remove };
  }
  await ensureDir(agentsDir);
  for (const p of plan.remove) {
    await rm(p, { force: true });
  }
  for (const p of plan.add) {
    const desired = plan.contents.get(p);
    if (desired != null) {
      await Bun.write(p, desired.endsWith("\n") ? desired : `${desired}\n`);
    }
  }
  return { add: plan.add, remove: plan.remove };
}

async function planAutomationFileChanges(args: {
  automationDir: string;
  rootDir: string;
  previouslyManagedTargets?: string[];
}): Promise<{
  add: string[];
  remove: string[];
  contents: Map<string, string>;
  sources: Map<string, string>;
}> {
  const automations = await loadCanonicalAutomations(args.rootDir);
  const contents = new Map<string, string>();
  const sources = new Map<string, string>();
  const desiredPaths = new Set<string>();
  const add = new Set<string>();

  for (const automation of automations) {
    for (const [relPath, raw] of automation.files.entries()) {
      const targetPath = join(args.automationDir, automation.name, relPath);
      const sourcePath = join(automation.sourceDir, relPath);
      contents.set(targetPath, raw);

      if (isAutomationRuntimeRelativePath(relPath)) {
        if ((await readTextIfExists(targetPath)) == null) {
          add.add(targetPath);
        }
        continue;
      }

      desiredPaths.add(targetPath);
      sources.set(targetPath, sourcePath);
      const current = await readTextIfExists(targetPath);
      if (current !== raw) {
        add.add(targetPath);
      }
    }
  }

  const remove = Array.from(
    new Set(
      (args.previouslyManagedTargets ?? []).filter(
        (targetPath) =>
          targetPath.startsWith(join(args.automationDir, "")) &&
          !isAutomationRuntimeTargetPath(targetPath) &&
          !desiredPaths.has(targetPath)
      )
    )
  ).sort();

  return {
    add: Array.from(add).sort(),
    remove,
    contents,
    sources,
  };
}

async function listSkillDirs(skillsRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(skillsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function canonicalSkillsExist(rootDir: string): Promise<boolean> {
  return (await listSkillDirs(join(rootDir, "skills"))).length > 0;
}

async function loadEnabledSkillNames({
  homeDir,
  rootDir,
  tool,
}: {
  homeDir: string;
  rootDir: string;
  tool: string;
}): Promise<string[]> {
  const entries = await loadEnabledSkillEntries({ homeDir, rootDir, tool });
  return entries.map((entry) => entry.name);
}

function canonicalServerToToolConfig(server: unknown): unknown {
  if (!isPlainObject(server)) {
    return server;
  }
  const raw = server as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const excluded = new Set([
    "name",
    "provenance",
    "enabledFor",
    "trusted",
    "auditStatus",
    "vendorExtensions",
  ]);
  for (const [k, v] of Object.entries(raw)) {
    if (!excluded.has(k)) {
      out[k] = v;
    }
  }
  const vendor = raw.vendorExtensions;
  if (isPlainObject(vendor)) {
    for (const [k, v] of Object.entries(vendor)) {
      out[k] = v;
    }
  }
  return out;
}

function filterServersForTool(
  servers: Record<string, unknown>,
  tool: string
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (isPlainObject(cfg)) {
      const enabledFor = cfg.enabledFor;
      if (Array.isArray(enabledFor) && !enabledFor.includes(tool)) {
        continue;
      }
    }
    out[name] = canonicalServerToToolConfig(cfg);
  }
  return out;
}

async function loadCanonicalServers(rootDir: string): Promise<{
  servers: Record<string, unknown>;
  sourcePath: string | null;
}> {
  const loaded = await loadCanonicalMcpState(rootDir);
  const sourcePath = (await fileExists(loaded.trackedPath))
    ? loaded.trackedPath
    : null;
  return { servers: loaded.trackedServers, sourcePath };
}

async function ensureEmptyDir(p: string) {
  await rm(p, { recursive: true, force: true });
  await ensureDir(p);
}

async function adoptExistingToolSkills({
  rootDir,
  toolSkillsDir,
  conflictMode,
}: {
  rootDir: string;
  toolSkillsDir: string;
  conflictMode?: "keep-canonical" | "keep-existing";
}): Promise<{ adopted: string[]; skipped: string[] }> {
  const adopted: string[] = [];
  const skipped: string[] = [];

  const entries = await readdir(toolSkillsDir, { withFileTypes: true }).catch(
    () => [] as import("node:fs").Dirent[]
  );
  if (entries.length === 0) {
    return { adopted, skipped };
  }

  const canonicalSkillsDir = join(rootDir, "skills");
  await ensureDir(canonicalSkillsDir);

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.startsWith(".")) {
      skipped.push(entry.name);
      continue;
    }

    const existingSkillDir = join(toolSkillsDir, entry.name);
    const existingSkillFile = join(existingSkillDir, "SKILL.md");
    if (!(await fileExists(existingSkillFile))) {
      skipped.push(entry.name);
      continue;
    }

    const canonicalSkillDir = join(canonicalSkillsDir, entry.name);
    const canonicalSkillFile = join(canonicalSkillDir, "SKILL.md");
    if (await fileExists(canonicalSkillFile)) {
      if (conflictMode !== "keep-existing") {
        skipped.push(entry.name);
        continue;
      }
      await rm(canonicalSkillDir, { recursive: true, force: true });
      await cp(existingSkillDir, canonicalSkillDir, { recursive: true });
      adopted.push(entry.name);
      continue;
    }

    await cp(existingSkillDir, canonicalSkillDir, { recursive: true });
    adopted.push(entry.name);
  }

  return {
    adopted: adopted.sort(),
    skipped: skipped.sort(),
  };
}

async function adoptSkillsIntoCanonicalStore(args: {
  homeDir: string;
  rootDir: string;
  skillSourceDirs: string[];
}): Promise<string[]> {
  const adopted = new Set<string>();

  for (const dir of args.skillSourceDirs) {
    if (!dir) {
      continue;
    }
    const result = await adoptExistingToolSkills({
      rootDir: args.rootDir,
      toolSkillsDir: dir,
      conflictMode: "keep-canonical",
    });
    for (const name of result.adopted) {
      adopted.add(name);
    }
  }

  if (adopted.size > 0) {
    await buildIndex({
      homeDir: args.homeDir,
      rootDir: args.rootDir,
      force: false,
    });
  }

  return Array.from(adopted).sort();
}

interface ExistingSkillConflict {
  name: string;
  livePath: string;
  canonicalPath: string;
}

interface ExistingSkillPlan {
  adopt: string[];
  identical: string[];
  conflicts: ExistingSkillConflict[];
  ignored: string[];
}

async function readTextOrNull(pathValue: string): Promise<string | null> {
  if (!(await fileExists(pathValue))) {
    return null;
  }
  return await Bun.file(pathValue).text();
}

async function planExistingToolSkillAdoption(args: {
  rootDir: string;
  toolSkillsDir: string;
}): Promise<ExistingSkillPlan> {
  const adopt: string[] = [];
  const identical: string[] = [];
  const conflicts: ExistingSkillConflict[] = [];
  const ignored: string[] = [];

  const entries = await readdir(args.toolSkillsDir, {
    withFileTypes: true,
  }).catch(() => [] as import("node:fs").Dirent[]);

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.startsWith(".")) {
      ignored.push(entry.name);
      continue;
    }

    const liveSkillDir = join(args.toolSkillsDir, entry.name);
    const liveSkillFile = join(liveSkillDir, "SKILL.md");
    if (!(await fileExists(liveSkillFile))) {
      ignored.push(entry.name);
      continue;
    }

    const canonicalSkillDir = join(args.rootDir, "skills", entry.name);
    const canonicalSkillFile = join(canonicalSkillDir, "SKILL.md");
    if (!(await fileExists(canonicalSkillFile))) {
      adopt.push(entry.name);
      continue;
    }

    const [liveText, canonicalText] = await Promise.all([
      readTextOrNull(liveSkillFile),
      readTextOrNull(canonicalSkillFile),
    ]);
    if (liveText === canonicalText) {
      identical.push(entry.name);
      continue;
    }

    conflicts.push({
      name: entry.name,
      livePath: liveSkillDir,
      canonicalPath: canonicalSkillDir,
    });
  }

  return {
    adopt: adopt.sort(),
    identical: identical.sort(),
    conflicts: conflicts.sort((a, b) => a.name.localeCompare(b.name)),
    ignored: ignored.sort(),
  };
}

function logManagePreflight(tool: string, plan: ExistingSkillPlan) {
  if (
    plan.adopt.length === 0 &&
    plan.conflicts.length === 0 &&
    plan.identical.length === 0 &&
    plan.ignored.length === 0
  ) {
    console.log(`${tool}: no existing tool-native skills detected`);
    return;
  }
  for (const name of plan.adopt) {
    console.log(
      `${tool}: would adopt existing skill ${name} into canonical store`
    );
  }
  for (const name of plan.identical) {
    console.log(
      `${tool}: existing skill ${name} already matches canonical store`
    );
  }
  for (const conflict of plan.conflicts) {
    console.log(
      `${tool}: conflict for skill ${conflict.name} (live ${conflict.livePath} vs canonical ${conflict.canonicalPath})`
    );
  }
  for (const name of plan.ignored) {
    console.log(`${tool}: would ignore existing entry ${name}`);
  }
}

interface ExistingManagedItem {
  kind:
    | "skill"
    | "agent"
    | "automation"
    | "plugin"
    | "plugin-marketplace"
    | "global-doc"
    | "rule"
    | "tool-config"
    | "mcp-server";
  name: string;
  livePath: string;
  canonicalPath: string;
}

interface ExistingManagedImportPlan {
  adopt: ExistingManagedItem[];
  identical: ExistingManagedItem[];
  conflicts: ExistingManagedItem[];
  ignored: ExistingManagedItem[];
}

function emptyManagedImportPlan(): ExistingManagedImportPlan {
  return {
    adopt: [],
    identical: [],
    conflicts: [],
    ignored: [],
  };
}

function mergeManagedImportPlans(
  ...plans: ExistingManagedImportPlan[]
): ExistingManagedImportPlan {
  const merged = emptyManagedImportPlan();
  for (const plan of plans) {
    merged.adopt.push(...plan.adopt);
    merged.identical.push(...plan.identical);
    merged.conflicts.push(...plan.conflicts);
    merged.ignored.push(...plan.ignored);
  }
  const sortItems = (items: ExistingManagedItem[]) =>
    items.sort((a, b) =>
      `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`)
    );
  return {
    adopt: sortItems(merged.adopt),
    identical: sortItems(merged.identical),
    conflicts: sortItems(merged.conflicts),
    ignored: sortItems(merged.ignored),
  };
}

function asManagedSkillPlan(
  plan: ExistingSkillPlan
): ExistingManagedImportPlan {
  return {
    adopt: plan.adopt.map((name) => ({
      kind: "skill" as const,
      name,
      livePath: "",
      canonicalPath: "",
    })),
    identical: plan.identical.map((name) => ({
      kind: "skill" as const,
      name,
      livePath: "",
      canonicalPath: "",
    })),
    conflicts: plan.conflicts.map((item) => ({
      kind: "skill" as const,
      name: item.name,
      livePath: item.livePath,
      canonicalPath: item.canonicalPath,
    })),
    ignored: plan.ignored.map((name) => ({
      kind: "skill" as const,
      name,
      livePath: "",
      canonicalPath: "",
    })),
  };
}

function formatManagedItem(item: ExistingManagedItem): string {
  return item.kind === "global-doc" || item.kind === "tool-config"
    ? `${item.kind}:${item.name}`
    : `${item.kind}:${item.name}`;
}

function logManagedImportPlan(tool: string, plan: ExistingManagedImportPlan) {
  if (
    plan.adopt.length === 0 &&
    plan.identical.length === 0 &&
    plan.conflicts.length === 0 &&
    plan.ignored.length === 0
  ) {
    console.log(`${tool}: no existing managed content detected`);
    return;
  }
  for (const item of plan.adopt) {
    console.log(
      `${tool}: would adopt existing ${formatManagedItem(item)} into canonical store`
    );
  }
  for (const item of plan.identical) {
    console.log(
      `${tool}: existing ${formatManagedItem(item)} already matches canonical store`
    );
  }
  for (const item of plan.conflicts) {
    console.log(
      `${tool}: conflict for ${formatManagedItem(item)} (live ${item.livePath} vs canonical ${item.canonicalPath})`
    );
  }
  for (const item of plan.ignored) {
    console.log(`${tool}: would ignore existing ${formatManagedItem(item)}`);
  }
}

async function planExistingToolAgentAdoption(args: {
  tool: string;
  rootDir: string;
  agentsDir: string;
}): Promise<ExistingManagedImportPlan> {
  const plan = emptyManagedImportPlan();
  const agents = await loadManagedAgentsFromTool({
    tool: args.tool,
    agentsDir: args.agentsDir,
  });
  for (const agent of agents) {
    const canonicalPath = join(
      args.rootDir,
      "agents",
      agent.name,
      "agent.toml"
    );
    const canonicalRaw = await readTextOrNull(canonicalPath);
    const item: ExistingManagedItem = {
      kind: "agent",
      name: agent.name,
      livePath: agent.sourcePath,
      canonicalPath,
    };
    if (canonicalRaw == null) {
      plan.adopt.push(item);
    } else if (canonicalRaw === agent.raw) {
      plan.identical.push(item);
    } else {
      plan.conflicts.push(item);
    }
  }
  return mergeManagedImportPlans(plan);
}

async function adoptExistingToolAgents(args: {
  tool: string;
  rootDir: string;
  agentsDir: string;
  conflictMode: "keep-canonical" | "keep-existing";
}): Promise<ExistingManagedItem[]> {
  const adopted: ExistingManagedItem[] = [];
  const agents = await loadManagedAgentsFromTool({
    tool: args.tool,
    agentsDir: args.agentsDir,
  });
  for (const agent of agents) {
    const canonicalPath = join(
      args.rootDir,
      "agents",
      agent.name,
      "agent.toml"
    );
    const canonicalRaw = await readTextOrNull(canonicalPath);
    if (canonicalRaw != null && args.conflictMode !== "keep-existing") {
      continue;
    }
    await ensureDir(dirname(canonicalPath));
    await Bun.write(
      canonicalPath,
      agent.raw.endsWith("\n") ? agent.raw : `${agent.raw}\n`
    );
    adopted.push({
      kind: "agent",
      name: agent.name,
      livePath: agent.sourcePath,
      canonicalPath,
    });
  }
  return adopted;
}

async function planExistingAutomationAdoption(args: {
  rootDir: string;
  automationDir: string;
}): Promise<ExistingManagedImportPlan> {
  const plan = emptyManagedImportPlan();
  const liveAutomations = await loadAutomationEntries(args.automationDir);
  const canonicalAutomations = new Map(
    (await loadCanonicalAutomations(args.rootDir)).map((entry) => [
      entry.name,
      entry,
    ])
  );

  for (const liveAutomation of liveAutomations) {
    const canonicalAutomation = canonicalAutomations.get(liveAutomation.name);
    if (!canonicalAutomation) {
      continue;
    }
    const item: ExistingManagedItem = {
      kind: "automation",
      name: liveAutomation.name,
      livePath: liveAutomation.sourceDir,
      canonicalPath: join(args.rootDir, "automations", liveAutomation.name),
    };
    if (automationEntriesEqual(liveAutomation, canonicalAutomation)) {
      plan.identical.push(item);
    } else {
      plan.conflicts.push(item);
    }
  }

  return mergeManagedImportPlans(plan);
}

async function adoptExistingAutomations(args: {
  rootDir: string;
  automationDir: string;
  conflictMode: "keep-canonical" | "keep-existing";
}): Promise<ExistingManagedItem[]> {
  if (args.conflictMode !== "keep-existing") {
    return [];
  }

  const adopted: ExistingManagedItem[] = [];
  const liveAutomations = await loadAutomationEntries(args.automationDir);
  const canonicalAutomations = new Map(
    (await loadCanonicalAutomations(args.rootDir)).map((entry) => [
      entry.name,
      entry,
    ])
  );

  for (const liveAutomation of liveAutomations) {
    const canonicalAutomation = canonicalAutomations.get(liveAutomation.name);
    if (
      !(
        canonicalAutomation &&
        !automationEntriesEqual(liveAutomation, canonicalAutomation)
      )
    ) {
      continue;
    }
    const canonicalPath = join(
      args.rootDir,
      "automations",
      liveAutomation.name
    );
    await ensureDir(dirname(canonicalPath));
    await rm(canonicalPath, { recursive: true, force: true });
    await cp(liveAutomation.sourceDir, canonicalPath, { recursive: true });
    adopted.push({
      kind: "automation",
      name: liveAutomation.name,
      livePath: liveAutomation.sourceDir,
      canonicalPath,
    });
  }

  return adopted;
}

async function planExistingGlobalDocAdoption(args: {
  rootDir: string;
  tool: string;
  toolHome: string;
}): Promise<ExistingManagedImportPlan> {
  const targets = globalDocTargetPaths(args.tool, args.toolHome);
  const mappings = [
    {
      name: basename(targets.primary),
      livePath: targets.primary,
      canonicalPath: join(args.rootDir, "AGENTS.global.md"),
    },
    ...(targets.override
      ? [
          {
            name: basename(targets.override),
            livePath: targets.override,
            canonicalPath: join(args.rootDir, "AGENTS.override.global.md"),
          },
        ]
      : []),
  ];
  const plan = emptyManagedImportPlan();
  for (const mapping of mappings) {
    const liveRaw = await readTextOrNull(mapping.livePath);
    if (liveRaw == null) {
      continue;
    }
    const canonicalRaw = await readTextOrNull(mapping.canonicalPath);
    const item: ExistingManagedItem = {
      kind: "global-doc",
      name: mapping.name,
      livePath: mapping.livePath,
      canonicalPath: mapping.canonicalPath,
    };
    if (canonicalRaw == null) {
      plan.adopt.push(item);
    } else if (canonicalRaw === liveRaw) {
      plan.identical.push(item);
    } else {
      plan.conflicts.push(item);
    }
  }
  return mergeManagedImportPlans(plan);
}

async function adoptExistingGlobalDocs(args: {
  rootDir: string;
  tool: string;
  toolHome: string;
  conflictMode: "keep-canonical" | "keep-existing";
}): Promise<ExistingManagedItem[]> {
  const adopted: ExistingManagedItem[] = [];
  const targets = globalDocTargetPaths(args.tool, args.toolHome);
  const mappings = [
    {
      name: basename(targets.primary),
      livePath: targets.primary,
      canonicalPath: join(args.rootDir, "AGENTS.global.md"),
    },
    ...(targets.override
      ? [
          {
            name: basename(targets.override),
            livePath: targets.override,
            canonicalPath: join(args.rootDir, "AGENTS.override.global.md"),
          },
        ]
      : []),
  ];
  for (const mapping of mappings) {
    const liveRaw = await readTextOrNull(mapping.livePath);
    if (liveRaw == null) {
      continue;
    }
    if (
      (await readTextOrNull(mapping.canonicalPath)) != null &&
      args.conflictMode !== "keep-existing"
    ) {
      continue;
    }
    await ensureDir(dirname(mapping.canonicalPath));
    await Bun.write(
      mapping.canonicalPath,
      liveRaw.endsWith("\n") ? liveRaw : `${liveRaw}\n`
    );
    adopted.push({
      kind: "global-doc",
      name: mapping.name,
      livePath: mapping.livePath,
      canonicalPath: mapping.canonicalPath,
    });
  }
  return adopted;
}

async function adoptExistingGlobalDocFile(args: {
  sourcePath: string;
  canonicalPath: string;
  name: string;
  conflictMode: "keep-canonical" | "keep-existing";
}): Promise<ExistingManagedItem[]> {
  const liveRaw = await readTextOrNull(args.sourcePath);
  if (liveRaw == null) {
    return [];
  }
  if (
    (await readTextOrNull(args.canonicalPath)) != null &&
    args.conflictMode !== "keep-existing"
  ) {
    return [];
  }
  await ensureDir(dirname(args.canonicalPath));
  await Bun.write(
    args.canonicalPath,
    liveRaw.endsWith("\n") ? liveRaw : `${liveRaw}\n`
  );
  return [
    {
      kind: "global-doc",
      name: args.name,
      livePath: args.sourcePath,
      canonicalPath: args.canonicalPath,
    },
  ];
}

async function planExistingRuleAdoption(args: {
  rootDir: string;
  tool: string;
  rulesDir: string;
}): Promise<ExistingManagedImportPlan> {
  const plan = emptyManagedImportPlan();
  const entries = await readdir(args.rulesDir, { withFileTypes: true }).catch(
    () => [] as import("node:fs").Dirent[]
  );
  for (const entry of entries) {
    if (!(entry.isFile() && entry.name.endsWith(".rules"))) {
      continue;
    }
    const livePath = join(args.rulesDir, entry.name);
    const canonicalPath = join(
      args.rootDir,
      "tools",
      args.tool,
      "rules",
      entry.name
    );
    const liveRaw = await readTextOrNull(livePath);
    if (liveRaw == null) {
      continue;
    }
    const canonicalRaw = await readTextOrNull(canonicalPath);
    const item: ExistingManagedItem = {
      kind: "rule",
      name: entry.name,
      livePath,
      canonicalPath,
    };
    if (canonicalRaw == null) {
      plan.adopt.push(item);
    } else if (canonicalRaw === liveRaw) {
      plan.identical.push(item);
    } else {
      plan.conflicts.push(item);
    }
  }
  return mergeManagedImportPlans(plan);
}

async function adoptExistingRules(args: {
  rootDir: string;
  tool: string;
  rulesDir: string;
  conflictMode: "keep-canonical" | "keep-existing";
}): Promise<ExistingManagedItem[]> {
  const adopted: ExistingManagedItem[] = [];
  const entries = await readdir(args.rulesDir, { withFileTypes: true }).catch(
    () => [] as import("node:fs").Dirent[]
  );
  for (const entry of entries) {
    if (!(entry.isFile() && entry.name.endsWith(".rules"))) {
      continue;
    }
    const livePath = join(args.rulesDir, entry.name);
    const canonicalPath = join(
      args.rootDir,
      "tools",
      args.tool,
      "rules",
      entry.name
    );
    const liveRaw = await readTextOrNull(livePath);
    if (liveRaw == null) {
      continue;
    }
    if (
      (await readTextOrNull(canonicalPath)) != null &&
      args.conflictMode !== "keep-existing"
    ) {
      continue;
    }
    await ensureDir(dirname(canonicalPath));
    await Bun.write(
      canonicalPath,
      liveRaw.endsWith("\n") ? liveRaw : `${liveRaw}\n`
    );
    adopted.push({
      kind: "rule",
      name: entry.name,
      livePath,
      canonicalPath,
    });
  }
  return adopted;
}

async function planExistingToolConfigAdoption(args: {
  rootDir: string;
  tool: string;
  toolConfigPath: string;
}): Promise<ExistingManagedImportPlan> {
  const plan = emptyManagedImportPlan();
  const liveRaw = await readTextOrNull(args.toolConfigPath);
  if (liveRaw == null) {
    return plan;
  }
  const canonicalPath = join(args.rootDir, "tools", args.tool, "config.toml");
  const canonicalRaw = await readTextOrNull(canonicalPath);
  const item: ExistingManagedItem = {
    kind: "tool-config",
    name: `${args.tool}/config.toml`,
    livePath: args.toolConfigPath,
    canonicalPath,
  };
  if (canonicalRaw == null) {
    plan.adopt.push(item);
  } else if (canonicalRaw === liveRaw) {
    plan.identical.push(item);
  } else {
    plan.conflicts.push(item);
  }
  return plan;
}

async function adoptExistingToolConfig(args: {
  rootDir: string;
  tool: string;
  toolConfigPath: string;
  conflictMode: "keep-canonical" | "keep-existing";
}): Promise<ExistingManagedItem[]> {
  const liveRaw = await readTextOrNull(args.toolConfigPath);
  if (liveRaw == null) {
    return [];
  }
  const canonicalPath = join(args.rootDir, "tools", args.tool, "config.toml");
  if (
    (await readTextOrNull(canonicalPath)) != null &&
    args.conflictMode !== "keep-existing"
  ) {
    return [];
  }
  await ensureDir(dirname(canonicalPath));
  await Bun.write(
    canonicalPath,
    liveRaw.endsWith("\n") ? liveRaw : `${liveRaw}\n`
  );
  return [
    {
      kind: "tool-config",
      name: `${args.tool}/config.toml`,
      livePath: args.toolConfigPath,
      canonicalPath,
    },
  ];
}

async function planExistingMcpAdoption(args: {
  rootDir: string;
  tool: string;
  mcpConfigPath: string;
}): Promise<ExistingManagedImportPlan> {
  const plan = emptyManagedImportPlan();
  const liveConfig = await readTomlFile(args.mcpConfigPath).catch(() => null);
  const liveRawJson = await readTextIfExists(args.mcpConfigPath);
  let liveServers: Record<string, unknown> | null = null;
  if (liveConfig) {
    liveServers = extractServersObject(liveConfig);
  }
  if (!liveServers && liveRawJson != null) {
    try {
      liveServers = extractServersObject(JSON.parse(liveRawJson));
    } catch {
      liveServers = null;
    }
  }
  if (!liveServers || Object.keys(liveServers).length === 0) {
    return plan;
  }
  const canonical = await loadCanonicalServers(args.rootDir);
  const canonicalPath =
    canonical.sourcePath ?? join(args.rootDir, "mcp", "servers.json");
  for (const [name, definition] of Object.entries(liveServers)) {
    const item: ExistingManagedItem = {
      kind: "mcp-server",
      name,
      livePath: args.mcpConfigPath,
      canonicalPath,
    };
    if (!(name in canonical.servers)) {
      plan.adopt.push(item);
      continue;
    }
    if (
      JSON.stringify(canonical.servers[name]) === JSON.stringify(definition)
    ) {
      plan.identical.push(item);
    } else {
      plan.conflicts.push(item);
    }
  }
  return plan;
}

async function adoptExistingMcpServers(args: {
  rootDir: string;
  tool: string;
  mcpConfigPath: string;
  conflictMode: "keep-canonical" | "keep-existing";
}): Promise<ExistingManagedItem[]> {
  const liveRaw = await readTextIfExists(args.mcpConfigPath);
  if (liveRaw == null) {
    return [];
  }
  let liveServers: Record<string, unknown> | null = null;
  try {
    liveServers = extractServersObject(Bun.TOML.parse(liveRaw));
  } catch {
    liveServers = null;
  }
  if (!liveServers) {
    try {
      liveServers = extractServersObject(JSON.parse(liveRaw));
    } catch {
      liveServers = null;
    }
  }
  if (!liveServers) {
    return [];
  }

  const canonical = await loadCanonicalServers(args.rootDir);
  const merged = { ...canonical.servers };
  const adopted: ExistingManagedItem[] = [];
  for (const [name, definition] of Object.entries(liveServers)) {
    if (!(name in merged) || args.conflictMode === "keep-existing") {
      merged[name] = definition;
      adopted.push({
        kind: "mcp-server",
        name,
        livePath: args.mcpConfigPath,
        canonicalPath:
          canonical.sourcePath ?? join(args.rootDir, "mcp", "servers.json"),
      });
    }
  }
  if (adopted.length === 0) {
    return [];
  }
  const canonicalPath =
    canonical.sourcePath ?? join(args.rootDir, "mcp", "servers.json");
  await ensureDir(dirname(canonicalPath));
  await Bun.write(canonicalPath, stringifyCanonicalMcpServers(merged));
  return adopted;
}

async function createSkillSymlinks({
  homeDir,
  toolSkillsDir,
  rootDir,
  tool,
}: {
  homeDir: string;
  toolSkillsDir: string;
  rootDir: string;
  tool: string;
}) {
  await ensureDir(toolSkillsDir);
  const skills = await loadEnabledSkillEntries({
    homeDir,
    rootDir,
    tool,
  });
  for (const skill of skills) {
    const target = skill.path;
    if (!(await fileExists(target))) {
      continue;
    }
    const linkPath = join(toolSkillsDir, skill.name);
    try {
      const st = await lstat(linkPath);
      if (st.isSymbolicLink()) {
        continue;
      }
      await rm(linkPath, { recursive: true, force: true });
    } catch {
      // not exists
    }
    await symlink(target, linkPath, "dir");
  }
}

function isPreservedToolSkillEntry(name: string): boolean {
  return name.startsWith(".");
}

async function restorePreservedToolSkillEntries({
  backupDir,
  toolSkillsDir,
}: {
  backupDir: string | null | undefined;
  toolSkillsDir: string;
}) {
  if (!(backupDir && (await fileExists(backupDir)))) {
    return;
  }
  const entries = await readdir(backupDir, { withFileTypes: true }).catch(
    () => [] as import("node:fs").Dirent[]
  );
  for (const entry of entries) {
    if (!isPreservedToolSkillEntry(entry.name)) {
      continue;
    }
    const source = join(backupDir, entry.name);
    const target = join(toolSkillsDir, entry.name);
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true });
  }
}

async function planSkillSymlinkChanges({
  homeDir,
  toolSkillsDir,
  rootDir,
  tool,
}: {
  homeDir: string;
  toolSkillsDir: string;
  rootDir: string;
  tool: string;
}): Promise<{ add: string[]; remove: string[] }> {
  const desiredEntries = await loadEnabledSkillEntries({
    homeDir,
    rootDir,
    tool,
  });
  const desiredTargets = new Map(
    desiredEntries.map((entry) => [entry.name, entry.path])
  );
  const desiredSet = new Set(desiredEntries.map((entry) => entry.name));
  const existing = await readdir(toolSkillsDir, { withFileTypes: true }).catch(
    () => [] as import("node:fs").Dirent[]
  );

  const remove: string[] = [];
  const add: string[] = [];

  for (const entry of existing) {
    if (isPreservedToolSkillEntry(entry.name)) {
      continue;
    }
    if (!desiredSet.has(entry.name)) {
      remove.push(entry.name);
      continue;
    }
    const linkPath = join(toolSkillsDir, entry.name);
    const target = desiredTargets.get(entry.name);
    if (!target) {
      remove.push(entry.name);
      continue;
    }
    try {
      const st = await lstat(linkPath);
      if (!st.isSymbolicLink()) {
        remove.push(entry.name);
        add.push(entry.name);
        continue;
      }
      const current = await readlink(linkPath);
      if (current !== target) {
        remove.push(entry.name);
        add.push(entry.name);
      }
    } catch {
      add.push(entry.name);
    }
  }

  for (const { name, path } of desiredEntries) {
    if (existing.find((entry) => entry.name === name)) {
      continue;
    }
    if (await fileExists(path)) {
      add.push(name);
    }
  }

  return {
    add: Array.from(new Set(add)).sort(),
    remove: Array.from(new Set(remove)).sort(),
  };
}

async function syncSkillSymlinks({
  homeDir,
  toolSkillsDir,
  rootDir,
  tool,
  dryRun,
}: {
  homeDir: string;
  toolSkillsDir: string;
  rootDir: string;
  tool: string;
  dryRun?: boolean;
}): Promise<{ add: string[]; remove: string[] }> {
  const plan = await planSkillSymlinkChanges({
    homeDir,
    toolSkillsDir,
    rootDir,
    tool,
  });
  if (dryRun) {
    return plan;
  }

  const desiredSkills = new Map(
    (
      await loadEnabledSkillEntries({
        homeDir,
        rootDir,
        tool,
      })
    ).map((entry) => [entry.name, entry.path])
  );

  await ensureDir(toolSkillsDir);
  for (const name of plan.remove) {
    const linkPath = join(toolSkillsDir, name);
    await rm(linkPath, { recursive: true, force: true });
  }
  for (const name of plan.add) {
    const target = desiredSkills.get(name);
    if (!(target && (await fileExists(target)))) {
      continue;
    }
    const linkPath = join(toolSkillsDir, name);
    await symlink(target, linkPath, "dir");
  }
  return plan;
}

async function planMcpWrite({
  mcpConfigPath,
  rootDir,
  tool,
}: {
  mcpConfigPath: string;
  rootDir: string;
  tool: string;
}): Promise<{ needsWrite: boolean; contents: string }> {
  const { servers } = await loadCanonicalMcpState(rootDir, {
    includeLocal: true,
  });
  const filtered = filterServersForTool(servers, tool);
  const contents = `${JSON.stringify({ mcpServers: filtered }, null, 2)}\n`;

  if (!(await fileExists(mcpConfigPath))) {
    return { needsWrite: true, contents };
  }
  try {
    const current = await Bun.file(mcpConfigPath).text();
    return { needsWrite: current !== contents, contents };
  } catch {
    return { needsWrite: true, contents };
  }
}

async function syncMcpConfig({
  mcpConfigPath,
  rootDir,
  tool,
  dryRun,
}: {
  mcpConfigPath: string;
  rootDir: string;
  tool: string;
  dryRun?: boolean;
}): Promise<{ needsWrite: boolean }> {
  const plan = await planMcpWrite({ mcpConfigPath, rootDir, tool });
  if (dryRun) {
    return { needsWrite: plan.needsWrite };
  }
  if (plan.needsWrite) {
    await ensureDir(dirname(mcpConfigPath));
    await Bun.write(mcpConfigPath, plan.contents);
  }
  return { needsWrite: plan.needsWrite };
}

async function writeToolMcpConfig({
  mcpConfigPath,
  rootDir,
  tool,
}: {
  mcpConfigPath: string;
  rootDir: string;
  tool: string;
}) {
  const { servers } = await loadCanonicalMcpState(rootDir, {
    includeLocal: true,
  });
  const filtered = filterServersForTool(servers, tool);
  await ensureDir(dirname(mcpConfigPath));
  await Bun.write(
    mcpConfigPath,
    `${JSON.stringify({ mcpServers: filtered }, null, 2)}\n`
  );
}

export async function manageTool(tool: string, opts: ManageOptions = {}) {
  const home = opts.homeDir ?? homedir();
  const rootDir = opts.rootDir ?? facultRootDir(home);
  const state = await loadManagedState(home, rootDir);

  if (state.tools[tool]) {
    throw new Error(`${tool} is already managed`);
  }

  const toolPaths = await resolveToolPaths(tool, home, rootDir, opts.toolPaths);
  if (!toolPaths) {
    throw new Error(`Unknown tool: ${tool}`);
  }

  const existingSkillPlan =
    toolPaths.skillsDir || tool === "codex"
      ? mergeManagedImportPlans(
          asManagedSkillPlan(
            toolPaths.skillsDir
              ? await planExistingToolSkillAdoption({
                  rootDir,
                  toolSkillsDir: toolPaths.skillsDir,
                })
              : {
                  adopt: [],
                  identical: [],
                  conflicts: [],
                  ignored: [],
                }
          ),
          tool === "codex"
            ? asManagedSkillPlan(
                await planExistingToolSkillAdoption({
                  rootDir,
                  toolSkillsDir: codexLegacySkillsDir(home, rootDir),
                })
              )
            : emptyManagedImportPlan()
        )
      : emptyManagedImportPlan();
  const existingImportPlan = mergeManagedImportPlans(
    existingSkillPlan,
    toolPaths.agentsDir
      ? await planExistingToolAgentAdoption({
          tool,
          rootDir,
          agentsDir: toolPaths.agentsDir,
        })
      : emptyManagedImportPlan(),
    toolPaths.automationDir
      ? await planExistingAutomationAdoption({
          rootDir,
          automationDir: toolPaths.automationDir,
        })
      : emptyManagedImportPlan(),
    toolPaths.toolHome
      ? await planExistingGlobalDocAdoption({
          rootDir,
          tool,
          toolHome: toolPaths.toolHome,
        })
      : emptyManagedImportPlan(),
    toolPaths.rulesDir
      ? await planExistingRuleAdoption({
          rootDir,
          tool,
          rulesDir: toolPaths.rulesDir,
        })
      : emptyManagedImportPlan(),
    toolPaths.toolConfig
      ? await planExistingToolConfigAdoption({
          rootDir,
          tool,
          toolConfigPath: toolPaths.toolConfig,
        })
      : emptyManagedImportPlan(),
    tool === "codex"
      ? await planExistingCodexPluginAdoption({
          homeDir: home,
          rootDir,
          pluginsDir: toolPaths.pluginsDir,
          pluginMarketplacePath: toolPaths.pluginMarketplacePath,
        })
      : emptyManagedImportPlan(),
    toolPaths.mcpConfig
      ? await planExistingMcpAdoption({
          rootDir,
          tool,
          mcpConfigPath: toolPaths.mcpConfig,
        })
      : emptyManagedImportPlan()
  );

  if (opts.dryRun) {
    logManagedImportPlan(tool, existingImportPlan);
    return;
  }

  if (
    (toolPaths.skillsDir ||
      toolPaths.agentsDir ||
      toolPaths.automationDir ||
      toolPaths.toolHome ||
      toolPaths.rulesDir ||
      toolPaths.toolConfig ||
      toolPaths.pluginsDir ||
      toolPaths.pluginMarketplacePath ||
      toolPaths.mcpConfig) &&
    !opts.adoptExisting &&
    (existingImportPlan.adopt.length > 0 ||
      existingImportPlan.conflicts.length > 0)
  ) {
    const summary = [
      `${tool} has existing managed content that must be reviewed before entering managed mode.`,
      existingImportPlan.adopt.length
        ? `Adoptable items: ${existingImportPlan.adopt
            .map((item) => formatManagedItem(item))
            .join(", ")}`
        : null,
      existingImportPlan.conflicts.length
        ? `Conflicting items: ${existingImportPlan.conflicts
            .map((item) => formatManagedItem(item))
            .join(", ")}`
        : null,
      `Run "fclt manage ${tool} --dry-run" to review the plan, then rerun with "--adopt-existing"`,
      existingImportPlan.conflicts.length > 0
        ? ' and "--existing-conflicts keep-canonical|keep-existing".'
        : ".",
    ]
      .filter(Boolean)
      .join(" ");
    throw new Error(summary);
  }

  if (
    opts.adoptExisting &&
    existingImportPlan.conflicts.length > 0 &&
    !opts.existingConflictMode
  ) {
    throw new Error(
      `${tool} has conflicting existing content (${existingImportPlan.conflicts
        .map((item) => formatManagedItem(item))
        .join(
          ", "
        )}). Rerun with "--existing-conflicts keep-canonical" or "--existing-conflicts keep-existing".`
    );
  }
  const importConflictMode = opts.existingConflictMode ?? "keep-canonical";

  const adoptedSkills = toolPaths.skillsDir
    ? await adoptSkillsIntoCanonicalStore({
        homeDir: home,
        rootDir,
        skillSourceDirs: [
          toolPaths.skillsDir,
          ...(tool === "codex" ? [codexLegacySkillsDir(home, rootDir)] : []),
        ],
      })
    : [];

  if (toolPaths.skillsDir && opts.adoptExisting) {
    const result = await adoptExistingToolSkills({
      rootDir,
      toolSkillsDir: toolPaths.skillsDir,
      conflictMode: importConflictMode,
    });
    for (const name of result.adopted) {
      if (!adoptedSkills.includes(name)) {
        adoptedSkills.push(name);
      }
    }
    if (result.adopted.length > 0) {
      await buildIndex({
        homeDir: home,
        rootDir,
        force: false,
      });
    }
  }
  if (tool === "codex" && opts.adoptExisting) {
    const legacySkillsDir = codexLegacySkillsDir(home, rootDir);
    const result = await adoptExistingToolSkills({
      rootDir,
      toolSkillsDir: legacySkillsDir,
      conflictMode: importConflictMode,
    });
    for (const name of result.adopted) {
      if (!adoptedSkills.includes(name)) {
        adoptedSkills.push(name);
      }
    }
    if (result.adopted.length > 0) {
      await buildIndex({
        homeDir: home,
        rootDir,
        force: false,
      });
    }
  }
  if (toolPaths.agentsDir && opts.adoptExisting) {
    const result = await adoptExistingToolAgents({
      tool,
      rootDir,
      agentsDir: toolPaths.agentsDir,
      conflictMode: importConflictMode,
    });
    adoptedSkills.push(...result.map((item) => item.name));
  }
  if (toolPaths.automationDir && opts.adoptExisting) {
    const result = await adoptExistingAutomations({
      rootDir,
      automationDir: toolPaths.automationDir,
      conflictMode: importConflictMode,
    });
    adoptedSkills.push(...result.map((item) => `${item.kind}:${item.name}`));
  }
  if (toolPaths.toolHome && opts.adoptExisting) {
    const result = await adoptExistingGlobalDocs({
      rootDir,
      tool,
      toolHome: toolPaths.toolHome,
      conflictMode: importConflictMode,
    });
    adoptedSkills.push(...result.map((item) => `${item.kind}:${item.name}`));
  }
  if (toolPaths.rulesDir && opts.adoptExisting) {
    const result = await adoptExistingRules({
      rootDir,
      tool,
      rulesDir: toolPaths.rulesDir,
      conflictMode: importConflictMode,
    });
    adoptedSkills.push(...result.map((item) => `${item.kind}:${item.name}`));
  }
  if (toolPaths.toolConfig && opts.adoptExisting) {
    const result = await adoptExistingToolConfig({
      rootDir,
      tool,
      toolConfigPath: toolPaths.toolConfig,
      conflictMode: importConflictMode,
    });
    adoptedSkills.push(...result.map((item) => `${item.kind}:${item.name}`));
  }
  if (toolPaths.mcpConfig && opts.adoptExisting) {
    const result = await adoptExistingMcpServers({
      rootDir,
      tool,
      mcpConfigPath: toolPaths.mcpConfig,
      conflictMode: importConflictMode,
    });
    adoptedSkills.push(...result.map((item) => `${item.kind}:${item.name}`));
  }
  if (tool === "codex" && opts.adoptExisting) {
    const result = await adoptExistingCodexPlugins({
      homeDir: home,
      rootDir,
      pluginsDir: toolPaths.pluginsDir,
      pluginMarketplacePath: toolPaths.pluginMarketplacePath,
      conflictMode: importConflictMode,
    });
    adoptedSkills.push(...result.map((item) => `${item.kind}:${item.name}`));
  }
  if (adoptedSkills.length > 0) {
    await buildIndex({
      homeDir: home,
      rootDir,
      force: false,
    });
  }
  const agentPreview = toolPaths.agentsDir
    ? await planAgentFileChanges({
        agentsDir: toolPaths.agentsDir,
        homeDir: home,
        rootDir,
        tool,
      })
    : null;
  const automationPreview = toolPaths.automationDir
    ? await planAutomationFileChanges({
        automationDir: toolPaths.automationDir,
        rootDir,
      })
    : null;
  const globalDocsPreview = toolPaths.toolHome
    ? await planToolGlobalDocsSync({
        homeDir: home,
        rootDir,
        tool,
        toolHome: toolPaths.toolHome,
      })
    : null;
  const globalDocTargets = toolPaths.toolHome
    ? globalDocTargetPaths(tool, toolPaths.toolHome)
    : null;
  const rulesPreview = toolPaths.rulesDir
    ? await planToolRulesSync({
        homeDir: home,
        rootDir,
        tool,
        rulesDir: toolPaths.rulesDir,
      })
    : null;
  const toolConfigPreview = toolPaths.toolConfig
    ? await planToolConfigSync({
        homeDir: home,
        rootDir,
        tool,
        toolConfigPath: toolPaths.toolConfig,
      })
    : null;
  const pluginPreview =
    tool === "codex" && toolPaths.pluginsDir && toolPaths.pluginMarketplacePath
      ? await planCodexPluginFileChanges({
          rootDir,
          pluginsDir: toolPaths.pluginsDir,
          pluginMarketplacePath: toolPaths.pluginMarketplacePath,
        })
      : null;

  const skillsBackup = toolPaths.skillsDir
    ? await backupPath(toolPaths.skillsDir, opts.now)
    : null;
  const mcpBackup = toolPaths.mcpConfig
    ? await backupPath(toolPaths.mcpConfig, opts.now)
    : null;
  const agentsBackup = toolPaths.agentsDir
    ? await backupPath(toolPaths.agentsDir, opts.now)
    : null;
  const globalAgentsBackup =
    toolPaths.toolHome &&
    globalDocTargets &&
    globalDocsPreview?.managedTargets.includes(globalDocTargets.primary)
      ? await backupPath(globalDocTargets.primary, opts.now)
      : null;
  const globalAgentsOverrideBackup =
    toolPaths.toolHome &&
    globalDocTargets?.override &&
    globalDocsPreview?.managedTargets.includes(globalDocTargets.override)
      ? await backupPath(globalDocTargets.override, opts.now)
      : null;
  const rulesBackup =
    toolPaths.rulesDir && rulesPreview?.managedRulesDir
      ? await backupPath(toolPaths.rulesDir, opts.now)
      : null;
  const toolConfigBackup =
    toolPaths.toolConfig && toolConfigPreview?.managedConfig
      ? await backupPath(toolPaths.toolConfig, opts.now)
      : null;
  const pluginsBackup =
    toolPaths.pluginsDir && pluginPreview?.contents.size
      ? await backupPath(toolPaths.pluginsDir, opts.now)
      : null;
  const pluginMarketplaceBackup =
    toolPaths.pluginMarketplacePath &&
    pluginPreview?.contents.has(toolPaths.pluginMarketplacePath)
      ? await backupPath(toolPaths.pluginMarketplacePath, opts.now)
      : null;

  if (toolPaths.skillsDir) {
    await ensureEmptyDir(toolPaths.skillsDir);
    await restorePreservedToolSkillEntries({
      backupDir: skillsBackup,
      toolSkillsDir: toolPaths.skillsDir,
    });
    await createSkillSymlinks({
      homeDir: home,
      toolSkillsDir: toolPaths.skillsDir,
      rootDir,
      tool,
    });
  }

  if (toolPaths.agentsDir) {
    await ensureEmptyDir(toolPaths.agentsDir);
  }

  if (toolPaths.mcpConfig) {
    await writeToolMcpConfig({
      mcpConfigPath: toolPaths.mcpConfig,
      rootDir,
      tool,
    });
  }

  if (toolPaths.agentsDir && agentPreview) {
    await applyRenderedWrites({
      contents: agentPreview.contents,
      targets: Array.from(agentPreview.contents.keys()),
    });
  }

  if (toolPaths.automationDir && automationPreview) {
    await ensureDir(toolPaths.automationDir);
    await applyRenderedRemoves(automationPreview.remove);
    await applyRenderedWrites({
      contents: automationPreview.contents,
      targets: Array.from(automationPreview.contents.keys()),
    });
    await pruneEmptyParents(automationPreview.remove, toolPaths.automationDir);
  }

  if (toolPaths.toolHome && globalDocsPreview) {
    await ensureDir(toolPaths.toolHome);
    await applyRenderedRemoves(globalDocsPreview.remove);
    await applyRenderedWrites({
      contents: globalDocsPreview.contents,
      targets: Array.from(globalDocsPreview.contents.keys()),
    });
  }

  if (toolPaths.rulesDir && rulesPreview?.managedRulesDir) {
    await ensureEmptyDir(toolPaths.rulesDir);
    await applyRenderedRemoves(rulesPreview.remove);
    await applyRenderedWrites({
      contents: rulesPreview.contents,
      targets: Array.from(rulesPreview.contents.keys()),
    });
  }

  if (toolPaths.toolConfig && toolConfigPreview?.managedConfig) {
    await applyRenderedWrites({
      contents: new Map(
        toolConfigPreview.contents != null
          ? [[toolConfigPreview.targetPath, toolConfigPreview.contents]]
          : []
      ),
      targets:
        toolConfigPreview.managedConfig && toolConfigPreview.contents != null
          ? [toolConfigPreview.targetPath]
          : [],
    });
  }

  if (
    pluginPreview &&
    toolPaths.pluginsDir &&
    toolPaths.pluginMarketplacePath
  ) {
    await ensureDir(toolPaths.pluginsDir);
    await ensureDir(dirname(toolPaths.pluginMarketplacePath));
    await applyRenderedRemoves(pluginPreview.remove);
    await applyRenderedWrites({
      contents: pluginPreview.contents,
      targets: Array.from(pluginPreview.contents.keys()),
    });
    await pruneEmptyParents(pluginPreview.remove, toolPaths.pluginsDir);
  }

  state.tools[tool] = {
    tool,
    managedAt: nowIso(opts.now),
    skillsDir: toolPaths.skillsDir,
    mcpConfig: toolPaths.mcpConfig,
    agentsDir: toolPaths.agentsDir,
    pluginsDir:
      pluginPreview?.contents.size && toolPaths.pluginsDir
        ? toolPaths.pluginsDir
        : undefined,
    pluginMarketplacePath:
      toolPaths.pluginMarketplacePath &&
      pluginPreview?.contents.has(toolPaths.pluginMarketplacePath)
        ? toolPaths.pluginMarketplacePath
        : undefined,
    automationDir: toolPaths.automationDir,
    toolHome: globalDocsPreview?.managedTargets.length
      ? toolPaths.toolHome
      : undefined,
    globalAgentsPath:
      globalDocTargets &&
      globalDocsPreview?.managedTargets.includes(globalDocTargets.primary)
        ? globalDocTargets.primary
        : undefined,
    globalAgentsOverridePath:
      globalDocTargets?.override &&
      globalDocsPreview?.managedTargets.includes(globalDocTargets.override)
        ? globalDocTargets.override
        : undefined,
    rulesDir: rulesPreview?.managedRulesDir ? toolPaths.rulesDir : undefined,
    toolConfig: toolConfigPreview?.managedConfig
      ? toolPaths.toolConfig
      : undefined,
    skillsBackup,
    mcpBackup,
    agentsBackup,
    pluginsBackup,
    pluginMarketplaceBackup,
    globalAgentsBackup,
    globalAgentsOverrideBackup,
    rulesBackup,
    toolConfigBackup,
    renderedTargets: {},
  };

  const managedEntry = state.tools[tool]!;
  if (agentPreview) {
    updateRenderedTargetState({
      entry: managedEntry,
      writtenTargets: Array.from(agentPreview.contents.keys()),
      removedTargets: agentPreview.remove,
      contents: agentPreview.contents,
      sources: agentPreview.sources,
    });
  }
  if (automationPreview) {
    updateRenderedTargetState({
      entry: managedEntry,
      writtenTargets: Array.from(automationPreview.contents.keys()),
      removedTargets: automationPreview.remove,
      contents: automationPreview.contents,
      sources: automationPreview.sources,
    });
  }
  if (globalDocsPreview) {
    updateRenderedTargetState({
      entry: managedEntry,
      writtenTargets: Array.from(globalDocsPreview.contents.keys()),
      removedTargets: globalDocsPreview.remove,
      contents: globalDocsPreview.contents,
      sources: globalDocsPreview.sources,
    });
  }
  if (rulesPreview) {
    updateRenderedTargetState({
      entry: managedEntry,
      writtenTargets: Array.from(rulesPreview.contents.keys()),
      removedTargets: rulesPreview.remove,
      contents: rulesPreview.contents,
      sources: rulesPreview.sources,
    });
  }
  if (toolConfigPreview?.managedConfig && toolConfigPreview.contents != null) {
    updateRenderedTargetState({
      entry: managedEntry,
      writtenTargets:
        toolConfigPreview.managedConfig && toolConfigPreview.contents != null
          ? [toolConfigPreview.targetPath]
          : [],
      removedTargets: toolConfigPreview.remove
        ? [toolConfigPreview.targetPath]
        : [],
      contents: new Map([
        [toolConfigPreview.targetPath, toolConfigPreview.contents],
      ]),
      sources: new Map(
        toolConfigPreview.sourcePath
          ? [[toolConfigPreview.targetPath, toolConfigPreview.sourcePath]]
          : []
      ),
    });
  }

  if (pluginPreview) {
    updateRenderedTargetState({
      entry: managedEntry,
      writtenTargets: Array.from(pluginPreview.contents.keys()),
      removedTargets: pluginPreview.remove,
      contents: pluginPreview.contents,
      sources: pluginPreview.sources,
      normalizeText: false,
    });
  }

  await saveManagedState(state, home, rootDir);

  for (const name of adoptedSkills) {
    console.log(
      `${tool}: adopted existing content ${name} into canonical store`
    );
  }
}

async function restoreBackup({
  original,
  backup,
}: {
  original: string;
  backup: string | null | undefined;
}) {
  await rm(original, { recursive: true, force: true });
  if (backup && (await fileExists(backup))) {
    await rename(backup, original);
  }
}

async function removeSymlinks(skillsDir: string) {
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(skillsDir, entry.name);
      try {
        const st = await lstat(full);
        if (st.isSymbolicLink()) {
          await rm(full, { force: true });
        } else if (entry.isDirectory()) {
          await rm(full, { recursive: true, force: true });
        } else {
          await rm(full, { force: true });
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

export async function unmanageTool(tool: string, opts: ManageOptions = {}) {
  const home = opts.homeDir ?? homedir();
  const rootDir = opts.rootDir ?? facultRootDir(home);
  const state = await loadManagedState(home, rootDir);
  const entry = state.tools[tool];
  if (!entry) {
    throw new Error(`${tool} is not managed`);
  }

  if (entry.skillsDir) {
    await removeSymlinks(entry.skillsDir);
    await restoreBackup({
      original: entry.skillsDir,
      backup: entry.skillsBackup ?? null,
    });
  }

  if (entry.mcpConfig) {
    await restoreBackup({
      original: entry.mcpConfig,
      backup: entry.mcpBackup ?? null,
    });
  }

  if (entry.agentsDir) {
    await restoreBackup({
      original: entry.agentsDir,
      backup: entry.agentsBackup ?? null,
    });
  }

  if (entry.pluginsDir) {
    await restoreBackup({
      original: entry.pluginsDir,
      backup: entry.pluginsBackup ?? null,
    });
  }

  if (entry.pluginMarketplacePath) {
    await restoreBackup({
      original: entry.pluginMarketplacePath,
      backup: entry.pluginMarketplaceBackup ?? null,
    });
  }

  if (entry.automationDir) {
    const automationTargets = Object.keys(entry.renderedTargets ?? {}).filter(
      (targetPath) => targetPath.startsWith(join(entry.automationDir!, ""))
    );
    await applyRenderedRemoves(automationTargets);
    await pruneEmptyParents(automationTargets, entry.automationDir);
  }

  if (entry.globalAgentsPath) {
    await restoreBackup({
      original: entry.globalAgentsPath,
      backup: entry.globalAgentsBackup ?? null,
    });
  }

  if (entry.globalAgentsOverridePath) {
    await restoreBackup({
      original: entry.globalAgentsOverridePath,
      backup: entry.globalAgentsOverrideBackup ?? null,
    });
  }

  if (entry.rulesDir) {
    await restoreBackup({
      original: entry.rulesDir,
      backup: entry.rulesBackup ?? null,
    });
  }

  if (entry.toolConfig) {
    await restoreBackup({
      original: entry.toolConfig,
      backup: entry.toolConfigBackup ?? null,
    });
  }

  const nextTools: ManagedState["tools"] = {};
  for (const [name, config] of Object.entries(state.tools)) {
    if (name === tool) {
      continue;
    }
    nextTools[name] = config;
  }
  state.tools = nextTools;
  await saveManagedState(state, home, rootDir);
}

export async function listManagedTools(
  opts: { homeDir?: string; rootDir?: string } = {}
): Promise<string[]> {
  const home = opts.homeDir ?? homedir();
  const rootDir = opts.rootDir ?? facultRootDir(home);
  const state = await loadManagedState(home, rootDir);
  return Object.keys(state.tools).sort();
}

async function canonicalAgentsExist(rootDir: string): Promise<boolean> {
  try {
    const agents = await loadCanonicalAgents(rootDir);
    return agents.length > 0;
  } catch {
    return false;
  }
}

async function repairManagedToolEntry(args: {
  homeDir: string;
  rootDir: string;
  tool: string;
  entry: ManagedToolState;
}): Promise<{ entry: ManagedToolState; changed: boolean }> {
  const { homeDir, rootDir, tool } = args;
  const toolPaths = await resolveToolPaths(tool, homeDir, rootDir);
  if (!toolPaths) {
    return { entry: args.entry, changed: false };
  }

  const next: ManagedToolState = { ...args.entry };
  let changed = false;

  if (
    tool === "codex" &&
    toolPaths.skillsDir &&
    (await canonicalSkillsExist(rootDir)) &&
    next.skillsDir !== toolPaths.skillsDir
  ) {
    next.skillsBackup = await backupPath(toolPaths.skillsDir);
    next.skillsDir = toolPaths.skillsDir;
    changed = true;
  }

  if (
    !next.agentsDir &&
    toolPaths.agentsDir &&
    (await canonicalAgentsExist(rootDir))
  ) {
    next.agentsBackup = await backupPath(toolPaths.agentsDir);
    next.agentsDir = toolPaths.agentsDir;
    changed = true;
  }

  if (
    !next.automationDir &&
    toolPaths.automationDir &&
    (await canonicalAutomationsExist(rootDir))
  ) {
    next.automationDir = toolPaths.automationDir;
    changed = true;
  }

  if (
    tool === "codex" &&
    !(next.pluginsDir && next.pluginMarketplacePath) &&
    toolPaths.pluginsDir &&
    toolPaths.pluginMarketplacePath &&
    (await canonicalCodexPluginsExist(rootDir))
  ) {
    if (!next.pluginsDir) {
      next.pluginsBackup = await backupPath(toolPaths.pluginsDir);
      next.pluginsDir = toolPaths.pluginsDir;
      changed = true;
    }
    if (!next.pluginMarketplacePath) {
      next.pluginMarketplaceBackup = await backupPath(
        toolPaths.pluginMarketplacePath
      );
      next.pluginMarketplacePath = toolPaths.pluginMarketplacePath;
      changed = true;
    }
  }

  if (
    tool === "codex" &&
    !toolPaths.pluginsDir &&
    !toolPaths.pluginMarketplacePath &&
    (next.pluginsDir ||
      next.pluginMarketplacePath ||
      next.pluginsBackup ||
      next.pluginMarketplaceBackup)
  ) {
    next.pluginsDir = undefined;
    next.pluginMarketplacePath = undefined;
    next.pluginsBackup = undefined;
    next.pluginMarketplaceBackup = undefined;
    changed = true;
  }

  if (toolPaths.toolHome && !next.toolHome) {
    const preview = await syncToolGlobalDocs({
      homeDir,
      rootDir,
      tool,
      toolHome: toolPaths.toolHome,
      dryRun: true,
    });
    if (preview.managedTargets.length > 0) {
      next.toolHome = toolPaths.toolHome;
      const targets = globalDocTargetPaths(tool, toolPaths.toolHome);
      const agentsPath = targets.primary;
      const overridePath = targets.override;
      if (
        preview.managedTargets.includes(agentsPath) &&
        !next.globalAgentsPath
      ) {
        next.globalAgentsBackup = await backupPath(agentsPath);
        next.globalAgentsPath = agentsPath;
        changed = true;
      }
      if (
        overridePath &&
        preview.managedTargets.includes(overridePath) &&
        !next.globalAgentsOverridePath
      ) {
        next.globalAgentsOverrideBackup = await backupPath(overridePath);
        next.globalAgentsOverridePath = overridePath;
        changed = true;
      }
    }
  }

  if (!next.rulesDir && toolPaths.rulesDir) {
    const preview = await syncToolRules({
      homeDir,
      rootDir,
      tool,
      rulesDir: toolPaths.rulesDir,
      dryRun: true,
    });
    if (preview.managedRulesDir) {
      next.rulesBackup = await backupPath(toolPaths.rulesDir);
      next.rulesDir = toolPaths.rulesDir;
      changed = true;
    }
  }

  if (!next.toolConfig && toolPaths.toolConfig) {
    const preview = await syncToolConfig({
      homeDir,
      rootDir,
      tool,
      toolConfigPath: toolPaths.toolConfig,
      dryRun: true,
    });
    if (preview.managedConfig) {
      next.toolConfigBackup = await backupPath(toolPaths.toolConfig);
      next.toolConfig = toolPaths.toolConfig;
      changed = true;
    }
  }

  return { entry: next, changed };
}

interface RenderedConflict {
  targetPath: string;
  sourcePath: string;
  sourceKind: ManagedRenderedTargetState["sourceKind"];
  reason: "modified" | "unknown_state";
}

interface RenderedApplyPlan {
  write: string[];
  remove: string[];
  conflicts: RenderedConflict[];
}

async function planRenderedTargetConflicts(args: {
  entry: ManagedToolState;
  desiredWrites: string[];
  desiredRemoves: string[];
  desiredContents: Map<string, ManagedTargetContent>;
  desiredSources: Map<string, string>;
  conflictMode?: "warn" | "overwrite";
  protectAllSources?: boolean;
  normalizeText?: boolean;
}): Promise<RenderedApplyPlan> {
  if (args.conflictMode === "overwrite") {
    return {
      write: args.desiredWrites,
      remove: args.desiredRemoves,
      conflicts: [],
    };
  }

  const previous = args.entry.renderedTargets ?? {};
  const write: string[] = [];
  const remove: string[] = [];
  const conflicts: RenderedConflict[] = [];
  const allTargets = new Set([...args.desiredWrites, ...args.desiredRemoves]);

  for (const targetPath of allTargets) {
    const sourcePath =
      args.desiredSources.get(targetPath) ?? previous[targetPath]?.sourcePath;
    if (!sourcePath) {
      if (args.desiredWrites.includes(targetPath)) {
        write.push(targetPath);
      } else {
        remove.push(targetPath);
      }
      continue;
    }
    const sourceKind = renderedSourceKindForPath(sourcePath);
    if (sourceKind !== "builtin" && !args.protectAllSources) {
      if (args.desiredWrites.includes(targetPath)) {
        write.push(targetPath);
      } else {
        remove.push(targetPath);
      }
      continue;
    }

    const prior = previous[targetPath];
    const currentHash = await readTargetHash(targetPath, {
      normalizeText: args.normalizeText,
    });
    if (currentHash == null) {
      if (args.desiredWrites.includes(targetPath)) {
        write.push(targetPath);
      }
      continue;
    }
    const desiredHash = args.desiredContents.get(targetPath)
      ? targetContentHash(args.desiredContents.get(targetPath)!, {
          normalizeText: args.normalizeText,
        })
      : null;
    if (prior?.hash) {
      if (
        currentHash === prior.hash ||
        (args.desiredWrites.includes(targetPath) &&
          desiredHash != null &&
          currentHash === desiredHash)
      ) {
        if (args.desiredWrites.includes(targetPath)) {
          write.push(targetPath);
        } else {
          remove.push(targetPath);
        }
        continue;
      }
      conflicts.push({
        targetPath,
        sourcePath,
        sourceKind,
        reason: "modified",
      });
      continue;
    }

    if (
      args.desiredWrites.includes(targetPath) &&
      desiredHash != null &&
      currentHash === desiredHash
    ) {
      write.push(targetPath);
      continue;
    }

    conflicts.push({
      targetPath,
      sourcePath,
      sourceKind,
      reason: "unknown_state",
    });
  }

  return {
    write: write.sort(),
    remove: remove.sort(),
    conflicts,
  };
}

function logRenderedConflicts(
  tool: string,
  conflicts: RenderedConflict[],
  dryRun?: boolean
) {
  for (const conflict of conflicts) {
    const verb = dryRun ? "would skip" : "skipped";
    const state =
      conflict.reason === "unknown_state"
        ? "no prior managed hash is recorded"
        : "local edits were detected";
    const surface =
      conflict.sourceKind === "builtin"
        ? "builtin-backed target"
        : "managed target";
    console.warn(
      conflict.sourceKind === "builtin"
        ? `${tool}: ${verb} ${surface} ${conflict.targetPath} because ${state}. Rerun with "--builtin-conflicts overwrite" to replace it with the latest packaged default.`
        : `${tool}: ${verb} ${surface} ${conflict.targetPath} because ${state}.`
    );
  }
}

async function applyRenderedWrites(args: {
  contents: Map<string, ManagedTargetContent>;
  targets: string[];
}) {
  for (const pathValue of args.targets) {
    const desired = args.contents.get(pathValue);
    if (desired == null) {
      continue;
    }
    await mkdir(dirname(pathValue), { recursive: true });
    await Bun.write(
      pathValue,
      typeof desired === "string" && !desired.endsWith("\n")
        ? `${desired}\n`
        : desired
    );
  }
}

async function applyRenderedRemoves(targets: string[]) {
  for (const pathValue of targets) {
    await rm(pathValue, { force: true });
  }
}

async function pruneEmptyParents(targets: string[], stopDir: string) {
  const candidateDirs = Array.from(
    new Set(targets.map((pathValue) => dirname(pathValue)))
  ).sort((a, b) => b.length - a.length);

  for (const startDir of candidateDirs) {
    let currentDir = startDir;
    while (currentDir.startsWith(join(stopDir, "")) && currentDir !== stopDir) {
      const entries = await readdir(currentDir).catch(() => null);
      if (!(entries && entries.length === 0)) {
        break;
      }
      await rm(currentDir, { recursive: true, force: true });
      currentDir = dirname(currentDir);
    }
  }
}

function updateRenderedTargetState(args: {
  entry: ManagedToolState;
  writtenTargets: string[];
  removedTargets: string[];
  contents: Map<string, ManagedTargetContent>;
  sources: Map<string, string>;
  normalizeText?: boolean;
}) {
  const next = { ...(args.entry.renderedTargets ?? {}) };
  for (const pathValue of args.removedTargets) {
    delete next[pathValue];
  }
  for (const pathValue of args.writtenTargets) {
    const contents = args.contents.get(pathValue);
    const sourcePath = args.sources.get(pathValue);
    if (!(contents && sourcePath)) {
      continue;
    }
    next[pathValue] = {
      hash: targetContentHash(contents, {
        normalizeText: args.normalizeText,
      }),
      sourcePath,
      sourceKind: renderedSourceKindForPath(sourcePath),
    };
  }
  args.entry.renderedTargets = next;
}

function pruneAutomationRuntimeRenderedTargets(args: {
  entry: ManagedToolState;
  automationDir?: string;
}) {
  if (!(args.automationDir && args.entry.renderedTargets)) {
    return;
  }
  const prefix = join(args.automationDir, "");
  const next = { ...args.entry.renderedTargets };
  let changed = false;
  for (const targetPath of Object.keys(next)) {
    if (
      targetPath.startsWith(prefix) &&
      isAutomationRuntimeTargetPath(targetPath)
    ) {
      delete next[targetPath];
      changed = true;
    }
  }
  if (changed) {
    args.entry.renderedTargets = next;
  }
}

function logSyncDryRun({
  tool,
  entry,
  skillPlan,
  mcpPlan,
  agentPlan,
  agentConflicts,
  automationPlan,
  automationConflicts,
  globalDocsPlan,
  globalDocsConflicts,
  rulesPlan,
  rulesConflicts,
  configPlan,
  configConflicts,
  pluginPlan,
  pluginConflicts,
}: {
  tool: string;
  entry: ManagedToolState;
  skillPlan: { add: string[]; remove: string[] };
  mcpPlan: { needsWrite: boolean };
  agentPlan: { add: string[]; remove: string[] };
  agentConflicts: RenderedConflict[];
  automationPlan: { write: string[]; remove: string[] };
  automationConflicts: RenderedConflict[];
  globalDocsPlan: { write: string[]; remove: string[] };
  globalDocsConflicts: RenderedConflict[];
  rulesPlan: { write: string[]; remove: string[] };
  rulesConflicts: RenderedConflict[];
  configPlan: { write: boolean; remove: boolean; targetPath: string };
  configConflicts: RenderedConflict[];
  pluginPlan: { write: string[]; remove: string[] };
  pluginConflicts: RenderedConflict[];
}) {
  for (const name of skillPlan.add) {
    console.log(`${tool}: would add skill ${name}`);
  }
  for (const name of skillPlan.remove) {
    console.log(`${tool}: would remove skill ${name}`);
  }
  for (const p of agentPlan.add) {
    console.log(`${tool}: would write agent ${p}`);
  }
  for (const p of agentPlan.remove) {
    console.log(`${tool}: would remove agent ${p}`);
  }
  logRenderedConflicts(tool, agentConflicts, true);
  for (const p of automationPlan.write) {
    console.log(`${tool}: would write automation ${p}`);
  }
  for (const p of automationPlan.remove) {
    console.log(`${tool}: would remove automation ${p}`);
  }
  logRenderedConflicts(tool, automationConflicts, true);
  for (const p of globalDocsPlan.write) {
    console.log(`${tool}: would write global doc ${p}`);
  }
  for (const p of globalDocsPlan.remove) {
    console.log(`${tool}: would remove global doc ${p}`);
  }
  logRenderedConflicts(tool, globalDocsConflicts, true);
  for (const p of rulesPlan.write) {
    console.log(`${tool}: would write rule ${p}`);
  }
  for (const p of rulesPlan.remove) {
    console.log(`${tool}: would remove rule ${p}`);
  }
  logRenderedConflicts(tool, rulesConflicts, true);
  if (configPlan.write) {
    console.log(`${tool}: would write tool config ${configPlan.targetPath}`);
  }
  if (configPlan.remove) {
    console.log(`${tool}: would remove tool config ${configPlan.targetPath}`);
  }
  logRenderedConflicts(tool, configConflicts, true);
  for (const p of pluginPlan.write) {
    console.log(`${tool}: would write plugin asset ${p}`);
  }
  for (const p of pluginPlan.remove) {
    console.log(`${tool}: would remove plugin asset ${p}`);
  }
  logRenderedConflicts(tool, pluginConflicts, true);
  if (mcpPlan.needsWrite && entry.mcpConfig) {
    console.log(`${tool}: would update mcp config ${entry.mcpConfig}`);
  }
  if (
    skillPlan.add.length === 0 &&
    skillPlan.remove.length === 0 &&
    agentPlan.add.length === 0 &&
    agentPlan.remove.length === 0 &&
    automationPlan.write.length === 0 &&
    automationPlan.remove.length === 0 &&
    globalDocsPlan.write.length === 0 &&
    globalDocsPlan.remove.length === 0 &&
    rulesPlan.write.length === 0 &&
    rulesPlan.remove.length === 0 &&
    !configPlan.write &&
    !configPlan.remove &&
    pluginPlan.write.length === 0 &&
    pluginPlan.remove.length === 0 &&
    !mcpPlan.needsWrite &&
    agentConflicts.length === 0 &&
    automationConflicts.length === 0 &&
    globalDocsConflicts.length === 0 &&
    rulesConflicts.length === 0 &&
    configConflicts.length === 0 &&
    pluginConflicts.length === 0
  ) {
    console.log(`${tool}: no changes`);
  }
}

async function repairManagedCanonicalContent(args: {
  homeDir: string;
  rootDir: string;
  tool: string;
  entry: ManagedToolState;
}): Promise<string[]> {
  const adopted: string[] = [];

  for (const name of await adoptSkillsIntoCanonicalStore({
    homeDir: args.homeDir,
    rootDir: args.rootDir,
    skillSourceDirs: [
      args.entry.skillsBackup ?? "",
      args.entry.skillsDir ?? "",
    ],
  })) {
    adopted.push(name);
  }

  if (args.entry.agentsBackup) {
    const items = await adoptExistingToolAgents({
      tool: args.entry.tool,
      rootDir: args.rootDir,
      agentsDir: args.entry.agentsBackup,
      conflictMode: "keep-canonical",
    });
    adopted.push(...items.map((item) => `agent:${item.name}`));
  }

  if (args.entry.globalAgentsBackup) {
    const items = await adoptExistingGlobalDocFile({
      sourcePath: args.entry.globalAgentsBackup,
      canonicalPath: join(args.rootDir, "AGENTS.global.md"),
      name: "AGENTS.md",
      conflictMode: "keep-canonical",
    });
    adopted.push(...items.map((item) => `${item.kind}:${item.name}`));
  }

  if (args.entry.globalAgentsOverrideBackup) {
    const items = await adoptExistingGlobalDocFile({
      sourcePath: args.entry.globalAgentsOverrideBackup,
      canonicalPath: join(args.rootDir, "AGENTS.override.global.md"),
      name: "AGENTS.override.md",
      conflictMode: "keep-canonical",
    });
    adopted.push(...items.map((item) => `${item.kind}:${item.name}`));
  }

  if (args.entry.rulesBackup) {
    const items = await adoptExistingRules({
      rootDir: args.rootDir,
      tool: args.tool,
      rulesDir: args.entry.rulesBackup,
      conflictMode: "keep-canonical",
    });
    adopted.push(...items.map((item) => `${item.kind}:${item.name}`));
  }

  if (args.entry.toolConfigBackup) {
    const items = await adoptExistingToolConfig({
      rootDir: args.rootDir,
      tool: args.tool,
      toolConfigPath: args.entry.toolConfigBackup,
      conflictMode: "keep-canonical",
    });
    adopted.push(...items.map((item) => `${item.kind}:${item.name}`));
  }

  if (args.entry.mcpBackup) {
    const items = await adoptExistingMcpServers({
      rootDir: args.rootDir,
      tool: args.tool,
      mcpConfigPath: args.entry.mcpBackup,
      conflictMode: "keep-canonical",
    });
    adopted.push(...items.map((item) => `${item.kind}:${item.name}`));
  }

  if (
    args.tool === "codex" &&
    (args.entry.pluginsBackup ||
      args.entry.pluginsDir ||
      args.entry.pluginMarketplaceBackup ||
      args.entry.pluginMarketplacePath)
  ) {
    const items = await adoptExistingCodexPlugins({
      homeDir: args.homeDir,
      rootDir: args.rootDir,
      pluginsDir: args.entry.pluginsBackup ?? args.entry.pluginsDir,
      pluginMarketplacePath:
        args.entry.pluginMarketplaceBackup ?? args.entry.pluginMarketplacePath,
      conflictMode: "keep-canonical",
    });
    adopted.push(...items.map((item) => `${item.kind}:${item.name}`));
  }

  if (adopted.length > 0) {
    await buildIndex({
      homeDir: args.homeDir,
      rootDir: args.rootDir,
      force: false,
    });
  }

  return adopted;
}

async function discoverExistingCodexPluginEntries(args: {
  homeDir: string;
  rootDir: string;
  pluginMarketplacePath?: string;
  pluginsDir?: string;
}): Promise<
  {
    name: string;
    livePath: string;
    sourcePath: string;
  }[]
> {
  const results = new Map<
    string,
    { name: string; livePath: string; sourcePath: string }
  >();
  const liveRoot = codexLiveRoot(args.homeDir, args.rootDir);
  const marketplaceRaw = args.pluginMarketplacePath
    ? await readTextOrNull(args.pluginMarketplacePath)
    : null;
  if (marketplaceRaw) {
    try {
      const parsed = JSON.parse(marketplaceRaw) as unknown;
      const plugins =
        isPlainObject(parsed) && Array.isArray(parsed.plugins)
          ? parsed.plugins
          : [];
      for (const entry of plugins) {
        if (!isPlainObject(entry) || typeof entry.name !== "string") {
          continue;
        }
        const source = isPlainObject(entry.source) ? entry.source : null;
        if (!(source?.source === "local" && typeof source.path === "string")) {
          continue;
        }
        const pathValue = source.path.trim();
        if (
          !(
            pathValue === `./plugins/${entry.name}` ||
            pathValue === `./.codex/plugins/${entry.name}`
          )
        ) {
          continue;
        }
        const livePath = join(liveRoot, pathValue.slice(2));
        if (
          !(await fileExists(join(livePath, ".codex-plugin", "plugin.json")))
        ) {
          continue;
        }
        results.set(entry.name, {
          name: entry.name,
          livePath,
          sourcePath: pathValue,
        });
      }
    } catch {
      // Ignore malformed marketplace files during adoption planning.
    }
  }

  for (const candidateRoot of [
    args.pluginsDir,
    codexLegacyPluginsDir(args.homeDir, args.rootDir),
  ]) {
    if (!(candidateRoot && (await fileExists(candidateRoot)))) {
      continue;
    }
    const entries = await readdir(candidateRoot, { withFileTypes: true }).catch(
      () => [] as import("node:fs").Dirent[]
    );
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      const livePath = join(candidateRoot, entry.name);
      if (!(await fileExists(join(livePath, ".codex-plugin", "plugin.json")))) {
        continue;
      }
      if (results.has(entry.name)) {
        continue;
      }
      const relativePrefix =
        candidateRoot === args.pluginsDir ? "./plugins/" : "./.codex/plugins/";
      results.set(entry.name, {
        name: entry.name,
        livePath,
        sourcePath: `${relativePrefix}${entry.name}`,
      });
    }
  }

  return Array.from(results.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

async function planExistingCodexPluginAdoption(args: {
  homeDir: string;
  rootDir: string;
  pluginMarketplacePath?: string;
  pluginsDir?: string;
}): Promise<ExistingManagedImportPlan> {
  const plan = emptyManagedImportPlan();
  const canonicalMarketplacePath = codexCanonicalPluginMarketplacePath(
    args.rootDir
  );
  const marketplaceRaw = args.pluginMarketplacePath
    ? await readTextOrNull(args.pluginMarketplacePath)
    : null;
  if (marketplaceRaw != null) {
    const normalizedLive = normalizeCodexMarketplaceText(marketplaceRaw);
    const canonicalRaw = await readTextOrNull(canonicalMarketplacePath);
    const item: ExistingManagedItem = {
      kind: "plugin-marketplace",
      name: "codex/plugins/marketplace.json",
      livePath: args.pluginMarketplacePath!,
      canonicalPath: canonicalMarketplacePath,
    };
    if (canonicalRaw == null) {
      plan.adopt.push(item);
    } else if (normalizeCodexMarketplaceText(canonicalRaw) === normalizedLive) {
      plan.identical.push(item);
    } else {
      plan.conflicts.push(item);
    }
  }

  for (const plugin of await discoverExistingCodexPluginEntries(args)) {
    const canonicalPath = join(
      codexCanonicalPluginsRoot(args.rootDir),
      plugin.name
    );
    const canonicalHash = await hashDirectoryTree(canonicalPath);
    const liveHash = await hashDirectoryTree(plugin.livePath);
    const item: ExistingManagedItem = {
      kind: "plugin",
      name: plugin.name,
      livePath: plugin.livePath,
      canonicalPath,
    };
    if (canonicalHash == null) {
      plan.adopt.push(item);
    } else if (canonicalHash === liveHash) {
      plan.identical.push(item);
    } else {
      plan.conflicts.push(item);
    }
  }

  return mergeManagedImportPlans(plan);
}

async function adoptExistingCodexPlugins(args: {
  homeDir: string;
  rootDir: string;
  pluginMarketplacePath?: string;
  pluginsDir?: string;
  conflictMode: "keep-canonical" | "keep-existing";
}): Promise<ExistingManagedItem[]> {
  const adopted: ExistingManagedItem[] = [];
  const canonicalMarketplacePath = codexCanonicalPluginMarketplacePath(
    args.rootDir
  );
  const marketplaceRaw = args.pluginMarketplacePath
    ? await readTextOrNull(args.pluginMarketplacePath)
    : null;
  if (marketplaceRaw != null) {
    const normalizedLive = normalizeCodexMarketplaceText(marketplaceRaw);
    const canonicalRaw = await readTextOrNull(canonicalMarketplacePath);
    if (canonicalRaw == null || args.conflictMode === "keep-existing") {
      await ensureDir(dirname(canonicalMarketplacePath));
      await Bun.write(canonicalMarketplacePath, normalizedLive);
      adopted.push({
        kind: "plugin-marketplace",
        name: "codex/plugins/marketplace.json",
        livePath: args.pluginMarketplacePath!,
        canonicalPath: canonicalMarketplacePath,
      });
    }
  }

  for (const plugin of await discoverExistingCodexPluginEntries(args)) {
    const canonicalPath = join(
      codexCanonicalPluginsRoot(args.rootDir),
      plugin.name
    );
    const canonicalHash = await hashDirectoryTree(canonicalPath);
    const liveHash = await hashDirectoryTree(plugin.livePath);
    if (
      canonicalHash != null &&
      canonicalHash !== liveHash &&
      args.conflictMode !== "keep-existing"
    ) {
      continue;
    }
    await ensureDir(dirname(canonicalPath));
    await rm(canonicalPath, { recursive: true, force: true });
    await cp(plugin.livePath, canonicalPath, { recursive: true });
    adopted.push({
      kind: "plugin",
      name: plugin.name,
      livePath: plugin.livePath,
      canonicalPath,
    });
  }

  return adopted;
}

async function planCodexPluginFileChanges(args: {
  rootDir: string;
  pluginsDir: string;
  pluginMarketplacePath: string;
  previouslyManagedTargets?: string[];
}): Promise<{
  add: string[];
  remove: string[];
  contents: Map<string, ManagedTargetContent>;
  sources: Map<string, string>;
}> {
  const contents = new Map<string, ManagedTargetContent>();
  const sources = new Map<string, string>();
  const desiredPaths = new Set<string>();

  const marketplace = await loadCanonicalCodexMarketplaceText(args.rootDir);
  if (marketplace.text != null) {
    desiredPaths.add(args.pluginMarketplacePath);
    contents.set(args.pluginMarketplacePath, marketplace.text);
    sources.set(args.pluginMarketplacePath, marketplace.sourcePath);
  }

  for (const plugin of await loadCanonicalCodexPlugins(args.rootDir)) {
    for (const [relPath, bytes] of plugin.files.entries()) {
      const targetPath = join(args.pluginsDir, plugin.name, relPath);
      desiredPaths.add(targetPath);
      contents.set(targetPath, bytes);
      sources.set(targetPath, join(plugin.sourceDir, relPath));
    }
  }

  const add = new Set<string>();
  for (const targetPath of desiredPaths) {
    const currentHash = await readTargetHash(targetPath, {
      normalizeText: false,
    });
    const desired = contents.get(targetPath);
    if (desired == null) {
      continue;
    }
    if (currentHash !== targetContentHash(desired, { normalizeText: false })) {
      add.add(targetPath);
    }
  }

  const remove = Array.from(
    new Set(
      (args.previouslyManagedTargets ?? []).filter((targetPath) => {
        const inManagedRoot =
          targetPath === args.pluginMarketplacePath ||
          targetPath.startsWith(join(args.pluginsDir, ""));
        return inManagedRoot && !desiredPaths.has(targetPath);
      })
    )
  ).sort();

  return {
    add: Array.from(add).sort(),
    remove,
    contents,
    sources,
  };
}

async function syncManagedToolEntry({
  homeDir,
  tool,
  entry,
  rootDir,
  dryRun,
  builtinConflictMode,
}: {
  homeDir: string;
  tool: string;
  entry: ManagedToolState;
  rootDir: string;
  dryRun?: boolean;
  builtinConflictMode?: "warn" | "overwrite";
}) {
  pruneAutomationRuntimeRenderedTargets({
    entry,
    automationDir: entry.automationDir,
  });

  const adoptedSkills = dryRun
    ? []
    : await repairManagedCanonicalContent({
        homeDir,
        rootDir,
        tool,
        entry,
      });

  const skillPlan = entry.skillsDir
    ? await syncSkillSymlinks({
        homeDir,
        toolSkillsDir: entry.skillsDir,
        rootDir,
        tool,
        dryRun,
      })
    : { add: [], remove: [] };

  const agentPlan = entry.agentsDir
    ? await planAgentFileChanges({
        agentsDir: entry.agentsDir,
        homeDir,
        rootDir,
        tool,
      })
    : { add: [], remove: [], contents: new Map(), sources: new Map() };
  const automationPlan = entry.automationDir
    ? await planAutomationFileChanges({
        automationDir: entry.automationDir,
        rootDir,
        previouslyManagedTargets: Object.keys(entry.renderedTargets ?? {}),
      })
    : { add: [], remove: [], contents: new Map(), sources: new Map() };

  const mcpPlan = entry.mcpConfig
    ? await syncMcpConfig({
        mcpConfigPath: entry.mcpConfig,
        rootDir,
        tool,
        dryRun,
      })
    : { needsWrite: false };

  const globalDocsPlan = entry.toolHome
    ? await planToolGlobalDocsSync({
        homeDir,
        rootDir,
        tool,
        toolHome: entry.toolHome,
        previouslyManagedTargets: [
          entry.globalAgentsPath,
          entry.globalAgentsOverridePath,
        ].filter((value): value is string => Boolean(value)),
      })
    : {
        write: [],
        remove: [],
        contents: new Map(),
        sources: new Map(),
        managedTargets: [],
      };

  const rulesPlan = entry.rulesDir
    ? await planToolRulesSync({
        homeDir,
        rootDir,
        tool,
        rulesDir: entry.rulesDir,
        previouslyManaged: true,
      })
    : {
        write: [],
        remove: [],
        contents: new Map(),
        sources: new Map(),
        managedRulesDir: false,
      };

  const configPlan = entry.toolConfig
    ? await planToolConfigSync({
        homeDir,
        rootDir,
        tool,
        toolConfigPath: entry.toolConfig,
        existingConfigPath: entry.toolConfigBackup ?? undefined,
        previouslyManaged: true,
      })
    : {
        write: false,
        remove: false,
        contents: null,
        sourcePath: undefined,
        managedConfig: false,
        targetPath: "",
      };
  const pluginPlan =
    tool === "codex" && entry.pluginsDir && entry.pluginMarketplacePath
      ? await planCodexPluginFileChanges({
          rootDir,
          pluginsDir: entry.pluginsDir,
          pluginMarketplacePath: entry.pluginMarketplacePath,
          previouslyManagedTargets: Object.keys(entry.renderedTargets ?? {}),
        })
      : { add: [], remove: [], contents: new Map(), sources: new Map() };

  const agentRendered = await planRenderedTargetConflicts({
    entry,
    desiredWrites: agentPlan.add,
    desiredRemoves: agentPlan.remove,
    desiredContents: agentPlan.contents,
    desiredSources: agentPlan.sources,
    conflictMode: builtinConflictMode,
  });
  const globalDocsRendered = await planRenderedTargetConflicts({
    entry,
    desiredWrites: globalDocsPlan.write,
    desiredRemoves: globalDocsPlan.remove,
    desiredContents: globalDocsPlan.contents,
    desiredSources: globalDocsPlan.sources,
    conflictMode: builtinConflictMode,
  });
  const automationRendered = await planRenderedTargetConflicts({
    entry,
    desiredWrites: automationPlan.add,
    desiredRemoves: automationPlan.remove,
    desiredContents: automationPlan.contents,
    desiredSources: automationPlan.sources,
    conflictMode: builtinConflictMode,
    protectAllSources: true,
  });
  const rulesRendered = await planRenderedTargetConflicts({
    entry,
    desiredWrites: rulesPlan.write,
    desiredRemoves: rulesPlan.remove,
    desiredContents: rulesPlan.contents,
    desiredSources: rulesPlan.sources,
    conflictMode: builtinConflictMode,
  });
  const configContents =
    configPlan.contents != null
      ? new Map([[configPlan.targetPath, configPlan.contents]])
      : new Map<string, string>();
  const configSources = new Map<string, string>(
    configPlan.sourcePath
      ? [[configPlan.targetPath, configPlan.sourcePath]]
      : []
  );
  const configRendered = await planRenderedTargetConflicts({
    entry,
    desiredWrites:
      configPlan.write && configPlan.targetPath ? [configPlan.targetPath] : [],
    desiredRemoves:
      configPlan.remove && configPlan.targetPath ? [configPlan.targetPath] : [],
    desiredContents: configContents,
    desiredSources: configSources,
    conflictMode: builtinConflictMode,
  });
  const pluginRendered = await planRenderedTargetConflicts({
    entry,
    desiredWrites: pluginPlan.add,
    desiredRemoves: pluginPlan.remove,
    desiredContents: pluginPlan.contents,
    desiredSources: pluginPlan.sources,
    conflictMode: builtinConflictMode,
    protectAllSources: true,
    normalizeText: false,
  });

  if (dryRun) {
    logSyncDryRun({
      tool,
      entry,
      skillPlan,
      mcpPlan,
      agentPlan: { add: agentRendered.write, remove: agentRendered.remove },
      agentConflicts: agentRendered.conflicts,
      automationPlan: {
        write: automationRendered.write,
        remove: automationRendered.remove,
      },
      automationConflicts: automationRendered.conflicts,
      globalDocsPlan: {
        write: globalDocsRendered.write,
        remove: globalDocsRendered.remove,
      },
      globalDocsConflicts: globalDocsRendered.conflicts,
      rulesPlan: { write: rulesRendered.write, remove: rulesRendered.remove },
      rulesConflicts: rulesRendered.conflicts,
      configPlan: {
        write: configRendered.write.length > 0,
        remove: configRendered.remove.length > 0,
        targetPath: configPlan.targetPath,
      },
      configConflicts: configRendered.conflicts,
      pluginPlan: {
        write: pluginRendered.write,
        remove: pluginRendered.remove,
      },
      pluginConflicts: pluginRendered.conflicts,
    });
  } else {
    await applyRenderedRemoves(agentRendered.remove);
    await applyRenderedWrites({
      contents: agentPlan.contents,
      targets: agentRendered.write,
    });
    await applyRenderedRemoves(automationRendered.remove);
    await applyRenderedWrites({
      contents: automationPlan.contents,
      targets: automationRendered.write,
    });
    if (entry.automationDir) {
      await pruneEmptyParents(automationRendered.remove, entry.automationDir);
    }
    await applyRenderedRemoves(globalDocsRendered.remove);
    await applyRenderedWrites({
      contents: globalDocsPlan.contents,
      targets: globalDocsRendered.write,
    });
    await applyRenderedRemoves(rulesRendered.remove);
    await applyRenderedWrites({
      contents: rulesPlan.contents,
      targets: rulesRendered.write,
    });
    await applyRenderedRemoves(configRendered.remove);
    await applyRenderedWrites({
      contents: configContents,
      targets: configRendered.write,
    });
    await applyRenderedRemoves(pluginRendered.remove);
    await applyRenderedWrites({
      contents: pluginPlan.contents,
      targets: pluginRendered.write,
    });
    if (entry.pluginsDir) {
      await pruneEmptyParents(pluginRendered.remove, entry.pluginsDir);
    }
    logRenderedConflicts(tool, agentRendered.conflicts);
    logRenderedConflicts(tool, automationRendered.conflicts);
    logRenderedConflicts(tool, globalDocsRendered.conflicts);
    logRenderedConflicts(tool, rulesRendered.conflicts);
    logRenderedConflicts(tool, configRendered.conflicts);
    logRenderedConflicts(tool, pluginRendered.conflicts);

    updateRenderedTargetState({
      entry,
      writtenTargets: agentRendered.write,
      removedTargets: agentRendered.remove,
      contents: agentPlan.contents,
      sources: agentPlan.sources,
    });
    updateRenderedTargetState({
      entry,
      writtenTargets: automationRendered.write,
      removedTargets: automationRendered.remove,
      contents: automationPlan.contents,
      sources: automationPlan.sources,
    });
    updateRenderedTargetState({
      entry,
      writtenTargets: globalDocsRendered.write,
      removedTargets: globalDocsRendered.remove,
      contents: globalDocsPlan.contents,
      sources: globalDocsPlan.sources,
    });
    updateRenderedTargetState({
      entry,
      writtenTargets: rulesRendered.write,
      removedTargets: rulesRendered.remove,
      contents: rulesPlan.contents,
      sources: rulesPlan.sources,
    });
    updateRenderedTargetState({
      entry,
      writtenTargets: configRendered.write,
      removedTargets: configRendered.remove,
      contents: configContents,
      sources: configSources,
    });
    updateRenderedTargetState({
      entry,
      writtenTargets: pluginRendered.write,
      removedTargets: pluginRendered.remove,
      contents: pluginPlan.contents,
      sources: pluginPlan.sources,
      normalizeText: false,
    });

    for (const name of adoptedSkills) {
      console.log(
        `${tool}: adopted existing content ${name} into canonical store`
      );
    }
    console.log(`${tool} synced`);
  }
}

export async function syncManagedTools(opts: SyncOptions = {}) {
  const home = opts.homeDir ?? homedir();
  const rootDir = opts.rootDir ?? facultRootDir(home);
  const state = await loadManagedState(home, rootDir);
  const tools = opts.tool ? [opts.tool] : Object.keys(state.tools).sort();

  if (!tools.length) {
    throw new Error("No managed tools to sync.");
  }

  if (!opts.dryRun) {
    let changed = false;
    for (const tool of tools) {
      const entry = state.tools[tool];
      if (!entry) {
        throw new Error(`${tool} is not managed`);
      }
      const repaired = await repairManagedToolEntry({
        homeDir: home,
        rootDir,
        tool,
        entry,
      });
      if (repaired.changed) {
        state.tools[tool] = repaired.entry;
        changed = true;
      }
    }
    if (changed) {
      await saveManagedState(state, home, rootDir);
    }
  }

  for (const tool of tools) {
    const entry = state.tools[tool];
    if (!entry) {
      throw new Error(`${tool} is not managed`);
    }
    await syncManagedToolEntry({
      homeDir: home,
      tool,
      entry,
      rootDir,
      dryRun: opts.dryRun,
      builtinConflictMode: opts.builtinConflictMode,
    });
  }

  if (!opts.dryRun) {
    await saveManagedState(state, home, rootDir);
  }
}

export async function manageCommand(argv: string[]) {
  const parsed = parseCliContextArgs(argv);
  const args = [...parsed.argv];
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    console.log(`fclt manage — enter managed mode for a tool (backup + symlinks + MCP generation)

Usage:
  fclt manage <tool> [--dry-run] [--adopt-existing] [--existing-conflicts keep-canonical|keep-existing] [--builtin-conflicts overwrite] [--root PATH|--global|--project]
`);
    return;
  }
  const dryRun = args.includes("--dry-run");
  const adoptExisting = args.includes("--adopt-existing");
  const conflictIndex = args.indexOf("--existing-conflicts");
  const builtinConflictIndex = args.indexOf("--builtin-conflicts");
  let existingConflictMode: "keep-canonical" | "keep-existing" | undefined;
  let builtinConflictMode: "warn" | "overwrite" | undefined;
  if (conflictIndex !== -1) {
    const value = args[conflictIndex + 1];
    if (value !== "keep-canonical" && value !== "keep-existing") {
      console.error(
        '--existing-conflicts requires "keep-canonical" or "keep-existing"'
      );
      process.exitCode = 1;
      return;
    }
    existingConflictMode = value;
  }
  if (builtinConflictIndex !== -1) {
    const value = args[builtinConflictIndex + 1];
    if (value !== "overwrite") {
      console.error('--builtin-conflicts currently supports only "overwrite"');
      process.exitCode = 1;
      return;
    }
    builtinConflictMode = value;
  }
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (!value) {
      continue;
    }
    if (value === "--existing-conflicts") {
      i += 1;
      continue;
    }
    if (value === "--builtin-conflicts") {
      i += 1;
      continue;
    }
    if (value.startsWith("--")) {
      continue;
    }
    positional.push(value);
  }
  const tool = positional[0];
  if (!tool) {
    console.error("manage requires a tool name");
    process.exitCode = 1;
    return;
  }
  try {
    await manageTool(tool, {
      rootDir: resolveCliContextRoot({
        rootArg: parsed.rootArg,
        scope: parsed.scope,
        cwd: process.cwd(),
      }),
      dryRun,
      adoptExisting,
      existingConflictMode,
      builtinConflictMode,
    });
    if (dryRun) {
      console.log(`${tool}: preflight complete`);
    } else {
      console.log(`${tool} is now managed`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function unmanageCommand(argv: string[]) {
  const parsed = parseCliContextArgs(argv);
  if (
    parsed.argv.includes("--help") ||
    parsed.argv.includes("-h") ||
    parsed.argv[0] === "help"
  ) {
    console.log(`fclt unmanage — exit managed mode for a tool (restore backups)

Usage:
  fclt unmanage <tool> [--root PATH|--global|--project]
`);
    return;
  }
  const tool = parsed.argv[0];
  if (!tool) {
    console.error("unmanage requires a tool name");
    process.exitCode = 1;
    return;
  }
  try {
    await unmanageTool(tool, {
      rootDir: resolveCliContextRoot({
        rootArg: parsed.rootArg,
        scope: parsed.scope,
        cwd: process.cwd(),
      }),
    });
    console.log(`${tool} is no longer managed`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function managedCommand(argv: string[] = []) {
  const parsed = parseCliContextArgs(argv);
  if (
    parsed.argv.includes("--help") ||
    parsed.argv.includes("-h") ||
    parsed.argv[0] === "help"
  ) {
    console.log(
      renderPage({
        title: "fclt managed",
        subtitle: "List tools currently in managed mode.",
        sections: [
          {
            title: "Usage",
            lines: renderBullets([
              renderCode("fclt managed [--root PATH|--global|--project]"),
            ]),
          },
        ],
      })
    );
    return;
  }
  const tools = await listManagedTools({
    rootDir: resolveCliContextRoot({
      rootArg: parsed.rootArg,
      scope: parsed.scope,
      cwd: process.cwd(),
    }),
  });
  if (!tools.length) {
    console.log(
      renderPage({
        title: "fclt managed",
        subtitle: "No managed tools.",
        sections: [],
      })
    );
    return;
  }
  console.log(
    renderPage({
      title: "fclt managed",
      subtitle: `${tools.length} managed tool${tools.length === 1 ? "" : "s"}`,
      sections: [
        {
          title: "Tools",
          lines: renderBullets(tools),
        },
      ],
    })
  );
}

export async function syncCommand(argv: string[]) {
  const parsed = parseCliContextArgs(argv);
  if (
    parsed.argv.includes("--help") ||
    parsed.argv.includes("-h") ||
    parsed.argv[0] === "help"
  ) {
    console.log(`fclt sync — sync managed tools with canonical state

Usage:
  fclt sync [tool] [--dry-run] [--builtin-conflicts overwrite] [--root PATH|--global|--project]

Options:
  --dry-run   Show what would change
  --builtin-conflicts overwrite   Replace locally modified builtin-backed rendered files
`);
    return;
  }
  const tool = parsed.argv.find((arg) => !arg.startsWith("-"));
  const dryRun = parsed.argv.includes("--dry-run");
  const builtinConflictIndex = parsed.argv.indexOf("--builtin-conflicts");
  let builtinConflictMode: "warn" | "overwrite" | undefined;
  if (builtinConflictIndex !== -1) {
    const value = parsed.argv[builtinConflictIndex + 1];
    if (value !== "overwrite") {
      console.error('--builtin-conflicts currently supports only "overwrite"');
      process.exitCode = 1;
      return;
    }
    builtinConflictMode = value;
  }
  try {
    await syncManagedTools({
      tool,
      dryRun,
      builtinConflictMode,
      rootDir: resolveCliContextRoot({
        rootArg: parsed.rootArg,
        scope: parsed.scope,
        cwd: process.cwd(),
      }),
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
