import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFindArgs, parseGraphArgs, parseListArgs } from "./index";

describe("parseListArgs", () => {
  it("parses list options and filters", () => {
    const opts = parseListArgs([
      "mcp",
      "--enabled-for",
      "cursor",
      "--untrusted",
      "--flagged",
      "--json",
    ]);

    expect(opts).toEqual({
      kind: "mcp",
      filters: {
        enabledFor: "cursor",
        untrusted: true,
        flagged: true,
      },
      json: true,
    });
  });

  it("defaults to skills when no type provided", () => {
    const opts = parseListArgs([]);
    expect(opts.kind).toBe("skills");
  });

  it("accepts instructions as a list type", () => {
    const opts = parseListArgs(["instructions", "--json"]);
    expect(opts.kind).toBe("instructions");
    expect(opts.json).toBe(true);
  });

  it("accepts automations as a list type", () => {
    const opts = parseListArgs(["automations", "--json"]);
    expect(opts.kind).toBe("automations");
    expect(opts.json).toBe(true);
  });
});

describe("parseFindArgs", () => {
  it("parses text query and json flag", () => {
    const opts = parseFindArgs(["feedback", "loops", "--json"]);
    expect(opts).toEqual({
      text: "feedback loops",
      json: true,
    });
  });
});

describe("parseGraphArgs", () => {
  it("defaults to show when only an asset is provided", () => {
    const opts = parseGraphArgs(["skills:alpha"]);

    expect(opts).toEqual({
      kind: "show",
      target: "skills:alpha",
      json: false,
    });
  });

  it("parses explicit graph modes", () => {
    const opts = parseGraphArgs(["deps", "skills:alpha", "--json"]);

    expect(opts).toEqual({
      kind: "deps",
      target: "skills:alpha",
      json: true,
    });
  });
});

describe("CLI output contracts", () => {
  it("adapters --json emits valid JSON", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "adapters", "--json"],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(code).toBe(0);
    expect(err).toBe("");
    const parsed = JSON.parse(out) as { id: string }[];
    expect(parsed.some((entry) => entry.id === "codex")).toBe(true);
  });

  it("show accepts explicit skill selectors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facult-cli-show-"));
    const rootDir = join(dir, ".ai");

    try {
      await mkdir(join(rootDir, "skills", "alpha"), { recursive: true });
      await Bun.write(
        join(rootDir, "skills", "alpha", "SKILL.md"),
        "---\ndescription: Alpha skill\n---\n\n# Alpha\n"
      );

      const env = { ...process.env, HOME: dir };
      const indexProc = Bun.spawn(
        ["bun", "run", "./src/index.ts", "index", "--root", rootDir],
        {
          cwd: process.cwd(),
          env,
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      expect(await indexProc.exited).toBe(0);

      const showProc = Bun.spawn(
        [
          "bun",
          "run",
          "./src/index.ts",
          "show",
          "skill:alpha",
          "--root",
          rootDir,
        ],
        {
          cwd: process.cwd(),
          env,
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const [code, out, err] = await Promise.all([
        showProc.exited,
        new Response(showProc.stdout).text(),
        new Response(showProc.stderr).text(),
      ]);

      expect(code).toBe(0);
      expect(err).toBe("");
      expect(out).toContain("fclt show skills:alpha");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
