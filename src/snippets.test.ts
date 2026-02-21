import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findSnippet,
  listSnippets,
  syncFile,
  validateSnippetMarkerName,
  validateSnippetMarkersInText,
} from "./snippets";

let temp: string | null = null;

afterEach(async () => {
  if (!temp) {
    return;
  }
  try {
    await rm(temp, { recursive: true, force: true });
  } catch {
    // ignore
  }
  temp = null;
});

async function makeTempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "facult-snippets-"));
  temp = dir;
  return dir;
}

describe("validateSnippetMarkerName", () => {
  it("accepts valid marker names", () => {
    const valid = [
      "alpha",
      "alpha-beta",
      "alpha_beta",
      "alpha/beta",
      "alpha/beta_gamma",
      "a1_b2-c3/d4",
    ];
    for (const name of valid) {
      expect(validateSnippetMarkerName(name)).toBeNull();
    }
  });

  it("rejects invalid marker names", () => {
    const invalid = [
      "",
      " alpha",
      "alpha ",
      "alpha beta",
      "/alpha",
      "alpha/",
      "alpha//beta",
      "alpha..",
      "../alpha",
      "alpha/../beta",
      "alpha\\beta",
      "alpha:beta",
    ];

    for (const name of invalid) {
      expect(validateSnippetMarkerName(name)).not.toBeNull();
    }
  });
});

describe("validateSnippetMarkersInText", () => {
  it("returns errors with file path and line number", () => {
    const text = [
      "line 1",
      "<!-- fclty:good/name -->",
      "<!-- fclty:bad name -->",
      "<!-- /fclty:good/name -->",
    ].join("\n");

    const errors = validateSnippetMarkersInText(text, "/tmp/file.md");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("/tmp/file.md:3");
    expect(errors[0]).toContain("invalid snippet marker name");
  });
});

describe("snippets sync", () => {
  it("syncFile injects global snippet content", async () => {
    const root = await makeTempRoot();
    await mkdir(join(root, "snippets", "global"), { recursive: true });
    await Bun.write(
      join(root, "snippets", "global", "codingstyle.md"),
      "Hello\nWorld\n"
    );

    const filePath = join(root, "agents", "CLAUDE.md");
    await mkdir(join(root, "agents"), { recursive: true });
    await Bun.write(
      filePath,
      [
        "# Title",
        "",
        "<!-- fclty:codingstyle -->",
        "OLD",
        "<!-- /fclty:codingstyle -->",
        "",
      ].join("\n")
    );

    const res = await syncFile({ filePath, rootDir: root });
    expect(res.errors).toEqual([]);
    expect(res.changed).toBe(true);
    expect(
      res.changes.some(
        (c) => c.marker === "codingstyle" && c.status === "updated"
      )
    ).toBe(true);

    const next = await Bun.file(filePath).text();
    expect(next).toContain(
      "<!-- fclty:codingstyle -->\nHello\nWorld\n<!-- /fclty:codingstyle -->"
    );

    const res2 = await syncFile({ filePath, rootDir: root });
    expect(res2.errors).toEqual([]);
    expect(res2.changed).toBe(false);
  });

  it("syncFile prefers project snippet for implicit markers", async () => {
    const root = await makeTempRoot();
    await mkdir(join(root, "snippets", "global"), { recursive: true });
    await mkdir(join(root, "snippets", "projects", "myproj"), {
      recursive: true,
    });
    await Bun.write(
      join(root, "snippets", "global", "codingstyle.md"),
      "GLOBAL\n"
    );
    await Bun.write(
      join(root, "snippets", "projects", "myproj", "codingstyle.md"),
      "PROJECT\n"
    );

    const repo = join(root, "repo", "myproj");
    await mkdir(join(repo, ".git"), { recursive: true });
    const filePath = join(repo, "CLAUDE.md");
    await Bun.write(
      filePath,
      ["<!-- fclty:codingstyle -->", "OLD", "<!-- /fclty:codingstyle -->"].join(
        "\n"
      )
    );

    const res = await syncFile({ filePath, rootDir: root });
    expect(res.errors).toEqual([]);

    const next = await Bun.file(filePath).text();
    expect(next).toContain(
      "<!-- fclty:codingstyle -->\nPROJECT\n<!-- /fclty:codingstyle -->"
    );
  });

  it("explicit global scope bypasses project overrides", async () => {
    const root = await makeTempRoot();
    await mkdir(join(root, "snippets", "global"), { recursive: true });
    await mkdir(join(root, "snippets", "projects", "myproj"), {
      recursive: true,
    });
    await Bun.write(
      join(root, "snippets", "global", "codingstyle.md"),
      "GLOBAL\n"
    );
    await Bun.write(
      join(root, "snippets", "projects", "myproj", "codingstyle.md"),
      "PROJECT\n"
    );

    const repo = join(root, "repo", "myproj");
    await mkdir(join(repo, ".git"), { recursive: true });
    const filePath = join(repo, "CLAUDE.md");
    await Bun.write(
      filePath,
      [
        "<!-- fclty:global/codingstyle -->",
        "OLD",
        "<!-- /fclty:global/codingstyle -->",
      ].join("\n")
    );

    await syncFile({ filePath, rootDir: root });
    const next = await Bun.file(filePath).text();
    expect(next).toContain(
      "<!-- fclty:global/codingstyle -->\nGLOBAL\n<!-- /fclty:global/codingstyle -->"
    );
  });

  it("findSnippet resolves implicit marker with project fallback", async () => {
    const root = await makeTempRoot();
    await mkdir(join(root, "snippets", "global"), { recursive: true });
    await Bun.write(join(root, "snippets", "global", "tooling.md"), "G\n");

    const snip = await findSnippet({
      marker: "tooling",
      project: "myproj",
      rootDir: root,
    });
    expect(snip?.scope).toBe("global");
    expect(snip?.content).toBe("G\n");
  });

  it("listSnippets lists marker names with explicit scopes", async () => {
    const root = await makeTempRoot();
    await mkdir(join(root, "snippets", "global"), { recursive: true });
    await mkdir(join(root, "snippets", "projects", "myproj"), {
      recursive: true,
    });
    await Bun.write(join(root, "snippets", "global", "a.md"), "A\n");
    await Bun.write(
      join(root, "snippets", "projects", "myproj", "b.md"),
      "B\n"
    );

    const listed = await listSnippets({ rootDir: root });
    expect(listed.map((s) => s.marker)).toEqual(["global/a", "myproj/b"]);
  });
});
