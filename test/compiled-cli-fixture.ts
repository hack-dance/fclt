import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CompiledCliFixture {
  cleanup: () => Promise<void>;
  entryPath: string;
}

export async function buildCompiledCliFixture(): Promise<CompiledCliFixture> {
  const root = await mkdtemp(join(tmpdir(), "fclt-compiled-cli-"));
  try {
    const packageJson = JSON.parse(
      await readFile(join(import.meta.dir, "..", "package.json"), "utf8")
    ) as { version?: unknown };
    if (typeof packageJson.version !== "string" || !packageJson.version) {
      throw new Error(
        "Package version is unavailable for the compiled CLI fixture"
      );
    }
    const entryPath = join(
      root,
      process.platform === "win32" ? "fclt.exe" : "fclt"
    );
    const result = await Bun.build({
      compile: { outfile: entryPath },
      define: {
        FCLT_COMPILED_VERSION: JSON.stringify(packageJson.version),
      },
      entrypoints: [join(import.meta.dir, "..", "src", "index.ts")],
    });
    if (!result.success) {
      throw new AggregateError(
        result.logs,
        "Failed to build the compiled CLI fixture"
      );
    }
    return {
      cleanup: async () => {
        await rm(root, { force: true, recursive: true });
      },
      entryPath,
    };
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
}
