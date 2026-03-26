import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { renderCanonicalText } from "./agents";
import { builtinSyncDefaultsEnabled, facultBuiltinPackRoot } from "./builtin";
import { projectRootFromAiRoot } from "./paths";
import { renderSnippetText } from "./snippets";

export interface GlobalDocPlan {
  write: string[];
  remove: string[];
  contents: Map<string, string>;
  sources: Map<string, string>;
  managedTargets: string[];
}

export interface RulesPlan {
  write: string[];
  remove: string[];
  contents: Map<string, string>;
  sources: Map<string, string>;
  managedRulesDir: boolean;
}

export interface ToolConfigPlan {
  targetPath: string;
  write: boolean;
  remove: boolean;
  contents: string | null;
  sourcePath?: string;
  managedConfig: boolean;
}

interface SourceTarget {
  sourcePath: string;
  targetPath: string;
}

interface GlobalDocTargetPaths {
  primary: string;
  override?: string;
}

const TOML_BARE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function fileExists(pathValue: string): Promise<boolean> {
  try {
    const stat = await Bun.file(pathValue).stat();
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readTextIfExists(pathValue: string): Promise<string | null> {
  if (!(await fileExists(pathValue))) {
    return null;
  }
  return await Bun.file(pathValue).text();
}

async function readTomlFile(
  pathValue: string
): Promise<Record<string, unknown> | null> {
  const text = await readTextIfExists(pathValue);
  if (text == null) {
    return null;
  }
  const parsed = Bun.TOML.parse(text);
  return isPlainObject(parsed) ? parsed : null;
}

function mergeTomlObjects(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      merged[key] = mergeTomlObjects(current, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function shouldQuoteTomlKey(key: string): boolean {
  return !TOML_BARE_KEY_PATTERN.test(key);
}

function escapeTomlString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function formatTomlKey(key: string): string {
  return shouldQuoteTomlKey(key) ? `"${escapeTomlString(key)}"` : key;
}

function formatTomlValue(value: unknown): string {
  if (typeof value === "string") {
    return `"${escapeTomlString(value)}"`;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => formatTomlValue(entry)).join(", ")}]`;
  }
  throw new Error(`Unsupported TOML value: ${typeof value}`);
}

function stringifyTomlObject(obj: Record<string, unknown>): string {
  const lines: string[] = [];

  function emitTable(table: Record<string, unknown>, pathParts: string[] = []) {
    const scalars: [string, unknown][] = [];
    const subtables: [string, Record<string, unknown>][] = [];

    for (const [key, value] of Object.entries(table)) {
      if (isPlainObject(value)) {
        subtables.push([key, value]);
      } else {
        scalars.push([key, value]);
      }
    }

    if (pathParts.length > 0) {
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push(`[${pathParts.map((part) => formatTomlKey(part)).join(".")}]`);
    }

    for (const [key, value] of scalars) {
      lines.push(`${formatTomlKey(key)} = ${formatTomlValue(value)}`);
    }

    for (const [key, subtable] of subtables) {
      emitTable(subtable, [...pathParts, key]);
    }
  }

  emitTable(obj);
  return lines.join("\n");
}

async function listGlobalDocSources(args: {
  rootDir: string;
  tool: string;
  toolHome: string;
}): Promise<SourceTarget[]> {
  const { rootDir, tool, toolHome } = args;
  const targets = globalDocTargetPaths(tool, toolHome);
  const useBuiltinDefaults = await builtinSyncDefaultsEnabled(rootDir);

  const candidates: SourceTarget[] = [];
  const base = join(rootDir, "AGENTS.global.md");
  if (await fileExists(base)) {
    candidates.push({
      sourcePath: base,
      targetPath: targets.primary,
    });
  } else if (useBuiltinDefaults) {
    const builtinBase = join(facultBuiltinPackRoot(), "AGENTS.global.md");
    if (await fileExists(builtinBase)) {
      candidates.push({
        sourcePath: builtinBase,
        targetPath: targets.primary,
      });
    }
  }

  const override = join(rootDir, "AGENTS.override.global.md");
  if (targets.override && (await fileExists(override))) {
    candidates.push({
      sourcePath: override,
      targetPath: targets.override,
    });
  }

  return candidates;
}

export function globalDocTargetPaths(
  tool: string,
  toolHome: string
): GlobalDocTargetPaths {
  if (tool === "claude") {
    return {
      primary: join(toolHome, "CLAUDE.md"),
    };
  }

  return {
    primary: join(toolHome, "AGENTS.md"),
    override: join(toolHome, "AGENTS.override.md"),
  };
}

async function renderSourceTarget(args: {
  homeDir: string;
  rootDir: string;
  sourcePath: string;
  targetPath: string;
  tool: string;
}): Promise<string> {
  const raw = await Bun.file(args.sourcePath).text();
  const withSnippets = await renderSnippetText({
    text: raw,
    filePath: args.sourcePath,
    rootDir: args.rootDir,
  });
  if (withSnippets.errors.length) {
    throw new Error(withSnippets.errors.join("\n"));
  }
  return await renderCanonicalText(withSnippets.text, {
    homeDir: args.homeDir,
    rootDir: args.rootDir,
    projectRoot: projectRootFromAiRoot(args.rootDir, args.homeDir) ?? undefined,
    targetTool: args.tool,
    targetPath: args.targetPath,
  });
}

export async function planToolGlobalDocsSync(args: {
  homeDir: string;
  rootDir: string;
  tool: string;
  toolHome: string;
  previouslyManagedTargets?: string[];
}): Promise<GlobalDocPlan> {
  const docs = await listGlobalDocSources(args);
  const contents = new Map<string, string>();
  const sources = new Map<string, string>();
  const managedTargets = docs.map((doc) => doc.targetPath).sort();

  for (const doc of docs) {
    const rendered = await renderSourceTarget({
      homeDir: args.homeDir,
      rootDir: args.rootDir,
      sourcePath: doc.sourcePath,
      targetPath: doc.targetPath,
      tool: args.tool,
    });
    contents.set(doc.targetPath, rendered);
    sources.set(doc.targetPath, doc.sourcePath);
  }

  const write: string[] = [];
  for (const targetPath of managedTargets) {
    const current = await readTextIfExists(targetPath);
    const desired = contents.get(targetPath);
    if (desired != null && current !== desired) {
      write.push(targetPath);
    }
  }

  const remove = (args.previouslyManagedTargets ?? [])
    .filter((targetPath) => !contents.has(targetPath))
    .sort();

  return {
    write: write.sort(),
    remove,
    contents,
    sources,
    managedTargets,
  };
}

export async function syncToolGlobalDocs(args: {
  homeDir: string;
  rootDir: string;
  tool: string;
  toolHome: string;
  previouslyManagedTargets?: string[];
  dryRun?: boolean;
}): Promise<GlobalDocPlan> {
  const plan = await planToolGlobalDocsSync(args);
  if (args.dryRun) {
    return plan;
  }

  for (const pathValue of plan.remove) {
    await rm(pathValue, { force: true });
  }
  for (const pathValue of plan.write) {
    const desired = plan.contents.get(pathValue);
    if (desired != null) {
      await mkdir(dirname(pathValue), { recursive: true });
      await Bun.write(
        pathValue,
        desired.endsWith("\n") ? desired : `${desired}\n`
      );
    }
  }
  return plan;
}

async function listToolRules(args: {
  rootDir: string;
  tool: string;
}): Promise<{ sourcePath: string; targetPath: string }[]> {
  const sourceRoot = join(args.rootDir, "tools", args.tool, "rules");
  const entries = await readdir(sourceRoot, { withFileTypes: true }).catch(
    () => [] as import("node:fs").Dirent[]
  );
  const out: { sourcePath: string; targetPath: string }[] = [];
  for (const entry of entries) {
    if (!(entry.isFile() && entry.name.endsWith(".rules"))) {
      continue;
    }
    out.push({
      sourcePath: join(sourceRoot, entry.name),
      targetPath: entry.name,
    });
  }
  return out.sort((a, b) => a.targetPath.localeCompare(b.targetPath));
}

export async function planToolRulesSync(args: {
  homeDir: string;
  rootDir: string;
  tool: string;
  rulesDir: string;
  previouslyManaged?: boolean;
}): Promise<RulesPlan> {
  const rules = await listToolRules(args);
  const contents = new Map<string, string>();
  const sources = new Map<string, string>();

  for (const rule of rules) {
    const targetPath = join(args.rulesDir, rule.targetPath);
    const raw = await Bun.file(rule.sourcePath).text();
    const rendered = await renderCanonicalText(raw, {
      homeDir: args.homeDir,
      rootDir: args.rootDir,
      projectRoot:
        projectRootFromAiRoot(args.rootDir, args.homeDir) ?? undefined,
      targetTool: args.tool,
      targetPath,
    });
    contents.set(targetPath, rendered);
    sources.set(targetPath, rule.sourcePath);
  }

  const write: string[] = [];
  for (const [targetPath, desired] of contents.entries()) {
    const current = await readTextIfExists(targetPath);
    if (current !== desired) {
      write.push(targetPath);
    }
  }

  const remove: string[] = [];
  if (args.previouslyManaged) {
    const existing = await readdir(args.rulesDir, {
      withFileTypes: true,
    }).catch(() => [] as import("node:fs").Dirent[]);
    for (const entry of existing) {
      if (!(entry.isFile() && entry.name.endsWith(".rules"))) {
        continue;
      }
      const existingPath = join(args.rulesDir, entry.name);
      if (!contents.has(existingPath)) {
        remove.push(existingPath);
      }
    }
  }

  return {
    write: write.sort(),
    remove: remove.sort(),
    contents,
    sources,
    managedRulesDir: rules.length > 0,
  };
}

export async function syncToolRules(args: {
  homeDir: string;
  rootDir: string;
  tool: string;
  rulesDir: string;
  previouslyManaged?: boolean;
  dryRun?: boolean;
}): Promise<RulesPlan> {
  const plan = await planToolRulesSync(args);
  if (args.dryRun) {
    return plan;
  }

  for (const pathValue of plan.remove) {
    await rm(pathValue, { force: true });
  }
  for (const pathValue of plan.write) {
    const desired = plan.contents.get(pathValue);
    if (desired != null) {
      await mkdir(dirname(pathValue), { recursive: true });
      await Bun.write(
        pathValue,
        desired.endsWith("\n") ? desired : `${desired}\n`
      );
    }
  }
  return plan;
}

export async function planToolConfigSync(args: {
  homeDir: string;
  rootDir: string;
  tool: string;
  toolConfigPath: string;
  existingConfigPath?: string;
  previouslyManaged?: boolean;
}): Promise<ToolConfigPlan> {
  const sourcePath = join(args.rootDir, "tools", args.tool, "config.toml");
  const localSourcePath = join(
    args.rootDir,
    "tools",
    args.tool,
    "config.local.toml"
  );
  const hasTrackedSource = await fileExists(sourcePath);
  const hasLocalSource = await fileExists(localSourcePath);

  if (!(hasTrackedSource || hasLocalSource)) {
    return {
      targetPath: args.toolConfigPath,
      write: false,
      remove: false,
      contents: null,
      sourcePath,
      managedConfig: false,
    };
  }

  const trackedRendered = hasTrackedSource
    ? await renderSourceTarget({
        homeDir: args.homeDir,
        rootDir: args.rootDir,
        sourcePath,
        targetPath: args.toolConfigPath,
        tool: args.tool,
      })
    : null;
  const localRendered = hasLocalSource
    ? await renderSourceTarget({
        homeDir: args.homeDir,
        rootDir: args.rootDir,
        sourcePath: localSourcePath,
        targetPath: args.toolConfigPath,
        tool: args.tool,
      })
    : null;
  const canonicalConfig = trackedRendered
    ? Bun.TOML.parse(trackedRendered)
    : {};
  const localConfig = localRendered ? Bun.TOML.parse(localRendered) : {};
  const existingConfig =
    (await readTomlFile(args.toolConfigPath)) ??
    (args.existingConfigPath
      ? await readTomlFile(args.existingConfigPath)
      : null) ??
    ({} as Record<string, unknown>);
  const merged = mergeTomlObjects(
    mergeTomlObjects(
      existingConfig,
      isPlainObject(canonicalConfig) ? canonicalConfig : {}
    ),
    isPlainObject(localConfig) ? localConfig : {}
  );
  const nextContents = stringifyTomlObject(merged);
  const current = await readTextIfExists(args.toolConfigPath);
  return {
    targetPath: args.toolConfigPath,
    write: current !== `${nextContents}\n`,
    remove: false,
    contents: nextContents,
    sourcePath: hasLocalSource ? localSourcePath : sourcePath,
    managedConfig: true,
  };
}

export async function syncToolConfig(args: {
  homeDir: string;
  rootDir: string;
  tool: string;
  toolConfigPath: string;
  existingConfigPath?: string;
  previouslyManaged?: boolean;
  dryRun?: boolean;
}): Promise<ToolConfigPlan> {
  const plan = await planToolConfigSync({
    homeDir: args.homeDir,
    rootDir: args.rootDir,
    tool: args.tool,
    toolConfigPath: args.toolConfigPath,
    existingConfigPath: args.existingConfigPath,
    previouslyManaged: args.previouslyManaged,
  });
  if (args.dryRun) {
    return plan;
  }

  if (plan.remove) {
    await rm(plan.targetPath, { force: true });
    return plan;
  }

  if (plan.write && plan.contents != null) {
    await mkdir(dirname(plan.targetPath), { recursive: true });
    await Bun.write(
      plan.targetPath,
      plan.contents.endsWith("\n") ? plan.contents : `${plan.contents}\n`
    );
  }

  return plan;
}
