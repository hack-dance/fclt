import { mock } from "bun:test";
import fs from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(rel)
  );
}

/** Keep fixture teardown fail-closed even if a test accidentally supplies a live path. */
export function installFixtureRemovalGuard(root: string): void {
  const physicalRoot = fs.realpathSync(root);
  function assertFixturePath(path: fs.PathLike): void {
    const absolute = resolve(
      path instanceof URL ? fileURLToPath(path) : path.toString()
    );
    if (!isWithin(absolute, root)) {
      throw new Error("Refusing test removal outside the isolated temp root");
    }
    // Resolve parents, not the final entry: unlinking a fixture symlink is safe.
    let parent = dirname(absolute);
    while (true) {
      try {
        const physicalParent = fs.realpathSync(parent);
        if (
          physicalParent !== physicalRoot &&
          !isWithin(physicalParent, physicalRoot)
        ) {
          throw new Error(
            "Refusing test removal through a symlink outside the isolated temp root"
          );
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        parent = dirname(parent);
      }
    }
  }

  const originalRm = fs.promises.rm;
  fs.promises.rm = (path, options) => {
    assertFixturePath(path);
    return originalRm(path, options);
  };
  const originalRmSync = fs.rmSync;
  fs.rmSync = (path, options) => {
    assertFixturePath(path);
    return originalRmSync(path, options);
  };
  // Bun's named builtin imports are not updated by syncBuiltinESMExports.
  mock.module("node:fs", () => ({ ...fs, default: fs }));
  mock.module("node:fs/promises", () => ({
    ...fs.promises,
    default: fs.promises,
  }));
}
