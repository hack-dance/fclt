import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  facultAiGraphPath,
  facultAiIndexPath,
  facultAiStateDir,
  facultContextRootDir,
  facultInstallStatePath,
  facultMachineStateDir,
  facultRootDir,
  facultRuntimeCacheDir,
} from "./paths";

const ORIGINAL_HOME = process.env.HOME;
let tempHome: string | null = null;

async function makeTempHome(): Promise<string> {
  const base = join(process.cwd(), ".tmp-tests");
  await mkdir(base, { recursive: true });
  const dir = join(
    base,
    `home-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

function expectedLocalStateRoot(home: string): string {
  return process.platform === "darwin"
    ? join(home, "Library", "Application Support", "fclt")
    : join(home, ".local", "state", "fclt");
}

function expectedLocalCacheRoot(home: string): string {
  return process.platform === "darwin"
    ? join(home, "Library", "Caches", "fclt")
    : join(home, ".cache", "fclt");
}

afterEach(async () => {
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
  }
  tempHome = null;
  process.env.HOME = ORIGINAL_HOME;
  process.env.FACULT_ROOT_DIR = undefined;
});

describe("paths", () => {
  it("prefers ~/.ai as the canonical root when present", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    await mkdir(join(tempHome, ".ai", "rules"), { recursive: true });

    expect(facultRootDir(tempHome)).toBe(join(tempHome, ".ai"));
  });

  it("falls back to legacy ~/agents/.fclt when ~/.ai is absent", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    await mkdir(join(tempHome, "agents", ".facult", "skills"), {
      recursive: true,
    });

    expect(facultRootDir(tempHome)).toBe(join(tempHome, "agents", ".facult"));
  });

  it("ignores a legacy configured root when ~/.ai is present", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    await mkdir(join(tempHome, ".ai", "agents"), { recursive: true });
    await mkdir(join(tempHome, ".facult"), { recursive: true });
    await writeFile(
      join(tempHome, ".facult", "config.json"),
      `${JSON.stringify({ rootDir: join(tempHome, "agents", ".facult") }, null, 2)}\n`,
      "utf8"
    );

    expect(facultRootDir(tempHome)).toBe(join(tempHome, ".ai"));
  });

  it("uses ~/.ai/.facult/ai for generated index state", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    expect(facultAiStateDir(tempHome)).toBe(
      join(tempHome, ".ai", ".facult", "ai")
    );
    expect(facultAiIndexPath(tempHome)).toBe(
      join(tempHome, ".ai", ".facult", "ai", "index.json")
    );
  });

  it("uses repo-local .ai/.facult/ai state for project roots", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const projectRoot = join(tempHome, "work", "repo");
    const rootDir = join(projectRoot, ".ai");
    await mkdir(join(rootDir, "instructions"), { recursive: true });

    expect(facultAiStateDir(tempHome, rootDir)).toBe(
      join(projectRoot, ".ai", ".facult", "ai")
    );
    expect(facultAiIndexPath(tempHome, rootDir)).toBe(
      join(projectRoot, ".ai", ".facult", "ai", "index.json")
    );
    expect(facultAiGraphPath(tempHome, rootDir)).toBe(
      join(projectRoot, ".ai", ".facult", "ai", "graph.json")
    );
  });

  it("prefers the nearest project .ai for CLI context resolution", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    await mkdir(join(tempHome, ".ai", "instructions"), { recursive: true });

    const projectRoot = join(tempHome, "work", "repo");
    const rootDir = join(projectRoot, ".ai");
    await mkdir(join(rootDir, "instructions"), { recursive: true });

    expect(
      facultContextRootDir({
        home: tempHome,
        cwd: join(projectRoot, "src"),
      })
    ).toBe(rootDir);
  });

  it("stores machine-local install state and runtime cache outside the canonical .ai tree", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    expect(facultInstallStatePath(tempHome)).toBe(
      join(expectedLocalStateRoot(tempHome), "install.json")
    );
    expect(facultRuntimeCacheDir(tempHome)).toBe(
      join(expectedLocalCacheRoot(tempHome), "runtime")
    );
  });

  it("stores project managed state in machine-local per-project state", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const projectRoot = join(tempHome, "work", "repo");
    const rootDir = join(projectRoot, ".ai");
    expect(facultMachineStateDir(tempHome, rootDir)).toContain(
      join(expectedLocalStateRoot(tempHome), "projects")
    );
    expect(facultMachineStateDir(tempHome, rootDir)).not.toContain(
      join(projectRoot, ".ai", ".facult")
    );
  });
});
