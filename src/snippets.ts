import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { facultRootDir } from "./paths";

export const SNIPPET_MARKER_RE = /<!--\s*(\/?)fclty:([^>]*?)\s*-->/g;

const VALID_MARKER_NAME_RE = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const WHITESPACE_RE = /\s/;
const NEWLINE_SPLIT_RE = /\r?\n/;

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function snippetNameToRelPath(name: string): string {
  // Marker names are validated and may contain slashes for scoping.
  // Snippets are stored as markdown files, so map marker names to `<name>.md`.
  return `${name}.md`;
}

function trimTrailingWhitespacePerLine(text: string): string {
  return normalizeNewlines(text)
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n");
}

export function validateSnippetMarkerName(name: string): string | null {
  if (!name) {
    return "Marker name cannot be empty.";
  }

  if (name.trim() !== name) {
    return "Marker name cannot have leading or trailing whitespace.";
  }

  if (WHITESPACE_RE.test(name)) {
    return "Marker name cannot contain whitespace.";
  }

  if (name.startsWith("/") || name.endsWith("/")) {
    return "Marker name cannot start or end with '/'";
  }

  if (name.includes("..")) {
    return "Marker name cannot contain '..' (path traversal).";
  }

  if (name.includes("//")) {
    return "Marker name cannot contain empty path segments ('//').";
  }

  if (!VALID_MARKER_NAME_RE.test(name)) {
    return "Marker name may only contain letters, numbers, '-', '_', and '/' for scoping.";
  }

  return null;
}

function lineNumberAt(text: string, index: number): number {
  if (index <= 0) {
    return 1;
  }
  return text.slice(0, index).split(NEWLINE_SPLIT_RE).length;
}

export interface Marker {
  name: string;
  isClosing: boolean;
  start: number;
  end: number;
  raw: string;
  line: number;
}

export interface MarkerPair {
  name: string;
  open: Marker;
  close: Marker;
  contentStart: number;
  contentEnd: number;
}

export function validateSnippetMarkersInText(
  text: string,
  filePath?: string
): string[] {
  const errors: string[] = [];
  for (const match of text.matchAll(SNIPPET_MARKER_RE)) {
    const rawName = match[2] ?? "";
    const name = rawName.trim();
    const err = validateSnippetMarkerName(name);
    if (!err) {
      continue;
    }
    const line = lineNumberAt(text, match.index ?? 0);
    const location = filePath ? `${filePath}:${line}` : `line ${line}`;
    errors.push(
      `${location}: invalid snippet marker name "${rawName}": ${err}`
    );
  }
  return errors;
}

export function findMarkersInText(
  text: string,
  filePath?: string
): { pairs: MarkerPair[]; errors: string[] } {
  const errors: string[] = [];
  const markers: Marker[] = [];

  for (const match of text.matchAll(SNIPPET_MARKER_RE)) {
    const rawName = match[2] ?? "";
    const name = rawName.trim();
    const err = validateSnippetMarkerName(name);
    const start = match.index ?? 0;
    const raw = match[0] ?? "";
    const end = start + raw.length;
    const line = lineNumberAt(text, start);
    const isClosing = (match[1] ?? "") === "/";

    if (err) {
      const location = filePath ? `${filePath}:${line}` : `line ${line}`;
      errors.push(
        `${location}: invalid snippet marker name "${rawName}": ${err}`
      );
      continue;
    }

    markers.push({ name, isClosing, start, end, raw, line });
  }

  const stack: Marker[] = [];
  const pairs: MarkerPair[] = [];

  for (const m of markers) {
    if (!m.isClosing) {
      stack.push(m);
      continue;
    }

    // Find matching open marker for recovery if nesting is broken.
    let openIndex = -1;
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i]?.name === m.name) {
        openIndex = i;
        break;
      }
    }

    if (openIndex < 0) {
      const location = filePath ? `${filePath}:${m.line}` : `line ${m.line}`;
      errors.push(`${location}: closing marker without opening: ${m.name}`);
      continue;
    }

    if (openIndex !== stack.length - 1) {
      // Unclosed inner markers; report and drop them so we can continue.
      const dropped = stack.slice(openIndex + 1);
      for (const d of dropped) {
        const loc = filePath ? `${filePath}:${d.line}` : `line ${d.line}`;
        errors.push(
          `${loc}: marker not closed before closing ${m.name}: ${d.name}`
        );
      }
      stack.splice(openIndex + 1);
    }

    const open = stack.pop();
    if (!open) {
      continue;
    }

    pairs.push({
      name: m.name,
      open,
      close: m,
      contentStart: open.end,
      contentEnd: m.start,
    });
  }

  for (const open of stack) {
    const loc = filePath ? `${filePath}:${open.line}` : `line ${open.line}`;
    errors.push(`${loc}: opening marker without closing: ${open.name}`);
  }

  return {
    pairs: pairs.sort((a, b) => a.open.start - b.open.start),
    errors,
  };
}

function normalizeSnippetBody(text: string): string {
  // Compare snippets and marker blocks in a whitespace-tolerant way to avoid churn.
  return trimTrailingWhitespacePerLine(text).trim();
}

export function formatSnippetInjection(snippet: string): string {
  const normalized = trimTrailingWhitespacePerLine(snippet).trimEnd();
  return `\n${normalized}\n`;
}

export interface SnippetResolution {
  /** The marker name requested (e.g. "codingstyle", "global/codingstyle", "myproj/context"). */
  marker: string;
  /** The snippet file path used for injection. */
  path: string;
  /** Global or project snippet. */
  scope: "global" | "project";
  /** Project name when scope=project. */
  project?: string;
  /** Snippet file contents. */
  content: string;
}

export interface SyncChange {
  marker: string;
  status: "updated" | "unchanged" | "not-found" | "error";
  snippetPath?: string;
  lines?: number;
  message?: string;
}

export interface SyncResult {
  filePath: string;
  dryRun: boolean;
  changed: boolean;
  changes: SyncChange[];
  errors: string[];
}

export interface RenderSnippetTextResult {
  text: string;
  changes: SyncChange[];
  errors: string[];
}

function isSafePathString(p: string): boolean {
  // Protect filesystem APIs from null-byte paths.
  return !p.includes("\0");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await Bun.file(p).stat();
    return st.isFile();
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await Bun.file(p).stat();
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function detectProjectForFile(filePath: string): Promise<string | null> {
  // Find the nearest parent directory containing a `.git` entry (dir or file).
  // Use that directory basename as the project name.
  let dir = dirname(resolve(filePath));
  for (let i = 0; i < 50; i += 1) {
    const git = join(dir, ".git");
    try {
      const st = await Bun.file(git).stat();
      if (st.isDirectory() || st.isFile()) {
        return basename(dir);
      }
    } catch {
      // ignore
    }

    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

function markerToCandidates(args: {
  rootDir: string;
  marker: string;
  projectContext?: string | null;
}): { scope: "global" | "project"; path: string; project?: string }[] {
  const { rootDir, marker, projectContext } = args;
  const snippetsDir = join(rootDir, "snippets");

  const parts = marker.split("/").filter(Boolean);
  const scope = parts[0];

  // Explicit global.
  if (scope === "global" && parts.length >= 2) {
    const rel = parts.slice(1).join("/");
    return [
      {
        scope: "global",
        path: join(snippetsDir, "global", snippetNameToRelPath(rel)),
      },
    ];
  }

  // Explicit project scope: "<project>/<name...>".
  if (parts.length >= 2) {
    const project = parts[0]!;
    const rel = parts.slice(1).join("/");
    return [
      {
        scope: "project",
        project,
        path: join(snippetsDir, "projects", project, snippetNameToRelPath(rel)),
      },
    ];
  }

  // Implicit: prefer project override, then global.
  const rel = marker;
  const out: { scope: "global" | "project"; path: string; project?: string }[] =
    [];
  if (projectContext) {
    out.push({
      scope: "project",
      project: projectContext,
      path: join(
        snippetsDir,
        "projects",
        projectContext,
        snippetNameToRelPath(rel)
      ),
    });
  }
  out.push({
    scope: "global",
    path: join(snippetsDir, "global", snippetNameToRelPath(rel)),
  });
  return out;
}

export async function findSnippet(args: {
  marker: string;
  /** Project context for implicit markers (git repo basename). */
  project?: string | null;
  /** Override canonical root (useful for tests). */
  rootDir?: string;
}): Promise<SnippetResolution | null> {
  const rootDir = args.rootDir ?? facultRootDir();
  const marker = args.marker;

  const candidates = markerToCandidates({
    rootDir,
    marker,
    projectContext: args.project ?? null,
  });

  for (const c of candidates) {
    if (!isSafePathString(c.path)) {
      continue;
    }
    if (!(await fileExists(c.path))) {
      continue;
    }
    const content = await Bun.file(c.path).text();
    return {
      marker,
      path: c.path,
      scope: c.scope,
      project: c.project,
      content,
    };
  }

  return null;
}

function hasMarkers(text: string): boolean {
  return text.includes("fclty:");
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: any[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const name = String(ent?.name ?? "");
      if (!name) {
        continue;
      }
      if (ent.isSymbolicLink?.()) {
        continue;
      }
      const abs = join(current, name);
      if (ent.isDirectory?.()) {
        stack.push(abs);
        continue;
      }
      if (ent.isFile?.()) {
        out.push(abs);
      }
    }
  }
  return out.sort();
}

function countLines(text: string): number {
  const norm = normalizeNewlines(text);
  const trimmed = norm.trim();
  if (!trimmed) {
    return 0;
  }
  return trimmed.split("\n").length;
}

export async function syncFile(args: {
  filePath: string;
  dryRun?: boolean;
  /** Override canonical root (useful for tests). */
  rootDir?: string;
}): Promise<SyncResult> {
  const dryRun = Boolean(args.dryRun);
  const filePath = args.filePath;
  const rootDir = args.rootDir ?? facultRootDir();

  const errors: string[] = [];
  const changes: SyncChange[] = [];

  if (!isSafePathString(filePath)) {
    return {
      filePath,
      dryRun,
      changed: false,
      changes: [],
      errors: [`Ignored unsafe path: ${filePath}`],
    };
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return {
      filePath,
      dryRun,
      changed: false,
      changes: [],
      errors: [`File not found: ${filePath}`],
    };
  }

  let text: string;
  try {
    text = await file.text();
  } catch (e: unknown) {
    return {
      filePath,
      dryRun,
      changed: false,
      changes: [],
      errors: [`Failed to read file: ${filePath}`],
    };
  }

  if (!hasMarkers(text)) {
    return { filePath, dryRun, changed: false, changes: [], errors: [] };
  }

  const found = findMarkersInText(text, filePath);
  if (found.errors.length) {
    return {
      filePath,
      dryRun,
      changed: false,
      changes: [],
      errors: found.errors,
    };
  }

  // Disallow overlapping/nested marker blocks for safety (v1).
  let lastEnd = -1;
  for (const p of found.pairs) {
    if (p.open.start < lastEnd) {
      errors.push(
        `${filePath}:${p.open.line}: snippet markers may not be nested or overlapping (found ${p.name})`
      );
    }
    lastEnd = p.close.end;
  }
  if (errors.length) {
    return {
      filePath,
      dryRun,
      changed: false,
      changes: [],
      errors,
    };
  }

  const project = await detectProjectForFile(filePath);

  type Replacement = { start: number; end: number; next: string };
  const replacements: Replacement[] = [];

  for (const pair of found.pairs) {
    const marker = pair.name;
    const existing = text.slice(pair.contentStart, pair.contentEnd);
    const existingNorm = normalizeSnippetBody(existing);

    const snippet = await findSnippet({
      marker,
      project,
      rootDir,
    });

    if (!snippet) {
      changes.push({ marker, status: "not-found" });
      continue;
    }

    const snippetNorm = normalizeSnippetBody(snippet.content);
    if (existingNorm === snippetNorm) {
      changes.push({
        marker,
        status: "unchanged",
        snippetPath: snippet.path,
        lines: countLines(snippetNorm),
      });
      continue;
    }

    const injection = formatSnippetInjection(snippet.content);
    replacements.push({
      start: pair.contentStart,
      end: pair.contentEnd,
      next: injection,
    });
    changes.push({
      marker,
      status: "updated",
      snippetPath: snippet.path,
      lines: countLines(snippetNorm),
    });
  }

  if (replacements.length === 0) {
    return { filePath, dryRun, changed: false, changes, errors: [] };
  }

  // Apply replacements back-to-front to keep indices valid.
  let updated = text;
  for (const r of replacements.sort((a, b) => b.start - a.start)) {
    updated = updated.slice(0, r.start) + r.next + updated.slice(r.end);
  }

  if (!dryRun) {
    await Bun.write(filePath, updated);
  }

  return { filePath, dryRun, changed: true, changes, errors: [] };
}

export async function renderSnippetText(args: {
  text: string;
  project?: string | null;
  filePath?: string;
  rootDir?: string;
}): Promise<RenderSnippetTextResult> {
  const rootDir = args.rootDir ?? facultRootDir();
  const text = args.text;
  const filePath = args.filePath;
  const errors: string[] = [];
  const changes: SyncChange[] = [];

  if (!hasMarkers(text)) {
    return { text, changes, errors };
  }

  const found = findMarkersInText(text, filePath);
  if (found.errors.length) {
    return {
      text,
      changes,
      errors: found.errors,
    };
  }

  let lastEnd = -1;
  for (const p of found.pairs) {
    if (p.open.start < lastEnd) {
      const location = filePath
        ? `${filePath}:${p.open.line}`
        : `line ${p.open.line}`;
      errors.push(
        `${location}: snippet markers may not be nested or overlapping (found ${p.name})`
      );
    }
    lastEnd = p.close.end;
  }
  if (errors.length) {
    return { text, changes, errors };
  }

  type Replacement = { start: number; end: number; next: string };
  const replacements: Replacement[] = [];

  for (const pair of found.pairs) {
    const marker = pair.name;
    const existing = text.slice(pair.contentStart, pair.contentEnd);
    const existingNorm = normalizeSnippetBody(existing);

    const snippet = await findSnippet({
      marker,
      project: args.project ?? null,
      rootDir,
    });

    if (!snippet) {
      changes.push({ marker, status: "not-found" });
      continue;
    }

    const snippetNorm = normalizeSnippetBody(snippet.content);
    if (existingNorm === snippetNorm) {
      changes.push({
        marker,
        status: "unchanged",
        snippetPath: snippet.path,
        lines: countLines(snippetNorm),
      });
      continue;
    }

    replacements.push({
      start: pair.contentStart,
      end: pair.contentEnd,
      next: formatSnippetInjection(snippet.content),
    });
    changes.push({
      marker,
      status: "updated",
      snippetPath: snippet.path,
      lines: countLines(snippetNorm),
    });
  }

  if (replacements.length === 0) {
    return { text, changes, errors };
  }

  let updated = text;
  for (const r of replacements.sort((a, b) => b.start - a.start)) {
    updated = updated.slice(0, r.start) + r.next + updated.slice(r.end);
  }

  return {
    text: updated,
    changes,
    errors,
  };
}

export async function syncAll(args?: {
  dryRun?: boolean;
  /** Override canonical root (useful for tests). */
  rootDir?: string;
  /** Optional explicit file list; if provided, only sync these. */
  files?: string[];
}): Promise<SyncResult[]> {
  const dryRun = Boolean(args?.dryRun);
  const rootDir = args?.rootDir ?? facultRootDir();

  const files: string[] = [];

  if (args?.files && args.files.length) {
    for (const p of args.files) {
      if (p) {
        files.push(p);
      }
    }
  } else {
    const agentsDir = join(rootDir, "agents");
    if (await dirExists(agentsDir)) {
      const discovered = await listFilesRecursive(agentsDir);
      for (const p of discovered) {
        files.push(p);
      }
    }
  }

  const results: SyncResult[] = [];
  for (const p of files.sort()) {
    // Only attempt to sync files that look like they contain markers.
    try {
      const f = Bun.file(p);
      if (!(await f.exists())) {
        continue;
      }
      const preview = await f.text();
      if (!hasMarkers(preview)) {
        continue;
      }
    } catch {
      // ignore unreadable files
    }
    results.push(await syncFile({ filePath: p, dryRun, rootDir }));
  }
  return results;
}

export async function listSnippets(args?: {
  /** Override canonical root (useful for tests). */
  rootDir?: string;
}): Promise<{ marker: string; path: string }[]> {
  const rootDir = args?.rootDir ?? facultRootDir();
  const snippetsDir = join(rootDir, "snippets");
  if (!(await dirExists(snippetsDir))) {
    return [];
  }

  const out: { marker: string; path: string }[] = [];
  const glob = new Bun.Glob("**/*.md");
  for await (const rel of glob.scan({ cwd: snippetsDir, onlyFiles: true })) {
    const abs = join(snippetsDir, rel);
    if (!isSafePathString(abs)) {
      continue;
    }

    // rel is like:
    // - global/foo.md
    // - projects/myproj/bar.md
    if (!rel.endsWith(".md")) {
      continue;
    }

    const noExt = rel.slice(0, -".md".length);
    const parts = noExt.split("/").filter(Boolean);
    if (parts[0] === "global") {
      const name = parts.slice(1).join("/");
      if (name) {
        out.push({ marker: `global/${name}`, path: abs });
      }
      continue;
    }
    if (parts[0] === "projects" && parts.length >= 3) {
      const project = parts[1]!;
      const name = parts.slice(2).join("/");
      out.push({ marker: `${project}/${name}`, path: abs });
    }
  }

  return out.sort((a, b) => a.marker.localeCompare(b.marker));
}

export async function ensureSnippetFile(args: {
  marker: string;
  /** Override canonical root (useful for tests). */
  rootDir?: string;
}): Promise<{ path: string; created: boolean }> {
  const rootDir = args.rootDir ?? facultRootDir();
  const marker = args.marker;

  const parts = marker.split("/").filter(Boolean);
  if (parts[0] === "global" && parts.length >= 2) {
    const rel = parts.slice(1).join("/");
    const p = join(rootDir, "snippets", "global", snippetNameToRelPath(rel));
    await mkdir(dirname(p), { recursive: true });
    const exists = await fileExists(p);
    if (!exists) {
      await Bun.write(p, "");
    }
    return { path: p, created: !exists };
  }

  // If marker includes an explicit project scope, create under that project.
  if (parts.length >= 2) {
    const project = parts[0]!;
    const rel = parts.slice(1).join("/");
    const p = join(
      rootDir,
      "snippets",
      "projects",
      project,
      snippetNameToRelPath(rel)
    );
    await mkdir(dirname(p), { recursive: true });
    const exists = await fileExists(p);
    if (!exists) {
      await Bun.write(p, "");
    }
    return { path: p, created: !exists };
  }

  // Default: create a global snippet for unscoped names.
  const p = join(rootDir, "snippets", "global", snippetNameToRelPath(marker));
  await mkdir(dirname(p), { recursive: true });
  const exists = await fileExists(p);
  if (!exists) {
    await Bun.write(p, "");
  }
  return { path: p, created: !exists };
}
