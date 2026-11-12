import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepare, syncReleaseMetadata } from "./sync-release-metadata.mjs";

const temporaryRoots: string[] = [];

async function createFailureFixture({
  packageText = '{"version":"3.4.5"}\n',
  pluginText = '{"version":"0.1.2"}\n',
  matrixText = '{\r\n  "generatedFrom": { "packageVersion": "3.4.4", "pluginVersion": "0.1.1" },\r\n  "capabilities": []\r\n}\r\n',
}: {
  packageText?: string;
  pluginText?: string;
  matrixText?: string;
} = {}) {
  const repoRoot = await mkdtemp(join(tmpdir(), "fclt-release-invalid-"));
  temporaryRoots.push(repoRoot);
  const docsDir = join(repoRoot, "docs");
  const pluginDir = join(repoRoot, "plugins", "fclt", ".codex-plugin");
  await mkdir(docsDir, { recursive: true });
  await mkdir(pluginDir, { recursive: true });
  const files = [
    { path: join(repoRoot, "package.json"), text: packageText },
    { path: join(pluginDir, "plugin.json"), text: pluginText },
    {
      path: join(docsDir, "codex-plugin-capability-matrix.json"),
      text: matrixText,
    },
  ];
  for (const file of files) {
    await Bun.write(file.path, file.text);
  }
  return {
    repoRoot,
    originalContents: files.map((file) => file.text),
    readContents() {
      return Promise.all(files.map((file) => Bun.file(file.path).text()));
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("sync release metadata", () => {
  for (const source of ["package", "plugin"] as const) {
    for (const version of [undefined, null, 42, "", " \t "]) {
      it(`rejects ${source} version ${JSON.stringify(version)} without changing release files`, async () => {
        const fixture = await createFailureFixture({
          [`${source}Text`]: JSON.stringify({ version }),
        });

        await expect(
          syncReleaseMetadata({ repoRoot: fixture.repoRoot })
        ).rejects.toThrow(
          `release metadata requires a non-empty ${source} version`
        );
        expect(await fixture.readContents()).toEqual(fixture.originalContents);
      });
    }
  }

  it.each([
    "",
    " \t ",
  ])("rejects an empty requested version %j rather than using the package version", async (version) => {
    const fixture = await createFailureFixture();
    const options = { repoRoot: fixture.repoRoot, version };

    await expect(syncReleaseMetadata(options)).rejects.toThrow(
      "release metadata requires a non-empty package version"
    );
    expect(await fixture.readContents()).toEqual(fixture.originalContents);
  });

  for (const source of ["package", "plugin", "matrix"] as const) {
    it(`rejects malformed ${source} JSON without changing release files`, async () => {
      const fixture = await createFailureFixture({
        [`${source}Text`]: '{"unfinished":',
      });

      await expect(
        syncReleaseMetadata({ repoRoot: fixture.repoRoot })
      ).rejects.toBeInstanceOf(SyntaxError);
      expect(await fixture.readContents()).toEqual(fixture.originalContents);
    });
  }

  it.each([
    undefined,
    null,
    false,
  ])("rejects missing generatedFrom metadata %j without changing release files", async (generatedFrom) => {
    const fixture = await createFailureFixture({
      matrixText: `${JSON.stringify({ generatedFrom, capabilities: [] })}\n`,
    });

    await expect(
      syncReleaseMetadata({ repoRoot: fixture.repoRoot })
    ).rejects.toThrow(
      "codex-plugin-capability-matrix.json must declare generatedFrom"
    );
    expect(await fixture.readContents()).toEqual(fixture.originalContents);
  });

  it.each([
    undefined,
    null,
    42,
    "",
    " \t ",
  ])("rejects an invalid semantic-release version %j without falling back to the package version", async (version) => {
    const fixture = await createFailureFixture();

    await expect(
      prepare({}, { cwd: fixture.repoRoot, nextRelease: { version } })
    ).rejects.toThrow(
      "semantic-release did not provide a non-empty nextRelease.version"
    );
    expect(await fixture.readContents()).toEqual(fixture.originalContents);
  });

  it("updates the audited capability matrix from the package version", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "fclt-release-metadata-"));
    temporaryRoots.push(repoRoot);
    const docsDir = join(repoRoot, "docs");
    await mkdir(docsDir, { recursive: true });
    const pluginDir = join(repoRoot, "plugins", "fclt", ".codex-plugin");
    await mkdir(pluginDir, { recursive: true });
    await Bun.write(join(pluginDir, "plugin.json"), '{"version":"0.1.2"}\n');
    await Bun.write(join(repoRoot, "package.json"), '{"version":"3.4.5"}\n');
    await Bun.write(
      join(docsDir, "codex-plugin-capability-matrix.json"),
      [
        "{",
        '  "generatedFrom": {',
        '    "packageVersion": "3.4.4",',
        '    "pluginVersion": "0.1.1"',
        "  },",
        '  "dispositions": ["exposed", "withheld"],',
        '  "capabilities": []',
        "}",
        "",
      ].join("\n")
    );

    expect(await syncReleaseMetadata({ repoRoot })).toEqual({
      changed: true,
      pluginVersion: "0.1.2",
      version: "3.4.5",
    });
    expect(
      await Bun.file(
        join(docsDir, "codex-plugin-capability-matrix.json")
      ).json()
    ).toMatchObject({
      generatedFrom: { packageVersion: "3.4.5", pluginVersion: "0.1.2" },
    });
    expect(
      await Bun.file(
        join(docsDir, "codex-plugin-capability-matrix.json")
      ).text()
    ).toContain('  "dispositions": ["exposed", "withheld"],');
    expect(await syncReleaseMetadata({ repoRoot })).toEqual({
      changed: false,
      pluginVersion: "0.1.2",
      version: "3.4.5",
    });
  });

  it("uses the semantic-release version during its prepare pipeline", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "fclt-release-prepare-"));
    temporaryRoots.push(repoRoot);
    const docsDir = join(repoRoot, "docs");
    await mkdir(docsDir, { recursive: true });
    const pluginDir = join(repoRoot, "plugins", "fclt", ".codex-plugin");
    await mkdir(pluginDir, { recursive: true });
    await Bun.write(join(pluginDir, "plugin.json"), '{"version":"0.1.2"}\n');
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
      generatedFrom: { packageVersion: "3.5.0", pluginVersion: "0.1.2" },
    });
  });

  it("refreshes plugin-only version drift so cached wrappers cannot retain an old identity", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "fclt-plugin-metadata-"));
    temporaryRoots.push(repoRoot);
    const docsDir = join(repoRoot, "docs");
    const pluginDir = join(repoRoot, "plugins", "fclt", ".codex-plugin");
    await mkdir(docsDir, { recursive: true });
    await mkdir(pluginDir, { recursive: true });
    await Bun.write(join(repoRoot, "package.json"), '{"version":"3.4.5"}\n');
    await Bun.write(join(pluginDir, "plugin.json"), '{"version":"0.1.2"}\n');
    await Bun.write(
      join(docsDir, "codex-plugin-capability-matrix.json"),
      `${JSON.stringify({
        generatedFrom: { packageVersion: "3.4.5", pluginVersion: "0.1.1" },
        capabilities: [],
      })}\n`
    );

    expect(await syncReleaseMetadata({ repoRoot })).toEqual({
      changed: true,
      pluginVersion: "0.1.2",
      version: "3.4.5",
    });
    expect(
      await Bun.file(
        join(docsDir, "codex-plugin-capability-matrix.json")
      ).json()
    ).toMatchObject({
      generatedFrom: { packageVersion: "3.4.5", pluginVersion: "0.1.2" },
    });
  });
});
