import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathIsInsideOrEqual } from "../src/paths";

test("shell test wrapper isolates inherited paths and clears Git context before Bun starts", async () => {
  const repoRoot = join(import.meta.dir, "..");
  const proc = Bun.spawn({
    cmd: [join(repoRoot, "scripts", "test-safe.sh"), "test/setup.test.ts"],
    cwd: repoRoot,
    env: {
      ...process.env,
      FACULT_ROOT_DIR: "/unowned/canonical",
      FACULT_LOCAL_STATE_DIR: "/unowned/state",
      FACULT_CACHE_DIR: "/unowned/cache",
      GIT_DIR: "/tmp/escape.git",
      GIT_WORK_TREE: "/tmp/escape",
      GIT_COMMON_DIR: "/tmp/common.git",
      GIT_INDEX_FILE: "/tmp/escape.index",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.bare",
      GIT_CONFIG_VALUE_0: "true",
      GIT_CEILING_DIRECTORIES: "/tmp",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  expect(code).toBe(0);
  expect(`${stdout}\n${stderr}`).toContain("7 pass");
  expect(`${stdout}\n${stderr}`).toContain("0 fail");
});

test("shell wrapper isolates the environment even without the Bun preload", async () => {
  const root = await mkdtemp(join(tmpdir(), "wrapper-probe-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const executable = join(bin, "bun");
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      'if [ "$1" = --print ]; then printf "%s\\n" "$0"; exit 0; fi',
      'printf "%s\\n" "$FCLT_TEST_SHELL_ROOT" "$HOME" "$XDG_STATE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$TMPDIR" "$FACULT_ROOT_DIR" "$FACULT_ROOT_SCOPE" "$NODE_ENV" "$FACULT_TEST_SKIP_LOCAL" "$*"',
      "",
    ].join("\n")
  );
  await chmod(executable, 0o755);
  const child = Bun.spawn({
    cmd: [
      join(import.meta.dir, "..", "scripts", "test-safe.sh"),
      "--ci",
      "fixture.test.ts",
    ],
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FACULT_ROOT_DIR: "/unowned/canonical",
      FACULT_ROOT_SCOPE: "project",
      XDG_STATE_HOME: "/unowned/state",
      XDG_CONFIG_HOME: "/unowned/config",
      XDG_DATA_HOME: "/unowned/data",
      XDG_CACHE_HOME: "/unowned/cache",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, stderr).toBe(0);
  const [shellRoot, ...values] = stdout.trimEnd().split("\n");
  expect(shellRoot).toBeTruthy();
  for (const path of values.slice(0, 6)) {
    expect(pathIsInsideOrEqual(path, shellRoot!)).toBe(true);
    expect(pathIsInsideOrEqual(path, process.env.FCLT_TEST_REAL_HOME!)).toBe(
      false
    );
  }
  expect(values.slice(6)).toEqual([
    "",
    "",
    "test",
    "1",
    "test fixture.test.ts",
  ]);
});
