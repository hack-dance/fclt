import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "./index-builder";
import { withFacultRootScope } from "./paths";
import { loadIndex } from "./query";
import {
  loadReadSnapshot,
  readSnapshotPath,
  refreshReadSnapshot,
} from "./read-snapshot";

async function fixture() {
  const homeDir = await mkdtemp(join(tmpdir(), "fclt-snapshot-"));
  const rootDir = join(homeDir, ".ai");
  const skill = join(rootDir, "skills", "alpha", "SKILL.md");
  await Bun.write(
    skill,
    "---\nname: alpha\ndescription: First\n---\n# Alpha\n"
  );
  return { homeDir, rootDir, skill };
}

test("read snapshots fail closed when unavailable, malformed or from a different root", async () => {
  const context = await fixture();
  try {
    await expect(loadReadSnapshot(context)).rejects.toThrow(
      "snapshot-unavailable"
    );
    await refreshReadSnapshot(context);
    const path = readSnapshotPath(context);
    const record = await Bun.file(path).json();
    expect(
      (await loadReadSnapshot(context)).index.skills.alpha?.description
    ).toBe("First");
    for (const changed of [
      "broken",
      JSON.stringify({ ...record, rootDir: context.homeDir }),
      JSON.stringify({ ...record, index: { ...record.index, skills: [] } }),
    ]) {
      await Bun.write(path, changed);
      await expect(loadReadSnapshot(context)).rejects.toThrow(
        "snapshot-unavailable"
      );
    }
    await Bun.write(
      path,
      JSON.stringify({ ...record, packageVersion: "obsolete" })
    );
    await expect(loadReadSnapshot(context)).rejects.toThrow("snapshot-stale");
  } finally {
    await rm(context.homeDir, { recursive: true, force: true });
  }
});

test("snapshot freshness detects equal-mtime edits, nested additions, removals and retargets without repair", async () => {
  const context = await fixture();
  try {
    await buildIndex(context);
    await refreshReadSnapshot(context);
    const path = readSnapshotPath(context);
    const previous = await Bun.file(path).text();
    const metadata = await stat(context.skill);
    await Bun.write(
      context.skill,
      "---\nname: alpha\ndescription: Other\n---\n# Alpha\n"
    );
    await utimes(context.skill, metadata.atime, metadata.mtime);
    await expect(loadReadSnapshot(context)).rejects.toThrow("snapshot-stale");
    expect(await Bun.file(path).text()).toBe(previous);
    await refreshReadSnapshot(context);
    expect(
      (await loadIndex({ ...context, cachedOnly: true })).skills.alpha
        ?.description
    ).toBe("Other");
    const added = join(context.rootDir, "skills", "nested", "beta", "SKILL.md");
    await Bun.write(added, "# Beta\n");
    await expect(loadReadSnapshot(context)).rejects.toThrow("snapshot-stale");
    await refreshReadSnapshot(context);
    await rm(join(context.rootDir, "skills", "nested"), { recursive: true });
    await expect(loadReadSnapshot(context)).rejects.toThrow("snapshot-stale");
    await refreshReadSnapshot(context);
    await Bun.write(
      join(context.homeDir, "outside", "one", "SKILL.md"),
      "# One\n"
    );
    await Bun.write(
      join(context.homeDir, "outside", "two", "SKILL.md"),
      "# Two\n"
    );
    const link = join(context.rootDir, "skills", "linked");
    await symlink(join(context.homeDir, "outside", "one"), link, "dir");
    await refreshReadSnapshot(context);
    await rm(link);
    await symlink(join(context.homeDir, "outside", "two"), link, "dir");
    await expect(loadReadSnapshot(context)).rejects.toThrow("snapshot-stale");
  } finally {
    await rm(context.homeDir, { recursive: true, force: true });
  }
});

test("snapshot publication is atomic and private, and unrelated home content does not invalidate reads", async () => {
  const context = await fixture();
  try {
    await refreshReadSnapshot(context);
    const path = readSnapshotPath(context);
    const before = await Bun.file(path).text();
    await Bun.write(
      join(context.homeDir, "decoy", "SKILL.md"),
      "# Unrelated\n"
    );
    expect((await loadReadSnapshot(context)).index.skills.alpha).toBeDefined();
    expect(await Bun.file(path).text()).toBe(before);
    const publishers = await Promise.allSettled([
      refreshReadSnapshot(context),
      refreshReadSnapshot(context),
    ]);
    expect(
      publishers.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      publishers.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    expect(
      (await loadReadSnapshot(context)).inventory.skills.some(
        (skill) => skill.name === "alpha"
      )
    ).toBe(true);
    expect(
      (await readdir(join(path, ".."))).every((name) => name.endsWith(".json"))
    ).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode % 0o1000).toBe(0o600);
    }
  } finally {
    await rm(context.homeDir, { recursive: true, force: true });
  }
});

test("project snapshots detect global changes and custom global roots keep separate caches", async () => {
  const context = await fixture();
  try {
    const project = join(context.homeDir, "project", ".ai");
    await mkdir(project, { recursive: true });
    await refreshReadSnapshot({ ...context, rootDir: project });
    await Bun.write(context.skill, "# Edited\n");
    await expect(
      loadReadSnapshot({ ...context, rootDir: project })
    ).rejects.toThrow("snapshot-stale");
    await refreshReadSnapshot(context);
    const other = join(context.homeDir, "custom", ".ai");
    await mkdir(other, { recursive: true });
    await withFacultRootScope({ rootDir: other, scope: "global" }, () =>
      refreshReadSnapshot({ ...context, rootDir: other })
    );
    expect(readSnapshotPath({ ...context, rootDir: other })).not.toBe(
      readSnapshotPath(context)
    );
    expect((await loadReadSnapshot(context)).rootDir).toBe(context.rootDir);
    expect(
      (
        await withFacultRootScope({ rootDir: other, scope: "global" }, () =>
          loadReadSnapshot({ ...context, rootDir: other })
        )
      ).rootDir
    ).toBe(other);
  } finally {
    await rm(context.homeDir, { recursive: true, force: true });
  }
});
