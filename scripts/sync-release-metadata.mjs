import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits, modify } from "jsonc-parser";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function syncReleaseMetadata({
  repoRoot = defaultRepoRoot,
  version: requestedVersion,
} = {}) {
  const packagePath = join(repoRoot, "package.json");
  const matrixPath = join(
    repoRoot,
    "docs",
    "codex-plugin-capability-matrix.json"
  );
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const packageVersion =
    typeof packageJson.version === "string" ? packageJson.version.trim() : "";
  const version =
    typeof requestedVersion === "string"
      ? requestedVersion.trim()
      : packageVersion;
  if (!version) {
    throw new Error("release metadata requires a non-empty package version");
  }
  const matrixText = await readFile(matrixPath, "utf8");
  const matrix = JSON.parse(matrixText);
  if (!matrix.generatedFrom) {
    throw new Error(
      "codex-plugin-capability-matrix.json must declare generatedFrom"
    );
  }
  if (matrix.generatedFrom.packageVersion === version) {
    return { changed: false, version };
  }
  const edits = modify(
    matrixText,
    ["generatedFrom", "packageVersion"],
    version,
    {
      formattingOptions: {
        eol: "\n",
        insertSpaces: true,
        tabSize: 2,
      },
    }
  );
  const updated = applyEdits(matrixText, edits);
  await writeFile(
    matrixPath,
    updated.endsWith("\n") ? updated : `${updated}\n`
  );
  return { changed: true, version };
}

export async function prepare(_pluginConfig, context) {
  const version = context?.nextRelease?.version;
  if (typeof version !== "string" || !version.trim()) {
    throw new Error(
      "semantic-release did not provide a non-empty nextRelease.version"
    );
  }
  await syncReleaseMetadata({
    repoRoot:
      typeof context.cwd === "string" && context.cwd
        ? context.cwd
        : defaultRepoRoot,
    version,
  });
}

if (import.meta.main) {
  const result = await syncReleaseMetadata();
  console.log(
    `${result.changed ? "Updated" : "Verified"} release metadata for ${result.version}`
  );
}
