import { mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { confirm, intro, isCancel, note, outro, select } from "@clack/prompts";
import {
  type AutoDecision,
  type AutoMode,
  contentHash,
  decideAuto,
  mcpServerHash,
  normalizeJson,
  normalizeText,
} from "./conflicts";
import { resolveConflictAction } from "./consolidate-conflict-action";
import {
  facultRootDir,
  facultStateDir,
  legacyExternalFacultStateDir,
} from "./paths";
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

function homePath(home: string, ...parts: string[]): string {
  return join(home, ...parts);
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

async function archiveExisting(p: string): Promise<string | null> {
  if (!(await fileExists(p))) {
    return null;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${p}.bak.${stamp}`;
  await rename(p, backup);
  return backup;
}

async function readTextSafe(p: string): Promise<string | null> {
  try {
    return await Bun.file(p).text();
  } catch {
    return null;
  }
}

function normalizedTextHash(text: string | null): string | null {
  if (text === null) {
    return null;
  }
  return contentHash(normalizeText(text));
}

function normalizedJsonHash(text: string | null): string | null {
  if (text === null) {
    return null;
  }
  try {
    return contentHash(normalizeJson(text));
  } catch {
    return contentHash(normalizeText(text));
  }
}

async function nextAvailableName({
  base,
  suffix,
  exists,
}: {
  base: string;
  suffix: string;
  exists: (candidate: string) => Promise<boolean> | boolean;
}): Promise<string> {
  let candidate = `${base}-${suffix}`;
  let index = 2;
  while (await exists(candidate)) {
    candidate = `${base}-${suffix}-${index}`;
    index += 1;
  }
  return candidate;
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

async function diffPreview({
  currentLabel,
  incomingLabel,
  currentContent,
  incomingContent,
}: {
  currentLabel: string;
  incomingLabel: string;
  currentContent: string;
  incomingContent: string;
}) {
  const dir = await mkdtemp(join(tmpdir(), "facult-diff-"));
  const currentPath = join(dir, "current");
  const incomingPath = join(dir, "incoming");
  await Bun.write(currentPath, currentContent);
  await Bun.write(incomingPath, incomingContent);

  const { spawnSync } = await import("node:child_process");
  const res = spawnSync("diff", ["-u", currentPath, incomingPath], {
    encoding: "utf8",
  });
  const raw = res.stdout?.trim() || "(no diff)";
  const lines = raw.split("\n");
  const maxLines = 200;
  const preview = lines.slice(0, maxLines).join("\n");
  const suffix =
    lines.length > maxLines
      ? `\n... (${lines.length - maxLines} more lines)`
      : "";
  note(`${preview}${suffix}`, `${currentLabel} ↔ ${incomingLabel}`);
  await rm(dir, { recursive: true, force: true });
}

async function loadState(home: string): Promise<ConsolidatedState> {
  const paths = [
    join(facultStateDir(home), "consolidated.json"),
    join(legacyExternalFacultStateDir(home), "consolidated.json"),
  ];
  for (const p of paths) {
    if (!(await fileExists(p))) {
      continue;
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
      // Ignore unreadable or malformed persisted state and fall back to defaults.
    }
  }
  return {
    version: CONSOLIDATED_VERSION,
    skills: {},
    mcpServers: {},
    mcpConfigs: {},
  };
}

async function saveState(home: string, state: ConsolidatedState) {
  const stateDir = facultStateDir(home);
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

function chooseByAutoMode<T extends { modified: Date | null }>(
  locs: T[],
  autoMode: AutoMode
): T | null {
  const first = locs[0];
  if (!first) {
    return null;
  }

  let chosen = first;
  for (const loc of locs.slice(1)) {
    const decision = decideAuto(
      autoMode,
      { modified: chosen.modified },
      { modified: loc.modified }
    );
    if (decision === "keep-incoming") {
      chosen = loc;
    }
  }
  return chosen;
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

async function promptConflictResolution({
  title,
  currentLabel,
  incomingLabel,
  currentContent,
  incomingContent,
}: {
  title: string;
  currentLabel: string;
  incomingLabel: string;
  currentContent: string;
  incomingContent: string;
}): Promise<AutoDecision | "skip"> {
  while (true) {
    const selection = await select({
      message: `Conflict detected: ${title}`,
      options: [
        { value: "keep-current", label: `Keep current (${currentLabel})` },
        { value: "keep-incoming", label: `Keep incoming (${incomingLabel})` },
        { value: "keep-both", label: "Keep both" },
        { value: "diff", label: "View diff" },
        { value: "skip", label: "Cancel" },
      ],
    });

    if (isCancel(selection) || selection === "skip") {
      return "skip";
    }
    if (selection === "diff") {
      await diffPreview({
        currentLabel,
        incomingLabel,
        currentContent,
        incomingContent,
      });
      continue;
    }
    if (selection === "keep-current") {
      return "keep-current";
    }
    if (selection === "keep-incoming") {
      return "keep-incoming";
    }
    if (selection === "keep-both") {
      return "keep-both";
    }
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

async function resolveSkillConflictAndCopy({
  name,
  sourceDir,
  dest,
  state,
  force,
  autoMode,
  incomingModified,
}: {
  name: string;
  sourceDir: string;
  dest: string;
  state: ConsolidatedState;
  force: boolean;
  autoMode: AutoMode | undefined;
  incomingModified: Date | null;
}): Promise<void> {
  if (!(await fileExists(dest))) {
    await copySkillAndUpdateState({
      name,
      sourceDir,
      dest,
      state,
      force,
    });
    return;
  }

  const currentContent = await readTextSafe(join(dest, "SKILL.md"));
  const incomingContent = await readTextSafe(join(sourceDir, "SKILL.md"));
  const currentHash = normalizedTextHash(currentContent);
  const incomingHash = normalizedTextHash(incomingContent);

  const decision = await resolveConflictAction({
    title: `Skill ${name}`,
    currentLabel: dest,
    incomingLabel: sourceDir,
    currentContent,
    incomingContent,
    currentHash,
    incomingHash,
    autoMode,
    currentMeta: { modified: await lastModified(dest) },
    incomingMeta: { modified: incomingModified },
    promptConflictResolution,
  });

  if (decision === "skip") {
    return;
  }

  if (decision === "keep-current") {
    state.skills[name] = {
      source: dest,
      target: dest,
      consolidatedAt: new Date().toISOString(),
    };
    note(`Kept existing skill at ${dest}`, `Skill: ${name}`);
    return;
  }

  if (decision === "keep-incoming") {
    const backup = await archiveExisting(dest);
    if (backup) {
      note(`Archived existing skill to ${backup}`, `Skill: ${name}`);
    }
    await copySkillAndUpdateState({
      name,
      sourceDir,
      dest,
      state,
      force: true,
    });
    return;
  }

  const parent = dirname(dest);
  const newName = await nextAvailableName({
    base: name,
    suffix: "incoming",
    exists: async (candidate) => fileExists(join(parent, candidate)),
  });
  const newDest = join(parent, newName);
  await copySkillAndUpdateState({
    name: newName,
    sourceDir,
    dest: newDest,
    state,
    force,
  });

  if (!state.skills[name]) {
    state.skills[name] = {
      source: dest,
      target: dest,
      consolidatedAt: new Date().toISOString(),
    };
  }
  note(`Kept both skills: ${name} + ${newName}`, `Skill: ${name}`);
}

async function handleSingleSkillLocation({
  name,
  loc,
  dest,
  state,
  force,
  autoMode,
}: {
  name: string;
  loc: SkillLocation;
  dest: string;
  state: ConsolidatedState;
  force: boolean;
  autoMode: AutoMode | undefined;
}): Promise<void> {
  if (!autoMode) {
    const ok = await confirm({
      message: `Copy ${name} from ${loc.entryDir} (modified ${formatDate(loc.modified)})?`,
    });
    if (isCancel(ok) || !ok) {
      return;
    }
  }
  await resolveSkillConflictAndCopy({
    name,
    sourceDir: loc.entryDir,
    dest,
    state,
    force,
    autoMode,
    incomingModified: loc.modified,
  });
}

async function handleMultipleSkillLocations({
  name,
  locs,
  dest,
  state,
  force,
  autoMode,
}: {
  name: string;
  locs: SkillLocation[];
  dest: string;
  state: ConsolidatedState;
  force: boolean;
  autoMode: AutoMode | undefined;
}): Promise<void> {
  if (autoMode) {
    const chosen = chooseByAutoMode(locs, autoMode);
    if (!chosen) {
      return;
    }
    await resolveSkillConflictAndCopy({
      name,
      sourceDir: chosen.entryDir,
      dest,
      state,
      force,
      autoMode,
      incomingModified: chosen.modified,
    });
    return;
  }

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
    await resolveSkillConflictAndCopy({
      name,
      sourceDir: chosen.entryDir,
      dest,
      state,
      force,
      autoMode,
      incomingModified: chosen.modified,
    });
    break;
  }
}

async function consolidateSkills(
  res: ScanResult,
  state: ConsolidatedState,
  targets: { skills: string },
  force: boolean,
  autoMode: AutoMode | undefined
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
        autoMode,
      });
    } else {
      await handleMultipleSkillLocations({
        name,
        locs,
        dest,
        state,
        force,
        autoMode,
      });
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

async function resolveMcpServerConflictAndMerge({
  serverName,
  loc,
  consolidatedPath,
  consolidatedObj,
  state,
  autoMode,
}: {
  serverName: string;
  loc: McpServerLocation;
  consolidatedPath: string;
  consolidatedObj: McpConsolidatedObject;
  state: ConsolidatedState;
  autoMode: AutoMode | undefined;
}): Promise<void> {
  const currentEntry = consolidatedObj.mcpServers[serverName];
  if (!currentEntry) {
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
    return;
  }

  const currentContent = JSON.stringify(currentEntry, null, 2);
  const incomingCanonical = canonicalizeMcpServer({
    serverName,
    serverConfig: loc.serverConfig,
    sourceId: loc.sourceId,
    configPath: loc.configPath,
    modified: loc.modified,
  });
  const incomingContent = JSON.stringify(incomingCanonical, null, 2);
  const currentHash = await mcpServerHash(currentEntry);
  const incomingHash = await mcpServerHash(incomingCanonical);

  const decision = await resolveConflictAction({
    title: `MCP server ${serverName}`,
    currentLabel: consolidatedPath,
    incomingLabel: loc.configPath,
    currentContent,
    incomingContent,
    currentHash,
    incomingHash,
    autoMode,
    currentMeta: { modified: await lastModified(consolidatedPath) },
    incomingMeta: { modified: loc.modified },
    promptConflictResolution,
  });

  if (decision === "skip") {
    return;
  }

  if (decision === "keep-current") {
    if (!state.mcpServers[serverName]) {
      state.mcpServers[serverName] = {
        source: consolidatedPath,
        target: consolidatedPath,
        consolidatedAt: nowIso(),
      };
    }
    note(
      `Kept existing MCP server in ${consolidatedPath}`,
      `MCP server: ${serverName}`
    );
    return;
  }

  if (decision === "keep-incoming") {
    const backup = await archiveExisting(consolidatedPath);
    if (backup) {
      note(`Archived existing MCP registry to ${backup}`, "MCP registry");
    }
    consolidatedObj.updatedAt = nowIso();
    consolidatedObj.mcpServers[serverName] = incomingCanonical;
    state.mcpServers[serverName] = {
      source: loc.configPath,
      target: consolidatedPath,
      consolidatedAt: nowIso(),
    };
    await Bun.write(
      consolidatedPath,
      `${JSON.stringify(consolidatedObj, null, 2)}\n`
    );
    note(`Merged into ${consolidatedPath}`, `MCP server: ${serverName}`);
    return;
  }

  const newName = await nextAvailableName({
    base: serverName,
    suffix: "incoming",
    exists: (candidate) => candidate in consolidatedObj.mcpServers,
  });
  const renamedCanonical = canonicalizeMcpServer({
    serverName: newName,
    serverConfig: loc.serverConfig,
    sourceId: loc.sourceId,
    configPath: loc.configPath,
    modified: loc.modified,
  });
  consolidatedObj.updatedAt = nowIso();
  consolidatedObj.mcpServers[newName] = renamedCanonical;
  state.mcpServers[newName] = {
    source: loc.configPath,
    target: consolidatedPath,
    consolidatedAt: nowIso(),
  };
  if (!state.mcpServers[serverName]) {
    state.mcpServers[serverName] = {
      source: consolidatedPath,
      target: consolidatedPath,
      consolidatedAt: nowIso(),
    };
  }
  await Bun.write(
    consolidatedPath,
    `${JSON.stringify(consolidatedObj, null, 2)}\n`
  );
  note(`Kept both servers: ${serverName} + ${newName}`, "MCP server");
}

async function handleSingleMcpServerLocation({
  serverName,
  loc,
  consolidatedPath,
  consolidatedObj,
  state,
  autoMode,
}: {
  serverName: string;
  loc: McpServerLocation;
  consolidatedPath: string;
  consolidatedObj: McpConsolidatedObject;
  state: ConsolidatedState;
  autoMode: AutoMode | undefined;
}): Promise<void> {
  if (!autoMode) {
    const ok = await confirm({
      message: `Add MCP server "${serverName}" from ${loc.configPath} (modified ${formatDate(loc.modified)})?`,
    });
    if (isCancel(ok) || !ok) {
      return;
    }
  }
  await resolveMcpServerConflictAndMerge({
    serverName,
    loc,
    consolidatedPath,
    consolidatedObj,
    state,
    autoMode,
  });
}

async function handleMultipleMcpServerLocations({
  serverName,
  locs,
  consolidatedPath,
  consolidatedObj,
  state,
  autoMode,
}: {
  serverName: string;
  locs: McpServerLocation[];
  consolidatedPath: string;
  consolidatedObj: McpConsolidatedObject;
  state: ConsolidatedState;
  autoMode: AutoMode | undefined;
}): Promise<void> {
  if (autoMode) {
    const chosen = chooseByAutoMode(locs, autoMode);
    if (!chosen) {
      return;
    }
    await resolveMcpServerConflictAndMerge({
      serverName,
      loc: chosen,
      consolidatedPath,
      consolidatedObj,
      state,
      autoMode,
    });
    return;
  }

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
    await resolveMcpServerConflictAndMerge({
      serverName,
      loc: chosen,
      consolidatedPath,
      consolidatedObj,
      state,
      autoMode,
    });
    break;
  }
}

async function resolveMcpConfigConflictAndCopy({
  config,
  dest,
  state,
  autoMode,
  key,
  mcpDir,
}: {
  config: McpConfigLocation;
  dest: string;
  state: ConsolidatedState;
  autoMode: AutoMode | undefined;
  key: string;
  mcpDir: string;
}): Promise<void> {
  if (!(await fileExists(dest))) {
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
    return;
  }

  const currentContent = await readTextSafe(dest);
  const incomingContent = await readTextSafe(config.configPath);
  const currentHash = normalizedJsonHash(currentContent);
  const incomingHash = normalizedJsonHash(incomingContent);

  const decision = await resolveConflictAction({
    title: `MCP config ${basename(config.configPath)}`,
    currentLabel: dest,
    incomingLabel: config.configPath,
    currentContent,
    incomingContent,
    currentHash,
    incomingHash,
    autoMode,
    currentMeta: { modified: await lastModified(dest) },
    incomingMeta: { modified: config.modified },
    promptConflictResolution,
  });

  if (decision === "skip") {
    return;
  }

  if (decision === "keep-current") {
    state.mcpConfigs[key] = {
      source: dest,
      target: dest,
      consolidatedAt: new Date().toISOString(),
    };
    note(
      `Kept existing MCP config at ${dest}`,
      `MCP config: ${basename(dest)}`
    );
    return;
  }

  if (decision === "keep-incoming") {
    const backup = await archiveExisting(dest);
    if (backup) {
      note(`Archived existing MCP config to ${backup}`, "MCP config");
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
    return;
  }

  const baseName = basename(config.configPath);
  const ext = extname(baseName);
  const stem = ext ? baseName.slice(0, -ext.length) : baseName;
  const newBase = await nextAvailableName({
    base: stem,
    suffix: "incoming",
    exists: async (candidate) => fileExists(join(mcpDir, `${candidate}${ext}`)),
  });
  const newName = `${newBase}${ext}`;
  const newDest = join(mcpDir, newName);
  try {
    await Bun.write(newDest, Bun.file(config.configPath));
    state.mcpConfigs[key] = {
      source: config.configPath,
      target: newDest,
      consolidatedAt: new Date().toISOString(),
    };
    note(`Copied to ${newDest}`, `MCP config: ${newName}`);
  } catch (e: unknown) {
    const err = e as { message?: string } | null;
    note(
      `Copy failed: ${String(err?.message ?? e)}`,
      `MCP config: ${config.configPath}`
    );
  }
}

async function consolidateMcpConfigFiles(
  configs: McpConfigLocation[],
  state: ConsolidatedState,
  mcpDir: string,
  force: boolean,
  autoMode: AutoMode | undefined
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
    if (!autoMode) {
      const ok = await confirm({
        message: `Copy MCP config ${config.configPath} (modified ${formatDate(config.modified)})?`,
      });
      if (isCancel(ok) || !ok) {
        continue;
      }
    }
    await resolveMcpConfigConflictAndCopy({
      config,
      dest,
      state,
      autoMode,
      key,
      mcpDir,
    });
  }
}

async function consolidateMcpServers(
  res: ScanResult,
  state: ConsolidatedState,
  targets: { mcp: string },
  force: boolean,
  autoMode: AutoMode | undefined
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
        autoMode,
      });
    } else if (locs.length > 1) {
      await handleMultipleMcpServerLocations({
        serverName,
        locs,
        consolidatedPath,
        consolidatedObj,
        state,
        autoMode,
      });
    }
  }

  await consolidateMcpConfigFiles(configs, state, targets.mcp, force, autoMode);
}

function parseAutoMode(argv: string[]): AutoMode | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === "--auto") {
      const value = argv[i + 1];
      if (
        value === "keep-newest" ||
        value === "keep-current" ||
        value === "keep-incoming"
      ) {
        return value;
      }
      throw new Error(
        "--auto requires keep-newest, keep-current, or keep-incoming"
      );
    }
    if (arg.startsWith("--auto=")) {
      const value = arg.slice("--auto=".length);
      if (
        value === "keep-newest" ||
        value === "keep-current" ||
        value === "keep-incoming"
      ) {
        return value;
      }
      throw new Error(
        "--auto requires keep-newest, keep-current, or keep-incoming"
      );
    }
  }
  return undefined;
}

function parsePositiveIntFlag(
  argv: string[],
  i: number,
  flag: string
): { value: number; advance: number } {
  const arg = argv[i];
  if (arg === flag) {
    const next = argv[i + 1];
    if (!next) {
      throw new Error(`${flag} requires a number`);
    }
    const n = Number(next);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`Invalid ${flag} value: ${next}`);
    }
    return { value: Math.floor(n), advance: 1 };
  }
  const raw = arg?.slice(`${flag}=`.length) ?? "";
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${flag} value: ${raw}`);
  }
  return { value: Math.floor(n), advance: 0 };
}

function parseConsolidateScanOptions(argv: string[]): {
  includeConfigFrom: boolean;
  includeGitHooks: boolean;
  from: string[];
  fromOptions: {
    ignoreDirNames: string[];
    noDefaultIgnore: boolean;
    maxVisits?: number;
    maxResults?: number;
  };
} {
  const noConfigFrom = argv.includes("--no-config-from");
  const includeGitHooks = argv.includes("--include-git-hooks");
  const from: string[] = [];
  const fromIgnore: string[] = [];
  let fromNoDefaultIgnore = false;
  let fromMaxVisits: number | undefined;
  let fromMaxResults: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
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

    if (arg === "--from-ignore") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--from-ignore requires a directory name");
      }
      fromIgnore.push(next);
      i += 1;
      continue;
    }
    if (arg.startsWith("--from-ignore=")) {
      const value = arg.slice("--from-ignore=".length);
      if (!value) {
        throw new Error("--from-ignore requires a directory name");
      }
      fromIgnore.push(value);
      continue;
    }

    if (arg === "--from-no-default-ignore") {
      fromNoDefaultIgnore = true;
      continue;
    }

    if (arg === "--from-max-visits" || arg.startsWith("--from-max-visits=")) {
      const parsed = parsePositiveIntFlag(argv, i, "--from-max-visits");
      fromMaxVisits = parsed.value;
      i += parsed.advance;
      continue;
    }

    if (arg === "--from-max-results" || arg.startsWith("--from-max-results=")) {
      const parsed = parsePositiveIntFlag(argv, i, "--from-max-results");
      fromMaxResults = parsed.value;
      i += parsed.advance;
    }
  }

  return {
    includeConfigFrom: !noConfigFrom,
    includeGitHooks,
    from,
    fromOptions: {
      ignoreDirNames: fromIgnore,
      noDefaultIgnore: fromNoDefaultIgnore,
      maxVisits: fromMaxVisits,
      maxResults: fromMaxResults,
    },
  };
}

export async function consolidateCommand(
  argv: string[],
  ctx: { homeDir?: string; rootDir?: string; cwd?: string } = {}
) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(`fclt consolidate — deduplicate and copy skills + MCP configs into the canonical store

Usage:
  fclt consolidate [--force] [--auto <keep-newest|keep-current|keep-incoming>] [scan options]

Options:
  --force                 Re-copy items already consolidated
  --auto                  Auto-resolve conflicts (non-interactive)
  --no-config-from        Disable scanFrom roots from ~/.ai/.facult/config.json
  --from                  Add scan root (repeatable): --from ~/dev
  --include-git-hooks     Include .git/hooks and .husky hooks in --from scans
  --from-ignore           Ignore directory basename in --from scans (repeatable)
  --from-no-default-ignore  Disable default ignore list for --from scans
  --from-max-visits       Max directories visited per --from root
  --from-max-results      Max discovered paths per --from root
`);
    return;
  }
  try {
    const force = argv.includes("--force");
    const autoMode = parseAutoMode(argv);
    const scanOptions = parseConsolidateScanOptions(argv);
    const home = ctx.homeDir ?? homedir();
    const rootDir = ctx.rootDir ?? facultRootDir(home);
    intro("fclt consolidate");

    const res = await scan([], {
      ...scanOptions,
      homeDir: home,
      cwd: ctx.cwd,
    });
    const state = await loadState(home);

    const targets = {
      skills: join(rootDir, "skills"),
      mcp: join(rootDir, "mcp"),
      agents: join(rootDir, "agents"),
    };

    await ensureDir(targets.skills);
    await ensureDir(targets.mcp);
    await ensureDir(targets.agents);

    await consolidateSkills(
      res,
      state,
      { skills: targets.skills },
      force,
      autoMode
    );
    await consolidateMcpServers(
      res,
      state,
      { mcp: targets.mcp },
      force,
      autoMode
    );

    await saveState(home, state);
    outro(
      `Consolidation complete. State saved to ${join(facultStateDir(home), "consolidated.json")}`
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
