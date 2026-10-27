import { mock } from "bun:test";
import fs from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isInsideOrEqual, physicalPath } from "./isolation-root";

const PATH_SEGMENTS = /[\\/]/;
const TRAILING_SEPARATOR = /[\\/]$/;

/** Keep fixture teardown fail-closed even if a test accidentally supplies a live path. */
export function fixtureRemovalGuard(root: string) {
  const physicalRoot = fs.realpathSync(root);
  function checkedFixturePath(path: fs.PathLike): string {
    const raw = path instanceof URL ? fileURLToPath(path) : path.toString();
    if (raw.split(PATH_SEGMENTS).includes("..")) {
      throw new Error("Refusing test removal with parent traversal segments");
    }
    const absolute = resolve(raw);
    if (absolute === resolve(root) || !isInsideOrEqual(absolute, root)) {
      throw new Error("Refusing test removal outside the isolated temp root");
    }
    // A trailing separator follows the final symlink; a bare link removes only the link.
    const checked = TRAILING_SEPARATOR.test(raw)
      ? physicalPath(absolute)
      : join(physicalPath(dirname(absolute)), basename(absolute));
    if (checked === physicalRoot || !isInsideOrEqual(checked, physicalRoot)) {
      throw new Error(
        "Refusing test removal through a symlink outside the isolated temp root"
      );
    }
    return checked;
  }

  const originalRm = fs.promises.rm;
  const rm: typeof fs.promises.rm = (path, options) => {
    return originalRm(checkedFixturePath(path), options);
  };
  const originalRmSync = fs.rmSync;
  const rmSync: typeof fs.rmSync = (path, options) => {
    return originalRmSync(checkedFixturePath(path), options);
  };
  return { rm, rmSync };
}

export function installFixtureRemovalGuard(root: string): void {
  const guard = fixtureRemovalGuard(root);
  fs.promises.rm = guard.rm;
  fs.rmSync = guard.rmSync;
  // Bun's named builtin imports are not updated by syncBuiltinESMExports.
  mock.module("node:fs", () => ({ ...fs, default: fs }));
  mock.module("node:fs/promises", () => ({
    ...fs.promises,
    default: fs.promises,
  }));
}
