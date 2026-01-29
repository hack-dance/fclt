import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { computeSkillOccurrences } from "./util/skills";

export interface ScanResult {
  version: 3;
  scannedAt: string;
  cwd: string;
  sources: SourceResult[];
}

export interface SourceResult {
  id: string;
  name: string;
  found: boolean;
  roots: string[];
  evidence: string[];
  mcp: {
    configs: McpConfig[];
  };
  skills: {
    roots: string[];
    entries: string[]; // skill directories (parent dirs of SKILL.md)
  };
}

export interface McpConfig {
  path: string;
  format: "json" | "unknown";
  servers?: string[];
  /** Parsed JSON object when format is json; used to preserve unknown fields. */
  data?: unknown;
  error?: string;
}

interface SourceSpec {
  id: string;
  name: string;
  candidates: string[]; // files/dirs to check
  skillDirs?: string[];
  configFiles?: string[];
}

const GLOB_CHARS_REGEX = /[*?[]/;

function expandTilde(p: string): string {
  if (p === "~") {
    return homedir();
  }
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function hasGlobChars(p: string): boolean {
  return GLOB_CHARS_REGEX.test(p);
}

function firstGlobIndex(p: string): number {
  return p.search(GLOB_CHARS_REGEX);
}

function isSafePathString(p: string): boolean {
  // Protect filesystem APIs from null-byte paths.
  return !p.includes("\0");
}

function globBaseDir(absPattern: string): string {
  const i = firstGlobIndex(absPattern);
  if (i < 0) {
    return dirname(absPattern);
  }
  // The non-glob prefix can end mid-segment (e.g. antigravity*), so stat the parent dir.
  const prefix = absPattern.slice(0, i);
  const dir = dirname(prefix);
  return dir === "." ? "/" : dir;
}

async function expandPathPatterns(patterns: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const pat of patterns) {
    const expanded = expandTilde(pat);
    const abs = expanded.startsWith("/") ? expanded : resolve(expanded);

    if (!isSafePathString(abs)) {
      continue;
    }

    if (!hasGlobChars(abs)) {
      out.push(abs);
      continue;
    }

    const baseDir = globBaseDir(abs);
    const baseSt = await statSafe(baseDir);
    if (!baseSt?.isDir) {
      continue;
    }

    try {
      const glob = new Bun.Glob(abs);
      for await (const m of glob.scan({ cwd: "/", onlyFiles: false })) {
        if (isSafePathString(m)) {
          out.push(m);
        }
      }
    } catch {
      // If the glob can't be scanned (e.g. missing base dir), treat as no matches.
    }
  }
  return uniqueSorted(out);
}

async function statSafe(
  p: string
): Promise<{ isFile: boolean; isDir: boolean } | null> {
  try {
    const s = await Bun.file(p).stat();
    return { isFile: s.isFile(), isDir: s.isDirectory() };
  } catch {
    return null;
  }
}

async function readJsonSafe(p: string): Promise<unknown> {
  const f = Bun.file(p);
  const txt = await f.text();
  return JSON.parse(txt);
}

function uniqueSorted(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

async function listSkillEntries(skillRoot: string): Promise<string[]> {
  const st = await statSafe(skillRoot);
  if (!st?.isDir) {
    return [];
  }

  // We treat any directory that contains a SKILL.md as a single skill entry.
  // This prevents noisy output like package.json/README.md under skills.
  const out: string[] = [];
  const glob = new Bun.Glob("**/SKILL.md");
  for await (const rel of glob.scan({ cwd: skillRoot, onlyFiles: true })) {
    // Avoid scanning/including dependencies vendored under skills.
    if (rel.split(sep).includes("node_modules")) {
      continue;
    }
    out.push(join(skillRoot, dirname(rel)));
  }

  return uniqueSorted(out);
}

async function discoverMcpConfig(p: string): Promise<McpConfig | null> {
  const st = await statSafe(p);
  if (!st?.isFile) {
    return null;
  }

  const cfg: McpConfig = { path: p, format: "unknown" };

  if (p.endsWith(".json")) {
    cfg.format = "json";
    try {
      const obj = (await readJsonSafe(p)) as Record<string, unknown> | null;
      cfg.data = obj;
      const serversObj =
        (obj?.mcpServers as Record<string, unknown> | undefined) ??
        ((obj?.mcp as Record<string, unknown> | undefined)?.servers as
          | Record<string, unknown>
          | undefined) ??
        (obj?.servers as Record<string, unknown> | undefined);
      if (serversObj && typeof serversObj === "object") {
        cfg.servers = uniqueSorted(Object.keys(serversObj));
      }
    } catch (e: unknown) {
      const err = e as { message?: string } | null;
      cfg.error = String(err?.message ?? e);
    }
  }

  return cfg;
}

function defaultSourceSpecs(cwd: string): SourceSpec[] {
  return [
    {
      id: "cursor",
      name: "Cursor",
      candidates: [
        "~/.cursor",
        "~/.cursr", // common typo; include if it exists
        "~/Library/Application Support/Cursor/User/settings.json",
        "~/.cursor/mcp.json",
        "~/.cursr/mcp.json",
      ],
      skillDirs: ["~/.cursor/skills", "~/.cursr/skills"],
      configFiles: [
        "~/.cursor/mcp.json",
        "~/.cursr/mcp.json",
        "~/Library/Application Support/Cursor/User/settings.json",
      ],
    },
    {
      id: "windsurf",
      name: "Windsurf",
      candidates: [
        "~/Library/Application Support/Windsurf/User/settings.json",
        "~/Library/Application Support/Windsurf",
        "~/.windsurf",
      ],
      // Windsurf is VS Code-like; settings.json may contain mcpServers.
      configFiles: [
        "~/Library/Application Support/Windsurf/User/settings.json",
      ],
    },
    {
      id: "vscode",
      name: "VS Code / VSCodium",
      candidates: [
        "~/Library/Application Support/Code/User/settings.json",
        "~/Library/Application Support/VSCodium/User/settings.json",
      ],
      configFiles: [
        "~/Library/Application Support/Code/User/settings.json",
        "~/Library/Application Support/VSCodium/User/settings.json",
      ],
    },
    {
      id: "codex",
      name: "Codex",
      candidates: [
        "~/.codex",
        "~/.config/openai",
        "~/.config/openai/codex.json",
        "~/.codex/config.json",
        "~/.codex/mcp.json",
      ],
      skillDirs: ["~/.codex/skills"],
      configFiles: [
        "~/.config/openai/codex.json",
        "~/.codex/config.json",
        "~/.codex/mcp.json",
      ],
    },
    {
      id: "claude",
      name: "Claude (CLI)",
      candidates: ["~/.claude", "~/.claude.json", "~/.config/claude"],
      skillDirs: ["~/.claude/skills", "~/.config/claude/skills"],
      configFiles: ["~/.claude.json"],
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      candidates: [
        "~/Library/Application Support/Claude/claude_desktop_config.json",
        "~/Library/Application Support/Claude",
      ],
      configFiles: [
        "~/Library/Application Support/Claude/claude_desktop_config.json",
      ],
    },
    {
      id: "gemini",
      name: "Gemini",
      candidates: ["~/.config/gemini", "~/.gemini", "~/.gemini/antigravity*"],
      skillDirs: [
        "~/.config/gemini/skills",
        "~/.gemini/skills",
        "~/.gemini/antigravity*/skills",
      ],
      configFiles: [
        "~/.config/gemini/mcp.json",
        "~/.gemini/mcp.json",
        "~/.gemini/antigravity*/mcp.json",
      ],
    },
    {
      id: "antigravity",
      name: "Antigravity",
      candidates: ["~/.antigravity", "~/.config/antigravity"],
      skillDirs: ["~/.antigravity/skills", "~/.config/antigravity/skills"],
      configFiles: [
        "~/.antigravity/mcp.json",
        "~/.config/antigravity/mcp.json",
      ],
    },
    {
      id: "clawdbot",
      name: "Clawdbot",
      candidates: [
        "~/.clawdbot",
        "~/.config/clawdbot",
        "~/clawdbot",
        "~/clawdbot/agents",
        "~/clawd/agents",
        "~/clawd",
      ],
      skillDirs: [
        "~/.clawdbot/skills",
        "~/.config/clawdbot/skills",
        "~/clawdbot/agents/**/skills",
        "~/clawd/agents/**/skills",
        "~/clawd/skills",
      ],
      configFiles: [
        "~/.clawdbot/mcp.json",
        "~/.config/clawdbot/mcp.json",
        "~/clawdbot/mcp.json",
      ],
    },
    {
      id: "agents",
      name: "Agents / Skills (generic)",
      candidates: [
        "~/.agents",
        "~/agents",
        "~/clawdbot/agents",
        "~/clawd/agents",
      ],
      skillDirs: [
        "~/.agents/skills",
        "~/agents",
        "~/agents/skills",
        "~/clawdbot/agents/**/skills",
        "~/clawd/agents/**/skills",
      ],
      configFiles: [
        // Common ad-hoc MCP config locations.
        "~/.agents/mcp.json",
        "~/agents/mcp.json",
      ],
    },
    {
      id: "dot-clawdbot",
      name: ".clawdbot (project)",
      candidates: [join(cwd, ".clawdbot")],
      skillDirs: [join(cwd, ".clawdbot", "skills"), join(cwd, "skills")],
      configFiles: [
        join(cwd, ".clawdbot", "mcp.json"),
        join(cwd, ".clawdbot", "config.json"),
      ],
    },
  ];
}

async function discoverRootsAndEvidence(
  candidates: string[]
): Promise<{ roots: string[]; evidence: string[] }> {
  const roots: string[] = [];
  const evidence: string[] = [];
  const candidatePaths = await expandPathPatterns(candidates);
  for (const p of candidatePaths) {
    const st = await statSafe(p);
    if (st) {
      evidence.push(p);
      roots.push(st.isDir ? p : dirname(p));
    }
  }
  return { roots, evidence };
}

async function discoverSkillsFromDirs(
  skillDirs: string[]
): Promise<{ roots: string[]; entries: string[] }> {
  const skillRoots = await expandPathPatterns(skillDirs);
  const entries: string[] = [];
  const existingRoots: string[] = [];
  for (const sr of skillRoots) {
    const st = await statSafe(sr);
    if (st?.isDir) {
      existingRoots.push(sr);
      entries.push(...(await listSkillEntries(sr)));
    }
  }
  return { roots: existingRoots, entries };
}

const COMMON_MCP_FILENAMES = [
  "mcp.json",
  "mcp.config.json",
  "claude_desktop_config.json",
];

async function discoverMcpConfigsFromRoots(
  roots: string[]
): Promise<McpConfig[]> {
  const configs: McpConfig[] = [];
  for (const r of roots) {
    const st = await statSafe(r);
    if (!st?.isDir) {
      continue;
    }
    for (const name of COMMON_MCP_FILENAMES) {
      const cfg = await discoverMcpConfig(join(r, name));
      if (cfg) {
        configs.push(cfg);
      }
    }
  }
  return configs;
}

async function buildSourceResult(spec: SourceSpec): Promise<SourceResult> {
  const { roots, evidence } = await discoverRootsAndEvidence(spec.candidates);
  const skills = await discoverSkillsFromDirs(spec.skillDirs ?? []);

  const configs: McpConfig[] = [];
  const configPaths = await expandPathPatterns(spec.configFiles ?? []);
  for (const p of configPaths) {
    const cfg = await discoverMcpConfig(p);
    if (cfg) {
      configs.push(cfg);
    }
  }

  // Also opportunistically detect common MCP filenames under any discovered roots.
  configs.push(...(await discoverMcpConfigsFromRoots(uniqueSorted(roots))));

  const found =
    evidence.length > 0 || configs.length > 0 || skills.entries.length > 0;

  return {
    id: spec.id,
    name: spec.name,
    found,
    roots: uniqueSorted(roots),
    evidence: uniqueSorted(evidence),
    mcp: {
      configs: uniqueSorted(configs.map((c) => JSON.stringify(c))).map((s) =>
        JSON.parse(s)
      ),
    },
    skills: {
      roots: uniqueSorted(skills.roots),
      entries: uniqueSorted(skills.entries),
    },
  };
}

function formatServers(servers?: string[]): string {
  if (!servers?.length) {
    return "";
  }
  return ` (servers: ${servers.join(", ")})`;
}

function printSourceMcpConfigs(configs: McpConfig[]) {
  if (configs.length) {
    console.log("  MCP configs:");
    for (const c of configs) {
      const err = c.error ? ` (error: ${c.error})` : "";
      console.log(`    - ${c.path}${formatServers(c.servers)}${err}`);
    }
  } else {
    console.log("  MCP configs: (none)");
  }
}

function printSourceSkills(skills: SourceResult["skills"]) {
  if (skills.entries.length) {
    console.log("  Skills:");
    for (const p of skills.entries) {
      console.log(`    - ${p}`);
    }
  } else if (skills.roots.length) {
    console.log(
      `  Skills: (no SKILL.md found under ${skills.roots.join(", ")})`
    );
  } else {
    console.log("  Skills: (none)");
  }
}

function printHuman(res: ScanResult) {
  console.log(`facult scan — ${res.scannedAt}`);
  console.log("");

  const foundSources = res.sources.filter((s) => s.found);
  if (foundSources.length === 0) {
    console.log("No known sources found.");
    return;
  }

  console.log("Discovered sources:");
  for (const s of foundSources) {
    const roots = s.roots.length ? s.roots : s.evidence;
    console.log(`- ${s.name}${roots.length ? `: ${roots.join(", ")}` : ""}`);
  }

  console.log("");

  for (const s of foundSources) {
    console.log(`${s.name}`);
    printSourceMcpConfigs(s.mcp.configs);
    printSourceSkills(s.skills);
    console.log("");
  }
}

function sourcesFromLocations(locations: string[]): string[] {
  const out = new Set<string>();
  for (const loc of locations) {
    const i = loc.indexOf(":");
    if (i > 0) {
      out.add(loc.slice(0, i));
    }
  }
  return [...out].sort();
}

function _printSkillsTable(res: ScanResult) {
  const all = computeSkillOccurrences(res);

  console.log(`facult scan — ${res.scannedAt}`);
  console.log("Skills (deduplicated by SKILL.md parent directory name):");

  if (all.length === 0) {
    console.log("(none)");
    return;
  }

  const rows = all.map((d) => ({
    skill: d.name,
    count: String(d.count),
    sources: sourcesFromLocations(d.locations).join(", "),
  }));

  const wSkill = Math.max("SKILL".length, ...rows.map((r) => r.skill.length));
  const wCount = Math.max("COUNT".length, ...rows.map((r) => r.count.length));

  console.log(
    `${"SKILL".padEnd(wSkill)}  ${"COUNT".padStart(wCount)}  SOURCES`
  );
  console.log(
    `${"-".repeat(wSkill)}  ${"-".repeat(wCount)}  ${"-".repeat("SOURCES".length)}`
  );
  for (const r of rows) {
    console.log(
      `${r.skill.padEnd(wSkill)}  ${r.count.padStart(wCount)}  ${r.sources}`
    );
  }
}

function printDuplicatesTable(res: ScanResult) {
  const all = computeSkillOccurrences(res).filter((d) => d.count > 1);

  console.log(`facult scan — ${res.scannedAt}`);
  console.log("Duplicate skills (same skill name appears in multiple places):");

  if (all.length === 0) {
    console.log("(none)");
    return;
  }

  const rows = all.map((d) => ({
    skill: d.name,
    count: String(d.count),
    sources: sourcesFromLocations(d.locations).join(", "),
  }));

  const wSkill = Math.max("SKILL".length, ...rows.map((r) => r.skill.length));
  const wCount = Math.max("COUNT".length, ...rows.map((r) => r.count.length));

  console.log(
    `${"SKILL".padEnd(wSkill)}  ${"COUNT".padStart(wCount)}  SOURCES`
  );
  console.log(
    `${"-".repeat(wSkill)}  ${"-".repeat(wCount)}  ${"-".repeat("SOURCES".length)}`
  );
  for (const r of rows) {
    console.log(
      `${r.skill.padEnd(wSkill)}  ${r.count.padStart(wCount)}  ${r.sources}`
    );
  }
}

async function ensureDir(p: string) {
  await mkdir(p, { recursive: true });
}

export async function scan(_argv: string[]): Promise<ScanResult> {
  const cwd = process.cwd();
  const specs = defaultSourceSpecs(cwd);
  const sources: SourceResult[] = [];
  for (const spec of specs) {
    sources.push(await buildSourceResult(spec));
  }

  return {
    version: 3,
    scannedAt: new Date().toISOString(),
    cwd,
    sources,
  };
}

export async function writeState(res: ScanResult) {
  const stateDir = join(homedir(), ".facult");
  await ensureDir(stateDir);
  const outPath = join(stateDir, "sources.json");
  await Bun.write(outPath, `${JSON.stringify(res, null, 2)}\n`);
}

export async function scanCommand(argv: string[]) {
  const json = argv.includes("--json");
  const showDuplicates = argv.includes("--show-duplicates");
  const tui = argv.includes("--tui");

  const res = await scan(argv);
  await writeState(res);

  if (json) {
    if (tui) {
      console.error("--json and --tui are mutually exclusive");
      process.exitCode = 2;
      return;
    }
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (tui) {
    const { runSkillsTui } = await import("./tui");
    await runSkillsTui(res);
  } else if (showDuplicates) {
    printDuplicatesTable(res);
  } else {
    printHuman(res);
  }

  console.log(`State written to ${join(homedir(), ".facult", "sources.json")}`);
}
