import * as path from "node:path";
import * as os from "node:os";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { confirm, intro, isCancel, note, outro, select } from "@clack/prompts";
import { scan, type McpConfig, type ScanResult } from "./scan";
import { computeSkillOccurrences, lastModified } from "./util/skills";

type ConsolidatedEntry = {
  source: string;
  target: string;
  consolidatedAt: string;
};

type ConsolidatedState = {
  version: 1;
  skills: Record<string, ConsolidatedEntry>;
  mcpServers: Record<string, ConsolidatedEntry>;
  mcpConfigs: Record<string, ConsolidatedEntry>;
};

type SkillLocation = {
  entryDir: string;
  sourceId: string;
  modified: Date | null;
};

type McpServerLocation = {
  configPath: string;
  sourceId: string;
  modified: Date | null;
  serverName: string;
  serverConfig: any;
};

type McpConfigLocation = {
  configPath: string;
  sourceId: string;
  modified: Date | null;
};

const CONSOLIDATED_VERSION = 1;

function homePath(...parts: string[]): string {
  return path.join(os.homedir(), ...parts);
}

function formatDate(d: Date | null): string {
  if (!d) return "unknown";
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
  if (force) await rm(dest, { recursive: true, force: true });
  await ensureDir(dest);
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
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
    return { version: CONSOLIDATED_VERSION, skills: {}, mcpServers: {}, mcpConfigs: {} };
  }
  try {
    const txt = await Bun.file(p).text();
    const data = JSON.parse(txt);
    return {
      version: CONSOLIDATED_VERSION,
      skills: data?.skills ?? {},
      mcpServers: data?.mcpServers ?? {},
      mcpConfigs: data?.mcpConfigs ?? {},
    };
  } catch {
    return { version: CONSOLIDATED_VERSION, skills: {}, mcpServers: {}, mcpConfigs: {} };
  }
}

async function saveState(state: ConsolidatedState) {
  const stateDir = homePath(".facult");
  await ensureDir(stateDir);
  const outPath = path.join(stateDir, "consolidated.json");
  await Bun.write(outPath, JSON.stringify(state, null, 2) + "\n");
}

function parseLocation(loc: string): { sourceId: string; entryDir: string } {
  const i = loc.indexOf(":");
  if (i < 0) return { sourceId: "", entryDir: loc };
  return { sourceId: loc.slice(0, i), entryDir: loc.slice(i + 1) };
}

async function buildSkillLocations(res: ScanResult): Promise<Map<string, SkillLocation[]>> {
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

function collectMcpConfigs(res: ScanResult): { config: McpConfig; sourceId: string }[] {
  const out: { config: McpConfig; sourceId: string }[] = [];
  for (const src of res.sources) {
    for (const cfg of src.mcp.configs) out.push({ config: cfg, sourceId: src.id });
  }
  return out;
}

async function readMcpServers(p: string): Promise<Record<string, any> | null> {
  try {
    const txt = await Bun.file(p).text();
    const obj = JSON.parse(txt);
    const servers = obj?.mcpServers ?? obj?.mcp?.servers ?? obj?.servers;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) return servers;
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

function locationLabel(loc: { sourceId: string; modified: Date | null; entryDir?: string; configPath?: string }) {
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
    options: locs.map((loc) => ({ value: skillChoiceValue(loc), label: locationLabel(loc) })),
  });
  if (isCancel(choice)) return;
  const selected = locs.find((loc) => skillChoiceValue(loc) === choice);
  if (!selected) return;
  const file = path.join(selected.entryDir, "SKILL.md");
  try {
    const content = await Bun.file(file).text();
    note(content.trim() || "(empty)", `SKILL.md — ${choice}`);
  } catch (err: any) {
    note(`Unable to read ${file}: ${String(err?.message ?? err)}`, "Error");
  }
}

async function promptViewMcpContents(locs: { configPath: string; sourceId?: string }[]) {
  const choice = await select({
    message: "View MCP JSON from which config?",
    options: locs.map((loc) => ({
      value: mcpChoiceValue({ sourceId: loc.sourceId ?? "", configPath: loc.configPath }),
      label: loc.configPath,
    })),
  });
  if (isCancel(choice)) return;
  const selected = locs.find(
    (loc) => mcpChoiceValue({ sourceId: loc.sourceId ?? "", configPath: loc.configPath }) === choice,
  );
  if (!selected) return;
  try {
    const content = await Bun.file(selected.configPath).text();
    note(content.trim() || "(empty)", `MCP config — ${selected.configPath}`);
  } catch (err: any) {
    note(`Unable to read ${selected.configPath}: ${String(err?.message ?? err)}`, "Error");
  }
}

async function consolidateSkills(
  res: ScanResult,
  state: ConsolidatedState,
  targets: { skills: string },
  force: boolean,
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
        `Skill: ${name}`,
      );
      continue;
    }

    const locs = skillMap.get(name) ?? [];
    if (locs.length === 0) continue;

    const dest = path.join(targets.skills, name);
    if (locs.length === 1) {
      const loc = locs[0]!;
      const ok = await confirm({
        message: `Copy ${name} from ${loc.entryDir} (modified ${formatDate(loc.modified)})?`,
      });
      if (isCancel(ok) || !ok) continue;
      try {
        await copyDir(loc.entryDir, dest, force);
        state.skills[name] = {
          source: loc.entryDir,
          target: dest,
          consolidatedAt: new Date().toISOString(),
        };
        note(`Copied to ${dest}`, `Skill: ${name}`);
      } catch (err: any) {
        note(`Copy failed: ${String(err?.message ?? err)}`, `Skill: ${name}`);
      }
      continue;
    }

    while (true) {
      const selection = await select({
        message: `Choose source for skill "${name}"`,
        options: [
          ...locs.map((loc) => ({ value: skillChoiceValue(loc), label: locationLabel(loc) })),
          { value: "view", label: "View SKILL.md" },
          { value: "skip", label: "Skip" },
        ],
      });
      if (isCancel(selection) || selection === "skip") break;
      if (selection === "view") {
        await promptViewSkillContents(locs);
        continue;
      }
      const chosen = locs.find((loc) => skillChoiceValue(loc) === selection);
      if (!chosen) break;
      try {
        await copyDir(chosen.entryDir, dest, force);
        state.skills[name] = {
          source: chosen.entryDir,
          target: dest,
          consolidatedAt: new Date().toISOString(),
        };
        note(`Copied to ${dest}`, `Skill: ${name}`);
      } catch (err: any) {
        note(`Copy failed: ${String(err?.message ?? err)}`, `Skill: ${name}`);
      }
      break;
    }
  }
}

async function consolidateMcpServers(
  res: ScanResult,
  state: ConsolidatedState,
  targets: { mcp: string },
  force: boolean,
) {
  const { servers, configs } = await buildMcpLocations(res);
  const serverNames = [...servers.keys()].sort();

  const consolidatedPath = path.join(targets.mcp, "mcp.json");
  let consolidatedObj: any = { mcpServers: {} };
  if (await fileExists(consolidatedPath)) {
    try {
      const txt = await Bun.file(consolidatedPath).text();
      consolidatedObj = JSON.parse(txt);
      if (!consolidatedObj.mcpServers || typeof consolidatedObj.mcpServers !== "object") {
        consolidatedObj.mcpServers = {};
      }
    } catch {
      consolidatedObj = { mcpServers: {} };
    }
  }

  for (const serverName of serverNames) {
    if (state.mcpServers[serverName] && !force) {
      note(
        `Already consolidated from ${state.mcpServers[serverName].source}`,
        `MCP server: ${serverName}`,
      );
      continue;
    }

    const locs = servers.get(serverName) ?? [];
    if (locs.length === 1) {
      const loc = locs[0]!;
      const ok = await confirm({
        message: `Add MCP server "${serverName}" from ${loc.configPath} (modified ${formatDate(
          loc.modified,
        )})?`,
      });
      if (isCancel(ok) || !ok) continue;
      consolidatedObj.mcpServers[serverName] = loc.serverConfig;
      state.mcpServers[serverName] = {
        source: loc.configPath,
        target: consolidatedPath,
        consolidatedAt: new Date().toISOString(),
      };
      await Bun.write(consolidatedPath, JSON.stringify(consolidatedObj, null, 2) + "\n");
      note(`Merged into ${consolidatedPath}`, `MCP server: ${serverName}`);
      continue;
    }

    while (true) {
      const selection = await select({
        message: `Choose source for MCP server "${serverName}"`,
        options: [
          ...locs.map((loc) => ({ value: mcpChoiceValue(loc), label: locationLabel(loc) })),
          { value: "view", label: "View MCP JSON" },
          { value: "skip", label: "Skip" },
        ],
      });
      if (isCancel(selection) || selection === "skip") break;
      if (selection === "view") {
        await promptViewMcpContents(locs);
        continue;
      }
      const chosen = locs.find((loc) => mcpChoiceValue(loc) === selection);
      if (!chosen) break;
      consolidatedObj.mcpServers[serverName] = chosen.serverConfig;
      state.mcpServers[serverName] = {
        source: chosen.configPath,
        target: consolidatedPath,
        consolidatedAt: new Date().toISOString(),
      };
      await Bun.write(consolidatedPath, JSON.stringify(consolidatedObj, null, 2) + "\n");
      note(`Merged into ${consolidatedPath}`, `MCP server: ${serverName}`);
      break;
    }
  }

  const configTargets = configs.sort((a, b) => a.configPath.localeCompare(b.configPath));
  for (const config of configTargets) {
    const key = config.configPath;
    if (state.mcpConfigs[key] && !force) {
      note(`Already consolidated from ${state.mcpConfigs[key].source}`, `MCP config: ${key}`);
      continue;
    }
    const dest = path.join(targets.mcp, path.basename(config.configPath));
    const ok = await confirm({
      message: `Copy MCP config ${config.configPath} (modified ${formatDate(config.modified)})?`,
    });
    if (isCancel(ok) || !ok) continue;
    try {
      await Bun.write(dest, Bun.file(config.configPath));
      state.mcpConfigs[key] = {
        source: config.configPath,
        target: dest,
        consolidatedAt: new Date().toISOString(),
      };
      note(`Copied to ${dest}`, `MCP config: ${path.basename(config.configPath)}`);
    } catch (err: any) {
      note(`Copy failed: ${String(err?.message ?? err)}`, `MCP config: ${config.configPath}`);
    }
  }
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
  outro(`Consolidation complete. State saved to ${homePath(".facult", "consolidated.json")}`);
}
