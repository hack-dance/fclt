import { join } from "node:path";

const AI_REF_RE = /(?<![\w@])@ai\/([^\s"'`<>]+)/g;
const INTERPOLATION_RE = /\$\{([^}]+)\}/g;
const TRAILING_PUNCTUATION_RE = /[.,;:!?)}\]]+$/;
const MAX_RENDER_PASSES = 10;

export interface RenderCanonicalTextOptions {
  homeDir?: string;
  rootDir: string;
  projectSlug?: string;
  projectRoot?: string;
  targetTool?: string;
  targetPath?: string;
  overrides?: Record<string, unknown>;
}

type RenderContext = Record<string, unknown>;

function trimTrailingPunctuation(refPath: string): {
  path: string;
  suffix: string;
} {
  const match = TRAILING_PUNCTUATION_RE.exec(refPath);
  if (!match) {
    return { path: refPath, suffix: "" };
  }

  const suffix = match[0];
  return {
    path: refPath.slice(0, -suffix.length),
    suffix,
  };
}

export function renderAiRefs(input: string, canonicalRoot: string): string {
  return input.replace(AI_REF_RE, (_match, refPath: string) => {
    const { path, suffix } = trimTrailingPunctuation(refPath);
    return `${join(canonicalRoot, path)}${suffix}`;
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeContexts(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      merged[key] = mergeContexts(current, value);
      continue;
    }
    merged[key] = value;
  }

  return merged;
}

async function readTomlFile(
  pathValue: string
): Promise<Record<string, unknown> | null> {
  const file = Bun.file(pathValue);
  if (!(await file.exists())) {
    return null;
  }

  const text = await file.text();
  const parsed = Bun.TOML.parse(text);
  return isPlainObject(parsed) ? parsed : null;
}

function getContextValue(
  context: Record<string, unknown>,
  dottedPath: string
): unknown {
  const segments = dottedPath
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return undefined;
  }

  let current: unknown = context;
  for (const segment of segments) {
    if (!(isPlainObject(current) && segment in current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function interpolateString(
  input: string,
  context: Record<string, unknown>
): string {
  return input.replace(INTERPOLATION_RE, (match, keyPath: string) => {
    const value = getContextValue(context, keyPath.trim());
    return typeof value === "string" ? value : match;
  });
}

export async function loadRenderContext(
  options: RenderCanonicalTextOptions
): Promise<RenderContext> {
  const {
    homeDir,
    overrides,
    projectRoot,
    projectSlug,
    rootDir,
    targetPath,
    targetTool,
  } = options;
  const contextBase: RenderContext = {
    AI_ROOT: rootDir,
    HOME: homeDir ?? "",
    PROJECT_ROOT: projectRoot ?? "",
    PROJECT_SLUG: projectSlug ?? "",
    TARGET_PATH: targetPath ?? "",
    TARGET_TOOL: targetTool ?? "",
  };

  let context = contextBase;
  const layers = [
    await readTomlFile(join(rootDir, "config.toml")),
    await readTomlFile(join(rootDir, "config.local.toml")),
    projectSlug
      ? await readTomlFile(
          join(rootDir, "projects", projectSlug, "config.toml")
        )
      : null,
    projectSlug
      ? await readTomlFile(
          join(rootDir, "projects", projectSlug, "config.local.toml")
        )
      : null,
    overrides && isPlainObject(overrides) ? overrides : null,
  ];

  for (const layer of layers) {
    if (layer) {
      context = mergeContexts(context, layer);
    }
  }

  return context;
}

export async function renderCanonicalText(
  input: string,
  options: RenderCanonicalTextOptions
): Promise<string> {
  const context = await loadRenderContext(options);
  let rendered = input;
  const seen = new Set<string>();

  for (let pass = 0; pass < MAX_RENDER_PASSES; pass += 1) {
    if (seen.has(rendered)) {
      break;
    }
    seen.add(rendered);

    const interpolated = interpolateString(rendered, context);
    const withRefs = renderAiRefs(interpolated, options.rootDir);
    if (withRefs === rendered) {
      return withRefs;
    }
    rendered = withRefs;
  }

  return rendered;
}
