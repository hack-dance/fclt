import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fixtureRemovalGuard } from "./fixture-safety";

test("removal rejects symlink parent traversal and trailing-slash escapes", () => {
  const fixture = mkdtempSync(join(tmpdir(), "removal-boundary-"));
  const guardedRoot = join(fixture, "guarded");
  const outside = join(fixture, "outside");
  const target = join(outside, "child");
  mkdirSync(guardedRoot);
  mkdirSync(target, { recursive: true });
  const victim = join(outside, "victim");
  const sentinel = join(target, "sentinel");
  writeFileSync(victim, "preserve victim");
  writeFileSync(sentinel, "preserve target");
  const link = join(guardedRoot, "link");
  symlinkSync(target, link, "junction");
  const guard = fixtureRemovalGuard(guardedRoot);
  for (const remove of [guard.rmSync, guard.rm]) {
    expect(() =>
      remove(`${link}${sep}..${sep}victim`, { recursive: true, force: true })
    ).toThrow("parent traversal");
    expect(() =>
      remove(`${link}${sep}`, { recursive: true, force: true })
    ).toThrow("outside the isolated temp root");
    expect(readFileSync(victim, "utf8")).toBe("preserve victim");
    expect(readFileSync(sentinel, "utf8")).toBe("preserve target");
  }
});

for (const entry of ["preload", "wrapper"] as const) {
  for (const boundary of ["home", "state"] as const) {
    test(`${entry} refuses a symlinked TMPDIR inside the real ${boundary} before creating fixtures`, async () => {
      const fixture = mkdtempSync(join(tmpdir(), "isolation-alias-"));
      const home = join(fixture, "fake-home");
      const state = join(fixture, "fake-state");
      const homeAlias = join(fixture, "home-alias");
      const tempAlias = join(fixture, "temp-alias");
      mkdirSync(home);
      mkdirSync(state);
      symlinkSync(home, homeAlias, "junction");
      const protectedRoot = boundary === "home" ? home : state;
      symlinkSync(protectedRoot, tempAlias, "junction");
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
          FCLT_TEST_REAL_HOME: homeAlias,
          FCLT_TEST_REAL_STATE_ROOT: state,
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
      expect(code).not.toBe(0);
      expect(stderr).toContain("Refusing test temp root");
      expect(readdirSync(home)).toEqual([]);
      expect(readdirSync(state)).toEqual([]);
    });
  }
}
