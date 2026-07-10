import { expect, test } from "bun:test";
import { join } from "node:path";

test("shell test wrapper clears Git context before Bun starts", async () => {
  const repoRoot = join(import.meta.dir, "..");
  const proc = Bun.spawn({
    cmd: [join(repoRoot, "scripts", "test-safe.sh"), "test/setup.test.ts"],
    cwd: repoRoot,
    env: {
      ...process.env,
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
  expect(`${stdout}\n${stderr}`).toContain("1 pass");
  expect(`${stdout}\n${stderr}`).toContain("0 fail");
});
