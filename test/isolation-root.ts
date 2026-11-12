import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
export function createIsolatedTestRoot(
  prefix: string,
  options: { preferWrapperRoot?: boolean } = {}
) {
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
  // Nested probes may deliberately redirect TMPDIR into a protected root.
  // Prefer the outer wrapper's temporary directory so its cleanup also owns them.
  const wrapperRoot = process.env.FCLT_TEST_SHELL_ROOT
    ? physicalPath(process.env.FCLT_TEST_SHELL_ROOT)
    : null;
  const systemTemp =
    process.platform === "win32"
      ? join(process.env.SystemRoot || "C:\\Windows", "Temp")
      : "/var/tmp";
  const base = [
    options.preferWrapperRoot ? wrapperRoot : null,
    tempBase,
    wrapperRoot ? join(wrapperRoot, "tmp") : null,
    physicalPath(systemTemp),
  ].find(
    (candidate): candidate is string =>
      candidate !== null &&
      !isInsideOrEqual(candidate, realHome) &&
      !isInsideOrEqual(candidate, realState)
  );
  if (!base) {
    throw new Error(
      "No temporary directory outside the original home and state"
    );
  }
  if (base.includes("\n") || base.includes("\r")) {
    throw new Error("Test isolation paths must not contain newlines");
  }
  const template = physicalPath(join(base, prefix));
  const testRoot = realpathSync(mkdtempSync(template));
  const info = lstatSync(testRoot, { bigint: true });
  return {
    realHome,
    realState,
    testRoot,
    device: String(info.dev),
    inode: String(info.ino),
  };
}

/** Remove only the shell root whose creation identity the wrapper captured. */
export function cleanupIsolatedTestRoot(args: {
  realHome: string;
  realState: string;
  testRoot: string;
  device: string;
  inode: string;
}): void {
  const root = resolve(args.testRoot);
  const info = lstatSync(root, { bigint: true });
  const protectedRoots = [
    physicalPath(args.realHome),
    physicalPath(args.realState),
  ];
  if (
    !(basename(root).startsWith("fclt-test-shell-") && info.isDirectory()) ||
    info.isSymbolicLink() ||
    realpathSync(root) !== root ||
    String(info.dev) !== args.device ||
    String(info.ino) !== args.inode ||
    protectedRoots.some(
      (boundary) =>
        isInsideOrEqual(root, boundary) || isInsideOrEqual(boundary, root)
    )
  ) {
    throw new Error(
      "Test scratch ownership changed; the directory was preserved"
    );
  }
  rmSync(root, { recursive: true });
}

if (import.meta.main) {
  if (process.argv[2] === "--cleanup") {
    if (process.argv.length !== 8) {
      throw new Error("Expected the exact test scratch creation receipt");
    }
    const [testRoot, device, inode, realHome, realState] =
      process.argv.slice(3);
    cleanupIsolatedTestRoot({
      testRoot: testRoot!,
      device: device!,
      inode: inode!,
      realHome: realHome!,
      realState: realState!,
    });
  } else {
    const { realHome, realState, testRoot, device, inode } =
      createIsolatedTestRoot("fclt-test-shell-");
    process.stdout.write(
      `${realHome}\n${realState}\n${testRoot}\n${device}\n${inode}\n`
    );
  }
}
