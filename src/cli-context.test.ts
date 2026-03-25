import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliContextArgs, resolveCliContextRoot } from "./cli-context";

let tempRoot: string | null = null;
const ORIGINAL_ROOT = process.env.FACULT_ROOT_DIR;

function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cli-context-"));
}

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
  tempRoot = null;
  process.env.FACULT_ROOT_DIR = ORIGINAL_ROOT;
});

describe("parseCliContextArgs", () => {
  it("parses scope, source, and root flags", () => {
    const parsed = parseCliContextArgs(
      ["skills", "--scope", "project", "--source=project", "--root", "~/repo"],
      { allowSource: true }
    );

    expect(parsed).toEqual({
      argv: ["skills"],
      rootArg: "~/repo",
      scope: "project",
      sourceKind: "project",
    });
  });

  it("rejects conflicting scope flags", () => {
    expect(() =>
      parseCliContextArgs(["--global", "--scope", "project"])
    ).toThrow("Conflicting scope flags");
  });
});

describe("resolveCliContextRoot", () => {
  it("prefers the nearest project .ai root for merged scope", async () => {
    tempRoot = await makeTempDir();
    const homeDir = join(tempRoot, "home");
    const cwd = join(homeDir, "work", "repo", "src");
    await mkdir(join(homeDir, "work", "repo", ".ai", "instructions"), {
      recursive: true,
    });
    const rootDir = resolveCliContextRoot({ homeDir, cwd, scope: "merged" });
    expect(rootDir).toBe(join(homeDir, "work", "repo", ".ai"));
  });

  it("resolves global scope to the global canonical root", () => {
    const homeDir = "/tmp/home";
    const cwd = "/tmp/home/work/repo";
    const rootDir = resolveCliContextRoot({ homeDir, cwd, scope: "global" });
    expect(rootDir).toBe("/tmp/home/.ai");
  });

  it("honors FACULT_ROOT_DIR before cwd project discovery in merged scope", async () => {
    tempRoot = await makeTempDir();
    const homeDir = join(tempRoot, "home");
    const envRoot = join(tempRoot, "external-root");
    const cwd = join(homeDir, "work", "repo", "src");
    await mkdir(join(envRoot, "instructions"), { recursive: true });
    await mkdir(join(homeDir, "work", "repo", ".ai", "instructions"), {
      recursive: true,
    });
    process.env.FACULT_ROOT_DIR = envRoot;

    const rootDir = resolveCliContextRoot({ homeDir, cwd, scope: "merged" });
    expect(rootDir).toBe(envRoot);
  });

  it("explains how to create project AI state when project scope has no repo-local .ai", async () => {
    tempRoot = await makeTempDir();
    const homeDir = join(tempRoot, "home");
    const cwd = join(homeDir, "work", "repo");
    await mkdir(cwd, { recursive: true });

    expect(() =>
      resolveCliContextRoot({ homeDir, cwd, scope: "project" })
    ).toThrow("No project-local .ai root found:");
    expect(() =>
      resolveCliContextRoot({ homeDir, cwd, scope: "project" })
    ).toThrow('Run "fclt templates init project-ai" in the repo first');
  });
});
