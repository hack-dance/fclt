import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildIndex } from "./index-builder";
import { facultConfigPath, withFacultRootScope } from "./paths";
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

async function cli(homeDir: string, argv: string[], cwd = homeDir) {
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "index.ts"), ...argv],
    {
      cwd,
      env: { ...process.env, HOME: homeDir },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("project-native instruction discovery tracks Markdown add/delete and global instruction candidates", async () => {
  const context = await fixture();
  try {
    const projectRoot = join(context.homeDir, "project");
    const project = {
      homeDir: context.homeDir,
      rootDir: join(projectRoot, ".ai"),
    };
    await Bun.write(
      join(project.rootDir, "skills", "local", "SKILL.md"),
      "# Local\n"
    );
    const toolRoot = join(projectRoot, ".codex");
    const existing = join(toolRoot, "instructions", "existing.md");
    await Bun.write(existing, "# Existing\n");
    const added = join(toolRoot, "instructions", "nested", "added.md");
    const changes = [
      { path: added, present: true },
      { path: existing, present: false },
      ...["AGENTS.global.md", "AGENTS.override.global.md"].flatMap((name) => [
        { path: join(toolRoot, name), present: true },
        { path: join(toolRoot, name), present: false },
      ]),
    ];
    for (const change of changes) {
      await refreshReadSnapshot(project);
      const before = await Bun.file(readSnapshotPath(project)).text();
      if (change.present) {
        await Bun.write(change.path, "# Changed\n");
      } else {
        await rm(change.path);
      }
      const result = await cli(
        context.homeDir,
        ["inventory", "--project", "--no-config-from", "--json", "--no-write"],
        projectRoot
      );
      expect({
        path: change.path,
        code: result.code,
        stdout: result.stdout,
      }).toEqual({ path: change.path, code: 1, stdout: "" });
      expect(result.stderr).toContain("snapshot-stale");
      expect(await Bun.file(readSnapshotPath(project)).text()).toBe(before);
      await refreshReadSnapshot(project);
      const refreshed = await loadReadSnapshot({
        ...project,
        surface: "inventory",
      });
      expect(
        refreshed.inventory.instructions.some(
          (entry) => entry.path === change.path
        )
      ).toBe(change.present);
    }
  } finally {
    await rm(context.homeDir, { recursive: true, force: true });
  }
});

for (const markerPresent of [false, true]) {
  test(`project discovery detects nested Git marker ${markerPresent ? "removal" : "addition"} with hook discovery disabled`, async () => {
    const context = await fixture();
    try {
      const projectRoot = join(context.homeDir, "project");
      const project = {
        homeDir: context.homeDir,
        rootDir: join(projectRoot, ".ai"),
      };
      await Bun.write(
        join(project.rootDir, "skills", "local", "SKILL.md"),
        "# Local\n"
      );
      const nested = join(projectRoot, "nested");
      const instruction = join(nested, "deeper", "AGENTS.md");
      const marker = join(nested, ".git");
      await Bun.write(instruction, "# Nested\n");
      if (markerPresent) {
        await Bun.write(marker, "gitdir: .fixture-git\n");
      }
      await refreshReadSnapshot(project);
      expect(
        (
          await loadReadSnapshot({ ...project, surface: "inventory" })
        ).inventory.instructions.some((entry) => entry.path === instruction)
      ).toBe(!markerPresent);
      const before = await Bun.file(readSnapshotPath(project)).text();
      if (markerPresent) {
        await rm(marker);
      } else {
        await Bun.write(marker, "gitdir: .fixture-git\n");
      }
      const result = await cli(
        context.homeDir,
        ["inventory", "--project", "--no-config-from", "--json", "--no-write"],
        projectRoot
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("snapshot-stale");
      expect(await Bun.file(readSnapshotPath(project)).text()).toBe(before);
      await refreshReadSnapshot(project);
      expect(
        (
          await loadReadSnapshot({ ...project, surface: "inventory" })
        ).inventory.instructions.some((entry) => entry.path === instruction)
      ).toBe(markerPresent);
    } finally {
      await rm(context.homeDir, { recursive: true, force: true });
    }
  });
}

for (const asset of [
  { directory: [".cursor", "rules"], extension: "mdc", label: "rules" },
  {
    directory: [".ai", "instructions"],
    extension: "md",
    label: "instructions",
  },
]) {
  test(`project inventory detects new nested ${asset.label} consumed by recursive discovery`, async () => {
    const context = await fixture();
    try {
      const projectRoot = join(context.homeDir, "project");
      const project = {
        homeDir: context.homeDir,
        rootDir: join(projectRoot, ".ai"),
      };
      await Bun.write(
        join(project.rootDir, "skills", "local", "SKILL.md"),
        "# Local\n"
      );
      const directory = join(projectRoot, "nested", ...asset.directory);
      const existing = join(directory, `existing.${asset.extension}`);
      const added = join(directory, `added.${asset.extension}`);
      await Bun.write(existing, "# Existing\n");
      await refreshReadSnapshot(project);
      const initial = await loadReadSnapshot({
        ...project,
        surface: "inventory",
      });
      expect(
        initial.inventory.instructions.some((entry) => entry.path === existing)
      ).toBe(true);
      const snapshotPath = readSnapshotPath(project);
      const before = await Bun.file(snapshotPath).text();
      await Bun.write(added, "# Added\n");
      const result = await cli(
        context.homeDir,
        ["inventory", "--project", "--no-config-from", "--json", "--no-write"],
        projectRoot
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("snapshot-stale");
      expect(await Bun.file(snapshotPath).text()).toBe(before);
      await refreshReadSnapshot(project);
      expect(
        (
          await loadReadSnapshot({ ...project, surface: "inventory" })
        ).inventory.instructions.some((entry) => entry.path === added)
      ).toBe(true);
    } finally {
      await rm(context.homeDir, { recursive: true, force: true });
    }
  });
}

test("project render publishes after apply and rollback while check stays read-only", async () => {
  const context = await fixture();
  try {
    const projectRoot = join(context.homeDir, "project");
    const rootDir = join(projectRoot, ".ai");
    await Bun.write(join(rootDir, "instructions", "WORK.md"), "# First\n");
    await Bun.write(
      join(rootDir, "project-render.toml"),
      `schema_version = 1
exclusive_roots = []
[[targets]]
id = "instructions"
tool = "codex"
destination = "AGENTS.md"
mode = "0644"
producer = "copy-text"
producer_version = 1
sources = ["instructions/WORK.md"]
`
    );
    const args = [
      "project",
      "render",
      "--root",
      rootDir,
      "--project-root",
      projectRoot,
      "--json",
    ];
    const checked = await cli(
      context.homeDir,
      [...args, "--check"],
      projectRoot
    );
    expect({ code: checked.code, stderr: checked.stderr }).toEqual({
      code: 1,
      stderr: "",
    });
    const snapshotContext = { homeDir: context.homeDir, rootDir };
    expect(await Bun.file(readSnapshotPath(snapshotContext)).exists()).toBe(
      false
    );
    expect((await cli(context.homeDir, args, projectRoot)).code).toBe(0);
    expect(
      Object.values(
        (await loadReadSnapshot(snapshotContext)).index.instructions
      ).some((entry) => entry.path === join(rootDir, "instructions", "WORK.md"))
    ).toBe(true);
    await Bun.write(join(rootDir, "instructions", "WORK.md"), "# Next\n");
    expect(
      (await cli(context.homeDir, [...args, "--check"], projectRoot)).code
    ).toBe(1);
    await expect(loadReadSnapshot(snapshotContext)).rejects.toThrow(
      "snapshot-stale"
    );
    expect((await cli(context.homeDir, args, projectRoot)).code).toBe(0);
    expect(
      (await cli(context.homeDir, [...args, "--rollback"], projectRoot)).code
    ).toBe(0);
    expect(
      Object.values(
        (await loadReadSnapshot({ ...snapshotContext, surface: "inventory" }))
          .index.instructions
      ).some((entry) => entry.path === join(rootDir, "instructions", "WORK.md"))
    ).toBe(true);
  } finally {
    await rm(context.homeDir, { recursive: true, force: true });
  }
});

test("routine tool activity keeps queries and scoped inventory fresh, while MCP edits only invalidate inventory", async () => {
  const context = await fixture();
  try {
    const claude = join(context.homeDir, ".claude.json");
    await Bun.write(claude, JSON.stringify({ numStartups: 1, mcpServers: {} }));
    await Bun.write(
      join(context.homeDir, ".codex", "config.toml"),
      'model = "fixture-one"\n'
    );
    await mkdir(join(context.homeDir, ".claude"), { recursive: true });
    expect((await cli(context.homeDir, ["index", "--global"])).code).toBe(0);
    const before = await Bun.file(readSnapshotPath(context)).text();
    for (const mutate of [
      async () => {
        await Bun.write(
          `${claude}.tmp`,
          JSON.stringify({ numStartups: 2, mcpServers: {} })
        );
        await rename(`${claude}.tmp`, claude);
      },
      async () => {
        await Bun.write(
          claude,
          JSON.stringify({ numStartups: 3, tipsHistory: {}, mcpServers: {} })
        );
      },
      async () => {
        const auth = join(context.homeDir, ".codex", "auth.json");
        await Bun.write(`${auth}.tmp`, "{}");
        await rename(`${auth}.tmp`, auth);
      },
      async () => {
        await mkdir(join(context.homeDir, ".claude", "session-cache"), {
          recursive: true,
        });
      },
      async () => {
        await Bun.write(
          join(context.homeDir, ".codex", "config.toml"),
          'model = "fixture-two"\n'
        );
      },
    ]) {
      await mutate();
      for (const args of [
        ["list", "skills", "--json"],
        ["find", "alpha", "--json"],
        ["show", "skills:alpha"],
        ["graph", "show", "skills:alpha", "--json"],
        ["inventory", "--no-config-from", "--json"],
      ]) {
        const result = await cli(context.homeDir, [
          ...args,
          "--global",
          "--no-write",
        ]);
        expect({ args, code: result.code, stderr: result.stderr }).toEqual({
          args,
          code: 0,
          stderr: "",
        });
      }
    }
    expect(await Bun.file(readSnapshotPath(context)).text()).toBe(before);
    await Bun.write(
      claude,
      JSON.stringify({ mcpServers: { added: { command: "example" } } })
    );
    expect(
      (await cli(context.homeDir, ["list", "skills", "--global", "--json"]))
        .code
    ).toBe(0);
    const inventory = await cli(context.homeDir, [
      "inventory",
      "--global",
      "--json",
    ]);
    expect(inventory.code).toBe(1);
    expect(inventory.stderr).toContain("snapshot-stale");
  } finally {
    await rm(context.homeDir, { recursive: true, force: true });
  }
}, 30_000);

test("project file churn stays fresh while new discovered capabilities invalidate only inventory", async () => {
  const context = await fixture();
  try {
    const project = join(context.homeDir, "project");
    const projectContext = {
      homeDir: context.homeDir,
      rootDir: join(project, ".ai"),
    };
    await Bun.write(
      join(projectContext.rootDir, "skills", "local", "SKILL.md"),
      "# Local\n"
    );
    await refreshReadSnapshot(projectContext);
    await Bun.write(join(project, "notes.txt"), "unrelated\n");
    expect(
      (
        await cli(
          context.homeDir,
          ["list", "skills", "--project", "--json"],
          project
        )
      ).code
    ).toBe(0);
    expect(
      (
        await cli(
          context.homeDir,
          ["inventory", "--project", "--no-config-from", "--json"],
          project
        )
      ).code
    ).toBe(0);
    await Bun.write(join(project, "SKILL.md"), "# Discovered\n");
    expect(
      (
        await cli(
          context.homeDir,
          ["list", "skills", "--project", "--json"],
          project
        )
      ).code
    ).toBe(0);
    await expect(
      loadReadSnapshot({ ...projectContext, surface: "inventory" })
    ).rejects.toThrow("snapshot-stale");
  } finally {
    await rm(context.homeDir, { recursive: true, force: true });
  }
});

test("configured global agents, snippets and config changes invalidate project snapshots", async () => {
  const context = await fixture();
  try {
    const custom = join(context.homeDir, "custom", ".ai");
    const agent = join(custom, "agents", "shared", "agent.toml");
    await Bun.write(agent, 'description = "Original"\n');
    await Bun.write(
      facultConfigPath(context.homeDir),
      JSON.stringify({ rootDir: custom })
    );
    const project = {
      homeDir: context.homeDir,
      rootDir: join(context.homeDir, "project", ".ai"),
    };
    await mkdir(project.rootDir, { recursive: true });
    await refreshReadSnapshot(project);
    expect(
      (await loadReadSnapshot(project)).index.agents?.shared?.description
    ).toBe("Original");
    await Bun.write(agent, 'description = "Changed"\n');
    await expect(loadReadSnapshot(project)).rejects.toThrow("snapshot-stale");
    await refreshReadSnapshot(project);
    await Bun.write(
      join(custom, "snippets", "global", "added.md"),
      "# Added\n"
    );
    await expect(loadReadSnapshot(project)).rejects.toThrow("snapshot-stale");
    await refreshReadSnapshot(project);
    await Bun.write(
      facultConfigPath(context.homeDir),
      JSON.stringify({ rootDir: context.rootDir })
    );
    await expect(loadReadSnapshot(project)).rejects.toThrow("snapshot-stale");
  } finally {
    await rm(context.homeDir, { recursive: true, force: true });
  }
});

test("abandoned publication files do not block a later index", async () => {
  const context = await fixture();
  try {
    const path = readSnapshotPath(context);
    await Bun.write(`${path}.lock`, "abandoned old publisher\n");
    await Bun.write(`${path}.interrupted.tmp`, "partial\n");
    const result = await cli(context.homeDir, ["index", "--global"]);
    expect({ code: result.code, stderr: result.stderr }).toEqual({
      code: 0,
      stderr: "",
    });
    expect((await loadReadSnapshot(context)).index.skills.alpha).toBeDefined();
    expect(await Bun.file(`${path}.lock`).text()).toBe(
      "abandoned old publisher\n"
    );
  } finally {
    await rm(context.homeDir, { recursive: true, force: true });
  }
});

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
    ).toHaveLength(2);
    expect(
      publishers.filter((result) => result.status === "rejected")
    ).toHaveLength(0);
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
