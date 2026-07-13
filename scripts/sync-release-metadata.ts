import { join, resolve } from "node:path";

interface ReleaseMetadataResult {
  changed: boolean;
  version: string;
}

interface CapabilityMatrix {
  generatedFrom?: {
    packageVersion?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export async function syncReleaseMetadata({
  repoRoot = resolve(import.meta.dir, ".."),
}: {
  repoRoot?: string;
} = {}): Promise<ReleaseMetadataResult> {
  const packagePath = join(repoRoot, "package.json");
  const matrixPath = join(
    repoRoot,
    "docs",
    "codex-plugin-capability-matrix.json"
  );
  const packageJson = (await Bun.file(packagePath).json()) as {
    version?: unknown;
  };
  const version =
    typeof packageJson.version === "string" ? packageJson.version.trim() : "";
  if (!version) {
    throw new Error("package.json must declare a non-empty version");
  }
  const matrix = (await Bun.file(matrixPath).json()) as CapabilityMatrix;
  if (!matrix.generatedFrom) {
    throw new Error(
      "codex-plugin-capability-matrix.json must declare generatedFrom"
    );
  }
  if (matrix.generatedFrom.packageVersion === version) {
    return { changed: false, version };
  }
  matrix.generatedFrom.packageVersion = version;
  await Bun.write(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
  return { changed: true, version };
}

if (import.meta.main) {
  const result = await syncReleaseMetadata();
  console.log(
    `${result.changed ? "Updated" : "Verified"} release metadata for ${result.version}`
  );
}
