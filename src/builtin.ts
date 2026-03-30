import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectRootFromAiRoot } from "./paths";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function facultBuiltinPackRoot(
  packName = "facult-operating-model"
): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "assets", "packs", packName);
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
