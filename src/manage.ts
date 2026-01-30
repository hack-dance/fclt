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
import { dirname, join } from "node:path";

export interface ManagedToolState {
  tool: string;
  managedAt: string;
  skillsDir?: string;
  mcpConfig?: string;
  skillsBackup?: string | null;
  mcpBackup?: string | null;
}

export interface ManagedState {
  version: 1;
  tools: Record<string, ManagedToolState>;
}

export interface ToolPaths {
  tool: string;
  skillsDir?: string;
  mcpConfig?: string;
}

export interface ManageOptions {
  homeDir?: string;
  tbRoot?: string;
  toolPaths?: Record<string, ToolPaths>;
  now?: () => Date;
}

export interface SyncOptions {
  homeDir?: string;
  tbRoot?: string;
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
  return {
    cursor: {
      tool: "cursor",
      skillsDir: homePath(home, ".cursor", "skills"),
      mcpConfig: homePath(home, ".cursor", "mcp.json"),
    },
    codex: {
      tool: "codex",
      skillsDir: homePath(home, ".codex", "skills"),
      mcpConfig: homePath(home, ".codex", "mcp.json"),
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

  const candidates = [
    homePath(home, ".config", "openai", "codex.json"),
    homePath(home, ".codex", "config.json"),
    homePath(home, ".codex", "mcp.json"),
  ];

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
  tbRoot,
  tool,
}: {
  tbRoot: string;
  tool: string;
}): Promise<string[]> {
  const indexPath = join(tbRoot, "index.json");
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
  return await listSkillDirs(join(tbRoot, "skills"));
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

async function loadCanonicalServers(tbRoot: string): Promise<{
  servers: Record<string, unknown>;
  sourcePath: string | null;
}> {
  const serversPath = join(tbRoot, "mcp", "servers.json");
  const mcpPath = join(tbRoot, "mcp", "mcp.json");

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
  toolSkillsDir,
  tbRoot,
  tool,
}: {
  toolSkillsDir: string;
  tbRoot: string;
  tool: string;
}) {
  await ensureDir(toolSkillsDir);
  const skillNames = await loadEnabledSkillNames({ tbRoot, tool });
  for (const name of skillNames) {
    const target = join(tbRoot, "skills", name);
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
  toolSkillsDir,
  tbRoot,
  tool,
}: {
  toolSkillsDir: string;
  tbRoot: string;
  tool: string;
}): Promise<{ add: string[]; remove: string[] }> {
  const desired = await loadEnabledSkillNames({ tbRoot, tool });
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
    const target = join(tbRoot, "skills", entry.name);
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
    const target = join(tbRoot, "skills", name);
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
  toolSkillsDir,
  tbRoot,
  tool,
  dryRun,
}: {
  toolSkillsDir: string;
  tbRoot: string;
  tool: string;
  dryRun?: boolean;
}): Promise<{ add: string[]; remove: string[] }> {
  const plan = await planSkillSymlinkChanges({ toolSkillsDir, tbRoot, tool });
  if (dryRun) {
    return plan;
  }

  await ensureDir(toolSkillsDir);
  for (const name of plan.remove) {
    const linkPath = join(toolSkillsDir, name);
    await rm(linkPath, { recursive: true, force: true });
  }
  for (const name of plan.add) {
    const target = join(tbRoot, "skills", name);
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
  tbRoot,
  tool,
}: {
  mcpConfigPath: string;
  tbRoot: string;
  tool: string;
}): Promise<{ needsWrite: boolean; contents: string }> {
  const { servers } = await loadCanonicalServers(tbRoot);
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
  tbRoot,
  tool,
  dryRun,
}: {
  mcpConfigPath: string;
  tbRoot: string;
  tool: string;
  dryRun?: boolean;
}): Promise<{ needsWrite: boolean }> {
  const plan = await planMcpWrite({ mcpConfigPath, tbRoot, tool });
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
  tbRoot,
  tool,
}: {
  mcpConfigPath: string;
  tbRoot: string;
  tool: string;
}) {
  const { servers } = await loadCanonicalServers(tbRoot);
  const filtered = filterServersForTool(servers, tool);
  await ensureDir(dirname(mcpConfigPath));
  await Bun.write(
    mcpConfigPath,
    `${JSON.stringify({ mcpServers: filtered }, null, 2)}\n`
  );
}

export async function manageTool(tool: string, opts: ManageOptions = {}) {
  const home = opts.homeDir ?? homedir();
  const tbRoot = opts.tbRoot ?? join(home, "agents", ".tb");
  const state = await loadManagedState(home);

  if (state.tools[tool]) {
    throw new Error(`${tool} is already managed`);
  }

  const toolPaths = await resolveToolPaths(tool, home, opts.toolPaths);
  if (!toolPaths) {
    throw new Error(`Unknown tool: ${tool}`);
  }

  const skillsBackup = toolPaths.skillsDir
    ? await backupPath(toolPaths.skillsDir, opts.now)
    : null;
  const mcpBackup = toolPaths.mcpConfig
    ? await backupPath(toolPaths.mcpConfig, opts.now)
    : null;

  if (toolPaths.skillsDir) {
    await ensureEmptyDir(toolPaths.skillsDir);
    await createSkillSymlinks({
      toolSkillsDir: toolPaths.skillsDir,
      tbRoot,
      tool,
    });
  }

  if (toolPaths.mcpConfig) {
    await writeToolMcpConfig({
      mcpConfigPath: toolPaths.mcpConfig,
      tbRoot,
      tool,
    });
  }

  state.tools[tool] = {
    tool,
    managedAt: nowIso(opts.now),
    skillsDir: toolPaths.skillsDir,
    mcpConfig: toolPaths.mcpConfig,
    skillsBackup,
    mcpBackup,
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

  delete state.tools[tool];
  await saveManagedState(state, home);
}

export async function listManagedTools(
  opts: { homeDir?: string } = {}
): Promise<string[]> {
  const state = await loadManagedState(opts.homeDir ?? homedir());
  return Object.keys(state.tools).sort();
}

function logSyncDryRun({
  tool,
  entry,
  skillPlan,
  mcpPlan,
}: {
  tool: string;
  entry: ManagedToolState;
  skillPlan: { add: string[]; remove: string[] };
  mcpPlan: { needsWrite: boolean };
}) {
  for (const name of skillPlan.add) {
    console.log(`${tool}: would add skill ${name}`);
  }
  for (const name of skillPlan.remove) {
    console.log(`${tool}: would remove skill ${name}`);
  }
  if (mcpPlan.needsWrite && entry.mcpConfig) {
    console.log(`${tool}: would update mcp config ${entry.mcpConfig}`);
  }
  if (
    skillPlan.add.length === 0 &&
    skillPlan.remove.length === 0 &&
    !mcpPlan.needsWrite
  ) {
    console.log(`${tool}: no changes`);
  }
}

async function syncManagedToolEntry({
  tool,
  entry,
  tbRoot,
  dryRun,
}: {
  tool: string;
  entry: ManagedToolState;
  tbRoot: string;
  dryRun?: boolean;
}) {
  const skillPlan = entry.skillsDir
    ? await syncSkillSymlinks({
        toolSkillsDir: entry.skillsDir,
        tbRoot,
        tool,
        dryRun,
      })
    : { add: [], remove: [] };

  const mcpPlan = entry.mcpConfig
    ? await syncMcpConfig({
        mcpConfigPath: entry.mcpConfig,
        tbRoot,
        tool,
        dryRun,
      })
    : { needsWrite: false };

  if (dryRun) {
    logSyncDryRun({ tool, entry, skillPlan, mcpPlan });
  } else {
    console.log(`${tool} synced`);
  }
}

export async function syncManagedTools(opts: SyncOptions = {}) {
  const home = opts.homeDir ?? homedir();
  const tbRoot = opts.tbRoot ?? join(home, "agents", ".tb");
  const state = await loadManagedState(home);
  const tools = opts.tool ? [opts.tool] : Object.keys(state.tools).sort();

  if (!tools.length) {
    throw new Error("No managed tools to sync.");
  }

  for (const tool of tools) {
    const entry = state.tools[tool];
    if (!entry) {
      throw new Error(`${tool} is not managed`);
    }
    await syncManagedToolEntry({
      tool,
      entry,
      tbRoot,
      dryRun: opts.dryRun,
    });
  }
}

export async function manageCommand(argv: string[]) {
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

export async function managedCommand() {
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
  const tool = argv.find((arg) => !arg.startsWith("-"));
  const dryRun = argv.includes("--dry-run");
  try {
    await syncManagedTools({ tool, dryRun });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
