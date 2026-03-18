import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { buildIndex } from "./index-builder";
import { facultRootDir } from "./paths";
import {
  assertManifestIntegrity,
  assertManifestSignature,
} from "./remote-manifest-integrity";
import { loadProviderManifest } from "./remote-providers";
import {
  assertSourceAllowed,
  evaluateSourceTrust,
  sourcesCommand as runSourcesCommand,
} from "./remote-source-policy";
import { readIndexSources, resolveKnownIndexSource } from "./remote-sources";
import {
  BUILTIN_INDEX_NAME,
  BUILTIN_INDEX_URL,
  CLAWHUB_INDEX_NAME,
  GLAMA_INDEX_NAME,
  type IndexSource,
  type LoadManifestHints,
  type RemoteAgentItem,
  type RemoteIndexItem,
  type RemoteIndexManifest,
  type RemoteItemType,
  type RemoteMcpItem,
  type RemoteSkillItem,
  type RemoteSnippetItem,
  SKILLS_SH_INDEX_NAME,
  SMITHERY_INDEX_NAME,
} from "./remote-types";
import { validateSnippetMarkerName } from "./snippets";
import { loadSourceTrustState, type SourceTrustLevel } from "./source-trust";
import { parseJsonLenient } from "./util/json";

const REMOTE_STATE_VERSION = 1;
const VERSION_TOKEN_RE = /[A-Za-z]+|[0-9]+/g;
const QUERY_SPLIT_RE = /\s+/;
const MD_EXT_RE = /\.md$/i;

interface InstalledRemoteItem {
  ref: string;
  index: string;
  itemId: string;
  type: RemoteItemType;
  installedAs: string;
  path: string;
  version?: string;
  sourceUrl?: string;
  sourceTrustLevel?: SourceTrustLevel;
  installedAt: string;
}

interface InstalledRemoteState {
  version: number;
  updatedAt: string;
  items: InstalledRemoteItem[];
}

interface RemoteCommandContext {
  homeDir?: string;
  rootDir?: string;
  cwd?: string;
  now?: () => Date;
  fetchJson?: (url: string) => Promise<unknown>;
  fetchText?: (url: string) => Promise<string>;
  strictSourceTrust?: boolean;
}

interface SearchResult {
  index: string;
  item: RemoteIndexItem;
  score: number;
}

interface InstallResult {
  ref: string;
  type: RemoteItemType;
  installedAs: string;
  path: string;
  sourceTrustLevel: SourceTrustLevel;
  dryRun: boolean;
  changedPaths: string[];
}

interface UpdateCheckResult {
  installed: InstalledRemoteItem;
  latestVersion?: string;
  currentVersion?: string;
  status:
    | "up-to-date"
    | "outdated"
    | "missing-index"
    | "missing-item"
    | "blocked-source"
    | "review-source";
}

interface UpdateReport {
  checkedAt: string;
  checks: UpdateCheckResult[];
  applied: InstallResult[];
}

type VerifyCheckStatus =
  | "passed"
  | "failed"
  | "not-configured"
  | "not-applicable";

interface VerifySourceReport {
  checkedAt: string;
  source: {
    name: string;
    url: string;
    kind: IndexSource["kind"];
  };
  trust: {
    level: SourceTrustLevel;
    explicit: boolean;
    note?: string;
    updatedAt?: string;
  };
  checks: {
    fetch: VerifyCheckStatus;
    parse: VerifyCheckStatus;
    integrity: VerifyCheckStatus;
    signature: VerifyCheckStatus;
    items: number;
  };
  error?: string;
}

const BUILTIN_MANIFEST: RemoteIndexManifest = {
  name: BUILTIN_INDEX_NAME,
  url: BUILTIN_INDEX_URL,
  updatedAt: "2026-02-21T00:00:00.000Z",
  items: [
    {
      id: "skill-template",
      type: "skill",
      title: "Skill Template",
      description:
        "Production-ready SKILL.md scaffold with clear trigger, workflow, and output sections.",
      version: "1.0.0",
      tags: ["template", "dx", "skill"],
      skill: {
        name: "my-skill",
        files: {
          "SKILL.md": `---
description: "{{name}} workflow skill"
tags: [template, workflow]
---

# {{name}}

## When To Use
Use this skill when the task repeatedly follows a known workflow and you want consistent, reviewable outputs.

## Inputs
- Goal and expected outcome.
- Constraints (time, tooling, compatibility).
- Required artifacts (files, commands, links).

## Steps
1. Confirm scope and assumptions in one short summary.
2. Gather only the context needed to complete the task.
3. Execute the workflow incrementally and validate after each major change.
4. Report results with concrete file/command references and remaining risks.

## Output Contract
- Include what changed and why.
- Include validation evidence (tests/checks run).
- Include clear next steps when follow-up work exists.
`,
        },
      },
    },
    {
      id: "mcp-stdio-template",
      type: "mcp",
      title: "MCP Stdio Template",
      description:
        "Safe starting MCP server entry with explicit command/args/env placeholders.",
      version: "1.0.0",
      tags: ["template", "dx", "mcp"],
      mcp: {
        name: "example-server",
        definition: {
          command: "node",
          args: ["./servers/{{name}}/index.js"],
          env: {
            API_KEY: "<set-me>",
          },
          enabledFor: [],
        },
      },
    },
    {
      id: "agents-md-template",
      type: "agent",
      title: "AGENTS.md Template",
      description:
        "Project-wide agent instruction template optimized for clarity, quality gates, and DX.",
      version: "1.0.0",
      tags: ["template", "dx", "instructions"],
      agent: {
        fileName: "AGENTS.md",
        content: `# Project Agent Instructions

## Mission
Ship reliable changes quickly while keeping behavior predictable.

## Working Rules
- Prefer small, reviewable diffs.
- Preserve existing style and architecture unless a refactor is explicitly requested.
- Validate behavior with tests/checks after meaningful changes.
- Avoid destructive actions unless explicitly approved.

## Engineering Quality
- Keep implementations simple and observable.
- Fail with actionable error messages.
- Prioritize backwards compatibility and data safety.

## Delivery Format
- Summarize what changed.
- Include file and command references.
- Call out open risks and next steps.
`,
      },
    },
    {
      id: "claude-md-template",
      type: "agent",
      title: "CLAUDE.md Template",
      description:
        "Agent-specific instruction template for consistent collaboration and output quality.",
      version: "1.0.0",
      tags: ["template", "dx", "instructions"],
      agent: {
        fileName: "CLAUDE.md",
        content: `# Claude Working Contract

## Default Mode
- Be concise, factual, and implementation-first.
- Prefer executable steps over abstract advice.

## Safety + Correctness
- Verify assumptions in code or tests before claiming completion.
- Surface uncertainties explicitly.
- Never leak secrets or include sensitive raw values in logs/output.

## Code Expectations
- Write readable code with clear intent.
- Add tests for behavior changes.
- Keep command usage reproducible.

## Response Expectations
- Lead with outcome.
- Include concrete references to files and validation.
- End with the smallest useful next-step list.
`,
      },
    },
    {
      id: "snippet-template",
      type: "snippet",
      title: "Snippet Template",
      description:
        "Reusable snippet block template for coding standards and communication style.",
      version: "1.0.0",
      tags: ["template", "dx", "snippet"],
      snippet: {
        marker: "team/codingstyle",
        content: `## Coding Style
- Prefer explicit, descriptive names over abbreviations.
- Keep functions focused and side-effect boundaries obvious.
- Add tests when behavior changes.

## Review Checklist
- Is behavior correct for edge cases?
- Are failure modes clear and actionable?
- Is the change minimal for the goal?
`,
      },
    },
  ],
};

function isSafePathString(p: string): boolean {
  return !p.includes("\0");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function nowIso(now?: () => Date): string {
  return (now ? now() : new Date()).toISOString();
}

function parseSourceTrustLevel(raw: unknown): SourceTrustLevel | undefined {
  if (raw === "trusted" || raw === "review" || raw === "blocked") {
    return raw;
  }
  return undefined;
}

function renderTemplate(text: string, values: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(values)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

function compareVersions(a: string, b: string): number {
  const aTokens = (a.match(VERSION_TOKEN_RE) ?? []).map((t) => t.toLowerCase());
  const bTokens = (b.match(VERSION_TOKEN_RE) ?? []).map((t) => t.toLowerCase());
  const n = Math.max(aTokens.length, bTokens.length);
  for (let i = 0; i < n; i += 1) {
    const av = aTokens[i];
    const bv = bTokens[i];
    if (av === undefined && bv === undefined) {
      return 0;
    }
    if (av === undefined) {
      return -1;
    }
    if (bv === undefined) {
      return 1;
    }

    const an = Number(av);
    const bn = Number(bv);
    const aIsNum = Number.isFinite(an) && `${an}` === av;
    const bIsNum = Number.isFinite(bn) && `${bn}` === bv;
    if (aIsNum && bIsNum) {
      if (an < bn) {
        return -1;
      }
      if (an > bn) {
        return 1;
      }
      continue;
    }

    const cmp = av.localeCompare(bv);
    if (cmp !== 0) {
      return cmp;
    }
  }
  return 0;
}

function isSafeRelativePath(relPath: string): boolean {
  if (!relPath || isAbsolute(relPath) || !isSafePathString(relPath)) {
    return false;
  }
  const normalized = relPath.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) {
    return false;
  }
  if (parts.includes(".") || parts.includes("..")) {
    return false;
  }
  return true;
}

function isSubpath(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || !(rel.startsWith("..") || isAbsolute(rel));
}

function parseRef(ref: string): { index: string; itemId: string } | null {
  const i = ref.indexOf(":");
  if (i <= 0 || i >= ref.length - 1) {
    return null;
  }
  return {
    index: ref.slice(0, i).trim(),
    itemId: ref.slice(i + 1).trim(),
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Bun.file(path).stat();
    return true;
  } catch {
    return false;
  }
}

async function defaultFetchJson(url: string, cwd: string): Promise<unknown> {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
    }
    return (await res.json()) as unknown;
  }

  let path = url;
  if (url.startsWith("file://")) {
    const parsed = new URL(url);
    path = decodeURIComponent(parsed.pathname);
  } else if (!isAbsolute(url)) {
    path = resolve(cwd, url);
  }

  const raw = await readFile(path, "utf8");
  return parseJsonLenient(raw);
}

async function defaultFetchText(url: string, cwd: string): Promise<string> {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
    }
    return await res.text();
  }

  let path = url;
  if (url.startsWith("file://")) {
    const parsed = new URL(url);
    path = decodeURIComponent(parsed.pathname);
  } else if (!isAbsolute(url)) {
    path = resolve(cwd, url);
  }

  return await readFile(path, "utf8");
}

function parseIndexItem(raw: unknown): RemoteIndexItem | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const type = typeof obj.type === "string" ? obj.type.trim() : "";
  if (!id) {
    return null;
  }
  if (
    type !== "skill" &&
    type !== "mcp" &&
    type !== "agent" &&
    type !== "snippet"
  ) {
    return null;
  }
  const title = typeof obj.title === "string" ? obj.title : undefined;
  const description =
    typeof obj.description === "string" ? obj.description : undefined;
  const version = typeof obj.version === "string" ? obj.version : undefined;
  const sourceUrl =
    typeof obj.sourceUrl === "string" ? obj.sourceUrl : undefined;
  const tags = Array.isArray(obj.tags)
    ? uniqueSorted(
        obj.tags
          .filter((v) => typeof v === "string")
          .map((v) => v.trim())
          .filter(Boolean)
      )
    : undefined;

  if (type === "skill") {
    const skillRaw = obj.skill;
    if (!isPlainObject(skillRaw)) {
      return null;
    }
    const name =
      typeof skillRaw.name === "string" ? skillRaw.name.trim() : "new-skill";
    const filesRaw = skillRaw.files;
    if (!isPlainObject(filesRaw)) {
      return null;
    }
    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(filesRaw)) {
      if (!isSafeRelativePath(k) || typeof v !== "string") {
        continue;
      }
      files[k] = v;
    }
    if (!Object.keys(files).length) {
      files["SKILL.md"] = "# {{name}}\n";
    }
    return {
      id,
      type,
      title,
      description,
      version,
      sourceUrl,
      tags,
      skill: { name, files },
    };
  }

  if (type === "mcp") {
    const mcpRaw = obj.mcp;
    if (!isPlainObject(mcpRaw)) {
      return null;
    }
    const name =
      typeof mcpRaw.name === "string" ? mcpRaw.name.trim() : "example-server";
    const defRaw = mcpRaw.definition;
    if (!isPlainObject(defRaw)) {
      return null;
    }
    return {
      id,
      type,
      title,
      description,
      version,
      sourceUrl,
      tags,
      mcp: { name, definition: defRaw },
    };
  }

  if (type === "agent") {
    const agentRaw = obj.agent;
    if (!isPlainObject(agentRaw)) {
      return null;
    }
    const fileName =
      typeof agentRaw.fileName === "string" ? agentRaw.fileName.trim() : "";
    const content =
      typeof agentRaw.content === "string" ? agentRaw.content : "";
    if (!(fileName && content)) {
      return null;
    }
    return {
      id,
      type,
      title,
      description,
      version,
      sourceUrl,
      tags,
      agent: { fileName, content },
    };
  }

  const snippetRaw = obj.snippet;
  if (!isPlainObject(snippetRaw)) {
    return null;
  }
  const marker =
    typeof snippetRaw.marker === "string" ? snippetRaw.marker.trim() : "";
  const content =
    typeof snippetRaw.content === "string" ? snippetRaw.content : "";
  if (!(marker && content)) {
    return null;
  }
  return {
    id,
    type,
    title,
    description,
    version,
    sourceUrl,
    tags,
    snippet: { marker, content },
  };
}

function parseManifest(source: IndexSource, raw: unknown): RemoteIndexManifest {
  const base: RemoteIndexManifest = {
    name: source.name,
    url: source.url,
    items: [],
  };

  if (Array.isArray(raw)) {
    base.items = raw
      .map(parseIndexItem)
      .filter((v): v is RemoteIndexItem => !!v);
    return base;
  }

  if (!isPlainObject(raw)) {
    return base;
  }

  const obj = raw as Record<string, unknown>;
  const updatedAt =
    typeof obj.updatedAt === "string" ? obj.updatedAt : undefined;
  const itemsRaw = Array.isArray(obj.items) ? obj.items : [];
  return {
    ...base,
    updatedAt,
    items: itemsRaw
      .map(parseIndexItem)
      .filter((v): v is RemoteIndexItem => !!v),
  };
}

async function loadManifest(
  source: IndexSource,
  ctx: Required<Pick<RemoteCommandContext, "cwd">> & {
    homeDir: string;
    fetchJson: (url: string) => Promise<unknown>;
    fetchText: (url: string) => Promise<string>;
  },
  hints: LoadManifestHints = {}
): Promise<RemoteIndexManifest> {
  if (source.kind === "builtin") {
    return BUILTIN_MANIFEST;
  }
  if (source.kind !== "manifest") {
    return await loadProviderManifest({
      source,
      fetchJson: ctx.fetchJson,
      fetchText: ctx.fetchText,
      hints,
    });
  }
  const rawText = await ctx.fetchText(source.url);
  if (source.integrity) {
    assertManifestIntegrity({
      sourceName: source.name,
      sourceUrl: source.url,
      integrity: source.integrity,
      manifestText: rawText,
    });
  }
  if (source.signature) {
    await assertManifestSignature({
      sourceName: source.name,
      sourceUrl: source.url,
      signature: source.signature,
      signatureKeys: source.signatureKeys,
      manifestText: rawText,
      cwd: ctx.cwd,
      homeDir: ctx.homeDir,
    });
  }
  const raw = parseJsonLenient(rawText);
  return parseManifest(source, raw);
}

function matchScore(item: RemoteIndexItem, query: string): number {
  if (!query.trim()) {
    return 1;
  }
  const haystack = [
    item.id,
    item.title ?? "",
    item.description ?? "",
    ...(item.tags ?? []),
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  for (const token of query
    .toLowerCase()
    .split(QUERY_SPLIT_RE)
    .filter(Boolean)) {
    if (haystack.includes(token)) {
      score += 1;
    }
  }
  return score;
}

async function loadInstalledState(
  rootDir: string
): Promise<InstalledRemoteState> {
  const path = join(rootDir, "remote", "installed.json");
  if (!(await fileExists(path))) {
    return {
      version: REMOTE_STATE_VERSION,
      updatedAt: new Date(0).toISOString(),
      items: [],
    };
  }
  try {
    const parsed = parseJsonLenient(await readFile(path, "utf8"));
    if (!isPlainObject(parsed)) {
      return {
        version: REMOTE_STATE_VERSION,
        updatedAt: new Date(0).toISOString(),
        items: [],
      };
    }
    const version =
      typeof parsed.version === "number"
        ? parsed.version
        : REMOTE_STATE_VERSION;
    const updatedAt =
      typeof parsed.updatedAt === "string"
        ? parsed.updatedAt
        : new Date(0).toISOString();
    const itemsRaw = Array.isArray(parsed.items) ? parsed.items : [];
    const items: InstalledRemoteItem[] = [];
    for (const raw of itemsRaw) {
      if (!isPlainObject(raw)) {
        continue;
      }
      const ref = typeof raw.ref === "string" ? raw.ref : "";
      const index = typeof raw.index === "string" ? raw.index : "";
      const itemId = typeof raw.itemId === "string" ? raw.itemId : "";
      const type = typeof raw.type === "string" ? raw.type : "";
      const installedAs =
        typeof raw.installedAs === "string" ? raw.installedAs : "";
      const pathValue = typeof raw.path === "string" ? raw.path : "";
      if (!(ref && index && itemId && installedAs && pathValue)) {
        continue;
      }
      if (
        type !== "skill" &&
        type !== "mcp" &&
        type !== "agent" &&
        type !== "snippet"
      ) {
        continue;
      }
      items.push({
        ref,
        index,
        itemId,
        type,
        installedAs,
        path: pathValue,
        version: typeof raw.version === "string" ? raw.version : undefined,
        sourceUrl:
          typeof raw.sourceUrl === "string" ? raw.sourceUrl : undefined,
        sourceTrustLevel: parseSourceTrustLevel(raw.sourceTrustLevel),
        installedAt:
          typeof raw.installedAt === "string"
            ? raw.installedAt
            : new Date(0).toISOString(),
      });
    }
    return { version, updatedAt, items };
  } catch {
    return {
      version: REMOTE_STATE_VERSION,
      updatedAt: new Date(0).toISOString(),
      items: [],
    };
  }
}

async function saveInstalledState(
  rootDir: string,
  state: InstalledRemoteState
): Promise<void> {
  const path = join(rootDir, "remote", "installed.json");
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(state, null, 2)}\n`);
}

async function loadCanonicalMcpContainer(rootDir: string): Promise<{
  path: string;
  parsed: Record<string, unknown>;
  getServers: () => Record<string, unknown>;
  setServers: (servers: Record<string, unknown>) => void;
}> {
  const serversPath = join(rootDir, "mcp", "servers.json");
  const mcpPath = join(rootDir, "mcp", "mcp.json");

  let path = serversPath;
  if (await fileExists(serversPath)) {
    path = serversPath;
  } else if (await fileExists(mcpPath)) {
    path = mcpPath;
  }

  let parsed: Record<string, unknown> = {};
  if (await fileExists(path)) {
    const raw = await readFile(path, "utf8");
    const obj = parseJsonLenient(raw);
    if (isPlainObject(obj)) {
      parsed = { ...obj };
    }
  }

  const getServers = () => {
    if (isPlainObject(parsed.servers)) {
      return parsed.servers as Record<string, unknown>;
    }
    if (isPlainObject(parsed.mcpServers)) {
      return parsed.mcpServers as Record<string, unknown>;
    }
    if (
      isPlainObject(parsed.mcp) &&
      isPlainObject((parsed.mcp as Record<string, unknown>).servers)
    ) {
      return (parsed.mcp as Record<string, unknown>).servers as Record<
        string,
        unknown
      >;
    }
    parsed.servers = {};
    return parsed.servers as Record<string, unknown>;
  };

  const setServers = (servers: Record<string, unknown>) => {
    if (isPlainObject(parsed.servers)) {
      parsed.servers = servers;
      return;
    }
    if (isPlainObject(parsed.mcpServers)) {
      parsed.mcpServers = servers;
      return;
    }
    if (
      isPlainObject(parsed.mcp) &&
      isPlainObject((parsed.mcp as Record<string, unknown>).servers)
    ) {
      (parsed.mcp as Record<string, unknown>).servers = servers;
      return;
    }
    parsed.servers = servers;
  };

  return { path, parsed, getServers, setServers };
}

function snippetMarkerToPath(rootDir: string, marker: string): string {
  const parts = marker.split("/").filter(Boolean);
  if (parts[0] === "global" && parts.length >= 2) {
    return join(
      rootDir,
      "snippets",
      "global",
      `${parts.slice(1).join("/")}.md`
    );
  }
  if (parts.length >= 2) {
    const project = parts[0] ?? "project";
    const name = parts.slice(1).join("/");
    return join(rootDir, "snippets", "projects", project, `${name}.md`);
  }
  return join(rootDir, "snippets", "global", `${marker}.md`);
}

function assertInstallPath(path: string, parent: string): void {
  if (!(isSafePathString(path) && isSubpath(parent, path))) {
    throw new Error(`Refusing unsafe install path: ${path}`);
  }
}

async function installSkillItem(args: {
  item: RemoteSkillItem;
  installAs?: string;
  rootDir: string;
  force: boolean;
  dryRun: boolean;
}): Promise<{ installedAs: string; path: string; changedPaths: string[] }> {
  const installedAs = (args.installAs ?? args.item.skill.name).trim();
  if (!installedAs) {
    throw new Error("Skill install target cannot be empty.");
  }
  const skillDir = join(args.rootDir, "skills", installedAs);
  assertInstallPath(skillDir, join(args.rootDir, "skills"));

  if ((await fileExists(skillDir)) && !args.force) {
    throw new Error(
      `Skill already exists: ${installedAs} (use --force to overwrite)`
    );
  }

  const changedPaths: string[] = [];
  const files = Object.entries(args.item.skill.files);
  if (files.length === 0) {
    throw new Error(`Skill template ${args.item.id} has no files.`);
  }

  if (!args.dryRun) {
    if (args.force && (await fileExists(skillDir))) {
      await rm(skillDir, { recursive: true, force: true });
    }
    await mkdir(skillDir, { recursive: true });
  }

  for (const [relPath, rawContent] of files) {
    if (!isSafeRelativePath(relPath)) {
      throw new Error(`Unsafe skill template file path: ${relPath}`);
    }
    const outPath = join(skillDir, relPath);
    assertInstallPath(outPath, skillDir);
    const content = renderTemplate(rawContent, { name: installedAs });
    changedPaths.push(outPath);
    if (!args.dryRun) {
      await mkdir(dirname(outPath), { recursive: true });
      await Bun.write(outPath, content);
    }
  }

  return { installedAs, path: skillDir, changedPaths };
}

async function installMcpItem(args: {
  item: RemoteMcpItem;
  installAs?: string;
  rootDir: string;
  force: boolean;
  dryRun: boolean;
}): Promise<{ installedAs: string; path: string; changedPaths: string[] }> {
  const installedAs = (args.installAs ?? args.item.mcp.name).trim();
  if (!installedAs) {
    throw new Error("MCP server name cannot be empty.");
  }

  const container = await loadCanonicalMcpContainer(args.rootDir);
  const servers = { ...container.getServers() };
  if (servers[installedAs] && !args.force) {
    throw new Error(
      `MCP server already exists: ${installedAs} (use --force to overwrite)`
    );
  }

  const rendered = JSON.parse(
    JSON.stringify(args.item.mcp.definition).replaceAll("{{name}}", installedAs)
  ) as Record<string, unknown>;
  servers[installedAs] = rendered;
  container.setServers(servers);

  if (!args.dryRun) {
    await mkdir(dirname(container.path), { recursive: true });
    await Bun.write(
      container.path,
      `${JSON.stringify(container.parsed, null, 2)}\n`
    );
  }

  return {
    installedAs,
    path: container.path,
    changedPaths: [container.path],
  };
}

async function installAgentItem(args: {
  item: RemoteAgentItem;
  installAs?: string;
  rootDir: string;
  force: boolean;
  dryRun: boolean;
}): Promise<{ installedAs: string; path: string; changedPaths: string[] }> {
  const fileName = (args.installAs ?? args.item.agent.fileName).trim();
  if (!fileName) {
    throw new Error("Agent instruction file name cannot be empty.");
  }
  if (!isSafeRelativePath(fileName)) {
    throw new Error(`Unsafe agent instruction file name: ${fileName}`);
  }
  const filePath = join(args.rootDir, "agents", fileName);
  assertInstallPath(filePath, join(args.rootDir, "agents"));

  if ((await fileExists(filePath)) && !args.force) {
    throw new Error(
      `Agent instruction already exists: ${fileName} (use --force to overwrite)`
    );
  }

  if (!args.dryRun) {
    await mkdir(dirname(filePath), { recursive: true });
    await Bun.write(
      filePath,
      renderTemplate(args.item.agent.content, {
        name: fileName.replace(MD_EXT_RE, ""),
      })
    );
  }
  return { installedAs: fileName, path: filePath, changedPaths: [filePath] };
}

async function installSnippetItem(args: {
  item: RemoteSnippetItem;
  installAs?: string;
  rootDir: string;
  force: boolean;
  dryRun: boolean;
}): Promise<{ installedAs: string; path: string; changedPaths: string[] }> {
  const marker = (args.installAs ?? args.item.snippet.marker).trim();
  const markerErr = validateSnippetMarkerName(marker);
  if (markerErr) {
    throw new Error(`Invalid snippet marker "${marker}": ${markerErr}`);
  }
  const snippetPath = snippetMarkerToPath(args.rootDir, marker);
  assertInstallPath(snippetPath, join(args.rootDir, "snippets"));
  if ((await fileExists(snippetPath)) && !args.force) {
    throw new Error(
      `Snippet already exists: ${marker} (use --force to overwrite)`
    );
  }
  if (!args.dryRun) {
    await mkdir(dirname(snippetPath), { recursive: true });
    await Bun.write(
      snippetPath,
      renderTemplate(args.item.snippet.content, { name: marker })
    );
  }
  return {
    installedAs: marker,
    path: snippetPath,
    changedPaths: [snippetPath],
  };
}

async function installParsedItem(args: {
  parsedRef: { index: string; itemId: string };
  item: RemoteIndexItem;
  sourceTrustLevel: SourceTrustLevel;
  installAs?: string;
  dryRun: boolean;
  force: boolean;
  homeDir: string;
  rootDir: string;
  now?: () => Date;
}): Promise<InstallResult> {
  let writeResult: {
    installedAs: string;
    path: string;
    changedPaths: string[];
  } | null = null;

  if (args.item.type === "skill") {
    writeResult = await installSkillItem({
      item: args.item,
      installAs: args.installAs,
      rootDir: args.rootDir,
      force: args.force,
      dryRun: args.dryRun,
    });
  } else if (args.item.type === "mcp") {
    writeResult = await installMcpItem({
      item: args.item,
      installAs: args.installAs,
      rootDir: args.rootDir,
      force: args.force,
      dryRun: args.dryRun,
    });
  } else if (args.item.type === "agent") {
    writeResult = await installAgentItem({
      item: args.item,
      installAs: args.installAs,
      rootDir: args.rootDir,
      force: args.force,
      dryRun: args.dryRun,
    });
  } else {
    writeResult = await installSnippetItem({
      item: args.item,
      installAs: args.installAs,
      rootDir: args.rootDir,
      force: args.force,
      dryRun: args.dryRun,
    });
  }

  const result: InstallResult = {
    ref: `${args.parsedRef.index}:${args.item.id}`,
    type: args.item.type,
    installedAs: writeResult.installedAs,
    path: writeResult.path,
    sourceTrustLevel: args.sourceTrustLevel,
    dryRun: args.dryRun,
    changedPaths: writeResult.changedPaths,
  };

  if (args.dryRun) {
    return result;
  }

  const state = await loadInstalledState(args.rootDir);
  const next: InstalledRemoteItem = {
    ref: result.ref,
    index: args.parsedRef.index,
    itemId: args.item.id,
    type: args.item.type,
    installedAs: result.installedAs,
    path: result.path,
    version: args.item.version,
    sourceUrl: args.item.sourceUrl,
    sourceTrustLevel: args.sourceTrustLevel,
    installedAt: nowIso(args.now),
  };
  const dedup = state.items.filter(
    (existing) =>
      !(
        existing.ref === next.ref &&
        existing.installedAs === next.installedAs &&
        existing.type === next.type
      )
  );
  dedup.push(next);
  await saveInstalledState(args.rootDir, {
    version: REMOTE_STATE_VERSION,
    updatedAt: nowIso(args.now),
    items: dedup.sort((a, b) => a.ref.localeCompare(b.ref)),
  });
  await buildIndex({
    rootDir: args.rootDir,
    homeDir: args.homeDir,
    force: false,
  });
  return result;
}

async function resolveIndexSourcesAndManifests(args: {
  homeDir: string;
  cwd: string;
  fetchJson: (url: string) => Promise<unknown>;
  fetchText: (url: string) => Promise<string>;
  onlyIndex?: string;
  hints?: LoadManifestHints;
  throwOnSourceError?: boolean;
}): Promise<Map<string, RemoteIndexManifest>> {
  const sources = await readIndexSources(args.homeDir, args.cwd);
  if (
    args.onlyIndex &&
    !sources.some((source) => source.name === args.onlyIndex)
  ) {
    const known = resolveKnownIndexSource(args.onlyIndex);
    if (known) {
      sources.push(known);
    }
  }
  const filtered = args.onlyIndex
    ? sources.filter((source) => source.name === args.onlyIndex)
    : sources;
  const manifests = new Map<string, RemoteIndexManifest>();
  for (const source of filtered) {
    try {
      const manifest = await loadManifest(
        source,
        {
          homeDir: args.homeDir,
          cwd: args.cwd,
          fetchJson: args.fetchJson,
          fetchText: args.fetchText,
        },
        args.hints
      );
      manifests.set(source.name, manifest);
    } catch (err) {
      if (args.throwOnSourceError) {
        throw err;
      }
    }
  }
  return manifests;
}

export async function searchRemoteItems(args: {
  query: string;
  limit?: number;
  index?: string;
  homeDir?: string;
  cwd?: string;
  fetchJson?: (url: string) => Promise<unknown>;
  fetchText?: (url: string) => Promise<string>;
}): Promise<SearchResult[]> {
  const home = args.homeDir ?? homedir();
  const cwd = args.cwd ?? process.cwd();
  const fetchJson =
    args.fetchJson ?? (async (url: string) => await defaultFetchJson(url, cwd));
  const fetchText =
    args.fetchText ?? (async (url: string) => await defaultFetchText(url, cwd));
  const manifests = await resolveIndexSourcesAndManifests({
    homeDir: home,
    cwd,
    fetchJson,
    fetchText,
    onlyIndex: args.index,
    hints: { query: args.query },
    throwOnSourceError: Boolean(args.index),
  });

  const rows: SearchResult[] = [];
  for (const [index, manifest] of manifests.entries()) {
    for (const item of manifest.items) {
      const score = matchScore(item, args.query);
      if (score <= 0) {
        continue;
      }
      rows.push({ index, item, score });
    }
  }

  rows.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (a.index !== b.index) {
      return a.index.localeCompare(b.index);
    }
    return a.item.id.localeCompare(b.item.id);
  });
  const limit = args.limit && args.limit > 0 ? args.limit : 50;
  return rows.slice(0, limit);
}

export async function installRemoteItem(args: {
  ref: string;
  as?: string;
  dryRun?: boolean;
  force?: boolean;
  strictSourceTrust?: boolean;
  homeDir?: string;
  rootDir?: string;
  cwd?: string;
  now?: () => Date;
  fetchJson?: (url: string) => Promise<unknown>;
  fetchText?: (url: string) => Promise<string>;
}): Promise<InstallResult> {
  const parsedRef = parseRef(args.ref);
  if (!parsedRef) {
    throw new Error(`Invalid ref "${args.ref}". Use <index>:<item>.`);
  }
  const home = args.homeDir ?? homedir();
  const root = args.rootDir ?? facultRootDir(home);
  const cwd = args.cwd ?? process.cwd();
  const strictSourceTrust = Boolean(args.strictSourceTrust);
  const fetchJson =
    args.fetchJson ?? (async (url: string) => await defaultFetchJson(url, cwd));
  const fetchText =
    args.fetchText ?? (async (url: string) => await defaultFetchText(url, cwd));
  const manifests = await resolveIndexSourcesAndManifests({
    homeDir: home,
    cwd,
    fetchJson,
    fetchText,
    onlyIndex: parsedRef.index,
    hints: { itemId: parsedRef.itemId },
    throwOnSourceError: true,
  });
  const manifest = manifests.get(parsedRef.index);
  if (!manifest) {
    throw new Error(`Index not found: ${parsedRef.index}`);
  }
  const item = manifest.items.find(
    (candidate) => candidate.id === parsedRef.itemId
  );
  if (!item) {
    throw new Error(`Item not found: ${args.ref}`);
  }
  const trustState = await loadSourceTrustState({ homeDir: home });
  const sourceTrustLevel = assertSourceAllowed({
    sourceName: parsedRef.index,
    trustState,
    strictSourceTrust,
  });
  return await installParsedItem({
    parsedRef,
    item,
    sourceTrustLevel,
    installAs: args.as,
    dryRun: Boolean(args.dryRun),
    force: Boolean(args.force),
    homeDir: home,
    rootDir: root,
    now: args.now,
  });
}

export async function checkRemoteUpdates(args?: {
  apply?: boolean;
  force?: boolean;
  strictSourceTrust?: boolean;
  homeDir?: string;
  rootDir?: string;
  cwd?: string;
  now?: () => Date;
  fetchJson?: (url: string) => Promise<unknown>;
  fetchText?: (url: string) => Promise<string>;
}): Promise<UpdateReport> {
  const home = args?.homeDir ?? homedir();
  const root = args?.rootDir ?? facultRootDir(home);
  const cwd = args?.cwd ?? process.cwd();
  const fetchJson =
    args?.fetchJson ??
    (async (url: string) => await defaultFetchJson(url, cwd));
  const fetchText =
    args?.fetchText ??
    (async (url: string) => await defaultFetchText(url, cwd));
  const strictSourceTrust = Boolean(args?.strictSourceTrust);
  const sourceTrustState = await loadSourceTrustState({ homeDir: home });

  const installed = await loadInstalledState(root);
  const checks: UpdateCheckResult[] = [];
  const applied: InstallResult[] = [];
  if (!installed.items.length) {
    return { checkedAt: nowIso(args?.now), checks, applied };
  }

  const configuredSources = await readIndexSources(home, cwd);
  const sourceByName = new Map<string, IndexSource>();
  for (const source of configuredSources) {
    sourceByName.set(source.name, source);
  }
  for (const item of installed.items) {
    if (sourceByName.has(item.index)) {
      continue;
    }
    const known = resolveKnownIndexSource(item.index);
    if (known) {
      sourceByName.set(known.name, known);
    }
  }
  const manifestCache = new Map<string, RemoteIndexManifest>();

  for (const entry of installed.items) {
    const trust = evaluateSourceTrust({
      sourceName: entry.index,
      trustState: sourceTrustState,
    });
    if (trust.level === "blocked") {
      checks.push({
        installed: entry,
        status: "blocked-source",
      });
      continue;
    }
    if (strictSourceTrust && trust.level === "review") {
      checks.push({
        installed: entry,
        status: "review-source",
      });
      continue;
    }

    const source = sourceByName.get(entry.index);
    if (!source) {
      checks.push({ installed: entry, status: "missing-index" });
      continue;
    }
    const cacheKey = `${source.name}:${entry.itemId}`;
    let manifest = manifestCache.get(cacheKey);
    if (!manifest) {
      try {
        manifest = await loadManifest(
          source,
          { homeDir: home, cwd, fetchJson, fetchText },
          { itemId: entry.itemId }
        );
      } catch {
        checks.push({ installed: entry, status: "missing-index" });
        continue;
      }
      manifestCache.set(cacheKey, manifest);
    }

    const item = manifest.items.find(
      (candidate) => candidate.id === entry.itemId
    );
    if (!item) {
      checks.push({ installed: entry, status: "missing-item" });
      continue;
    }
    const latestVersion = item.version;
    const currentVersion = entry.version;
    if (!(latestVersion && currentVersion)) {
      checks.push({
        installed: entry,
        status: "up-to-date",
        latestVersion,
        currentVersion,
      });
      continue;
    }
    const cmp = compareVersions(currentVersion, latestVersion);
    if (cmp < 0) {
      checks.push({
        installed: entry,
        status: "outdated",
        latestVersion,
        currentVersion,
      });
      if (args?.apply) {
        const next = await installRemoteItem({
          ref: entry.ref,
          as: entry.installedAs,
          dryRun: false,
          force: args.force ?? true,
          strictSourceTrust,
          homeDir: home,
          rootDir: root,
          cwd,
          now: args.now,
          fetchJson,
          fetchText,
        });
        applied.push(next);
      }
      continue;
    }
    checks.push({
      installed: entry,
      status: "up-to-date",
      latestVersion,
      currentVersion,
    });
  }

  return { checkedAt: nowIso(args?.now), checks, applied };
}

async function verifySource(args: {
  sourceName: string;
  homeDir?: string;
  cwd?: string;
  now?: () => Date;
  fetchJson?: (url: string) => Promise<unknown>;
  fetchText?: (url: string) => Promise<string>;
}): Promise<VerifySourceReport> {
  const home = args.homeDir ?? homedir();
  const cwd = args.cwd ?? process.cwd();
  const fetchJson =
    args.fetchJson ?? (async (url: string) => await defaultFetchJson(url, cwd));
  const fetchText =
    args.fetchText ?? (async (url: string) => await defaultFetchText(url, cwd));
  const configured = await readIndexSources(home, cwd);
  const source =
    configured.find((candidate) => candidate.name === args.sourceName) ??
    resolveKnownIndexSource(args.sourceName);
  if (!source) {
    throw new Error(`Source not found: ${args.sourceName}`);
  }

  const trustState = await loadSourceTrustState({ homeDir: home });
  const trust = evaluateSourceTrust({
    sourceName: source.name,
    trustState,
  });

  const report: VerifySourceReport = {
    checkedAt: nowIso(args.now),
    source: {
      name: source.name,
      url: source.url,
      kind: source.kind,
    },
    trust,
    checks: {
      fetch: "not-applicable",
      parse: "not-applicable",
      integrity: "not-applicable",
      signature: "not-applicable",
      items: 0,
    },
  };

  try {
    if (source.kind === "builtin") {
      report.checks.parse = "passed";
      report.checks.items = BUILTIN_MANIFEST.items.length;
      return report;
    }

    if (source.kind === "manifest") {
      const rawText = await fetchText(source.url);
      report.checks.fetch = "passed";

      if (source.integrity) {
        assertManifestIntegrity({
          sourceName: source.name,
          sourceUrl: source.url,
          integrity: source.integrity,
          manifestText: rawText,
        });
        report.checks.integrity = "passed";
      } else {
        report.checks.integrity = "not-configured";
      }

      if (source.signature) {
        await assertManifestSignature({
          sourceName: source.name,
          sourceUrl: source.url,
          signature: source.signature,
          signatureKeys: source.signatureKeys,
          manifestText: rawText,
          cwd,
          homeDir: home,
        });
        report.checks.signature = "passed";
      } else {
        report.checks.signature = "not-configured";
      }

      const parsed = parseJsonLenient(rawText);
      const manifest = parseManifest(source, parsed);
      report.checks.parse = "passed";
      report.checks.items = manifest.items.length;
      return report;
    }

    const manifest = await loadProviderManifest({
      source,
      fetchJson,
      fetchText,
      hints: {},
    });
    report.checks.fetch = "passed";
    report.checks.parse = "passed";
    report.checks.items = manifest.items.length;
    return report;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.error = message;
    if (report.checks.fetch === "not-applicable") {
      report.checks.fetch = "failed";
    }
    if (report.checks.parse === "not-applicable") {
      report.checks.parse = "failed";
    }
    if (
      report.checks.integrity === "not-applicable" &&
      source.kind === "manifest"
    ) {
      report.checks.integrity = source.integrity ? "failed" : "not-configured";
    }
    if (
      report.checks.signature === "not-applicable" &&
      source.kind === "manifest"
    ) {
      report.checks.signature = source.signature ? "failed" : "not-configured";
    }
    return report;
  }
}

function printSearchHelp() {
  console.log(`facult search — search configured remote indices

Usage:
  facult search <query> [--index <name>] [--limit <n>] [--json]

Notes:
  - Builtin index "${BUILTIN_INDEX_NAME}" is always available.
  - Builtin provider aliases: "${SMITHERY_INDEX_NAME}", "${GLAMA_INDEX_NAME}", "${SKILLS_SH_INDEX_NAME}", "${CLAWHUB_INDEX_NAME}".
  - Optional custom indices can be configured in ~/.facult/indices.json.
`);
}

function printInstallHelp() {
  console.log(`facult install — install an item from a remote index

Usage:
  facult install <index:item> [--as <name>] [--dry-run] [--force] [--strict-source-trust] [--json]

Examples:
  facult install facult:skill-template --as my-skill
  facult install facult:mcp-stdio-template --as github
  facult install smithery:github
  facult install glama:systeminit/si --as system-initiative
  facult install skills.sh:owner/repo --as my-skill
  facult install clawhub:my-skill
`);
}

function printUpdateHelp() {
  console.log(`facult update — check for updates to remotely installed items

Usage:
  facult update [--apply] [--strict-source-trust] [--json]

Options:
  --apply                Install available updates
  --strict-source-trust  Block review-level sources unless explicitly trusted
`);
}

function printTemplatesHelp() {
  console.log(`facult templates — DX-first local scaffolding for skills/instructions/MCP/snippets

Usage:
  facult templates list [--json]
  facult templates init skill <name> [--force] [--dry-run]
  facult templates init mcp <name> [--force] [--dry-run]
  facult templates init snippet <marker> [--force] [--dry-run]
  facult templates init agents [--force] [--dry-run]
  facult templates init claude [--force] [--dry-run]

Notes:
  - Templates are powered by the builtin remote index (${BUILTIN_INDEX_NAME}).
`);
}

function printVerifySourceHelp() {
  console.log(`facult verify-source — verify source trust/integrity/signature status

Usage:
  facult verify-source <name> [--json]

Examples:
  facult verify-source facult
  facult verify-source smithery
  facult verify-source local-index --json
`);
}

function parseLongFlag(argv: string[], flag: string): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === flag) {
      return argv[i + 1] ?? null;
    }
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }
  return null;
}

export async function sourcesCommand(
  argv: string[],
  ctx: RemoteCommandContext = {}
) {
  await runSourcesCommand({
    argv,
    ctx: {
      homeDir: ctx.homeDir,
      cwd: ctx.cwd,
      now: ctx.now,
    },
    readIndexSources,
    builtinIndexName: BUILTIN_INDEX_NAME,
  });
}

export async function searchCommand(
  argv: string[],
  ctx: RemoteCommandContext = {}
) {
  if (
    !argv.length ||
    argv.includes("--help") ||
    argv.includes("-h") ||
    argv[0] === "help"
  ) {
    printSearchHelp();
    return;
  }
  const query = argv.find((arg) => arg && !arg.startsWith("-"));
  if (!query) {
    console.error("search requires a query");
    process.exitCode = 1;
    return;
  }
  const index = parseLongFlag(argv, "--index") ?? undefined;
  const limitRaw = parseLongFlag(argv, "--limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  if (limitRaw && (!Number.isFinite(limit) || (limit ?? 0) <= 0)) {
    console.error(`Invalid --limit value: ${limitRaw}`);
    process.exitCode = 1;
    return;
  }
  const json = argv.includes("--json");

  try {
    const results = await searchRemoteItems({
      query,
      index,
      limit,
      homeDir: ctx.homeDir,
      cwd: ctx.cwd,
      fetchJson: ctx.fetchJson,
      fetchText: ctx.fetchText,
    });
    if (json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    if (!results.length) {
      console.log("(no results)");
      return;
    }
    for (const row of results) {
      const version = row.item.version ?? "-";
      const title = row.item.title ?? row.item.description ?? "";
      console.log(
        `${row.index}:${row.item.id}\t${row.item.type}\t${version}\t${title}`
      );
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function installCommand(
  argv: string[],
  ctx: RemoteCommandContext = {}
) {
  if (
    !argv.length ||
    argv.includes("--help") ||
    argv.includes("-h") ||
    argv[0] === "help"
  ) {
    printInstallHelp();
    return;
  }
  const ref = argv.find((arg) => arg && !arg.startsWith("-"));
  if (!ref) {
    console.error("install requires a ref like <index:item>");
    process.exitCode = 1;
    return;
  }
  const as = parseLongFlag(argv, "--as") ?? undefined;
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const strictSourceTrust =
    argv.includes("--strict-source-trust") || Boolean(ctx.strictSourceTrust);
  const json = argv.includes("--json");
  try {
    const result = await installRemoteItem({
      ref,
      as,
      dryRun,
      force,
      strictSourceTrust,
      homeDir: ctx.homeDir,
      rootDir: ctx.rootDir,
      cwd: ctx.cwd,
      fetchJson: ctx.fetchJson,
      fetchText: ctx.fetchText,
      now: ctx.now,
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const action = dryRun ? "Would install" : "Installed";
    console.log(`${action} ${result.ref} as ${result.installedAs}`);
    if (result.sourceTrustLevel === "review" && !strictSourceTrust) {
      console.log(
        "  ! source policy: review (use --strict-source-trust to enforce trust-only installs)"
      );
    }
    for (const path of result.changedPaths) {
      console.log(`  - ${path}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function updateCommand(
  argv: string[],
  ctx: RemoteCommandContext = {}
) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printUpdateHelp();
    return;
  }
  const apply = argv.includes("--apply");
  const strictSourceTrust =
    argv.includes("--strict-source-trust") || Boolean(ctx.strictSourceTrust);
  const json = argv.includes("--json");
  try {
    const report = await checkRemoteUpdates({
      apply,
      strictSourceTrust,
      homeDir: ctx.homeDir,
      rootDir: ctx.rootDir,
      cwd: ctx.cwd,
      fetchJson: ctx.fetchJson,
      fetchText: ctx.fetchText,
      now: ctx.now,
    });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (!report.checks.length) {
      console.log("No remotely installed items found.");
      return;
    }
    for (const check of report.checks) {
      const current = check.currentVersion ?? "-";
      const latest = check.latestVersion ?? "-";
      console.log(
        `${check.installed.ref} (${check.installed.installedAs})\t${check.status}\t${current} -> ${latest}`
      );
    }
    if (apply) {
      console.log(`Applied ${report.applied.length} updates.`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function verifySourceCommand(
  argv: string[],
  ctx: RemoteCommandContext = {}
) {
  if (
    !argv.length ||
    argv.includes("--help") ||
    argv.includes("-h") ||
    argv[0] === "help"
  ) {
    printVerifySourceHelp();
    return;
  }

  const sourceName = argv.find((arg) => arg && !arg.startsWith("-"));
  if (!sourceName) {
    console.error("verify-source requires a source name");
    process.exitCode = 1;
    return;
  }
  const json = argv.includes("--json");

  try {
    const report = await verifySource({
      sourceName,
      homeDir: ctx.homeDir,
      cwd: ctx.cwd,
      now: ctx.now,
      fetchJson: ctx.fetchJson,
      fetchText: ctx.fetchText,
    });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      const trustOrigin = report.trust.explicit ? "explicit" : "default";
      console.log(
        `${report.source.name}\t${report.source.kind}\t${report.source.url}`
      );
      console.log(
        `trust=${report.trust.level} (${trustOrigin})\tfetch=${report.checks.fetch}\tparse=${report.checks.parse}\tintegrity=${report.checks.integrity}\tsignature=${report.checks.signature}\titems=${report.checks.items}`
      );
      if (report.error) {
        console.log(`error: ${report.error}`);
      }
    }

    if (report.error) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function templatesCommand(
  argv: string[],
  ctx: RemoteCommandContext = {}
) {
  const [sub, ...rest] = argv;
  if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
    printTemplatesHelp();
    return;
  }
  if (sub === "list") {
    const json = rest.includes("--json");
    const rows = BUILTIN_MANIFEST.items.map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title ?? "",
      description: item.description ?? "",
      version: item.version ?? "",
    }));
    if (json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    for (const row of rows) {
      console.log(`${row.id}\t${row.type}\t${row.version}\t${row.title}`);
    }
    return;
  }
  if (sub !== "init") {
    console.error(`Unknown templates command: ${sub}`);
    process.exitCode = 2;
    return;
  }

  const [kind, ...args] = rest;
  if (!kind) {
    console.error(
      "templates init requires a kind (skill|mcp|snippet|agents|claude)"
    );
    process.exitCode = 2;
    return;
  }
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const json = args.includes("--json");
  const positional = args.filter((a) => a && !a.startsWith("-"));

  let ref = "";
  let as: string | undefined;
  if (kind === "skill") {
    ref = `${BUILTIN_INDEX_NAME}:skill-template`;
    as = positional[0];
    if (!as) {
      console.error("templates init skill requires a <name>");
      process.exitCode = 2;
      return;
    }
  } else if (kind === "mcp") {
    ref = `${BUILTIN_INDEX_NAME}:mcp-stdio-template`;
    as = positional[0];
    if (!as) {
      console.error("templates init mcp requires a <name>");
      process.exitCode = 2;
      return;
    }
  } else if (kind === "snippet") {
    ref = `${BUILTIN_INDEX_NAME}:snippet-template`;
    as = positional[0];
    if (!as) {
      console.error("templates init snippet requires a <marker>");
      process.exitCode = 2;
      return;
    }
  } else if (kind === "agents") {
    ref = `${BUILTIN_INDEX_NAME}:agents-md-template`;
    as = positional[0];
  } else if (kind === "claude") {
    ref = `${BUILTIN_INDEX_NAME}:claude-md-template`;
    as = positional[0];
  } else {
    console.error(`Unknown template kind: ${kind}`);
    process.exitCode = 2;
    return;
  }

  try {
    const result = await installRemoteItem({
      ref,
      as,
      dryRun,
      force,
      homeDir: ctx.homeDir,
      rootDir: ctx.rootDir,
      cwd: ctx.cwd,
      fetchJson: ctx.fetchJson,
      fetchText: ctx.fetchText,
      now: ctx.now,
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const action = dryRun ? "Would scaffold" : "Scaffolded";
    console.log(`${action} ${kind} template as ${result.installedAs}`);
    for (const path of result.changedPaths) {
      console.log(`  - ${path}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
