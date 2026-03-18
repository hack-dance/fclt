import {
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
import {
  syncToolConfig,
  syncToolGlobalDocs,
  syncToolRules,
} from "./global-docs";
import { facultRootDir } from "./paths";

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
}

export interface SyncOptions {
  homeDir?: string;
  rootDir?: string;
  tool?: string;
  dryRun?: boolean;
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

function defaultToolPaths(home: string): Record<string, ToolPaths> {
  const defaults: Record<string, ToolPaths> = {
    cursor: {
      tool: "cursor",
      skillsDir: homePath(home, ".cursor", "skills"),
      mcpConfig: homePath(home, ".cursor", "mcp.json"),
    },
    codex: {
      tool: "codex",
      skillsDir: homePath(home, ".codex", "skills"),
      mcpConfig: homePath(home, ".codex", "mcp.json"),
      agentsDir: homePath(home, ".codex", "agents"),
      toolHome: homePath(home, ".codex"),
      rulesDir: homePath(home, ".codex", "rules"),
      toolConfig: homePath(home, ".codex", "config.toml"),
    },
    claude: {
      tool: "claude",
      skillsDir: homePath(home, ".claude", "skills"),
      mcpConfig: homePath(home, ".claude.json"),
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
      skillsDir: homePath(home, ".clawdbot", "skills"),
      mcpConfig: homePath(home, ".clawdbot", "mcp.json"),
    },
    gemini: {
      tool: "gemini",
      skillsDir: homePath(home, ".gemini", "skills"),
      mcpConfig: homePath(home, ".gemini", "mcp.json"),
    },
    antigravity: {
      tool: "antigravity",
      skillsDir: homePath(home, ".antigravity", "skills"),
      mcpConfig: homePath(home, ".antigravity", "mcp.json"),
    },
  };

  const adapterDefaults = (tool: string): ToolPaths | null => {
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
  override?: Record<string, ToolPaths>
): Promise<ToolPaths | null> {
  if (override?.[tool]) {
    return override[tool] ?? null;
  }
  const defaults = defaultToolPaths(home);
  const base = defaults[tool] ?? null;
  if (!base) {
    return null;
  }
  if (tool !== "codex") {
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
  return homePath(home, ".facult", "managed.json");
}

export async function loadManagedState(
  home: string = homedir()
): Promise<ManagedState> {
  const p = managedStatePath(home);
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
  home: string = homedir()
) {
  const dir = homePath(home, ".facult");
  await ensureDir(dir);
  await Bun.write(
    managedStatePath(home),
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

async function loadCanonicalAgents(
  rootDir: string
): Promise<{ name: string; sourcePath: string; raw: string }[]> {
  const agentsRoot = homePath(rootDir, "agents");
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
}> {
  const agents = await loadCanonicalAgents(rootDir);
  const contents = new Map<string, string>();
  const desiredPaths = new Set<string>();

  for (const agent of agents) {
    const target = homePath(agentsDir, `${agent.name}.toml`);
    const rendered = await renderCanonicalText(agent.raw, {
      homeDir,
      rootDir,
      targetTool: tool,
      targetPath: target,
    });
    desiredPaths.add(target);
    contents.set(target, rendered);
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

function skillNamesFromIndex(
  indexData: Record<string, unknown>,
  tool: string
): string[] {
  const skills = indexData.skills as Record<string, unknown> | undefined;
  if (!skills) {
    return [];
  }
  const names: string[] = [];
  for (const [name, entry] of Object.entries(skills)) {
    if (!isPlainObject(entry)) {
      continue;
    }
    const enabledFor = entry.enabledFor;
    if (Array.isArray(enabledFor)) {
      if (enabledFor.includes(tool)) {
        names.push(name);
      }
    } else {
      names.push(name);
    }
  }
  return names.sort();
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
  const { path: indexPath } = await ensureAiIndexPath({
    homeDir,
    rootDir,
    repair: true,
  });
  if (await fileExists(indexPath)) {
    try {
      const txt = await Bun.file(indexPath).text();
      const parsed = JSON.parse(txt) as Record<string, unknown>;
      const names = skillNamesFromIndex(parsed, tool);
      if (names.length) {
        return names;
      }
    } catch {
      // fallthrough to directory listing
    }
  }
  return await listSkillDirs(join(rootDir, "skills"));
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
  const skillNames = await loadEnabledSkillNames({
    homeDir,
    rootDir,
    tool,
  });
  for (const name of skillNames) {
    const target = join(rootDir, "skills", name);
    if (!(await fileExists(target))) {
      continue;
    }
    const linkPath = join(toolSkillsDir, name);
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
  const desired = await loadEnabledSkillNames({ homeDir, rootDir, tool });
  const desiredSet = new Set(desired);
  const existing = await readdir(toolSkillsDir, { withFileTypes: true }).catch(
    () => [] as import("node:fs").Dirent[]
  );

  const remove: string[] = [];
  const add: string[] = [];

  for (const entry of existing) {
    if (!desiredSet.has(entry.name)) {
      remove.push(entry.name);
      continue;
    }
    const linkPath = join(toolSkillsDir, entry.name);
    const target = join(rootDir, "skills", entry.name);
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

  for (const name of desired) {
    if (existing.find((entry) => entry.name === name)) {
      continue;
    }
    const target = join(rootDir, "skills", name);
    if (await fileExists(target)) {
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

  await ensureDir(toolSkillsDir);
  for (const name of plan.remove) {
    const linkPath = join(toolSkillsDir, name);
    await rm(linkPath, { recursive: true, force: true });
  }
  for (const name of plan.add) {
    const target = join(rootDir, "skills", name);
    if (!(await fileExists(target))) {
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
  const state = await loadManagedState(home);

  if (state.tools[tool]) {
    throw new Error(`${tool} is already managed`);
  }

  const toolPaths = await resolveToolPaths(tool, home, opts.toolPaths);
  if (!toolPaths) {
    throw new Error(`Unknown tool: ${tool}`);
  }
  const globalDocsPreview = toolPaths.toolHome
    ? await syncToolGlobalDocs({
        homeDir: home,
        rootDir,
        tool,
        toolHome: toolPaths.toolHome,
        dryRun: true,
      })
    : null;
  const rulesPreview = toolPaths.rulesDir
    ? await syncToolRules({
        homeDir: home,
        rootDir,
        tool,
        rulesDir: toolPaths.rulesDir,
        dryRun: true,
      })
    : null;
  const toolConfigPreview = toolPaths.toolConfig
    ? await syncToolConfig({
        homeDir: home,
        rootDir,
        tool,
        toolConfigPath: toolPaths.toolConfig,
        dryRun: true,
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
    globalDocsPreview?.managedTargets.includes(
      join(toolPaths.toolHome, "AGENTS.md")
    )
      ? await backupPath(join(toolPaths.toolHome, "AGENTS.md"), opts.now)
      : null;
  const globalAgentsOverrideBackup =
    toolPaths.toolHome &&
    globalDocsPreview?.managedTargets.includes(
      join(toolPaths.toolHome, "AGENTS.override.md")
    )
      ? await backupPath(
          join(toolPaths.toolHome, "AGENTS.override.md"),
          opts.now
        )
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

  if (toolPaths.agentsDir) {
    await syncAgentFiles({
      agentsDir: toolPaths.agentsDir,
      homeDir: home,
      rootDir,
      tool,
    });
  }

  if (toolPaths.toolHome && globalDocsPreview) {
    await ensureDir(toolPaths.toolHome);
    await syncToolGlobalDocs({
      homeDir: home,
      rootDir,
      tool,
      toolHome: toolPaths.toolHome,
    });
  }

  if (toolPaths.rulesDir && rulesPreview?.managedRulesDir) {
    await ensureEmptyDir(toolPaths.rulesDir);
    await syncToolRules({
      homeDir: home,
      rootDir,
      tool,
      rulesDir: toolPaths.rulesDir,
      previouslyManaged: true,
    });
  }

  if (toolPaths.toolConfig && toolConfigPreview?.managedConfig) {
    await syncToolConfig({
      homeDir: home,
      rootDir,
      tool,
      toolConfigPath: toolPaths.toolConfig,
      existingConfigPath: toolConfigBackup ?? undefined,
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
    globalAgentsPath: globalDocsPreview?.managedTargets.includes(
      join(toolPaths.toolHome ?? "", "AGENTS.md")
    )
      ? join(toolPaths.toolHome ?? "", "AGENTS.md")
      : undefined,
    globalAgentsOverridePath: globalDocsPreview?.managedTargets.includes(
      join(toolPaths.toolHome ?? "", "AGENTS.override.md")
    )
      ? join(toolPaths.toolHome ?? "", "AGENTS.override.md")
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
  };

  await saveManagedState(state, home);
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
  const state = await loadManagedState(home);
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
  await saveManagedState(state, home);
}

export async function listManagedTools(
  opts: { homeDir?: string } = {}
): Promise<string[]> {
  const state = await loadManagedState(opts.homeDir ?? homedir());
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
  const toolPaths = await resolveToolPaths(tool, homeDir);
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
      const agentsPath = join(toolPaths.toolHome, "AGENTS.md");
      const overridePath = join(toolPaths.toolHome, "AGENTS.override.md");
      if (
        preview.managedTargets.includes(agentsPath) &&
        !next.globalAgentsPath
      ) {
        next.globalAgentsBackup = await backupPath(agentsPath);
        next.globalAgentsPath = agentsPath;
        changed = true;
      }
      if (
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

function logSyncDryRun({
  tool,
  entry,
  skillPlan,
  mcpPlan,
  agentPlan,
  globalDocsPlan,
  rulesPlan,
  configPlan,
}: {
  tool: string;
  entry: ManagedToolState;
  skillPlan: { add: string[]; remove: string[] };
  mcpPlan: { needsWrite: boolean };
  agentPlan: { add: string[]; remove: string[] };
  globalDocsPlan: { write: string[]; remove: string[] };
  rulesPlan: { write: string[]; remove: string[] };
  configPlan: { write: boolean; remove: boolean; targetPath: string };
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
  for (const p of globalDocsPlan.write) {
    console.log(`${tool}: would write global doc ${p}`);
  }
  for (const p of globalDocsPlan.remove) {
    console.log(`${tool}: would remove global doc ${p}`);
  }
  for (const p of rulesPlan.write) {
    console.log(`${tool}: would write rule ${p}`);
  }
  for (const p of rulesPlan.remove) {
    console.log(`${tool}: would remove rule ${p}`);
  }
  if (configPlan.write) {
    console.log(`${tool}: would write tool config ${configPlan.targetPath}`);
  }
  if (configPlan.remove) {
    console.log(`${tool}: would remove tool config ${configPlan.targetPath}`);
  }
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
    !mcpPlan.needsWrite
  ) {
    console.log(`${tool}: no changes`);
  }
}

async function syncManagedToolEntry({
  homeDir,
  tool,
  entry,
  rootDir,
  dryRun,
}: {
  homeDir: string;
  tool: string;
  entry: ManagedToolState;
  rootDir: string;
  dryRun?: boolean;
}) {
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
    ? await syncAgentFiles({
        agentsDir: entry.agentsDir,
        homeDir,
        rootDir,
        tool,
        dryRun,
      })
    : { add: [], remove: [] };

  const mcpPlan = entry.mcpConfig
    ? await syncMcpConfig({
        mcpConfigPath: entry.mcpConfig,
        rootDir,
        tool,
        dryRun,
      })
    : { needsWrite: false };

  const globalDocsPlan = entry.toolHome
    ? await syncToolGlobalDocs({
        homeDir,
        rootDir,
        tool,
        toolHome: entry.toolHome,
        previouslyManagedTargets: [
          entry.globalAgentsPath,
          entry.globalAgentsOverridePath,
        ].filter((value): value is string => Boolean(value)),
        dryRun,
      })
    : { write: [], remove: [], contents: new Map(), managedTargets: [] };

  const rulesPlan = entry.rulesDir
    ? await syncToolRules({
        homeDir,
        rootDir,
        tool,
        rulesDir: entry.rulesDir,
        previouslyManaged: true,
        dryRun,
      })
    : { write: [], remove: [], contents: new Map(), managedRulesDir: false };

  const configPlan = entry.toolConfig
    ? await syncToolConfig({
        homeDir,
        rootDir,
        tool,
        toolConfigPath: entry.toolConfig,
        existingConfigPath: entry.toolConfigBackup ?? undefined,
        previouslyManaged: true,
        dryRun,
      })
    : {
        write: false,
        remove: false,
        contents: null,
        managedConfig: false,
        targetPath: "",
      };

  if (dryRun) {
    logSyncDryRun({
      tool,
      entry,
      skillPlan,
      mcpPlan,
      agentPlan,
      globalDocsPlan,
      rulesPlan,
      configPlan,
    });
  } else {
    console.log(`${tool} synced`);
  }
}

export async function syncManagedTools(opts: SyncOptions = {}) {
  const home = opts.homeDir ?? homedir();
  const rootDir = opts.rootDir ?? facultRootDir(home);
  const state = await loadManagedState(home);
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
      await saveManagedState(state, home);
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
    });
  }
}

export async function manageCommand(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(`facult manage — enter managed mode for a tool (backup + symlinks + MCP generation)

Usage:
  facult manage <tool>
`);
    return;
  }
  const tool = argv[0];
  if (!tool) {
    console.error("manage requires a tool name");
    process.exitCode = 1;
    return;
  }
  try {
    await manageTool(tool);
    console.log(`${tool} is now managed`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function unmanageCommand(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(`facult unmanage — exit managed mode for a tool (restore backups)

Usage:
  facult unmanage <tool>
`);
    return;
  }
  const tool = argv[0];
  if (!tool) {
    console.error("unmanage requires a tool name");
    process.exitCode = 1;
    return;
  }
  try {
    await unmanageTool(tool);
    console.log(`${tool} is no longer managed`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function managedCommand(argv: string[] = []) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(`facult managed — list tools currently in managed mode

Usage:
  facult managed
`);
    return;
  }
  const tools = await listManagedTools();
  if (!tools.length) {
    console.log("No managed tools.");
    return;
  }
  for (const tool of tools) {
    console.log(tool);
  }
}

export async function syncCommand(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(`facult sync — sync managed tools with canonical state

Usage:
  facult sync [tool] [--dry-run]

Options:
  --dry-run   Show what would change
`);
    return;
  }
  const tool = argv.find((arg) => !arg.startsWith("-"));
  const dryRun = argv.includes("--dry-run");
  try {
    await syncManagedTools({ tool, dryRun });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
