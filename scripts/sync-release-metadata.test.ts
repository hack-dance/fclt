import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepare, syncReleaseMetadata } from "./sync-release-metadata.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("sync release metadata", () => {
  it("updates the audited capability matrix from the package version", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "fclt-release-metadata-"));
    temporaryRoots.push(repoRoot);
    const docsDir = join(repoRoot, "docs");
    await mkdir(docsDir, { recursive: true });
    await Bun.write(join(repoRoot, "package.json"), '{"version":"3.4.5"}\n');
    await Bun.write(
      join(docsDir, "codex-plugin-capability-matrix.json"),
      JSON.stringify({
        generatedFrom: { packageVersion: "3.4.4", pluginVersion: "0.1.1" },
        capabilities: [],
      })
    );

    expect(await syncReleaseMetadata({ repoRoot })).toEqual({
      changed: true,
      version: "3.4.5",
    });
    expect(
      await Bun.file(
        join(docsDir, "codex-plugin-capability-matrix.json")
      ).json()
    ).toMatchObject({
      generatedFrom: { packageVersion: "3.4.5", pluginVersion: "0.1.1" },
    });
    expect(await syncReleaseMetadata({ repoRoot })).toEqual({
      changed: false,
      version: "3.4.5",
    });
  });

  it("uses the semantic-release version during its prepare pipeline", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "fclt-release-prepare-"));
    temporaryRoots.push(repoRoot);
    const docsDir = join(repoRoot, "docs");
    await mkdir(docsDir, { recursive: true });
    await Bun.write(join(repoRoot, "package.json"), '{"version":"3.4.4"}\n');
    await Bun.write(
      join(docsDir, "codex-plugin-capability-matrix.json"),
      JSON.stringify({
        generatedFrom: { packageVersion: "3.4.4", pluginVersion: "0.1.1" },
        capabilities: [],
      })
    );

    await prepare({}, { cwd: repoRoot, nextRelease: { version: "3.5.0" } });

    expect(
      await Bun.file(
        join(docsDir, "codex-plugin-capability-matrix.json")
      ).json()
    ).toMatchObject({
      generatedFrom: { packageVersion: "3.5.0", pluginVersion: "0.1.1" },
    });
  });
});
