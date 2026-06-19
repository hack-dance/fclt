import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_FCLT_CODEX_PLUGIN_FILES,
  BUILTIN_OPERATING_MODEL_FILES,
} from "./builtin-assets";
import { projectRootFromAiRoot } from "./paths";

export const OPERATING_MODEL_AGENTS_GLOBAL_TEMPLATE =
  "snippets/templates/agents-global.md";
export const OPERATING_MODEL_AGENTS_GLOBAL_TARGET = "AGENTS.global.md";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function facultBuiltinPackRoot(
  packName = "facult-operating-model"
): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = join(here, "..", "assets", "packs", packName);
  if (existsSync(sourceRoot)) {
    return sourceRoot;
  }
  if (packName === "facult-operating-model") {
    return materializeBuiltinOperatingModelPack();
  }
  return sourceRoot;
}

export function facultBuiltinAgentsGlobalSourcePath(): string {
  const root = facultBuiltinPackRoot();
  const templatePath = join(root, OPERATING_MODEL_AGENTS_GLOBAL_TEMPLATE);
  if (existsSync(templatePath)) {
    return templatePath;
  }
  return join(root, OPERATING_MODEL_AGENTS_GLOBAL_TARGET);
}

export function facultBuiltinCodexPluginRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = join(here, "..", "plugins", "fclt");
  if (existsSync(join(sourceRoot, ".codex-plugin", "plugin.json"))) {
    return sourceRoot;
  }
  return materializeBuiltinCodexPlugin();
}

export function builtinOperatingModelInstallRelPath(
  relativePath: string
): string {
  if (relativePath === OPERATING_MODEL_AGENTS_GLOBAL_TEMPLATE) {
    return OPERATING_MODEL_AGENTS_GLOBAL_TARGET;
  }
  return relativePath;
}

function materializeBuiltinOperatingModelPack(): string {
  const root = join(tmpdir(), "fclt-builtin-packs", "facult-operating-model");
  for (const [relativePath, content] of Object.entries(
    BUILTIN_OPERATING_MODEL_FILES
  )) {
    const pathValue = join(root, relativePath);
    mkdirSync(dirname(pathValue), { recursive: true });
    if (existsSync(pathValue)) {
      try {
        if (readFileSync(pathValue, "utf8") === content) {
          continue;
        }
      } catch {
        // Rewrite unreadable materialized assets below.
      }
    }
    writeFileSync(pathValue, content, "utf8");
  }
  return root;
}

function materializeBuiltinCodexPlugin(): string {
  const root = join(tmpdir(), "fclt-builtin-plugins", "fclt");
  for (const [relativePath, content] of Object.entries(
    BUILTIN_FCLT_CODEX_PLUGIN_FILES
  )) {
    const pathValue = join(root, relativePath);
    mkdirSync(dirname(pathValue), { recursive: true });
    if (existsSync(pathValue)) {
      try {
        if (readFileSync(pathValue, "utf8") === content) {
          continue;
        }
      } catch {
        // Rewrite unreadable materialized assets below.
      }
    }
    writeFileSync(pathValue, content, "utf8");
  }
  return root;
}

async function readTomlObject(
  pathValue: string
): Promise<Record<string, unknown> | null> {
  const file = Bun.file(pathValue);
  if (!(await file.exists())) {
    return null;
  }
  const parsed = Bun.TOML.parse(await file.text());
  return isPlainObject(parsed) ? parsed : null;
}

function readBooleanConfig(
  data: Record<string, unknown> | null,
  key: string
): boolean | null {
  if (!data) {
    return null;
  }
  const builtin = data.builtin;
  if (!isPlainObject(builtin)) {
    return null;
  }
  const value = builtin[key];
  return typeof value === "boolean" ? value : null;
}

export async function builtinSyncDefaultsEnabled(
  rootDir: string,
  homeDir?: string
): Promise<boolean> {
  const [tracked, local] = await Promise.all([
    readTomlObject(join(rootDir, "config.toml")),
    readTomlObject(join(rootDir, "config.local.toml")),
  ]);

  for (const candidate of [tracked, local]) {
    const direct = readBooleanConfig(candidate, "sync_defaults");
    if (direct != null) {
      return direct;
    }
    const legacy = readBooleanConfig(candidate, "sync_global_defaults");
    if (legacy != null) {
      return legacy;
    }
  }

  if (projectRootFromAiRoot(rootDir, homeDir) != null) {
    return false;
  }

  return true;
}
