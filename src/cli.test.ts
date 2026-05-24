import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFindArgs, parseGraphArgs, parseListArgs } from "./index";

const SEMVER_RE = /^\d+\.\d+\.\d+/;

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
  it("--version prints the package version", async () => {
    const proc = Bun.spawn(["bun", "run", "./src/index.ts", "--version"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out.trim()).toMatch(SEMVER_RE);
  });

  it("status --json emits valid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facult-cli-status-"));

    try {
      const proc = Bun.spawn(
        ["bun", "run", join(process.cwd(), "src/index.ts"), "status", "--json"],
        {
          cwd: dir,
          env: { ...process.env, HOME: dir },
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
      const parsed = JSON.parse(out) as {
        version: number;
        packageVersion: string;
        contextRoot: string;
      };
      expect(parsed.version).toBe(1);
      expect(parsed.packageVersion).toMatch(SEMVER_RE);
      expect(parsed.contextRoot).toBe(join(dir, ".ai"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ai writeback subcommand help exits cleanly", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "ai", "writeback", "add", "--help"],
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
    expect(out).toContain("fclt ai writeback");
  });

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

  it("inventory --json emits valid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facult-cli-inventory-"));
    const rootDir = join(dir, ".ai");
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await Bun.write(
      join(rootDir, "mcp", "servers.json"),
      JSON.stringify({ servers: { github: { command: "gh" } } }, null, 2)
    );

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "./src/index.ts",
        "inventory",
        "--json",
        "--no-config-from",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: dir },
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
    const parsed = JSON.parse(out) as {
      version: number;
      mcpServers: { name: string }[];
    };
    expect(parsed.version).toBe(1);
    expect(parsed.mcpServers.some((entry) => entry.name === "github")).toBe(
      true
    );
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
