const EXCLUDED_SEGMENTS = new Set([
  ".ai",
  ".agents",
  ".claude",
  ".codex",
  ".cursor",
  ".git",
  "dist",
  "node_modules",
  "test",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Check npm's actual pack list independently of package.json's files allowlist. */
export function verifyPackageContents(
  report: unknown,
  requiredPaths: readonly string[]
): number {
  if (!(Array.isArray(report) && report.length === 1)) {
    throw new Error("Expected exactly one npm package report.");
  }
  const entry: unknown = report[0];
  if (
    !(isRecord(entry) && entry.name === "facult" && Array.isArray(entry.files))
  ) {
    throw new Error("Expected a facult package report with a files list.");
  }
  const paths = new Set<string>();
  for (const file of entry.files) {
    if (!(isRecord(file) && typeof file.path === "string" && file.path)) {
      throw new Error("Invalid npm package file entry.");
    }
    const segments = file.path.split("/");
    if (
      segments.some((segment) => EXCLUDED_SEGMENTS.has(segment)) ||
      file.path.endsWith(".test.ts")
    ) {
      throw new Error(
        `Unexpected test or local-state file in package: ${file.path}`
      );
    }
    paths.add(file.path);
  }
  const missing = requiredPaths.filter((path) => !paths.has(path));
  if (missing.length > 0) {
    throw new Error(
      `Required npm package files are missing:\n${missing.join("\n")}`
    );
  }
  return paths.size;
}

/** Runtime sources and bundled capabilities must survive packaging as a complete set. */
export async function requiredPackagePaths(
  repoRoot: string
): Promise<string[]> {
  const paths = new Set([
    "package.json",
    "README.md",
    "LICENSE",
    "bin/fclt.cjs",
    "bin/facult.cjs",
  ]);
  for (const pattern of ["src/**/*.ts", "assets/**/*", "plugins/fclt/**/*"]) {
    for await (const path of new Bun.Glob(pattern).scan({
      cwd: repoRoot,
      dot: true,
      onlyFiles: true,
    })) {
      if (!path.endsWith(".test.ts")) {
        paths.add(path);
      }
    }
  }
  return [...paths].sort();
}
