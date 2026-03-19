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
  facultGeneratedStateDir,
  facultRootDir,
  projectRootFromAiRoot,
} from "./paths";

export interface ManagedToolState {
  tool: string;
  managedAt: string;
  skillsDir?: string;
  mcpConfig?: string;
  agentsDir?: string;
  toolHome?: string;
  globalAgentsPath?: string;
  globalAgentsOverridePath?: string;
  rulesDir?: string;
  toolConfig?: string;
  skillsBackup?: string | null;
  mcpBackup?: string | null;
  agentsBackup?: string | null;
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
      skillsDir: toolBase(".codex", "skills"),
      mcpConfig: toolBase(".codex", "mcp.json"),
      agentsDir: toolBase(".codex", "agents"),
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
  return join(facultGeneratedStateDir({ home, rootDir }), "managed.json");
}

export async function loadManagedState(
  home: string = homedir(),
  rootDir?: string
): Promise<ManagedState> {
  const p = managedStatePathForRoot(home, rootDir);
  if (!(await fileExists(p))) {
    return { version: MANAGED_VERSION, tools: {} };
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
  return { version: MANAGED_VERSION, tools: {} };
}

export async function saveManagedState(
  state: ManagedState,
  home: string = homedir(),
  rootDir?: string
) {
  const dir = facultGeneratedStateDir({ home, rootDir });
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
  const useBuiltinDefaults = await builtinSyncDefaultsEnabled(args.rootDir);
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
  const useBuiltinDefaults = await builtinSyncDefaultsEnabled(args.rootDir);
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

  for (const agent of agents) {
    const target = homePath(agentsDir, `${agent.name}.toml`);
    const rendered = await renderCanonicalText(agent.raw, {
      homeDir,
      rootDir,
      projectRoot: projectRootFromAiRoot(rootDir, homeDir) ?? undefined,
      targetTool: tool,
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
    if (!(entry.isFile() && entry.name.endsWith(".toml"))) {
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

function extractServersObject(parsed: unknown): Record<string, unknown> | null {
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
  const serversPath = join(rootDir, "mcp", "servers.json");
  const mcpPath = join(rootDir, "mcp", "mcp.json");

  const preferred = (await fileExists(serversPath)) ? serversPath : mcpPath;
  if (!(await fileExists(preferred))) {
    return { servers: {}, sourcePath: null };
  }
  try {
    const txt = await Bun.file(preferred).text();
    const parsed = JSON.parse(txt) as unknown;
    const servers = extractServersObject(parsed) ?? {};
    return { servers, sourcePath: preferred };
  } catch {
    return { servers: {}, sourcePath: preferred };
  }
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
  rootDir: string;
  agentsDir: string;
}): Promise<ExistingManagedImportPlan> {
  const plan = emptyManagedImportPlan();
  const agents = await loadAgentsFromRoot(args.agentsDir);
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
  rootDir: string;
  agentsDir: string;
  conflictMode: "keep-canonical" | "keep-existing";
}): Promise<ExistingManagedItem[]> {
  const adopted: ExistingManagedItem[] = [];
  const agents = await loadAgentsFromRoot(args.agentsDir);
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

function normalizeCanonicalMcpServers(
  servers: Record<string, unknown>
): string {
  return JSON.stringify({ servers }, null, 2);
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
  await Bun.write(canonicalPath, `${normalizeCanonicalMcpServers(merged)}\n`);
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
  const { servers } = await loadCanonicalServers(rootDir);
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
  const { servers } = await loadCanonicalServers(rootDir);
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

  const existingSkillPlan = toolPaths.skillsDir
    ? await planExistingToolSkillAdoption({
        rootDir,
        toolSkillsDir: toolPaths.skillsDir,
      })
    : {
        adopt: [],
        identical: [],
        conflicts: [],
        ignored: [],
      };
  const existingImportPlan = mergeManagedImportPlans(
    asManagedSkillPlan(existingSkillPlan),
    toolPaths.agentsDir
      ? await planExistingToolAgentAdoption({
          rootDir,
          agentsDir: toolPaths.agentsDir,
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
      toolPaths.toolHome ||
      toolPaths.rulesDir ||
      toolPaths.toolConfig ||
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
      `Run "facult manage ${tool} --dry-run" to review the plan, then rerun with "--adopt-existing"`,
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
        skillSourceDirs: [toolPaths.skillsDir],
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
  if (toolPaths.agentsDir && opts.adoptExisting) {
    const result = await adoptExistingToolAgents({
      rootDir,
      agentsDir: toolPaths.agentsDir,
      conflictMode: importConflictMode,
    });
    adoptedSkills.push(...result.map((item) => item.name));
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

  state.tools[tool] = {
    tool,
    managedAt: nowIso(opts.now),
    skillsDir: toolPaths.skillsDir,
    mcpConfig: toolPaths.mcpConfig,
    agentsDir: toolPaths.agentsDir,
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
    !next.agentsDir &&
    toolPaths.agentsDir &&
    (await canonicalAgentsExist(rootDir))
  ) {
    next.agentsBackup = await backupPath(toolPaths.agentsDir);
    next.agentsDir = toolPaths.agentsDir;
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
  desiredContents: Map<string, string>;
  desiredSources: Map<string, string>;
  conflictMode?: "warn" | "overwrite";
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
    if (sourceKind !== "builtin") {
      if (args.desiredWrites.includes(targetPath)) {
        write.push(targetPath);
      } else {
        remove.push(targetPath);
      }
      continue;
    }

    const prior = previous[targetPath];
    const current = await readTextIfExists(targetPath);
    if (current == null) {
      if (args.desiredWrites.includes(targetPath)) {
        write.push(targetPath);
      }
      continue;
    }

    const currentHash = renderedHash(current);
    if (prior?.hash) {
      if (currentHash === prior.hash) {
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
    console.warn(
      `${tool}: ${verb} builtin-backed target ${conflict.targetPath} because ${state}. Rerun with "--builtin-conflicts overwrite" to replace it with the latest packaged default.`
    );
  }
}

async function applyRenderedWrites(args: {
  contents: Map<string, string>;
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
      desired.endsWith("\n") ? desired : `${desired}\n`
    );
  }
}

async function applyRenderedRemoves(targets: string[]) {
  for (const pathValue of targets) {
    await rm(pathValue, { force: true });
  }
}

function updateRenderedTargetState(args: {
  entry: ManagedToolState;
  writtenTargets: string[];
  removedTargets: string[];
  contents: Map<string, string>;
  sources: Map<string, string>;
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
      hash: renderedHash(contents),
      sourcePath,
      sourceKind: renderedSourceKindForPath(sourcePath),
    };
  }
  args.entry.renderedTargets = next;
}

function logSyncDryRun({
  tool,
  entry,
  skillPlan,
  mcpPlan,
  agentPlan,
  agentConflicts,
  globalDocsPlan,
  globalDocsConflicts,
  rulesPlan,
  rulesConflicts,
  configPlan,
  configConflicts,
}: {
  tool: string;
  entry: ManagedToolState;
  skillPlan: { add: string[]; remove: string[] };
  mcpPlan: { needsWrite: boolean };
  agentPlan: { add: string[]; remove: string[] };
  agentConflicts: RenderedConflict[];
  globalDocsPlan: { write: string[]; remove: string[] };
  globalDocsConflicts: RenderedConflict[];
  rulesPlan: { write: string[]; remove: string[] };
  rulesConflicts: RenderedConflict[];
  configPlan: { write: boolean; remove: boolean; targetPath: string };
  configConflicts: RenderedConflict[];
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
  if (mcpPlan.needsWrite && entry.mcpConfig) {
    console.log(`${tool}: would update mcp config ${entry.mcpConfig}`);
  }
  if (
    skillPlan.add.length === 0 &&
    skillPlan.remove.length === 0 &&
    agentPlan.add.length === 0 &&
    agentPlan.remove.length === 0 &&
    globalDocsPlan.write.length === 0 &&
    globalDocsPlan.remove.length === 0 &&
    rulesPlan.write.length === 0 &&
    rulesPlan.remove.length === 0 &&
    !configPlan.write &&
    !configPlan.remove &&
    !mcpPlan.needsWrite &&
    agentConflicts.length === 0 &&
    globalDocsConflicts.length === 0 &&
    rulesConflicts.length === 0 &&
    configConflicts.length === 0
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

  if (adopted.length > 0) {
    await buildIndex({
      homeDir: args.homeDir,
      rootDir: args.rootDir,
      force: false,
    });
  }

  return adopted;
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

  if (dryRun) {
    logSyncDryRun({
      tool,
      entry,
      skillPlan,
      mcpPlan,
      agentPlan: { add: agentRendered.write, remove: agentRendered.remove },
      agentConflicts: agentRendered.conflicts,
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
    });
  } else {
    await applyRenderedRemoves(agentRendered.remove);
    await applyRenderedWrites({
      contents: agentPlan.contents,
      targets: agentRendered.write,
    });
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
    logRenderedConflicts(tool, agentRendered.conflicts);
    logRenderedConflicts(tool, globalDocsRendered.conflicts);
    logRenderedConflicts(tool, rulesRendered.conflicts);
    logRenderedConflicts(tool, configRendered.conflicts);

    updateRenderedTargetState({
      entry,
      writtenTargets: agentRendered.write,
      removedTargets: agentRendered.remove,
      contents: agentPlan.contents,
      sources: agentPlan.sources,
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
    console.log(`facult manage — enter managed mode for a tool (backup + symlinks + MCP generation)

Usage:
  facult manage <tool> [--dry-run] [--adopt-existing] [--existing-conflicts keep-canonical|keep-existing] [--builtin-conflicts overwrite] [--root PATH|--global|--project]
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
    console.log(`facult unmanage — exit managed mode for a tool (restore backups)

Usage:
  facult unmanage <tool> [--root PATH|--global|--project]
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
    console.log(`facult managed — list tools currently in managed mode

Usage:
  facult managed [--root PATH|--global|--project]
`);
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
    console.log("No managed tools.");
    return;
  }
  for (const tool of tools) {
    console.log(tool);
  }
}

export async function syncCommand(argv: string[]) {
  const parsed = parseCliContextArgs(argv);
  if (
    parsed.argv.includes("--help") ||
    parsed.argv.includes("-h") ||
    parsed.argv[0] === "help"
  ) {
    console.log(`facult sync — sync managed tools with canonical state

Usage:
  facult sync [tool] [--dry-run] [--builtin-conflicts overwrite] [--root PATH|--global|--project]

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
