import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snippetsCommand } from "./snippets-cli";

let tempDir: string | null = null;
const originalCwd = process.cwd();
const originalRootDir = process.env.FACULT_ROOT_DIR;
const originalEditor = process.env.EDITOR;

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "facult-snippets-cli-"));
  tempDir = dir;
  return dir;
}

async function captureConsole(fn: () => Promise<void>) {
  const logs: string[] = [];
  const errors: string[] = [];
  const prevLog = console.log;
  const prevError = console.error;

  console.log = (...args: Parameters<typeof console.log>) => {
    logs.push(args.map((v) => String(v)).join(" "));
  };
  console.error = (...args: Parameters<typeof console.error>) => {
    errors.push(args.map((v) => String(v)).join(" "));
  };

  try {
    await fn();
  } finally {
    console.log = prevLog;
    console.error = prevError;
  }

  return { logs, errors };
}

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalRootDir === undefined) {
    process.env.FACULT_ROOT_DIR = undefined;
  } else {
    process.env.FACULT_ROOT_DIR = originalRootDir;
  }
  if (originalEditor === undefined) {
    process.env.EDITOR = undefined;
  } else {
    process.env.EDITOR = originalEditor;
  }
  process.exitCode = 0;
  if (!tempDir) {
    return;
  }
  await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("snippets CLI", () => {
  it("show accepts marker names that start with '-'", async () => {
    const root = await makeTempDir();
    await mkdir(join(root, "snippets", "global"), { recursive: true });
    await Bun.write(join(root, "snippets", "global", "-foo.md"), "HELLO\n");

    process.env.FACULT_ROOT_DIR = root;
    process.chdir(root);

    const out = await captureConsole(async () => {
      await snippetsCommand(["show", "-foo"]);
    });

    expect(out.errors).toEqual([]);
    expect(out.logs.join("\n")).toContain("HELLO");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("sync accepts explicit file paths that start with '-'", async () => {
    const root = await makeTempDir();
    await mkdir(join(root, "snippets", "global"), { recursive: true });
    await Bun.write(
      join(root, "snippets", "global", "codingstyle.md"),
      "SYNCED\n"
    );

    const targetPath = join(root, "-target.md");
    await Bun.write(
      targetPath,
      ["<!-- fclty:codingstyle -->", "OLD", "<!-- /fclty:codingstyle -->"].join(
        "\n"
      )
    );

    process.env.FACULT_ROOT_DIR = root;
    process.chdir(root);

    const out = await captureConsole(async () => {
      await snippetsCommand(["sync", "-target.md"]);
    });

    expect(out.errors).toEqual([]);
    expect(out.logs.join("\n")).toContain("1 files updated");

    const next = await readFile(targetPath, "utf8");
    expect(next).toContain(
      "<!-- fclty:codingstyle -->\nSYNCED\n<!-- /fclty:codingstyle -->"
    );
    expect(process.exitCode).toBe(0);
  });
});
