import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { lastModified } from "./util/skills";

export interface SkillEntry {
  name: string;
  path: string;
  description: string;
  tags: string[];
  lastModifiedAt?: string;
}

export interface McpEntry {
  name: string;
  path: string;
  lastModifiedAt?: string;
  /** The raw server definition from servers.json (lossless). */
  definition: unknown;
}

export interface AgentEntry {
  name: string;
  path: string;
  lastModifiedAt?: string;
}

export interface SnippetEntry {
  name: string;
  path: string;
  lastModifiedAt?: string;
}

export interface FacultIndex {
  version: number;
  updatedAt: string;
  skills: Record<string, SkillEntry>;
  mcp: { servers: Record<string, McpEntry> };
  agents: Record<string, AgentEntry>;
  snippets: Record<string, SnippetEntry>;
}

function isSafePathString(p: string): boolean {
  return !p.includes("\0");
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

const NEWLINE_RE = /\r?\n/;
const FRONTMATTER_KEY_RE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
const FRONTMATTER_LIST_ITEM_RE = /^\s*-\s*(.+)$/;

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter(Boolean))].sort();
}

function firstParagraphDescription(mdBody: string): string {
  const lines = mdBody.split(NEWLINE_RE);

  // Find first paragraph of non-empty lines, skipping headings.
  const para: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();

    if (!line) {
      if (para.length) {
        break;
      }
      continue;
    }

    // Skip headings and separators; they aren't a description.
    if (line.startsWith("#") || line === "---") {
      continue;
    }

    para.push(line);
  }

  return para.join(" ").trim();
}

function parseTagsValue(value: string, followingLines: string[]): string[] {
  const out: string[] = [];
  const v = value.trim();

  if (!v) {
    // Parse list-style tags:
    // tags:\n  - a\n  - b
    for (const l of followingLines) {
      const li = FRONTMATTER_LIST_ITEM_RE.exec(l);
      if (!li) {
        break;
      }
      const tag = li[1];
      if (tag) {
        out.push(stripQuotes(tag));
      }
    }
    return out;
  }

  // Inline styles.
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1);
    for (const part of inner.split(",")) {
      out.push(stripQuotes(part));
    }
    return out;
  }

  // Comma-separated or single.
  if (v.includes(",")) {
    for (const part of v.split(",")) {
      out.push(stripQuotes(part));
    }
    return out;
  }

  return [stripQuotes(v)];
}

function extractFrontmatterBlock(md: string): {
  fmLines: string[];
  body: string;
} | null {
  if (!(md.startsWith("---\n") || md.startsWith("---\r\n"))) {
    return null;
  }

  const lines = md.split(NEWLINE_RE);

  // lines[0] is ---
  let i = 1;
  const fmLines: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      break;
    }
    if (line === "---") {
      i += 1;
      break;
    }
    fmLines.push(line);
  }

  return { fmLines, body: lines.slice(i).join("\n") };
}

function countListItems(lines: string[]): number {
  let n = 0;
  for (const l of lines) {
    if (!FRONTMATTER_LIST_ITEM_RE.test(l)) {
      break;
    }
    n++;
  }
  return n;
}

function parseFrontmatter(md: string): {
  description?: string;
  tags: string[];
  body: string;
} {
  const block = extractFrontmatterBlock(md);
  if (!block) {
    return { tags: [], body: md };
  }

  const tags: string[] = [];
  let description: string | undefined;

  const fmLines = block.fmLines;
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (line === undefined) {
      continue;
    }
    const m = FRONTMATTER_KEY_RE.exec(line);
    if (!m) {
      continue;
    }

    const key = m[1];
    const value = m[2] ?? "";

    if (key === "description") {
      description = stripQuotes(value);
      continue;
    }

    if (key === "tags") {
      const rest = fmLines.slice(j + 1);
      tags.push(...parseTagsValue(value, rest));

      if (!value.trim()) {
        j += countListItems(rest);
      }
    }
  }

  return { description, tags, body: block.body };
}

export function parseSkillMarkdown(md: string): {
  description: string;
  tags: string[];
} {
  const fm = parseFrontmatter(md);

  const description =
    fm.description?.trim() || firstParagraphDescription(fm.body) || "";

  return { description, tags: normalizeTags(fm.tags) };
}

async function statIsoTime(p: string): Promise<string | undefined> {
  const lm = await lastModified(p);
  return lm ? lm.toISOString() : undefined;
}

async function readJsonSafe(p: string): Promise<unknown> {
  const txt = await Bun.file(p).text();
  return JSON.parse(txt);
}

async function listDirFiles(dir: string): Promise<string[]> {
  try {
    const ents = await readdir(dir, { withFileTypes: true });
    return ents
      .filter((e) => e.isFile())
      .map((e) => join(dir, e.name))
      .filter(isSafePathString)
      .sort();
  } catch {
    return [];
  }
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const ents = await readdir(dir, { withFileTypes: true });
    return ents
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name))
      .filter(isSafePathString)
      .sort();
  } catch {
    return [];
  }
}

async function indexSkills(
  skillsDir: string
): Promise<Record<string, SkillEntry>> {
  const out: Record<string, SkillEntry> = {};
  const dirs = await listSubdirs(skillsDir);
  for (const d of dirs) {
    const skillMd = join(d, "SKILL.md");
    try {
      const st = await Bun.file(skillMd).stat();
      if (!st.isFile()) {
        continue;
      }

      const md = await Bun.file(skillMd).text();
      const { description, tags } = parseSkillMarkdown(md);
      const name = basename(d);

      out[name] = {
        name,
        path: d,
        description,
        tags,
        lastModifiedAt: await statIsoTime(skillMd),
      };
    } catch {
      // Ignore missing/invalid skill entries.
    }
  }
  return out;
}

async function indexMcpServers(
  serversJsonPath: string
): Promise<Record<string, McpEntry>> {
  const out: Record<string, McpEntry> = {};

  try {
    const st = await Bun.file(serversJsonPath).stat();
    if (!st.isFile()) {
      return out;
    }

    const data = (await readJsonSafe(serversJsonPath)) as Record<
      string,
      unknown
    > | null;

    // Accept a few shapes:
    // 1) { servers: { name: {...} } }
    // 2) { mcp: { servers: {...} } }
    // 3) { mcpServers: {...} }
    const serversObj =
      (data?.servers as Record<string, unknown> | undefined) ??
      ((data?.mcp as Record<string, unknown> | undefined)?.servers as
        | Record<string, unknown>
        | undefined) ??
      (data?.mcpServers as Record<string, unknown> | undefined);

    if (!serversObj || typeof serversObj !== "object") {
      return out;
    }

    const lm = await statIsoTime(serversJsonPath);
    for (const name of Object.keys(serversObj).sort()) {
      out[name] = {
        name,
        path: serversJsonPath,
        lastModifiedAt: lm,
        definition: serversObj[name],
      };
    }
  } catch {
    return out;
  }

  return out;
}

async function indexAgents(
  agentsDir: string
): Promise<Record<string, AgentEntry>> {
  const out: Record<string, AgentEntry> = {};
  const files = await listDirFiles(agentsDir);
  for (const p of files) {
    const name = basename(p);
    out[name] = {
      name,
      path: p,
      lastModifiedAt: await statIsoTime(p),
    };
  }
  return out;
}

async function indexSnippets(
  snippetsDir: string
): Promise<Record<string, SnippetEntry>> {
  const out: Record<string, SnippetEntry> = {};
  const files = await listDirFiles(snippetsDir);
  for (const p of files) {
    const name = basename(p);
    out[name] = {
      name,
      path: p,
      lastModifiedAt: await statIsoTime(p),
    };
  }
  return out;
}

export function tackleboxRootDir(home: string = homedir()): string {
  return join(home, "agents", ".tb");
}

export async function buildIndex(opts?: {
  force?: boolean;
  /** Override the default ~/agents/.tb root (useful for tests). */
  rootDir?: string;
}): Promise<{ index: FacultIndex; outputPath: string }> {
  const force = Boolean(opts?.force);

  const tbRoot = opts?.rootDir ?? tackleboxRootDir();
  const skillsDir = join(tbRoot, "skills");
  const agentsDir = join(tbRoot, "agents");
  const snippetsDir = join(tbRoot, "snippets");
  const serversJsonPath = join(tbRoot, "mcp", "servers.json");

  const outputPath = join(tbRoot, "index.json");

  if (force) {
    try {
      await Bun.write(outputPath, "");
    } catch {
      // ignore
    }
  }

  const [skills, servers, agents, snippets] = await Promise.all([
    indexSkills(skillsDir),
    indexMcpServers(serversJsonPath),
    indexAgents(agentsDir),
    indexSnippets(snippetsDir),
  ]);

  const index: FacultIndex = {
    version: 1,
    updatedAt: new Date().toISOString(),
    skills,
    mcp: { servers },
    agents,
    snippets,
  };

  await mkdir(tbRoot, { recursive: true });
  await Bun.write(outputPath, `${JSON.stringify(index, null, 2)}\n`);

  return { index, outputPath };
}

export async function indexCommand(argv: string[]) {
  const force = argv.includes("--force");
  const { outputPath } = await buildIndex({ force });
  console.log(`Index written to ${outputPath}`);
}
