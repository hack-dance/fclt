import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { facultAiReconciliationStatePath, withFacultRootScope } from "./paths";
import {
  reconcileSources,
  reconciliationSourceDiagnostics,
} from "./reconciliation";
import { parseReconciliationConfig } from "./reconciliation-config";
import {
  MAX_RECONCILIATION_FILES,
  reconciliationFilePaths,
} from "./reconciliation-files";
import {
  previewReconciliationSource,
  reconciliationSourceRecipe,
  reconciliationSourcesCommand,
} from "./reconciliation-sources";
import { writebackQueueReadPaths } from "./writeback-read";

let scratch: string | undefined;
afterEach(async () => {
  if (scratch) {
    await rm(scratch, { recursive: true, force: true });
  }
  scratch = undefined;
});

async function fixture() {
  scratch = await mkdtemp(join(tmpdir(), "fclt-source-tools-"));
  const homeDir = join(scratch, "home");
  const projectRoot = join(scratch, "project");
  const rootDir = join(projectRoot, ".ai");
  await mkdir(homeDir, { recursive: true });
  await mkdir(rootDir, { recursive: true });
  return { homeDir, rootDir, projectRoot };
}

async function snapshot(path: string): Promise<Record<string, string>> {
  const files = await readdir(path, { recursive: true, withFileTypes: true });
  const result: Record<string, string> = {};
  for (const file of files) {
    if (file.isFile()) {
      const fullPath = join(file.parentPath, file.name);
      result[fullPath] = await Bun.file(fullPath).text();
    }
  }
  return result;
}

describe("narrow source recipes", () => {
  it.each([
    "git",
    "markdown",
    "automation",
    "evidence-export",
  ])("generates a validated %s entry without writing configuration", async (type) => {
    const context = await fixture();
    const before = await snapshot(scratch!);
    const output = await reconciliationSourcesCommand({
      ...context,
      argv: [
        "init",
        "--id",
        "selected",
        "--type",
        type,
        "--path",
        "notes/evidence.json",
        ...(["markdown", "automation"].includes(type)
          ? ["--file-root", "project"]
          : []),
        "--json",
      ],
    });
    const result = JSON.parse(output);
    expect(result).toMatchObject({
      version: 1,
      configPath: join(context.rootDir, "reconciliation.json"),
      source: { id: "selected", type, enabled: true },
      writes: [],
    });
    expect(
      parseReconciliationConfig({ version: 1, sources: [result.source] })
        .sources
    ).toHaveLength(1);
    expect(await snapshot(scratch!)).toEqual(before);
  });

  it.each([
    ".",
    " . ",
    "**/*.md",
    "*.md",
    "../notes.md",
    "notes/../../notes.md",
    "/tmp/notes.md",
    "C:\\notes.md",
    "\\\\server\\notes.md",
    ":(top)**",
    "notes/./readme.md",
  ])("refuses a broad or escaping recipe: %s", (path) => {
    expect(() =>
      reconciliationSourceRecipe({
        id: "notes",
        type: "markdown",
        fileRoot: "project",
        paths: [path],
      })
    ).toThrow();
  });

  it("requires explicit roots and paths and rejects irrelevant flags", async () => {
    expect(() =>
      reconciliationSourceRecipe({
        id: "logs",
        type: "automation",
        paths: ["logs/job.log"],
      })
    ).toThrow("--file-root");
    expect(() =>
      reconciliationSourceRecipe({ id: "git", type: "git", paths: [] })
    ).toThrow();
    expect(() =>
      reconciliationSourceRecipe({
        id: "git",
        type: "git",
        paths: ["docs/**/*.md"],
      })
    ).toThrow("literal");
    expect(() =>
      reconciliationSourceRecipe({
        id: "export",
        type: "evidence-export",
        paths: ["a.json", "b.json"],
      })
    ).toThrow("exactly one");
    const context = await fixture();
    await expect(
      reconciliationSourcesCommand({ ...context, argv: ["init", "--force"] })
    ).rejects.toThrow("Unknown source option");
    await expect(
      reconciliationSourcesCommand({
        ...context,
        argv: ["init", "--id", "one", "--id", "two"],
      })
    ).rejects.toThrow("only be provided once");
    await expect(
      reconciliationSourcesCommand({
        ...context,
        argv: ["preview", "--source"],
      })
    ).rejects.toThrow("requires a value");
  });
});

describe("read-only source previews", () => {
  it("uses the scan's exact file selection and excludes escaping symlinks and oversized files", async () => {
    const context = await fixture();
    await Bun.write(join(context.projectRoot, "notes/a.md"), "# runbook\n");
    await Bun.write(join(context.projectRoot, "notes/b.md"), "# evidence\n");
    await Bun.write(
      join(context.projectRoot, "notes/large.md"),
      "x".repeat(1_000_001)
    );
    await Bun.write(join(context.homeDir, "outside.md"), "outside boundary");
    if (process.platform !== "win32") {
      await symlink(
        join(context.homeDir, "outside.md"),
        join(context.projectRoot, "notes/link.md")
      );
    }
    const source = reconciliationSourceRecipe({
      id: "notes",
      type: "markdown",
      fileRoot: "project",
      paths: ["notes/**/*.md", "notes/a.md"],
    });
    const before = await snapshot(scratch!);
    const preview = await previewReconciliationSource({ ...context, source });
    const selected = await reconciliationFilePaths({
      root: context.projectRoot,
      patterns: ["notes/**/*.md", "notes/a.md"],
    });
    expect(preview.files.map((file) => file.path)).toEqual(
      selected.paths.map((path) => join(context.projectRoot, path))
    );
    expect(
      preview.files
        .filter((file) => file.state === "available")
        .map((file) => file.path)
    ).toEqual([
      join(context.projectRoot, "notes/a.md"),
      join(context.projectRoot, "notes/b.md"),
    ]);
    expect(
      preview.files.find((file) => file.path.endsWith("large.md"))
    ).toMatchObject({ state: "excluded" });
    if (process.platform !== "win32") {
      expect(
        preview.files.some(
          (file) => file.path.endsWith("link.md") && file.state === "available"
        )
      ).toBe(false);
      const exportPreview = await previewReconciliationSource({
        ...context,
        source: { id: "link", type: "evidence-export", path: "notes/link.md" },
      });
      expect(exportPreview.files[0]).toMatchObject({
        state: "excluded",
        reason: "Resolves outside the configured root",
      });
    }
    expect(await snapshot(scratch!)).toEqual(before);
  });

  it("reports truncation at the same safety cap as reconciliation", async () => {
    const context = await fixture();
    await Promise.all(
      Array.from({ length: MAX_RECONCILIATION_FILES + 1 }, (_, index) =>
        Bun.write(join(context.projectRoot, "notes", `${index}.md`), "note")
      )
    );
    const preview = await previewReconciliationSource({
      ...context,
      source: { id: "notes", type: "markdown", paths: ["notes/*.md"] },
    });
    expect(preview.truncated).toBe(true);
    expect(preview.files).toHaveLength(MAX_RECONCILIATION_FILES);
    expect(preview.reason).toContain("incomplete");
  });

  it("resolves custom-global export paths and keeps project-only sources unavailable", async () => {
    const context = await fixture();
    const rootDir = join(context.homeDir, "custom-capability");
    await withFacultRootScope({ rootDir, scope: "global" }, async () => {
      await Bun.write(join(rootDir, "reconciliation/evidence.json"), "{}");
      const preview = await previewReconciliationSource({
        ...context,
        rootDir,
        source: {
          id: "external",
          type: "evidence-export",
          path: "reconciliation/evidence.json",
        },
      });
      expect(preview.files).toEqual([
        {
          path: join(rootDir, "reconciliation/evidence.json"),
          state: "available",
        },
      ]);
      expect(
        await previewReconciliationSource({
          ...context,
          rootDir,
          source: { id: "git", type: "git", paths: ["docs"] },
        })
      ).toMatchObject({ state: "unavailable", files: [] });
      expect(
        await previewReconciliationSource({
          ...context,
          rootDir,
          source: { id: "notes", type: "markdown", paths: ["notes/*.md"] },
        })
      ).toMatchObject({ state: "unavailable", files: [] });
    });
  });

  it("previews exact scoped queue paths, missing exports, disabled sources and Git queries", async () => {
    const context = await fixture();
    const writebacks = await previewReconciliationSource({
      ...context,
      source: { id: "wb", type: "writebacks" },
    });
    expect(writebacks.files.map((file) => file.path)).toEqual(
      writebackQueueReadPaths(context)
    );
    expect(
      await previewReconciliationSource({
        ...context,
        source: {
          id: "export",
          type: "evidence-export",
          path: "exports/missing.json",
        },
      })
    ).toMatchObject({
      state: "unavailable",
      files: [
        {
          path: join(context.projectRoot, "exports/missing.json"),
          state: "unavailable",
        },
      ],
    });
    expect(
      await previewReconciliationSource({
        ...context,
        source: {
          id: "off",
          type: "markdown",
          enabled: false,
          root: "home",
          paths: ["**"],
        },
      })
    ).toMatchObject({ state: "disabled", files: [] });
    expect(
      await previewReconciliationSource({
        ...context,
        source: {
          id: "git",
          type: "git",
          paths: ["docs"],
          defaultBranch: "main",
        },
      })
    ).toMatchObject({
      state: "not_checked",
      repository: context.projectRoot,
      paths: ["docs"],
      revisions: "default_branch",
      defaultBranch: "main",
    });
  });
});

describe("source diagnostics", () => {
  it("separates recorded checks, changed configuration, unavailable inputs, renamed IDs and disabled sources without writes", async () => {
    const context = await fixture();
    const path = join(context.rootDir, "reconciliation.json");
    await Bun.write(
      path,
      JSON.stringify({
        version: 1,
        sources: [
          { id: "old-name", type: "writebacks" },
          { id: "same", type: "writebacks" },
          {
            id: "missing",
            type: "evidence-export",
            path: "exports/missing.json",
          },
        ],
      })
    );
    await reconcileSources({
      ...context,
      since: "2026-11-01T00:00:00Z",
      until: "2026-11-02T00:00:00Z",
    });
    let config = parseReconciliationConfig(
      JSON.parse(await Bun.file(path).text())
    );
    const original = await reconciliationSourceDiagnostics({
      ...context,
      config,
    });
    expect(original.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: "old-name", status: "checked" }),
        expect.objectContaining({ sourceId: "missing", status: "unavailable" }),
      ])
    );
    config = parseReconciliationConfig({
      version: 1,
      sources: [
        { id: "new-name", type: "writebacks" },
        { id: "same", type: "writebacks", scope: "global" },
        { id: "disabled", type: "writebacks", enabled: false },
      ],
    });
    await Bun.write(path, JSON.stringify(config));
    const before = await snapshot(scratch!);
    const beforeState = await Bun.file(
      facultAiReconciliationStatePath(context.homeDir, context.rootDir)
    ).text();
    const output = JSON.parse(
      await reconciliationSourcesCommand({
        ...context,
        argv: ["doctor", "--json"],
      })
    );
    expect(output).toMatchObject({
      contentScanned: false,
      sources: [
        { sourceId: "new-name", status: "not_checked" },
        { sourceId: "same", status: "configuration_changed" },
        { sourceId: "disabled", status: "disabled" },
      ],
      removedSources: [
        { sourceId: "old-name", status: "retired_or_renamed" },
        { sourceId: "missing", status: "retired_or_renamed" },
      ],
    });
    expect(await snapshot(scratch!)).toEqual(before);
    expect(
      await Bun.file(
        facultAiReconciliationStatePath(context.homeDir, context.rootDir)
      ).text()
    ).toBe(beforeState);
    const human = await reconciliationSourcesCommand({
      ...context,
      argv: ["doctor", "--source=new-name"],
    });
    expect(human).toContain("No recorded check for this ID");
    expect(human).toContain("history is preserved");
    await expect(
      reconciliationSourcesCommand({
        ...context,
        argv: ["preview", "--source=typo"],
      })
    ).rejects.toThrow("Unknown reconciliation source id");
  });

  it("reports stale recorded coverage and preserves corrupt state on failure", async () => {
    const context = await fixture();
    await Bun.write(
      join(context.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "wb", type: "writebacks" }],
      })
    );
    await reconcileSources({
      ...context,
      since: "2026-11-01T00:00:00Z",
      until: "2026-11-02T00:00:00Z",
    });
    const statePath = facultAiReconciliationStatePath(
      context.homeDir,
      context.rootDir
    );
    const state = JSON.parse(await Bun.file(statePath).text());
    state.sources.wb.freshnessState = "stale";
    await Bun.write(statePath, JSON.stringify(state));
    expect(
      JSON.parse(
        await reconciliationSourcesCommand({
          ...context,
          argv: ["doctor", "--json"],
        })
      ).sources[0]
    ).toMatchObject({ status: "stale" });
    await Bun.write(statePath, "{bad state}");
    await expect(
      reconciliationSourcesCommand({ ...context, argv: ["doctor", "--json"] })
    ).rejects.toThrow("file was preserved");
    expect(await Bun.file(statePath).text()).toBe("{bad state}");
  });
});
