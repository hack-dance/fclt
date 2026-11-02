import { join } from "node:path";
import {
  capabilityRoot,
  pathsOverlap,
  safeCapabilityPath,
} from "./capability-files";
import { hashCapability } from "./capability-registry";
import { indexFile } from "./index-filesystem";
import type { LibraryContext } from "./library-editor";
import { withLibraryMutationLock } from "./library-lock";
import { atomicLibraryWrite } from "./library-storage";

function settingsPath(ctx: LibraryContext, scope: "global" | "project") {
  return scope === "project"
    ? join(ctx.sourceRoot, "library-settings.json")
    : join(ctx.localRoot, "library", "preferences.json");
}
export async function readLibrarySettings(
  ctx: LibraryContext,
  scope: "global" | "project"
) {
  const root = await capabilityRoot(
    scope === "project" ? ctx.sourceRoot : ctx.localRoot
  );
  if (
    scope === "global" &&
    pathsOverlap(root, await capabilityRoot(ctx.sourceRoot))
  ) {
    throw new Error("Library preferences must stay outside canonical source");
  }
  const path =
    scope === "project"
      ? join(root, "library-settings.json")
      : join(root, "library", "preferences.json");
  await safeCapabilityPath(path);
  const file = indexFile(path);
  if (await file.exists()) {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 16_384) {
      throw new Error("Library settings are unsafe");
    }
  }
  const content = (await file.exists()) ? await file.text() : null;
  if (content !== null && content.length > 16_384) {
    throw new Error("Library settings exceed the supported size");
  }
  const parsed: unknown =
    content === null ? { schemaVersion: 1 } : JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid library settings");
  }
  const value = parsed as Record<string, unknown>;
  const key = scope === "project" ? "inheritGlobal" : "autoSync";
  if (
    value.schemaVersion !== 1 ||
    Object.keys(value).some((name) => !["schemaVersion", key].includes(name)) ||
    (value[key] !== undefined && typeof value[key] !== "boolean")
  ) {
    throw new Error("Invalid library settings");
  }
  const legacy =
    scope === "project" && content === null
      ? await legacyInheritance(root)
      : null;
  return {
    revision: hashCapability(
      JSON.stringify([scope, content, legacy?.content ?? null])
    ),
    enabled: content === null && legacy ? legacy.enabled : value[key] !== false,
  };
}
export async function saveLibrarySettings(
  ctx: LibraryContext,
  scope: "global" | "project",
  revision: string,
  enabled: boolean
) {
  const root = await capabilityRoot(ctx.sourceRoot);
  return await withLibraryMutationLock(root, async () => {
    const current = await readLibrarySettings(ctx, scope);
    if (current.revision !== revision || typeof enabled !== "boolean") {
      throw new Error("Library settings changed");
    }
    await atomicLibraryWrite(
      settingsPath(ctx, scope),
      `${JSON.stringify({ schemaVersion: 1, [scope === "project" ? "inheritGlobal" : "autoSync"]: enabled }, null, 2)}\n`
    );
    return await readLibrarySettings(ctx, scope);
  });
}
async function legacyInheritance(rootDir: string) {
  const path = join(rootDir, "config.toml");
  await safeCapabilityPath(path);
  const config = indexFile(path);
  if (!(await config.exists())) {
    return { content: null, enabled: true };
  }
  const metadata = await config.stat();
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 262_144) {
    throw new Error("Invalid project settings");
  }
  const content = await config.text();
  const parsed = Bun.TOML.parse(content) as Record<string, unknown>;
  const projects = parsed.projects;
  const defaults =
    projects && typeof projects === "object" && !Array.isArray(projects)
      ? (projects as Record<string, unknown>).defaults
      : undefined;
  const value =
    defaults && typeof defaults === "object" && !Array.isArray(defaults)
      ? (defaults as Record<string, unknown>).inherit_global
      : undefined;
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error("Invalid project inheritance setting");
  }
  return { content, enabled: value !== false };
}
