import { expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  facultLocalCacheRoot,
  facultLocalStateRoot,
  facultMachineStateDir,
  facultRootDir,
  pathIsInsideOrEqual,
  preferredGlobalAiRoot,
} from "../src/paths";

const testRoot = process.env.FCLT_TEST_TEMP_ROOT!;
const realHome = process.env.FCLT_TEST_REAL_HOME!;
const fixtureProjectAiDir = preferredGlobalAiRoot(join(testRoot, "project"));

test("test preload removes repository-local Git context", () => {
  expect(process.env.GIT_DIR).toBeUndefined();
  expect(process.env.GIT_WORK_TREE).toBeUndefined();
  expect(process.env.GIT_COMMON_DIR).toBeUndefined();
  expect(process.env.GIT_INDEX_FILE).toBeUndefined();
  expect(process.env.GIT_CONFIG_COUNT).toBeUndefined();
  expect(process.env.GIT_CEILING_DIRECTORIES).toBeUndefined();
});

test("preload isolates home, XDG, temporary fixtures, and global/project state", () => {
  expect(testRoot).toBeTruthy();
  expect(realHome).toBeTruthy();
  const paths = [
    homedir(),
    tmpdir(),
    process.env.XDG_STATE_HOME!,
    process.env.XDG_CONFIG_HOME!,
    process.env.XDG_DATA_HOME!,
    process.env.XDG_CACHE_HOME!,
    facultRootDir(),
    facultLocalStateRoot(),
    facultLocalCacheRoot(),
    facultMachineStateDir(),
    facultMachineStateDir(undefined, fixtureProjectAiDir),
  ];
  for (const path of paths) {
    expect(pathIsInsideOrEqual(path, testRoot), path).toBe(true);
    expect(pathIsInsideOrEqual(path, realHome)).toBe(false);
  }
  if (process.env.FCLT_TEST_SHELL_ROOT) {
    expect(testRoot).not.toBe(process.env.FCLT_TEST_SHELL_ROOT);
  }
});

test("fixture-specific homes keep their own machine-local state", () => {
  const home = join(testRoot, "fixture-home");
  expect(pathIsInsideOrEqual(facultLocalStateRoot(home), home)).toBe(true);
  expect(pathIsInsideOrEqual(facultLocalCacheRoot(home), home)).toBe(true);
});

test("test guard rejects real-home overrides and fallback paths before access", () => {
  const saved = { ...process.env };
  try {
    process.env.FACULT_LOCAL_STATE_DIR = join(
      realHome,
      ".local",
      "state",
      "fclt"
    );
    expect(() => facultMachineStateDir()).toThrow("under the real home");
    expect(() => facultMachineStateDir(undefined, fixtureProjectAiDir)).toThrow(
      "under the real home"
    );
    process.env.FACULT_CACHE_DIR = join(realHome, ".cache", "fclt");
    expect(() => facultLocalCacheRoot()).toThrow("under the real home");
    Reflect.deleteProperty(process.env, "FACULT_LOCAL_STATE_DIR");
    process.env.XDG_STATE_HOME = join(realHome, ".local", "state");
    expect(() => facultLocalStateRoot(realHome)).toThrow("under the real home");
    Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
    expect(() => facultLocalStateRoot(realHome)).toThrow("under the real home");
  } finally {
    process.env = saved;
  }
});

test("test guard rejects a symlink into a protected home", () => {
  const saved = { ...process.env };
  const protectedHome = join(testRoot, "protected-home");
  const alias = join(testRoot, "home-alias");
  mkdirSync(protectedHome);
  symlinkSync(protectedHome, alias, "junction");
  try {
    process.env.FCLT_TEST_REAL_HOME = protectedHome;
    process.env.FACULT_LOCAL_STATE_DIR = join(alias, "state");
    expect(() => facultLocalStateRoot()).toThrow("under the real home");
  } finally {
    process.env = saved;
  }
});

test("fixture teardown refuses paths outside the process temp root", async () => {
  expect(() =>
    rmSync(join(testRoot, "..", "not-a-fixture"), { force: true })
  ).toThrow("outside the isolated temp root");
  expect(() =>
    rm(join(testRoot, "..", "not-a-fixture"), { force: true })
  ).toThrow("outside the isolated temp root");
  const fixture = join(testRoot, "removable-fixture");
  mkdirSync(fixture);
  await rm(fixture, { recursive: true });
  const alias = join(testRoot, "outside-removal-alias");
  symlinkSync(join(testRoot, ".."), alias, "junction");
  expect(() => rmSync(join(alias, "not-a-fixture"), { force: true })).toThrow(
    "outside the isolated temp root"
  );
  // Removing the symlink itself must not follow its target.
  await rm(alias);
});

test("CLI subprocesses inherit isolation and the fail-closed guard", async () => {
  const pathsModule = join(import.meta.dir, "..", "src", "paths.ts");
  for (const unsafe of [false, true]) {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--eval",
        `import { facultMachineStateDir } from ${JSON.stringify(pathsModule)}; console.log(facultMachineStateDir());`,
      ],
      env: {
        ...process.env,
        ...(unsafe
          ? {
              FACULT_LOCAL_STATE_DIR: join(realHome, ".local", "state", "fclt"),
            }
          : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (unsafe) {
      expect(code).not.toBe(0);
      expect(stderr).toContain("under the real home");
    } else {
      expect(code).toBe(0);
      expect(pathIsInsideOrEqual(stdout.trim(), testRoot)).toBe(true);
    }
  }
});
