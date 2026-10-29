import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const entry of ["preload", "wrapper"] as const) {
  for (const boundary of ["home", "state"] as const) {
    test(`${entry} relocates a symlinked TMPDIR outside the original ${boundary}`, async () => {
      const fixture = mkdtempSync(join(tmpdir(), "isolation-alias-"));
      const home = join(fixture, "fake-home");
      const state = join(fixture, "fake-state");
      const homeAlias = join(fixture, "home-alias");
      const tempAlias = join(fixture, "temp-alias");
      mkdirSync(home);
      mkdirSync(state);
      symlinkSync(home, homeAlias, "junction");
      symlinkSync(boundary === "home" ? home : state, tempAlias, "junction");
      const repo = join(import.meta.dir, "..");
      const child = Bun.spawn({
        cmd:
          entry === "preload"
            ? [process.execPath, "test", "test/setup.test.ts"]
            : [join(repo, "scripts", "test-safe.sh"), "test/setup.test.ts"],
        cwd: repo,
        env: {
          ...process.env,
          HOME: homeAlias,
          FCLT_TEST_REAL_HOME: undefined,
          FCLT_TEST_REAL_STATE_ROOT: undefined,
          FACULT_LOCAL_STATE_DIR: state,
          TMPDIR: tempAlias,
          TMP: tempAlias,
          TEMP: tempAlias,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, , stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(stderr).toContain("0 fail");
      expect(readdirSync(home)).toEqual([]);
      expect(readdirSync(state)).toEqual([]);
    });
  }
}
