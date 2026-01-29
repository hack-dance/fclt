import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { confirm, intro, isCancel, note, outro, select } from "@clack/prompts";
import { type McpConfig, type ScanResult, scan } from "./scan";
import type {
  CanonicalMcpRegistry,
  CanonicalMcpServer,
  McpTransport,
} from "./schema";
import { computeSkillOccurrences, lastModified } from "./util/skills";

interface ConsolidatedEntry {
  source: string;
  target: string;
  consolidatedAt: string;
}

interface ConsolidatedState {
  version: 1;
  skills: Record<string, ConsolidatedEntry>;
  mcpServers: Record<string, ConsolidatedEntry>;
  mcpConfigs: Record<string, ConsolidatedEntry>;
}

interface SkillLocation {
  entryDir: string;
  sourceId: string;
  modified: Date | null;
}

interface McpServerLocation {
  configPath: string;
  sourceId: string;
  modified: Date | null;
  serverName: string;
  serverConfig: unknown;
}

interface McpConfigLocation {
  configPath: string;
  sourceId: string;
  modified: Date | null;
}

type McpConsolidatedObject = CanonicalMcpRegistry;

const CONSOLIDATED_VERSION = 1;

function homePath(...parts: string[]): string {
  return join(homedir(), ...parts);
}

function formatDate(d: Date | null): string {
  if (!d) {
    return "unknown";
  }
  return d.toISOString().replace("T", " ").replace("Z", "");
}

async function ensureDir(p: string) {
  await mkdir(p, { recursive: true });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src: string, dest: string, force: boolean) {
  if (force) {
    await rm(dest, { recursive: true, force: true });
  }
  await ensureDir(dest);
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to, force);
    } else if (entry.isFile()) {
      await Bun.write(to, Bun.file(from));
    }
  }
}

async function loadState(): Promise<ConsolidatedState> {
  const p = homePath(".facult", "consolidated.json");
  if (!(await fileExists(p))) {
    return {
      version: CONSOLIDATED_VERSION,
      skills: {},
      mcpServers: {},
      mcpConfigs: {},
    };
  }
  try {
    const txt = await Bun.file(p).text();
    const data = JSON.parse(txt) as {
      skills?: Record<string, ConsolidatedEntry>;
      mcpServers?: Record<string, ConsolidatedEntry>;
      mcpConfigs?: Record<string, ConsolidatedEntry>;
    } | null;
    return {
      version: CONSOLIDATED_VERSION,
      skills: data?.skills ?? {},
      mcpServers: data?.mcpServers ?? {},
      mcpConfigs: data?.mcpConfigs ?? {},
    };
  } catch {
    return {
      version: CONSOLIDATED_VERSION,
      skills: {},
      mcpServers: {},
      mcpConfigs: {},
    };
  }
}

async function saveState(state: ConsolidatedState) {
  const stateDir = homePath(".facult");
  await ensureDir(stateDir);
  const outPath = join(stateDir, "consolidated.json");
  await Bun.write(outPath, `${JSON.stringify(state, null, 2)}\n`);
}

function parseLocation(loc: string): { sourceId: string; entryDir: string } {
  const i = loc.indexOf(":");
  if (i < 0) {
    return { sourceId: "", entryDir: loc };
  }
  return { sourceId: loc.slice(0, i), entryDir: loc.slice(i + 1) };
}

async function buildSkillLocations(
  res: ScanResult
): Promise<Map<string, SkillLocation[]>> {
  const map = new Map<string, SkillLocation[]>();
  const occurrences = computeSkillOccurrences(res);
  for (const skill of occurrences) {
    const locs: SkillLocation[] = [];
    for (const loc of skill.locations) {
      const { sourceId, entryDir } = parseLocation(loc);
      locs.push({
        entryDir,
        sourceId,
        modified: await lastModified(entryDir),
      });
    }
    map.set(skill.name, locs);
  }
  return map;
}

function collectMcpConfigs(
  res: ScanResult
): { config: McpConfig; sourceId: string }[] {
  const out: { config: McpConfig; sourceId: string }[] = [];
  for (const src of res.sources) {
    for (const cfg of src.mcp.configs) {
      out.push({ config: cfg, sourceId: src.id });
    }
  }
  return out;
}

async function readMcpServers(
  p: string
): Promise<Record<string, unknown> | null> {
  try {
    const txt = await Bun.file(p).text();
    const obj = JSON.parse(txt) as Record<string, unknown> | null;
    const servers =
      (obj?.mcpServers as Record<string, unknown> | undefined) ??
      ((obj?.mcp as Record<string, unknown> | undefined)?.servers as
        | Record<string, unknown>
        | undefined) ??
      (obj?.servers as Record<string, unknown> | undefined);
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      return servers;
    }
  } catch {
    return null;
  }
  return null;
}

async function buildMcpLocations(res: ScanResult): Promise<{
  servers: Map<string, McpServerLocation[]>;
  configs: McpConfigLocation[];
}> {
  const servers = new Map<string, McpServerLocation[]>();
  const configs: McpConfigLocation[] = [];
  const items = collectMcpConfigs(res);
  for (const item of items) {
    const configPath = item.config.path;
    const modified = await lastModified(configPath);
    const serverDefs = await readMcpServers(configPath);
    if (serverDefs) {
      for (const [serverName, serverConfig] of Object.entries(serverDefs)) {
        const list = servers.get(serverName) ?? [];
        list.push({
          configPath,
          sourceId: item.sourceId,
          modified,
          serverName,
          serverConfig,
        });
        servers.set(serverName, list);
      }
    } else {
      configs.push({ configPath, sourceId: item.sourceId, modified });
    }
  }
  return { servers, configs };
}

function locationLabel(loc: {
  sourceId: string;
  modified: Date | null;
  entryDir?: string;
  configPath?: string;
}) {
  const p = loc.entryDir ?? loc.configPath ?? "";
  return `${p} (${loc.sourceId}, modified ${formatDate(loc.modified)})`;
}

function skillChoiceValue(loc: SkillLocation) {
  return `${loc.sourceId}:${loc.entryDir}`;
}

function mcpChoiceValue(loc: { sourceId: string; configPath: string }) {
  return `${loc.sourceId}:${loc.configPath}`;
}

async function promptViewSkillContents(locs: SkillLocation[]) {
  const choice = await select({
    message: "View SKILL.md from which location?",
    options: locs.map((loc) => ({
      value: skillChoiceValue(loc),
      label: locationLabel(loc),
    })),
  });
  if (isCancel(choice)) {
    return;
  }
  const selected = locs.find((loc) => skillChoiceValue(loc) === choice);
  if (!selected) {
    return;
  }
  const file = join(selected.entryDir, "SKILL.md");
  try {
    const content = await Bun.file(file).text();
    note(content.trim() || "(empty)", `SKILL.md — ${choice}`);
  } catch (e: unknown) {
    const err = e as { message?: string } | null;
    note(`Unable to read ${file}: ${String(err?.message ?? e)}`, "Error");
  }
}

async function promptViewMcpContents(
  locs: { configPath: string; sourceId?: string }[]
) {
  const choice = await select({
    message: "View MCP JSON from which config?",
    options: locs.map((loc) => ({
      value: mcpChoiceValue({
        sourceId: loc.sourceId ?? "",
        configPath: loc.configPath,
      }),
      label: loc.configPath,
    })),
  });
  if (isCancel(choice)) {
    return;
  }
  const selected = locs.find(
    (loc) =>
      mcpChoiceValue({
        sourceId: loc.sourceId ?? "",
        configPath: loc.configPath,
      }) === choice
  );
  if (!selected) {
    return;
  }
  try {
    const content = await Bun.file(selected.configPath).text();
    note(content.trim() || "(empty)", `MCP config — ${selected.configPath}`);
  } catch (e: unknown) {
    const err = e as { message?: string } | null;
    note(
      `Unable to read ${selected.configPath}: ${String(err?.message ?? e)}`,
      "Error"
    );
  }
}

async function copySkillAndUpdateState({
  name,
  sourceDir,
  dest,
  state,
  force,
}: {
  name: string;
  sourceDir: string;
  dest: string;
  state: ConsolidatedState;
  force: boolean;
}): Promise<boolean> {
  try {
    await copyDir(sourceDir, dest, force);
    state.skills[name] = {
      source: sourceDir,
      target: dest,
      consolidatedAt: new Date().toISOString(),
    };
    note(`Copied to ${dest}`, `Skill: ${name}`);
    return true;
  } catch (e: unknown) {
    const err = e as { message?: string } | null;
    note(`Copy failed: ${String(err?.message ?? e)}`, `Skill: ${name}`);
    return false;
  }
}

async function handleSingleSkillLocation({
  name,
  loc,
  dest,
  state,
  force,
}: {
  name: string;
  loc: SkillLocation;
  dest: string;
  state: ConsolidatedState;
  force: boolean;
}): Promise<void> {
  const ok = await confirm({
    message: `Copy ${name} from ${loc.entryDir} (modified ${formatDate(loc.modified)})?`,
  });
  if (isCancel(ok) || !ok) {
    return;
  }
  await copySkillAndUpdateState({
    name,
    sourceDir: loc.entryDir,
    dest,
    state,
    force,
  });
}

async function handleMultipleSkillLocations({
  name,
  locs,
  dest,
  state,
  force,
}: {
  name: string;
  locs: SkillLocation[];
  dest: string;
  state: ConsolidatedState;
  force: boolean;
}): Promise<void> {
  while (true) {
    const selection = await select({
      message: `Choose source for skill "${name}"`,
      options: [
        ...locs.map((loc) => ({
          value: skillChoiceValue(loc),
          label: locationLabel(loc),
        })),
        { value: "view", label: "View SKILL.md" },
        { value: "skip", label: "Skip" },
      ],
    });
    if (isCancel(selection) || selection === "skip") {
      break;
    }
    if (selection === "view") {
      await promptViewSkillContents(locs);
      continue;
    }
    const chosen = locs.find((loc) => skillChoiceValue(loc) === selection);
    if (!chosen) {
      break;
    }
    await copySkillAndUpdateState({
      name,
      sourceDir: chosen.entryDir,
      dest,
      state,
      force,
    });
    break;
  }
}

async function consolidateSkills(
  res: ScanResult,
  state: ConsolidatedState,
  targets: { skills: string },
  force: boolean
) {
  const skillMap = await buildSkillLocations(res);
  const skillNames = [...skillMap.keys()].sort();
  if (!skillNames.length) {
    note("No skills found to consolidate.", "Skills");
    return;
  }

  for (const name of skillNames) {
    if (state.skills[name] && !force) {
      note(
        `Already consolidated from ${state.skills[name].source} → ${state.skills[name].target}`,
        `Skill: ${name}`
      );
      continue;
    }

    const locs = skillMap.get(name) ?? [];
    if (locs.length === 0) {
      continue;
    }

    const dest = join(targets.skills, name);
    if (locs.length === 1 && locs[0]) {
      await handleSingleSkillLocation({
        name,
        loc: locs[0],
        dest,
        state,
        force,
      });
    } else {
      await handleMultipleSkillLocations({ name, locs, dest, state, force });
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function coerceTransport(v: unknown): McpTransport | undefined {
  if (v === "stdio" || v === "http" || v === "sse") {
    return v;
  }
  return undefined;
}

function coerceStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") {
      out.push(item);
    }
  }
  return out.length ? out : undefined;
}

function coerceEnv(v: unknown): Record<string, string> | undefined {
  if (!isPlainObject(v)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") {
      out[k] = val;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function canonicalizeMcpServer({
  serverName,
  serverConfig,
  sourceId,
  configPath,
  modified,
}: {
  serverName: string;
  serverConfig: unknown;
  sourceId: string;
  configPath: string;
  modified: Date | null;
}): CanonicalMcpServer {
  const importedAt = nowIso();

  if (!isPlainObject(serverConfig)) {
    // Preserve the raw non-object definition in vendorExtensions so we never lose it.
    return {
      name: serverName,
      vendorExtensions: { raw: serverConfig },
      provenance: {
        sourceId,
        sourcePath: configPath,
        importedAt,
        sourceModifiedAt: modified ? modified.toISOString() : undefined,
      },
    };
  }

  let transport = coerceTransport(serverConfig.transport);
  if (!transport) {
    if (typeof serverConfig.command === "string") {
      transport = "stdio";
    } else if (typeof serverConfig.url === "string") {
      transport = "http";
    }
  }

  const command =
    typeof serverConfig.command === "string" ? serverConfig.command : undefined;
  const args = coerceStringArray(serverConfig.args);
  const url =
    typeof serverConfig.url === "string" ? serverConfig.url : undefined;
  const env = coerceEnv(serverConfig.env);

  const knownKeys = new Set(["transport", "command", "args", "url", "env"]);
  const vendorExtensions: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(serverConfig)) {
    if (!knownKeys.has(k)) {
      vendorExtensions[k] = v;
    }
  }

  return {
    name: serverName,
    transport,
    command,
    args,
    url,
    env,
    vendorExtensions: Object.keys(vendorExtensions).length
      ? vendorExtensions
      : undefined,
    provenance: {
      sourceId,
      sourcePath: configPath,
      importedAt,
      sourceModifiedAt: modified ? modified.toISOString() : undefined,
    },
  };
}

function defaultCanonicalMcpObject(): McpConsolidatedObject {
  return {
    version: 1,
    updatedAt: nowIso(),
    mcpServers: {},
  };
}

function coerceCanonicalMcpRegistry(
  parsedUnknown: unknown
): McpConsolidatedObject | null {
  if (!isPlainObject(parsedUnknown)) {
    return null;
  }

  const parsedObj = parsedUnknown as Record<string, unknown>;
  const rawServers = parsedObj.mcpServers;
  if (!isPlainObject(rawServers)) {
    return null;
  }

  // Already canonical.
  if (
    parsedObj.version === 1 &&
    typeof parsedObj.updatedAt === "string" &&
    isPlainObject(parsedObj.mcpServers)
  ) {
    return parsedUnknown as unknown as McpConsolidatedObject;
  }

  // Legacy shape: migrate minimally and preserve unknown fields.
  const migrated = defaultCanonicalMcpObject();

  for (const [name, cfg] of Object.entries(rawServers)) {
    migrated.mcpServers[name] = {
      name,
      vendorExtensions: isPlainObject(cfg) ? { ...cfg } : { raw: cfg },
    };
  }

  const vendorTop: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsedObj)) {
    if (k === "mcpServers" || k === "version" || k === "updatedAt") {
      continue;
    }
    vendorTop[k] = v;
  }
  if (Object.keys(vendorTop).length) {
    migrated.vendorExtensions = vendorTop;
  }

  return migrated;
}

async function loadConsolidatedMcpObject(
  path: string
): Promise<McpConsolidatedObject> {
  if (!(await fileExists(path))) {
    return defaultCanonicalMcpObject();
  }
  try {
    const txt = await Bun.file(path).text();
    const parsedUnknown = JSON.parse(txt) as unknown;
    return (
      coerceCanonicalMcpRegistry(parsedUnknown) ?? defaultCanonicalMcpObject()
    );
  } catch {
    return defaultCanonicalMcpObject();
  }
}

async function mergeServerAndSave({
  serverName,
  serverConfig,
  sourceId,
  modified,
  configPath,
  consolidatedPath,
  consolidatedObj,
  state,
}: {
  serverName: string;
  serverConfig: unknown;
  sourceId: string;
  modified: Date | null;
  configPath: string;
  consolidatedPath: string;
  consolidatedObj: McpConsolidatedObject;
  state: ConsolidatedState;
}): Promise<void> {
  consolidatedObj.updatedAt = nowIso();
  consolidatedObj.mcpServers[serverName] = canonicalizeMcpServer({
    serverName,
    serverConfig,
    sourceId,
    configPath,
    modified,
  });

  state.mcpServers[serverName] = {
    source: configPath,
    target: consolidatedPath,
    consolidatedAt: nowIso(),
  };
  await Bun.write(
    consolidatedPath,
    `${JSON.stringify(consolidatedObj, null, 2)}\n`
  );
  note(`Merged into ${consolidatedPath}`, `MCP server: ${serverName}`);
}

async function handleSingleMcpServerLocation({
  serverName,
  loc,
  consolidatedPath,
  consolidatedObj,
  state,
}: {
  serverName: string;
  loc: McpServerLocation;
  consolidatedPath: string;
  consolidatedObj: McpConsolidatedObject;
  state: ConsolidatedState;
}): Promise<void> {
  const ok = await confirm({
    message: `Add MCP server "${serverName}" from ${loc.configPath} (modified ${formatDate(loc.modified)})?`,
  });
  if (isCancel(ok) || !ok) {
    return;
  }
  await mergeServerAndSave({
    serverName,
    serverConfig: loc.serverConfig,
    sourceId: loc.sourceId,
    modified: loc.modified,
    configPath: loc.configPath,
    consolidatedPath,
    consolidatedObj,
    state,
  });
}

async function handleMultipleMcpServerLocations({
  serverName,
  locs,
  consolidatedPath,
  consolidatedObj,
  state,
}: {
  serverName: string;
  locs: McpServerLocation[];
  consolidatedPath: string;
  consolidatedObj: McpConsolidatedObject;
  state: ConsolidatedState;
}): Promise<void> {
  while (true) {
    const selection = await select({
      message: `Choose source for MCP server "${serverName}"`,
      options: [
        ...locs.map((loc) => ({
          value: mcpChoiceValue(loc),
          label: locationLabel(loc),
        })),
        { value: "view", label: "View MCP JSON" },
        { value: "skip", label: "Skip" },
      ],
    });
    if (isCancel(selection) || selection === "skip") {
      break;
    }
    if (selection === "view") {
      await promptViewMcpContents(locs);
      continue;
    }
    const chosen = locs.find((loc) => mcpChoiceValue(loc) === selection);
    if (!chosen) {
      break;
    }
    await mergeServerAndSave({
      serverName,
      serverConfig: chosen.serverConfig,
      sourceId: chosen.sourceId,
      modified: chosen.modified,
      configPath: chosen.configPath,
      consolidatedPath,
      consolidatedObj,
      state,
    });
    break;
  }
}

async function consolidateMcpConfigFiles(
  configs: McpConfigLocation[],
  state: ConsolidatedState,
  mcpDir: string,
  force: boolean
): Promise<void> {
  const sorted = configs.sort((a, b) =>
    a.configPath.localeCompare(b.configPath)
  );
  for (const config of sorted) {
    const key = config.configPath;
    if (state.mcpConfigs[key] && !force) {
      note(
        `Already consolidated from ${state.mcpConfigs[key].source}`,
        `MCP config: ${key}`
      );
      continue;
    }
    const dest = join(mcpDir, basename(config.configPath));
    const ok = await confirm({
      message: `Copy MCP config ${config.configPath} (modified ${formatDate(config.modified)})?`,
    });
    if (isCancel(ok) || !ok) {
      continue;
    }
    try {
      await Bun.write(dest, Bun.file(config.configPath));
      state.mcpConfigs[key] = {
        source: config.configPath,
        target: dest,
        consolidatedAt: new Date().toISOString(),
      };
      note(`Copied to ${dest}`, `MCP config: ${basename(config.configPath)}`);
    } catch (e: unknown) {
      const err = e as { message?: string } | null;
      note(
        `Copy failed: ${String(err?.message ?? e)}`,
        `MCP config: ${config.configPath}`
      );
    }
  }
}

async function consolidateMcpServers(
  res: ScanResult,
  state: ConsolidatedState,
  targets: { mcp: string },
  force: boolean
) {
  const { servers, configs } = await buildMcpLocations(res);
  const serverNames = [...servers.keys()].sort();
  const consolidatedPath = join(targets.mcp, "mcp.json");
  const consolidatedObj = await loadConsolidatedMcpObject(consolidatedPath);

  for (const serverName of serverNames) {
    if (state.mcpServers[serverName] && !force) {
      note(
        `Already consolidated from ${state.mcpServers[serverName].source}`,
        `MCP server: ${serverName}`
      );
      continue;
    }

    const locs = servers.get(serverName) ?? [];
    if (locs.length === 1 && locs[0]) {
      await handleSingleMcpServerLocation({
        serverName,
        loc: locs[0],
        consolidatedPath,
        consolidatedObj,
        state,
      });
    } else if (locs.length > 1) {
      await handleMultipleMcpServerLocations({
        serverName,
        locs,
        consolidatedPath,
        consolidatedObj,
        state,
      });
    }
  }

  await consolidateMcpConfigFiles(configs, state, targets.mcp, force);
}

export async function consolidateCommand(argv: string[]) {
  const force = argv.includes("--force");
  intro("facult consolidate");

  const res = await scan(argv);
  const state = await loadState();

  const targets = {
    skills: homePath("agents", ".tb", "skills"),
    mcp: homePath("agents", ".tb", "mcp"),
    agents: homePath("agents", ".tb", "agents"),
  };

  await ensureDir(targets.skills);
  await ensureDir(targets.mcp);
  await ensureDir(targets.agents);

  await consolidateSkills(res, state, { skills: targets.skills }, force);
  await consolidateMcpServers(res, state, { mcp: targets.mcp }, force);

  await saveState(state);
  outro(
    `Consolidation complete. State saved to ${homePath(".facult", "consolidated.json")}`
  );
}
