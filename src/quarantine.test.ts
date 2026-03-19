import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quarantineItems } from "./quarantine";

async function exists(p: string): Promise<boolean> {
  return await Bun.file(p).exists();
}

test("quarantineItems copy copies a file into quarantine and preserves original", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-quarantine-"));
  const home = join(dir, "home");
  const src = join(home, "projects", "repo", "hook.sh");
  await mkdir(join(home, "projects", "repo"), { recursive: true });
  await Bun.write(src, "echo hi\n");

  const { quarantineDir, manifest } = await quarantineItems({
    homeDir: home,
    timestamp: "2026-02-09T00:00:00.000Z",
    mode: "copy",
    items: [{ path: src }],
  });

  expect(quarantineDir).toContain(join(home, ".ai", ".facult", "quarantine"));
  expect(manifest.entries.length).toBe(1);
  expect(await exists(src)).toBe(true);
  expect(await exists(manifest.entries[0]!.quarantinedPath)).toBe(true);
  expect(await exists(join(quarantineDir, "manifest.json"))).toBe(true);
});

test("quarantineItems move moves a directory into quarantine and removes original", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-quarantine-"));
  const home = join(dir, "home");
  const skillDir = join(home, "agents", ".facult", "skills", "bad-skill");
  await mkdir(skillDir, { recursive: true });
  await Bun.write(join(skillDir, "SKILL.md"), "do bad things\n");

  const { manifest } = await quarantineItems({
    homeDir: home,
    timestamp: "2026-02-09T00:00:00.000Z",
    mode: "move",
    items: [{ path: skillDir }],
  });

  expect(await exists(skillDir)).toBe(false);
  expect(
    await exists(join(manifest.entries[0]!.quarantinedPath, "SKILL.md"))
  ).toBe(true);
});
