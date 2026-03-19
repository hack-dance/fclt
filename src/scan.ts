import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { facultRootDir, facultStateDir, readFacultConfig } from "./paths";
import {
  extractCodexTomlMcpServerBlocks,
  extractCodexTomlMcpServerNames,
  sanitizeCodexTomlMcpText,
} from "./util/codex-toml";
import { parseJsonLenient } from "./util/json";
import { computeSkillOccurrences } from "./util/skills";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export interface ScanResult {
  version: 6;
  scannedAt: string;
  cwd: string;
  sources: SourceResult[];
}

export interface AssetFile {
  kind: string;
  path: string;
  format: "json" | "markdown" | "shell" | "unknown";
  error?: string;
  /**
   * Small, safe-to-store summary (avoid persisting raw configs).
   * Intended for auditing + quick inspection.
   */
  summary?: Record<string, unknown>;
}

export interface SourceResult {
  id: string;
  name: string;
  found: boolean;
  roots: string[];
  evidence: string[];
  truncated?: boolean;
  warnings?: string[];
  assets: {
    files: AssetFile[];
  };
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
  format: "json" | "toml" | "unknown";
  servers?: string[];
  error?: string;
}

interface SourceSpec {
  id: string;
  name: string;
  candidates: string[]; // files/dirs to check
  skillDirs?: string[];
  configFiles?: string[];
  assets?: { kind: string; patterns: string[] }[];
}

const GLOB_CHARS_REGEX = /[*?[]/;
const SECRETY_STRING_RE =
  /\b(sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g;
const FIRST_LINE_SPLIT_RE = /\r?\n/;
const GITDIR_LINE_RE = /^gitdir:\s*(.+)\s*$/i;
const SECRET_ENV_KEY_RE = /(TOKEN|KEY|SECRET|PASSWORD|PASS|BEARER)/i;

function redactPossibleSecrets(value: string): string {
  return value.replace(SECRETY_STRING_RE, "<redacted>");
}

function expandTilde(p: string, home: string): string {
  if (p === "~") {
    return home;
  }
  if (p.startsWith("~/")) {
    return join(home, p.slice(2));
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

async function expandPathPatterns(
  patterns: string[],
  home: string
): Promise<string[]> {
  const out: string[] = [];
  for (const pat of patterns) {
    const expanded = expandTilde(pat, home);
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
  return parseJsonLenient(txt);
}

function uniqueSorted(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

function isNodeModulesLikeDirName(name: string): boolean {
  // Besides the canonical `node_modules/`, local container volume directories often embed it
  // as a suffix (e.g. `project_node_modules`). Those trees are dependency content and noisy.
  return name === "node_modules" || name.endsWith("_node_modules");
}

function pathHasNodeModulesLikeSegment(p: string): boolean {
  return p.split(sep).some((seg) => isNodeModulesLikeDirName(seg));
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
      const parsed = await readJsonSafe(p);
      const serversObj = extractMcpServersObject(parsed);
      if (serversObj) {
        cfg.servers = uniqueSorted(Object.keys(serversObj));
      }
    } catch (e: unknown) {
      const err = e as { message?: string } | null;
      cfg.error = String(err?.message ?? e);
    }
  }

  if (p.endsWith(".toml")) {
    cfg.format = "toml";
    try {
      const txt = await Bun.file(p).text();
      cfg.servers = extractCodexTomlMcpServerNames(txt);
    } catch (e: unknown) {
      const err = e as { message?: string } | null;
      cfg.error = String(err?.message ?? e);
    }
  }

  return cfg;
}

function detectAssetFormat(p: string): AssetFile["format"] {
  if (p.endsWith(".json")) {
    return "json";
  }
  if (p.endsWith(".md") || p.endsWith(".mdc")) {
    return "markdown";
  }
  if (
    p.endsWith(".sh") ||
    p.endsWith(".bash") ||
    p.endsWith(".zsh") ||
    p.endsWith(".fish")
  ) {
    return "shell";
  }
  // Husky hooks often have no extension.
  if (
    p.includes(`${sep}.husky${sep}`) ||
    p.includes(`${sep}.git${sep}hooks${sep}`)
  ) {
    return "shell";
  }
  return "unknown";
}

async function discoverAssetFile(p: string): Promise<AssetFile | null> {
  const st = await statSafe(p);
  if (!st?.isFile) {
    return null;
  }

  const format = detectAssetFormat(p);
  const asset: AssetFile = { kind: "unknown", path: p, format };

  if (format === "json") {
    try {
      const parsed = await readJsonSafe(p);
      // Summary is derived later once we know "kind" (see discoverAssetsFromSpecs).
      // Avoid storing parsed content here to prevent persisting secrets.
      asset.summary = isPlainObject(parsed)
        ? { keys: Object.keys(parsed).sort().slice(0, 30) }
        : undefined;
    } catch (e: unknown) {
      const err = e as { message?: string } | null;
      asset.error = String(err?.message ?? e);
    }
  }

  return asset;
}

function extractClaudeHooksSummary(parsed: unknown): {
  hookEvents: string[];
  hookCommands: string[];
  hookTypes: string[];
} {
  const hookEvents: string[] = [];
  const hookCommands: string[] = [];
  const hookTypes: string[] = [];

  if (!isPlainObject(parsed)) {
    return { hookEvents, hookCommands, hookTypes };
  }

  const hooks = (parsed as Record<string, unknown>).hooks;
  if (!isPlainObject(hooks)) {
    return { hookEvents, hookCommands, hookTypes };
  }

  for (const [event, rules] of Object.entries(hooks)) {
    hookEvents.push(event);
    if (!Array.isArray(rules)) {
      continue;
    }
    for (const rule of rules) {
      if (!isPlainObject(rule)) {
        continue;
      }
      const inner = (rule as Record<string, unknown>).hooks;
      if (!Array.isArray(inner)) {
        continue;
      }
      for (const h of inner) {
        if (!isPlainObject(h)) {
          continue;
        }
        const type = (h as Record<string, unknown>).type;
        if (typeof type === "string") {
          hookTypes.push(type);
        }
        const cmd = (h as Record<string, unknown>).command;
        if (typeof cmd === "string") {
          hookCommands.push(redactPossibleSecrets(cmd));
        }
      }
    }
  }

  return {
    hookEvents: uniqueSorted(hookEvents),
    hookCommands: uniqueSorted(hookCommands),
    hookTypes: uniqueSorted(hookTypes),
  };
}

function extractClaudePermissionsSummary(parsed: unknown): {
  permissionsAllowCount: number;
  permissionsAllowSample: string[];
  permissionsAllowTruncated: boolean;
} {
  const allow: string[] = [];
  if (isPlainObject(parsed)) {
    const perm = (parsed as Record<string, unknown>).permissions;
    if (isPlainObject(perm)) {
      const rawAllow = (perm as Record<string, unknown>).allow;
      if (Array.isArray(rawAllow)) {
        for (const v of rawAllow) {
          if (typeof v === "string") {
            allow.push(redactPossibleSecrets(v));
          }
        }
      }
    }
  }

  const unique = uniqueSorted(allow);
  const sampleLimit = 25;
  return {
    permissionsAllowCount: unique.length,
    permissionsAllowSample: unique.slice(0, sampleLimit),
    permissionsAllowTruncated: unique.length > sampleLimit,
  };
}

function extractCursorHooksSummary(parsed: unknown): {
  hookEvents: string[];
  hookCommands: string[];
} {
  const hookEvents: string[] = [];
  const hookCommands: string[] = [];
  if (!isPlainObject(parsed)) {
    return { hookEvents, hookCommands };
  }

  const hooks = (parsed as Record<string, unknown>).hooks;
  if (!isPlainObject(hooks)) {
    return { hookEvents, hookCommands };
  }

  for (const [event, entries] of Object.entries(hooks)) {
    hookEvents.push(event);
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const e of entries) {
      if (!isPlainObject(e)) {
        continue;
      }
      const cmd = (e as Record<string, unknown>).command;
      if (typeof cmd === "string") {
        hookCommands.push(redactPossibleSecrets(cmd));
      }
    }
  }

  return {
    hookEvents: uniqueSorted(hookEvents),
    hookCommands: uniqueSorted(hookCommands),
  };
}

function summarizeAsset(
  kind: string,
  parsed: unknown
): Record<string, unknown> | undefined {
  if (kind === "claude-settings") {
    const hooks = extractClaudeHooksSummary(parsed);
    const perms = extractClaudePermissionsSummary(parsed);
    return { ...hooks, ...perms };
  }
  if (kind === "claude-plugin-hooks") {
    // Plugin hooks.json uses the same shape as Claude settings hooks.
    return extractClaudeHooksSummary(parsed);
  }
  if (kind === "claude-plugins") {
    if (!isPlainObject(parsed)) {
      return undefined;
    }
    const plugins = (parsed as Record<string, unknown>).plugins;
    if (!isPlainObject(plugins)) {
      return undefined;
    }
    const ids = Object.keys(plugins).sort();
    return {
      pluginCount: ids.length,
      pluginsSample: ids.slice(0, 25),
      pluginsTruncated: ids.length > 25,
    };
  }
  if (kind === "cursor-hook") {
    return extractCursorHooksSummary(parsed);
  }
  return undefined;
}

function uniqueSortedAssets(files: AssetFile[]): AssetFile[] {
  const seen = new Set<string>();
  const out: AssetFile[] = [];
  for (const f of files) {
    const key = `${f.kind}\0${f.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(f);
  }
  return out.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path)
  );
}

async function discoverAssetsFromSpecs(
  assets: SourceSpec["assets"],
  home: string
): Promise<AssetFile[]> {
  if (!assets || assets.length === 0) {
    return [];
  }

  const out: AssetFile[] = [];
  for (const spec of assets) {
    const paths = await expandPathPatterns(spec.patterns, home);
    for (const p of paths) {
      // Skip default sample hooks; they are not active hook scripts.
      if (spec.kind === "git-hook" && p.endsWith(".sample")) {
        continue;
      }
      const asset = await discoverAssetFile(p);
      if (asset) {
        // Re-parse (leniently) for known kinds so we can emit a safe summary.
        let summary: Record<string, unknown> | undefined;
        if (asset.format === "json" && !asset.error) {
          try {
            const parsed = await readJsonSafe(p);
            summary = summarizeAsset(spec.kind, parsed);
          } catch {
            // ignore summary errors; keep the file listed.
          }
        }
        out.push({
          ...asset,
          kind: spec.kind,
          summary: summary ?? asset.summary,
        });
      }
    }
  }
  return uniqueSortedAssets(out);
}

function defaultSourceSpecs(
  cwd: string,
  home: string,
  opts?: { includeGitHooks?: boolean }
): SourceSpec[] {
  const canonicalRoot = facultRootDir(home);
  const includeGitHooks = opts?.includeGitHooks ?? false;

  const specs: SourceSpec[] = [
    {
      id: "facult",
      name: "fclt (canonical)",
      candidates: [canonicalRoot],
      skillDirs: [join(canonicalRoot, "skills")],
      configFiles: [
        join(canonicalRoot, "mcp", "servers.json"),
        join(canonicalRoot, "mcp", "mcp.json"),
      ],
    },
    {
      id: "cursor",
      name: "Cursor",
      candidates: [
        "~/.cursor",
        "~/.cursr", // common typo; include if it exists
        "~/Library/Application Support/Cursor/User/settings.json",
        "~/AppData/Roaming/Cursor/User/settings.json",
        "~/AppData/Roaming/Cursor/mcp.json",
        "~/AppData/Roaming/Cursor",
        "~/.cursor/mcp.json",
        "~/.cursr/mcp.json",
      ],
      skillDirs: [
        "~/.cursor/skills",
        "~/.cursr/skills",
        "~/AppData/Roaming/Cursor/skills",
      ],
      configFiles: [
        "~/.cursor/mcp.json",
        "~/.cursr/mcp.json",
        "~/Library/Application Support/Cursor/User/settings.json",
        "~/AppData/Roaming/Cursor/User/settings.json",
        "~/AppData/Roaming/Cursor/mcp.json",
      ],
    },
    {
      id: "windsurf",
      name: "Windsurf",
      candidates: [
        "~/Library/Application Support/Windsurf/User/settings.json",
        "~/AppData/Roaming/Windsurf/User/settings.json",
        "~/Library/Application Support/Windsurf",
        "~/AppData/Roaming/Windsurf",
        "~/.windsurf",
      ],
      // Windsurf is VS Code-like; settings.json may contain mcpServers.
      configFiles: [
        "~/Library/Application Support/Windsurf/User/settings.json",
        "~/AppData/Roaming/Windsurf/User/settings.json",
      ],
    },
    {
      id: "vscode",
      name: "VS Code / VSCodium",
      candidates: [
        "~/Library/Application Support/Code/User/settings.json",
        "~/Library/Application Support/VSCodium/User/settings.json",
        "~/AppData/Roaming/Code/User/settings.json",
        "~/AppData/Roaming/VSCodium/User/settings.json",
      ],
      configFiles: [
        "~/Library/Application Support/Code/User/settings.json",
        "~/Library/Application Support/VSCodium/User/settings.json",
        "~/AppData/Roaming/Code/User/settings.json",
        "~/AppData/Roaming/VSCodium/User/settings.json",
      ],
    },
    {
      id: "codex",
      name: "Codex",
      candidates: [
        "~/.codex",
        "~/.config/openai",
        "~/.config/openai/codex.json",
        "~/AppData/Roaming/openai/codex.json",
        "~/AppData/Roaming/OpenAI/codex.json",
        "~/.codex/config.json",
        "~/.codex/config.toml",
        "~/.codex/mcp.json",
      ],
      skillDirs: ["~/.codex/skills"],
      configFiles: [
        "~/.config/openai/codex.json",
        "~/AppData/Roaming/openai/codex.json",
        "~/AppData/Roaming/OpenAI/codex.json",
        "~/.codex/config.json",
        "~/.codex/config.toml",
        "~/.codex/mcp.json",
      ],
    },
    {
      id: "claude",
      name: "Claude (CLI)",
      candidates: ["~/.claude", "~/.claude.json", "~/.config/claude"],
      skillDirs: ["~/.claude/skills", "~/.config/claude/skills"],
      configFiles: ["~/.claude.json"],
      assets: [
        {
          kind: "claude-settings",
          patterns: [
            "~/.claude/settings.json",
            "~/.claude/settings.local.json",
            "~/.config/claude/settings.json",
            "~/.config/claude/settings.local.json",
          ],
        },
        {
          kind: "claude-instructions",
          patterns: ["~/.claude/CLAUDE.md", "~/.config/claude/CLAUDE.md"],
        },
      ],
    },
    {
      id: "claude-plugins",
      name: "Claude plugins",
      candidates: [
        "~/.claude/plugins",
        "~/.claude/plugins/installed_plugins.json",
      ],
      assets: [
        {
          kind: "claude-plugins",
          patterns: ["~/.claude/plugins/installed_plugins.json"],
        },
      ],
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      candidates: [
        "~/Library/Application Support/Claude/claude_desktop_config.json",
        "~/Library/Application Support/Claude",
        "~/AppData/Roaming/Claude/claude_desktop_config.json",
        "~/AppData/Roaming/Claude",
      ],
      configFiles: [
        "~/Library/Application Support/Claude/claude_desktop_config.json",
        "~/AppData/Roaming/Claude/claude_desktop_config.json",
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
    {
      id: "codex-project",
      name: "Codex (project)",
      candidates: [join(cwd, ".codex")],
      skillDirs: [join(cwd, ".codex", "skills")],
      configFiles: [
        join(cwd, ".codex", "mcp.json"),
        join(cwd, ".codex", "mcp.config.json"),
        join(cwd, ".codex", "config.json"),
        join(cwd, ".codex", "config.toml"),
      ],
    },
    {
      id: "agents-project",
      name: "Agents (project)",
      candidates: [join(cwd, ".agents")],
      skillDirs: [join(cwd, ".agents", "skills")],
      configFiles: [
        join(cwd, ".agents", "mcp.json"),
        join(cwd, ".agents", "mcp.config.json"),
      ],
    },
    {
      id: "cursor-project",
      name: "Cursor (project)",
      candidates: [join(cwd, ".cursor")],
      assets: [
        { kind: "cursor-hook", patterns: [join(cwd, ".cursor", "hooks.json")] },
        {
          kind: "cursor-rule",
          patterns: [join(cwd, ".cursor", "rules", "**")],
        },
      ],
    },
    {
      id: "claude-project",
      name: "Claude (project)",
      candidates: [join(cwd, ".claude")],
      assets: [
        {
          kind: "claude-settings",
          patterns: [
            join(cwd, ".claude", "settings.json"),
            join(cwd, ".claude", "settings.local.json"),
          ],
        },
        {
          kind: "claude-instructions",
          patterns: [join(cwd, ".claude", "CLAUDE.md")],
        },
      ],
    },
  ];

  if (includeGitHooks) {
    specs.push({
      id: "git-hooks",
      name: "Git hooks (project)",
      candidates: [join(cwd, ".husky"), join(cwd, ".git", "hooks")],
      assets: [
        { kind: "husky", patterns: [join(cwd, ".husky", "**")] },
        { kind: "git-hook", patterns: [join(cwd, ".git", "hooks", "*")] },
      ],
    });
  }

  return specs;
}

export interface FromScanOptions {
  /** Directory basenames to skip while scanning `--from` roots. */
  ignoreDirNames: Set<string>;
  /** Max directories visited per `--from` root before truncating. */
  maxVisits: number;
  /** Max discovered paths (skills + configs + assets) per `--from` root before truncating. */
  maxResults: number;
  /** Include git hooks (`.git/hooks`) and Husky hooks (`.husky/**`) under `--from` roots. */
  includeGitHooks: boolean;
}

const DEFAULT_FROM_IGNORE_DIRS = new Set<string>([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "coverage",
  "Library", // macOS home dir is huge; default scan already covers tool configs there.
  "AppData", // Windows home dir is huge; default scan already covers tool configs there.
  "OrbStack", // Local container volumes; usually irrelevant and very noisy (e.g. *_node_modules).
  "Applications",
  "Desktop",
  "Documents",
  "Downloads",
  "Movies",
  "Music",
  "Pictures",
  "Public",
  "DerivedData",
  ".pnpm-store",
  ".yarn",
  "Pods",
  // These can be very large and are already covered by the default scan sources.
  "clawd",
  "clawdbot",
]);

async function listFilesRecursive(
  root: string,
  opts: { ignore: Set<string>; maxFiles: number }
): Promise<string[]> {
  const out: string[] = [];
  if (pathHasNodeModulesLikeSegment(root)) {
    return out;
  }
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) {
      continue;
    }
    if (pathHasNodeModulesLikeSegment(dir)) {
      continue;
    }
    let entries: any[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      if (!ent) {
        continue;
      }
      const name = String(ent.name ?? "");
      if (!name) {
        continue;
      }
      if (isNodeModulesLikeDirName(name)) {
        continue;
      }
      if (ent.isSymbolicLink?.()) {
        continue;
      }
      const abs = join(dir, name);
      if (ent.isDirectory?.()) {
        if (opts.ignore.has(name)) {
          continue;
        }
        // Avoid deep traversal into nested git dirs.
        if (name === ".git") {
          continue;
        }
        stack.push(abs);
        continue;
      }
      if (ent.isFile?.()) {
        out.push(abs);
        if (out.length >= opts.maxFiles) {
          return out;
        }
      }
    }
  }
  return out;
}

async function buildFromRootResult(args: {
  id: string;
  name: string;
  root: string;
  home: string;
  opts: FromScanOptions;
}): Promise<SourceResult> {
  const expanded = expandTilde(args.root, args.home);
  const abs = expanded.startsWith("/") ? expanded : resolve(expanded);

  const warnings: string[] = [];
  let truncated = false;

  if (!isSafePathString(abs)) {
    return {
      id: args.id,
      name: args.name,
      found: false,
      roots: [],
      evidence: [],
      truncated: false,
      warnings: [`Ignored unsafe path: ${args.root}`],
      assets: { files: [] },
      mcp: { configs: [] },
      skills: { roots: [], entries: [] },
    };
  }

  const st = await statSafe(abs);
  if (!st?.isDir) {
    return {
      id: args.id,
      name: args.name,
      found: false,
      roots: [],
      evidence: [],
      assets: { files: [] },
      mcp: { configs: [] },
      skills: { roots: [], entries: [] },
    };
  }

  const skillDirs = new Set<string>();
  const mcpConfigPaths = new Set<string>();
  const assetPaths: { kind: string; path: string }[] = [];

  const addResult = (n = 1) => {
    const total = skillDirs.size + mcpConfigPaths.size + assetPaths.length + n;
    if (total > args.opts.maxResults) {
      if (!truncated) {
        warnings.push(
          `Truncated scan for ${args.root}: exceeded maxResults=${args.opts.maxResults}`
        );
      }
      truncated = true;
      return false;
    }
    return true;
  };

  const addAsset = (kind: string, p: string) => {
    if (truncated) {
      return;
    }
    if (!addResult(1)) {
      return;
    }
    assetPaths.push({ kind, path: p });
  };

  const scanCursorDir = async (cursorDir: string) => {
    for (const name of ["mcp.json", "mcp.config.json"]) {
      const p = join(cursorDir, name);
      if ((await statSafe(p))?.isFile) {
        if (addResult(1)) {
          mcpConfigPaths.add(p);
        } else {
          return;
        }
      }
    }

    const hooksPath = join(cursorDir, "hooks.json");
    const hooksStat = await statSafe(hooksPath);
    if (hooksStat?.isFile) {
      addAsset("cursor-hook", hooksPath);
    }
    const rulesDir = join(cursorDir, "rules");
    const rulesStat = await statSafe(rulesDir);
    if (rulesStat?.isDir) {
      const files = await listFilesRecursive(rulesDir, {
        ignore: args.opts.ignoreDirNames,
        maxFiles: 2000,
      });
      for (const f of files) {
        addAsset("cursor-rule", f);
        if (truncated) {
          break;
        }
      }
    }
  };

  const scanClaudeDir = async (claudeDir: string) => {
    for (const name of ["settings.json", "settings.local.json"]) {
      const p = join(claudeDir, name);
      const s = await statSafe(p);
      if (s?.isFile) {
        addAsset("claude-settings", p);
      }
    }
    const md = join(claudeDir, "CLAUDE.md");
    if ((await statSafe(md))?.isFile) {
      addAsset("claude-instructions", md);
    }
  };

  const scanHuskyDir = async (huskyDir: string) => {
    const files = await listFilesRecursive(huskyDir, {
      ignore: args.opts.ignoreDirNames,
      maxFiles: 5000,
    });
    for (const f of files) {
      addAsset("husky", f);
      if (truncated) {
        break;
      }
    }
  };

  const scanGitHooksDir = async (gitDir: string) => {
    const hooksDir = join(gitDir, "hooks");
    const s = await statSafe(hooksDir);
    if (!s?.isDir) {
      return;
    }
    let entries: any[];
    try {
      entries = await readdir(hooksDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent?.isFile?.()) {
        continue;
      }
      const name = String(ent.name ?? "");
      if (!name || name.endsWith(".sample")) {
        continue;
      }
      addAsset("git-hook", join(hooksDir, name));
      if (truncated) {
        break;
      }
    }
  };

  const scanGitHooksFile = async (gitFile: string) => {
    const s = await statSafe(gitFile);
    if (!s?.isFile) {
      return;
    }

    let txt = "";
    try {
      txt = await Bun.file(gitFile).text();
    } catch {
      return;
    }

    const firstLine = (txt.split(FIRST_LINE_SPLIT_RE, 1)[0] ?? "").trim();
    const m = firstLine.match(GITDIR_LINE_RE);
    if (!m) {
      return;
    }

    const raw = (m[1] ?? "").trim();
    if (!raw) {
      return;
    }

    const gitDir = raw.startsWith("/") ? raw : resolve(dirname(gitFile), raw);
    if (!isSafePathString(gitDir)) {
      return;
    }

    if (!args.opts.includeGitHooks) {
      return;
    }

    // Worktrees may store hooks in the referenced gitdir or its commondir.
    await scanGitHooksDir(gitDir);

    const commonDirFile = join(gitDir, "commondir");
    const cs = await statSafe(commonDirFile);
    if (cs?.isFile) {
      let commonTxt = "";
      try {
        commonTxt = await Bun.file(commonDirFile).text();
      } catch {
        return;
      }
      const commonRel = (
        commonTxt.split(FIRST_LINE_SPLIT_RE, 1)[0] ?? ""
      ).trim();
      if (!commonRel) {
        return;
      }
      const commonDir = commonRel.startsWith("/")
        ? commonRel
        : resolve(gitDir, commonRel);
      if (!isSafePathString(commonDir)) {
        return;
      }
      await scanGitHooksDir(commonDir);
    }
  };

  const scanToolDotDir = async (toolDir: string) => {
    // These dot-directories can be very large (sessions/history/caches). We only care
    // about the standard config + skill entry locations inside them.
    for (const name of [
      "mcp.json",
      "mcp.config.json",
      "config.json",
      "config.toml",
      ".claude.json",
    ]) {
      const p = join(toolDir, name);
      if ((await statSafe(p))?.isFile) {
        if (addResult(1)) {
          mcpConfigPaths.add(p);
        } else {
          return;
        }
      }
    }

    // Common instruction/rules files sometimes live inside tool dot-dirs too.
    const agentsMd = join(toolDir, "AGENTS.md");
    const agentsMdLower = join(toolDir, "agents.md");
    const claudeMd = join(toolDir, "CLAUDE.md");
    const cursorRules = join(toolDir, ".cursorrules");
    if ((await statSafe(agentsMd))?.isFile) {
      addAsset("agents-instructions", agentsMd);
    } else if ((await statSafe(agentsMdLower))?.isFile) {
      addAsset("agents-instructions", agentsMdLower);
    }
    if ((await statSafe(claudeMd))?.isFile) {
      addAsset("claude-instructions", claudeMd);
    }
    if ((await statSafe(cursorRules))?.isFile) {
      addAsset("cursor-rules-file", cursorRules);
    }

    const skillsDir = join(toolDir, "skills");
    if ((await statSafe(skillsDir))?.isDir) {
      const entries = await listSkillEntries(skillsDir);
      for (const skillDir of entries) {
        if (!addResult(1)) {
          return;
        }
        skillDirs.add(skillDir);
      }
    }
  };

  const MCP_NAMES = new Set([
    "mcp.json",
    "mcp.config.json",
    "claude_desktop_config.json",
    ".claude.json",
  ]);

  let visits = 0;
  const walk = async (dir: string) => {
    if (truncated) {
      return;
    }
    visits += 1;
    if (visits > args.opts.maxVisits) {
      truncated = true;
      warnings.push(
        `Truncated scan for ${args.root}: exceeded maxVisits=${args.opts.maxVisits}`
      );
      return;
    }

    let entries: any[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const hasGit = entries.some(
      (e) =>
        (e?.isDirectory?.() || e?.isFile?.()) &&
        String(e?.name ?? "") === ".git"
    );

    // Fast file checks in this directory.
    for (const ent of entries) {
      if (!ent?.isFile?.()) {
        continue;
      }
      const name = String(ent.name ?? "");
      if (name === ".git" && args.opts.includeGitHooks) {
        await scanGitHooksFile(join(dir, name));
      }
      if (name === "SKILL.md") {
        if (addResult(1)) {
          skillDirs.add(dir);
        } else {
          return;
        }
      }
      if (name === "AGENTS.md" || name === "agents.md") {
        addAsset("agents-instructions", join(dir, name));
      }
      if (name === "CLAUDE.md") {
        addAsset("claude-instructions", join(dir, name));
      }
      if (name === ".cursorrules") {
        addAsset("cursor-rules-file", join(dir, name));
      }
      if (MCP_NAMES.has(name)) {
        if (addResult(1)) {
          mcpConfigPaths.add(join(dir, name));
        } else {
          return;
        }
      }
    }

    // Handle special directories we care about.
    for (const ent of entries) {
      if (!ent?.isDirectory?.()) {
        continue;
      }
      const name = String(ent.name ?? "");
      if (!name) {
        continue;
      }
      if (ent.isSymbolicLink?.()) {
        continue;
      }

      if (isNodeModulesLikeDirName(name)) {
        continue;
      }

      const child = join(dir, name);

      if (name === ".git") {
        if (args.opts.includeGitHooks) {
          await scanGitHooksDir(child);
        }
        continue;
      }
      if (name === ".cursor") {
        await scanCursorDir(child);
        continue;
      }
      if (name === ".claude") {
        await scanClaudeDir(child);
        continue;
      }
      if (name === ".vscode") {
        // VS Code-like settings are commonly JSONC and may contain per-project MCP servers.
        const settings = join(child, "settings.json");
        if ((await statSafe(settings))?.isFile) {
          if (addResult(1)) {
            mcpConfigPaths.add(settings);
          } else {
            return;
          }
        }
        continue;
      }
      if (name === ".husky") {
        if (args.opts.includeGitHooks) {
          await scanHuskyDir(child);
        }
        continue;
      }
      if (name === ".codex" || name === ".agents" || name === ".clawdbot") {
        await scanToolDotDir(child);
        continue;
      }

      // Skills directories are typically called "skills"; scan them and don't descend further.
      if (name === "skills") {
        if (addResult(1)) {
          const entries = await listSkillEntries(child);
          for (const skillDir of entries) {
            if (!addResult(1)) {
              return;
            }
            skillDirs.add(skillDir);
          }
        }
        continue;
      }

      // Avoid traversing arbitrary hidden directories while scanning broad roots like `--from ~`.
      // We only descend into dot-dirs we explicitly understand (handled above).
      if (name.startsWith(".")) {
        continue;
      }

      // Respect ignore list under --from scans.
      if (args.opts.ignoreDirNames.has(name)) {
        continue;
      }

      // If this directory is a git repo root, don't recurse into its whole tree. We'll still
      // catch root-level agent configs via the special-directory checks above, plus skill dirs.
      if (hasGit) {
        continue;
      }

      await walk(child);
      if (truncated) {
        return;
      }
    }
  };

  await walk(abs);

  // Build normalized scan output using the existing safe parsers/summarizers.
  const skillsEntries = uniqueSorted([...skillDirs]);

  const mcpConfigs: McpConfig[] = [];
  for (const p of uniqueSorted([...mcpConfigPaths])) {
    const cfg = await discoverMcpConfig(p);
    if (cfg) {
      mcpConfigs.push(cfg);
    }
  }

  const discoveredAssets: AssetFile[] = [];
  for (const a of assetPaths) {
    const asset = await discoverAssetFile(a.path);
    if (!asset) {
      continue;
    }
    // Re-parse for known kinds so we can emit a safe summary.
    let summary: Record<string, unknown> | undefined;
    if (asset.format === "json" && !asset.error) {
      try {
        const parsed = await readJsonSafe(a.path);
        summary = summarizeAsset(a.kind, parsed);
      } catch {
        // ignore summary errors; keep the file listed.
      }
    }
    discoveredAssets.push({
      ...asset,
      kind: a.kind,
      summary: summary ?? asset.summary,
    });
  }

  const found =
    skillsEntries.length > 0 ||
    mcpConfigs.length > 0 ||
    discoveredAssets.length > 0;

  return {
    id: args.id,
    name: args.name,
    found,
    roots: [abs],
    evidence: [abs],
    truncated: truncated || undefined,
    warnings: warnings.length ? warnings : undefined,
    assets: { files: uniqueSortedAssets(discoveredAssets) },
    mcp: {
      configs: uniqueSorted(mcpConfigs.map((c) => JSON.stringify(c))).map((s) =>
        JSON.parse(s)
      ),
    },
    skills: {
      roots: [abs],
      entries: skillsEntries,
    },
  };
}

async function discoverRootsAndEvidence(
  candidates: string[],
  home: string
): Promise<{ roots: string[]; evidence: string[] }> {
  const roots: string[] = [];
  const evidence: string[] = [];
  const candidatePaths = await expandPathPatterns(candidates, home);
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
  skillDirs: string[],
  home: string
): Promise<{ roots: string[]; entries: string[] }> {
  const skillRoots = await expandPathPatterns(skillDirs, home);
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

async function buildSourceResult(
  spec: SourceSpec,
  home: string
): Promise<SourceResult> {
  const { roots, evidence } = await discoverRootsAndEvidence(
    spec.candidates,
    home
  );
  const skills = await discoverSkillsFromDirs(spec.skillDirs ?? [], home);
  const assets = await discoverAssetsFromSpecs(spec.assets, home);

  const configs: McpConfig[] = [];
  const configPaths = await expandPathPatterns(spec.configFiles ?? [], home);
  for (const p of configPaths) {
    const cfg = await discoverMcpConfig(p);
    if (cfg) {
      configs.push(cfg);
    }
  }

  // Also opportunistically detect common MCP filenames under any discovered roots.
  configs.push(...(await discoverMcpConfigsFromRoots(uniqueSorted(roots))));

  // Claude plugins are stored under ~/.claude/plugins/cache/... and can include skills and hooks.
  // To avoid scanning the whole cache, use installed_plugins.json to find active install paths.
  if (spec.id === "claude-plugins") {
    const installedPath = join(
      home,
      ".claude",
      "plugins",
      "installed_plugins.json"
    );
    const st = await statSafe(installedPath);
    if (st?.isFile) {
      try {
        const parsed = await readJsonSafe(installedPath);
        const plugins = isPlainObject(parsed)
          ? ((parsed as Record<string, unknown>).plugins as unknown)
          : null;
        const installPaths = new Set<string>();
        if (isPlainObject(plugins)) {
          for (const entries of Object.values(plugins)) {
            if (!Array.isArray(entries)) {
              continue;
            }
            for (const ent of entries) {
              if (!isPlainObject(ent)) {
                continue;
              }
              const installPath = (ent as Record<string, unknown>).installPath;
              if (typeof installPath === "string" && installPath) {
                installPaths.add(installPath);
              }
            }
          }
        }

        const extraSkillRoots: string[] = [];
        const extraSkillEntries: string[] = [];
        const extraAssets: AssetFile[] = [];

        const addAsset = async (kind: string, p: string) => {
          const asset = await discoverAssetFile(p);
          if (!asset) {
            return;
          }
          let summary: Record<string, unknown> | undefined;
          if (asset.format === "json" && !asset.error) {
            try {
              const parsed = await readJsonSafe(p);
              summary = summarizeAsset(kind, parsed);
            } catch {
              // ignore summary errors
            }
          }
          extraAssets.push({
            ...asset,
            kind,
            summary: summary ?? asset.summary,
          });
        };

        for (const installPath of [...installPaths].sort()) {
          const skillsDir = join(installPath, "skills");
          if ((await statSafe(skillsDir))?.isDir) {
            extraSkillRoots.push(skillsDir);
            extraSkillEntries.push(...(await listSkillEntries(skillsDir)));
          }

          // Add hooks config and scripts (if any).
          const hooksDir = join(installPath, "hooks");
          if ((await statSafe(hooksDir))?.isDir) {
            const glob = new Bun.Glob("hooks/**/*");
            let n = 0;
            for await (const rel of glob.scan({
              cwd: installPath,
              onlyFiles: true,
            })) {
              // Prevent pathological caches from exploding scan size.
              n += 1;
              if (n > 500) {
                break;
              }
              const abs = join(installPath, rel);
              const kind =
                rel === "hooks/hooks.json"
                  ? "claude-plugin-hooks"
                  : "claude-plugin-hook";
              await addAsset(kind, abs);
            }
          }
        }

        skills.roots.push(...extraSkillRoots);
        skills.entries.push(...extraSkillEntries);
        assets.push(...extraAssets);
      } catch {
        // ignore parse errors; installed_plugins.json is already listed as an asset for inspection.
      }
    }
  }

  const found =
    evidence.length > 0 ||
    configs.length > 0 ||
    skills.entries.length > 0 ||
    assets.length > 0;

  return {
    id: spec.id,
    name: spec.name,
    found,
    roots: uniqueSorted(roots),
    evidence: uniqueSorted(evidence),
    assets: { files: uniqueSortedAssets(assets) },
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

function printSourceAssets(assets: SourceResult["assets"]) {
  const files = assets.files;
  if (files.length) {
    console.log("  Assets:");
    for (const f of files) {
      const err = f.error ? ` (error: ${f.error})` : "";
      let summary = "";
      const hookEvents = Array.isArray(f.summary?.hookEvents)
        ? (f.summary?.hookEvents as unknown[]).map(String)
        : [];
      const hookCommands = Array.isArray(f.summary?.hookCommands)
        ? (f.summary?.hookCommands as unknown[]).map(String)
        : [];
      const allowCount =
        typeof f.summary?.permissionsAllowCount === "number"
          ? (f.summary.permissionsAllowCount as number)
          : null;

      if (hookEvents.length || hookCommands.length || allowCount !== null) {
        const parts: string[] = [];
        if (hookEvents.length) {
          parts.push(
            `hooks=${hookEvents.slice(0, 6).join(", ")}${hookEvents.length > 6 ? ", ..." : ""}`
          );
        }
        if (hookCommands.length) {
          parts.push(
            `commands=${hookCommands.slice(0, 3).join(" | ")}${hookCommands.length > 3 ? " | ..." : ""}`
          );
        }
        if (allowCount !== null) {
          parts.push(`permissions.allow=${allowCount}`);
        }
        summary = parts.length ? ` (${parts.join("; ")})` : "";
      }

      console.log(`    - ${f.kind}: ${f.path}${summary}${err}`);
    }
  } else {
    console.log("  Assets: (none)");
  }
}

function printHuman(res: ScanResult) {
  console.log(`fclt scan — ${res.scannedAt}`);
  console.log("");

  const foundSources = res.sources.filter((s) => s.found);
  if (foundSources.length === 0) {
    console.log("No known sources found.");
    return;
  }

  console.log("Discovered sources:");
  for (const s of foundSources) {
    const roots = s.roots.length ? s.roots : s.evidence;
    const trunc = s.truncated ? " (truncated)" : "";
    console.log(
      `- ${s.name}${trunc}${roots.length ? `: ${roots.join(", ")}` : ""}`
    );
  }

  console.log("");

  for (const s of foundSources) {
    console.log(`${s.name}`);
    printSourceMcpConfigs(s.mcp.configs);
    printSourceSkills(s.skills);
    printSourceAssets(s.assets);
    if (s.warnings?.length) {
      for (const w of s.warnings) {
        console.log(`  Warning: ${w}`);
      }
    }
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

interface McpServerOccurrence {
  name: string;
  count: number;
  locations: string[];
  /** Number of distinct sanitized definitions observed across configs (best-effort). */
  variants?: number;
}

function computeMcpServerOccurrences(res: ScanResult): McpServerOccurrence[] {
  const byName = new Map<
    string,
    { count: number; locations: Set<string>; variants?: number }
  >();

  for (const src of res.sources) {
    for (const cfg of src.mcp.configs) {
      for (const name of cfg.servers ?? []) {
        const cur = byName.get(name) ?? {
          count: 0,
          locations: new Set<string>(),
        };
        cur.count += 1;
        cur.locations.add(`${src.id}:${cfg.path}`);
        byName.set(name, cur);
      }
    }
  }

  return [...byName.entries()]
    .map(([name, v]) => ({
      name,
      count: v.count,
      locations: [...v.locations].sort(),
      variants: v.variants,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function extractMcpServersObject(
  parsed: unknown
): Record<string, unknown> | null {
  if (!isPlainObject(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (isPlainObject(obj.mcpServers)) {
    return obj.mcpServers as Record<string, unknown>;
  }
  // Some VS Code-like settings store this under a tool-prefixed key.
  for (const [k, v] of Object.entries(obj)) {
    if (k.endsWith(".mcpServers") && isPlainObject(v)) {
      return v as Record<string, unknown>;
    }
  }
  if (isPlainObject(obj["mcp.servers"])) {
    return obj["mcp.servers"] as Record<string, unknown>;
  }
  if (isPlainObject(obj.servers)) {
    return obj.servers as Record<string, unknown>;
  }
  if (isPlainObject(obj.mcp)) {
    const mcp = obj.mcp as Record<string, unknown>;
    if (isPlainObject(mcp.servers)) {
      return mcp.servers as Record<string, unknown>;
    }
  }
  return null;
}

function mcpSafeDefinitionText(definition: unknown): string {
  // Best-effort sanitization: include structural fields and env keys, not env values.
  if (!isPlainObject(definition)) {
    return String(definition);
  }

  const obj = definition as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof obj.transport === "string") {
    out.transport = obj.transport;
  }
  if (typeof obj.command === "string") {
    out.command = redactPossibleSecrets(obj.command);
  }
  if (Array.isArray(obj.args)) {
    out.args = obj.args.map((v) => redactPossibleSecrets(String(v)));
  }
  if (typeof obj.url === "string") {
    out.url = redactPossibleSecrets(obj.url);
  }
  if (isPlainObject(obj.env)) {
    out.envKeys = Object.keys(obj.env as Record<string, unknown>).sort();
  }
  if (isPlainObject(obj.vendorExtensions)) {
    out.vendorKeys = Object.keys(
      obj.vendorExtensions as Record<string, unknown>
    ).sort();
  }
  return JSON.stringify(out, null, 2);
}

async function computeMcpDefinitionVariantCounts(
  res: ScanResult
): Promise<Map<string, number>> {
  const byServer = new Map<string, Set<string>>();

  for (const src of res.sources) {
    for (const cfg of src.mcp.configs) {
      if (cfg.format === "toml") {
        let txt: string;
        try {
          txt = await Bun.file(cfg.path).text();
        } catch {
          continue;
        }
        const blocks = extractCodexTomlMcpServerBlocks(txt);
        for (const [serverName, blockText] of Object.entries(blocks)) {
          const safe = sanitizeCodexTomlMcpText(blockText);
          const hash = sha256Hex(safe);
          const set = byServer.get(serverName) ?? new Set<string>();
          set.add(hash);
          byServer.set(serverName, set);
        }
        continue;
      }

      if (cfg.format !== "json") {
        continue;
      }
      let parsed: unknown;
      try {
        const txt = await Bun.file(cfg.path).text();
        parsed = parseJsonLenient(txt);
      } catch {
        continue;
      }

      const serversObj = extractMcpServersObject(parsed);
      if (!serversObj) {
        continue;
      }

      for (const [serverName, definition] of Object.entries(serversObj)) {
        const safe = mcpSafeDefinitionText(definition);
        const hash = sha256Hex(safe);
        const set = byServer.get(serverName) ?? new Set<string>();
        set.add(hash);
        byServer.set(serverName, set);
      }
    }
  }

  const out = new Map<string, number>();
  for (const [name, hashes] of byServer.entries()) {
    out.set(name, hashes.size);
  }
  return out;
}

async function computeAssetContentDuplicates(
  res: ScanResult
): Promise<
  { kind: string; hash: string; count: number; locations: string[] }[]
> {
  const sanitizeJson = (value: unknown): unknown => {
    if (typeof value === "string") {
      return redactPossibleSecrets(value);
    }
    if (Array.isArray(value)) {
      return value.slice(0, 500).map(sanitizeJson);
    }
    if (!isPlainObject(value)) {
      return value;
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (SECRET_ENV_KEY_RE.test(k)) {
        out[k] = "<redacted>";
      } else {
        out[k] = sanitizeJson(v);
      }
    }
    return out;
  };

  const groups = new Map<
    string,
    { kind: string; hash: string; locations: Set<string> }
  >();

  for (const src of res.sources) {
    for (const f of src.assets.files) {
      const file = Bun.file(f.path);
      if (!(await file.exists())) {
        continue;
      }
      let text: string;
      try {
        text = await file.text();
      } catch {
        continue;
      }

      // Avoid hashing arbitrarily large blobs.
      const MAX_CHARS = 200_000;
      if (text.length > MAX_CHARS) {
        text = text.slice(0, MAX_CHARS);
      }

      let safeText = redactPossibleSecrets(text);
      if (f.format === "json") {
        try {
          const parsed = parseJsonLenient(text);
          safeText = JSON.stringify(sanitizeJson(parsed), null, 2);
        } catch {
          // keep redacted raw text
        }
      }

      const hash = sha256Hex(safeText);
      const key = `${f.kind}\0${hash}`;
      const cur = groups.get(key) ?? {
        kind: f.kind,
        hash,
        locations: new Set<string>(),
      };
      cur.locations.add(`${src.id}:${f.path}`);
      groups.set(key, cur);
    }
  }

  return [...groups.values()]
    .map((v) => ({
      kind: v.kind,
      hash: v.hash,
      count: v.locations.size,
      locations: [...v.locations].sort(),
    }))
    .filter((v) => v.count > 1)
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.kind.localeCompare(b.kind) ||
        a.hash.localeCompare(b.hash)
    );
}

function _printSkillsTable(res: ScanResult) {
  const all = computeSkillOccurrences(res);

  console.log(`fclt scan — ${res.scannedAt}`);
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

function printSkillDuplicatesTable(res: ScanResult) {
  const all = computeSkillOccurrences(res).filter((d) => d.count > 1);

  console.log(`fclt scan — ${res.scannedAt}`);
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

async function printMcpDuplicatesTable(res: ScanResult) {
  const all = computeMcpServerOccurrences(res).filter((d) => d.count > 1);
  const variants = await computeMcpDefinitionVariantCounts(res);

  console.log(
    "Duplicate MCP servers (same server name appears in multiple config files):"
  );

  if (all.length === 0) {
    console.log("(none)");
    return;
  }

  const rows = all.map((d) => ({
    name: d.name,
    count: String(d.count),
    variants: String(variants.get(d.name) ?? 0),
    sources: sourcesFromLocations(d.locations).join(", "),
  }));

  const wName = Math.max("SERVER".length, ...rows.map((r) => r.name.length));
  const wCount = Math.max("COUNT".length, ...rows.map((r) => r.count.length));
  const wVar = Math.max("VAR".length, ...rows.map((r) => r.variants.length));

  console.log(
    `${"SERVER".padEnd(wName)}  ${"COUNT".padStart(wCount)}  ${"VAR".padStart(wVar)}  SOURCES`
  );
  console.log(
    `${"-".repeat(wName)}  ${"-".repeat(wCount)}  ${"-".repeat(wVar)}  ${"-".repeat("SOURCES".length)}`
  );

  for (const r of rows) {
    console.log(
      `${r.name.padEnd(wName)}  ${r.count.padStart(wCount)}  ${r.variants.padStart(wVar)}  ${r.sources}`
    );
  }
}

async function printAssetDuplicatesTable(res: ScanResult) {
  const all = await computeAssetContentDuplicates(res);

  console.log(
    "Duplicate assets (same kind + same sanitized content appears in multiple places):"
  );

  if (all.length === 0) {
    console.log("(none)");
    return;
  }

  const rows = all.map((d) => ({
    kind: d.kind,
    count: String(d.count),
    hash: d.hash.slice(0, 10),
    sources: sourcesFromLocations(d.locations).join(", "),
  }));

  const wKind = Math.max("KIND".length, ...rows.map((r) => r.kind.length));
  const wCount = Math.max("COUNT".length, ...rows.map((r) => r.count.length));
  const wHash = Math.max("HASH".length, ...rows.map((r) => r.hash.length));

  console.log(
    `${"KIND".padEnd(wKind)}  ${"COUNT".padStart(wCount)}  ${"HASH".padEnd(wHash)}  SOURCES`
  );
  console.log(
    `${"-".repeat(wKind)}  ${"-".repeat(wCount)}  ${"-".repeat(wHash)}  ${"-".repeat("SOURCES".length)}`
  );
  for (const r of rows) {
    console.log(
      `${r.kind.padEnd(wKind)}  ${r.count.padStart(wCount)}  ${r.hash.padEnd(wHash)}  ${r.sources}`
    );
  }
}

async function printDuplicatesReport(res: ScanResult) {
  printSkillDuplicatesTable(res);
  console.log("");
  await printMcpDuplicatesTable(res);
  console.log("");
  await printAssetDuplicatesTable(res);
}

async function ensureDir(p: string) {
  await mkdir(p, { recursive: true });
}

export async function scan(
  _argv: string[],
  opts?: {
    cwd?: string;
    homeDir?: string;
    /** Include scan defaults from `~/.ai/.facult/config.json` (scanFrom*). */
    includeConfigFrom?: boolean;
    /** Include git hooks + Husky hooks in results (can be noisy). Default: false. */
    includeGitHooks?: boolean;
    from?: string[];
    fromOptions?: {
      /** Disable the default ignore list for `--from` scans. */
      noDefaultIgnore?: boolean;
      /** Add directory basenames to ignore for `--from` scans. */
      ignoreDirNames?: string[];
      /** Override max directories visited per `--from` root. */
      maxVisits?: number;
      /** Override max discovered paths per `--from` root. */
      maxResults?: number;
    };
  }
): Promise<ScanResult> {
  const cwd = opts?.cwd ?? process.cwd();
  const home = opts?.homeDir ?? homedir();
  const includeGitHooks = opts?.includeGitHooks ?? false;

  const cfg = opts?.includeConfigFrom ? readFacultConfig(home) : null;

  const noDefaultIgnore =
    opts?.fromOptions?.noDefaultIgnore ?? cfg?.scanFromNoDefaultIgnore ?? false;

  const ignore = new Set<string>(
    noDefaultIgnore ? [] : [...DEFAULT_FROM_IGNORE_DIRS]
  );
  for (const name of cfg?.scanFromIgnore ?? []) {
    if (name) {
      ignore.add(name);
    }
  }
  for (const name of opts?.fromOptions?.ignoreDirNames ?? []) {
    if (name) {
      ignore.add(name);
    }
  }

  const fromOpts: FromScanOptions = {
    ignoreDirNames: ignore,
    // Keep `--from ~` usable by default; users can still tune this down/up via flags.
    maxVisits:
      opts?.fromOptions?.maxVisits ?? cfg?.scanFromMaxVisits ?? 200_000,
    maxResults:
      opts?.fromOptions?.maxResults ?? cfg?.scanFromMaxResults ?? 20_000,
    includeGitHooks,
  };

  const specs = [...defaultSourceSpecs(cwd, home, { includeGitHooks })];
  const sources: SourceResult[] = [];
  for (const spec of specs) {
    sources.push(await buildSourceResult(spec, home));
  }

  const fromRootsInput = [...(cfg?.scanFrom ?? []), ...(opts?.from ?? [])];
  const fromRoots: string[] = [];
  const seenAbs = new Set<string>();
  for (const root of fromRootsInput) {
    const expanded = expandTilde(root, home);
    const abs = expanded.startsWith("/") ? expanded : resolve(expanded);
    if (!isSafePathString(abs)) {
      continue;
    }
    if (seenAbs.has(abs)) {
      continue;
    }
    seenAbs.add(abs);
    fromRoots.push(root);
  }

  for (let i = 0; i < fromRoots.length; i += 1) {
    const root = fromRoots[i]!;
    const id = `from-${i + 1}`;
    sources.push(
      await buildFromRootResult({
        id,
        name: `From: ${root}`,
        root,
        home,
        opts: fromOpts,
      })
    );
  }

  return {
    version: 6,
    scannedAt: new Date().toISOString(),
    cwd,
    sources,
  };
}

export async function writeState(res: ScanResult) {
  const stateDir = facultStateDir(homedir());
  await ensureDir(stateDir);
  const outPath = join(stateDir, "sources.json");
  await Bun.write(outPath, `${JSON.stringify(res, null, 2)}\n`);
}

function printScanHelp() {
  console.log(`fclt scan — inventory local agent configs across tools

Usage:
  fclt scan [--json] [--show-duplicates] [--tui]
  fclt scan --from <path> [--from <path> ...]

Notes:
  - If no --from roots are provided and no scanFrom is configured, fclt defaults to scanning ~.

Options:
  --json              Print full JSON (ScanResult)
  --show-duplicates   Print duplicates for skills, MCP servers, and hook assets
  --tui               Render scan output in an interactive TUI (skills list)
  --no-config-from    Disable default scan roots from ~/.ai/.facult/config.json (scanFrom)
  --from              Add one or more additional scan roots (repeatable): --from ~/dev
  --include-git-hooks Include git hooks (.git/hooks) and husky hooks (.husky/**) (noisy)
  --from-ignore       (scan) Ignore directories by basename under --from roots (repeatable)
  --from-no-default-ignore  (scan) Disable the default ignore list for --from scans
  --from-max-visits   (scan) Max directories visited per --from root before truncating
  --from-max-results  (scan) Max discovered paths per --from root before truncating
`);
}

export async function scanCommand(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printScanHelp();
    return;
  }

  const json = argv.includes("--json");
  const showDuplicates = argv.includes("--show-duplicates");
  const tui = argv.includes("--tui");
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
        console.error("--from requires a path");
        process.exitCode = 2;
        return;
      }
      from.push(next);
      i += 1;
      continue;
    }
    if (arg.startsWith("--from=")) {
      const value = arg.slice("--from=".length);
      if (!value) {
        console.error("--from requires a path");
        process.exitCode = 2;
        return;
      }
      from.push(value);
      continue;
    }

    if (arg === "--from-ignore") {
      const next = argv[i + 1];
      if (!next) {
        console.error("--from-ignore requires a directory name");
        process.exitCode = 2;
        return;
      }
      fromIgnore.push(next);
      i += 1;
      continue;
    }
    if (arg.startsWith("--from-ignore=")) {
      const value = arg.slice("--from-ignore=".length);
      if (!value) {
        console.error("--from-ignore requires a directory name");
        process.exitCode = 2;
        return;
      }
      fromIgnore.push(value);
      continue;
    }
    if (arg === "--from-no-default-ignore") {
      fromNoDefaultIgnore = true;
      continue;
    }
    if (arg === "--from-max-visits") {
      const next = argv[i + 1];
      if (!next) {
        console.error("--from-max-visits requires a number");
        process.exitCode = 2;
        return;
      }
      const n = Number(next);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`Invalid --from-max-visits value: ${next}`);
        process.exitCode = 2;
        return;
      }
      fromMaxVisits = Math.floor(n);
      i += 1;
      continue;
    }
    if (arg.startsWith("--from-max-visits=")) {
      const raw = arg.slice("--from-max-visits=".length);
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`Invalid --from-max-visits value: ${raw}`);
        process.exitCode = 2;
        return;
      }
      fromMaxVisits = Math.floor(n);
      continue;
    }
    if (arg === "--from-max-results") {
      const next = argv[i + 1];
      if (!next) {
        console.error("--from-max-results requires a number");
        process.exitCode = 2;
        return;
      }
      const n = Number(next);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`Invalid --from-max-results value: ${next}`);
        process.exitCode = 2;
        return;
      }
      fromMaxResults = Math.floor(n);
      i += 1;
      continue;
    }
    if (arg.startsWith("--from-max-results=")) {
      const raw = arg.slice("--from-max-results=".length);
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`Invalid --from-max-results value: ${raw}`);
        process.exitCode = 2;
        return;
      }
      fromMaxResults = Math.floor(n);
    }
  }

  // For universal inventory, default to scanning the home directory when the user
  // didn't specify any `--from` roots and there isn't a configured default set.
  // Users can disable this with `--no-config-from`.
  if (!noConfigFrom && from.length === 0) {
    const cfg = readFacultConfig();
    if (!(cfg?.scanFrom && cfg.scanFrom.length > 0)) {
      from.push("~");
    }
  }

  const res = await scan(argv, {
    includeConfigFrom: !noConfigFrom,
    includeGitHooks,
    from,
    fromOptions: {
      ignoreDirNames: fromIgnore,
      noDefaultIgnore: fromNoDefaultIgnore,
      maxVisits: fromMaxVisits,
      maxResults: fromMaxResults,
    },
  });
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
    await printDuplicatesReport(res);
  } else {
    printHuman(res);
  }

  console.log(
    `State written to ${join(facultStateDir(homedir()), "sources.json")}`
  );
}
