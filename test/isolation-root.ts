import { mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export function isInsideOrEqual(path: string, root: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/** Resolve missing descendants through their deepest existing physical ancestor. */
export function physicalPath(path: string): string {
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return join(realpathSync(ancestor), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw error;
      }
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

function expandHome(path: string, home: string): string {
  if (path === "~") {
    return home;
  }
  return path.startsWith("~/") ? join(home, path.slice(2)) : resolve(path);
}

/** This module has no product imports and is shared by the shell wrapper and preload. */
export function createIsolatedTestRoot(prefix: string) {
  const realHome = realpathSync(process.env.FCLT_TEST_REAL_HOME || homedir());
  const configuredState =
    process.env.FCLT_TEST_REAL_STATE_ROOT ||
    process.env.FACULT_LOCAL_STATE_DIR?.trim();
  const statePath = configuredState
    ? expandHome(configuredState, realHome)
    : process.platform === "darwin"
      ? join(realHome, "Library", "Application Support", "fclt")
      : process.env.XDG_STATE_HOME?.trim()
        ? join(expandHome(process.env.XDG_STATE_HOME.trim(), realHome), "fclt")
        : join(realHome, ".local", "state", "fclt");
  const realState = physicalPath(statePath);
  const tempBase = realpathSync(tmpdir());
  for (const path of [realHome, realState, tempBase]) {
    if (path.includes("\n") || path.includes("\r")) {
      throw new Error("Test isolation paths must not contain newlines");
    }
  }
  // A caller may keep TMPDIR in HOME or its state store. Allocate elsewhere
  // instead of placing fixtures in either captured directory.
  const base =
    isInsideOrEqual(tempBase, realHome) || isInsideOrEqual(tempBase, realState)
      ? process.platform === "win32"
        ? join(process.env.SystemRoot || "C:\\Windows", "Temp")
        : "/tmp"
      : tempBase;
  const template = physicalPath(join(base, prefix));
  const testRoot = realpathSync(mkdtempSync(template));
  return { realHome, realState, testRoot };
}

if (import.meta.main) {
  const { realHome, realState, testRoot } =
    createIsolatedTestRoot("fclt-test-shell-");
  process.stdout.write(`${realHome}\n${realState}\n${testRoot}\n`);
}
