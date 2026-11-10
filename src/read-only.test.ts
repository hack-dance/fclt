import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildAgentInventory } from "./inventory";

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(path: string) {
    const metadata = await stat(path);
    result[path] = `${metadata.mtimeMs}:${metadata.size}:${
      metadata.isFile()
        ? createHash("sha256")
            .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
            .digest("hex")
        : "dir"
    }`;
    if (metadata.isDirectory()) {
      for (const entry of await readdir(path)) {
        await visit(join(path, entry));
      }
    }
  }
  await visit(root);
  return result;
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "fclt-read-only-"));
  const root = join(home, ".ai");
  await mkdir(join(root, "skills", "alpha"), { recursive: true });
  await Bun.write(
    join(root, "skills", "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: first\n---\n# Alpha\n"
  );
  await Bun.write(join(root, "instructions", "WORK.md"), "# Work\n");
  return { home, root };
}

function cli(home: string, args: string[], extra: Record<string, string> = {}) {
  return Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "index.ts"), ...args],
    {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        FACULT_ROOT_DIR: join(home, ".ai"),
        FACULT_ROOT_SCOPE: "global",
        FACULT_LOCAL_STATE_DIR: join(home, "state"),
        XDG_STATE_HOME: join(home, "state"),
        ...extra,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
}

test("read commands preserve canonical file hashes and mtimes with missing and stale indexes", async () => {
  const { home, root } = await fixture();
  try {
    const commands = [
      ["list", "skills", "--json"],
      ["status", "--json"],
      ["inventory", "--global", "--no-config-from", "--json"],
      ["show", "skill:alpha"],
      ["graph", "skill:alpha", "--json"],
      ["find", "alpha", "--json"],
      ["doctor", "--json"],
    ];
    for (const stale of [false, true]) {
      if (stale) {
        const index = cli(home, ["index"]);
        expect(await index.exited).toBe(0);
        await Bun.write(
          join(root, "skills", "alpha", "SKILL.md"),
          "---\nname: alpha\ndescription: changed\n---\n# Changed\n"
        );
      }
      const before = await snapshot(root);
      for (const args of commands) {
        const child = cli(home, args);
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ args, stderr, code }).toEqual({ args, stderr: "", code: 0 });
        if (args[0] === "list") {
          expect(stdout).toContain("alpha");
        }
        expect(await snapshot(root)).toEqual(before);
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);

test("explicit no-write blocks mutations before any files change and disables cache writes", async () => {
  const { home } = await fixture();
  try {
    const before = await snapshot(home);
    for (const args of [
      ["index", "--no-write"],
      ["sync"],
      ["doctor", "--repair"],
      ["ai", "writeback", "add", "--summary", "blocked"],
    ]) {
      const child = cli(home, args, { FCLT_NO_WRITE: "1" });
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited).toBe(2);
      expect(stderr).toContain("disabled by --no-write / FCLT_NO_WRITE=1");
      expect(await snapshot(home)).toEqual(before);
    }
    const read = cli(home, ["inventory", "--global", "--json", "--no-write"]);
    expect(await read.exited).toBe(0);
    expect(await snapshot(home)).toEqual(before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("global inventory skips home decoys and invalidates cache on nested add/edit/delete", async () => {
  const { home, root } = await fixture();
  try {
    await Bun.write(
      join(home, "decoy", "nested", "SKILL.md"),
      "# Must not scan\n"
    );
    await Bun.write(
      join(root, ".facult", "config.json"),
      JSON.stringify({ scanFrom: [home] })
    );
    const options = { homeDir: home, cwd: home, sourceMode: "global" as const };
    const first = await buildAgentInventory(options);
    expect(first.cache?.hit).toBe(false);
    expect(first.scanFrom).toEqual([]);
    expect(
      first.sources.some(
        (source) =>
          source.id.startsWith("from-") || source.id.endsWith("-project")
      )
    ).toBe(false);
    expect(first.skills.some((skill) => skill.path.includes("decoy"))).toBe(
      false
    );
    expect((await buildAgentInventory(options)).cache?.hit).toBe(true);
    for (const change of [
      () =>
        Bun.write(
          join(root, "skills", "nested", "beta", "SKILL.md"),
          "# Beta\n"
        ),
      () => Bun.write(join(root, "skills", "alpha", "SKILL.md"), "# Edited\n"),
      () => rm(join(root, "skills", "nested"), { recursive: true }),
      () =>
        Bun.write(
          join(home, ".codex", "mcp.json"),
          '{"mcpServers":{"example":{"command":"example"}}}'
        ),
      () =>
        Bun.write(join(root, "instructions", "NESTED", "NEW.md"), "# New\n"),
      () => rm(join(root, "instructions", "WORK.md")),
    ]) {
      await change();
      expect((await buildAgentInventory(options)).cache?.hit).toBe(false);
      expect((await buildAgentInventory(options)).cache?.hit).toBe(true);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("project reads preserve both project and global canonical roots", async () => {
  const { home, root } = await fixture();
  try {
    const project = join(home, "project", ".ai");
    await Bun.write(
      join(project, "skills", "local", "SKILL.md"),
      "---\nname: local\ndescription: local\n---\n# Local\n"
    );
    const before = {
      global: await snapshot(root),
      project: await snapshot(project),
    };
    for (const args of [
      ["list", "skills", "--json"],
      ["status", "--json"],
      ["show", "skill:local"],
      ["graph", "skill:local", "--json"],
      ["find", "local", "--json"],
    ]) {
      const child = cli(home, [...args, "--root", project, "--no-write"]);
      const [stderr, code] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ args, stderr, code }).toEqual({ args, stderr: "", code: 0 });
      expect({
        global: await snapshot(root),
        project: await snapshot(project),
      }).toEqual(before);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("global inventory scales to hundreds of skills without visiting a large home decoy", async () => {
  const { home } = await fixture();
  try {
    await Promise.all(
      Array.from({ length: 116 }, (_, i) =>
        Promise.all(
          [".ai", ".codex", ".claude"].map((tool) =>
            Bun.write(
              join(home, tool, "skills", `skill-${i}`, "SKILL.md"),
              `# Skill ${i}\n`
            )
          )
        )
      )
    );
    await Promise.all(
      Array.from({ length: 2000 }, (_, i) =>
        Bun.write(join(home, "decoy", `repo-${i}`, "SKILL.md"), "# Decoy\n")
      )
    );
    const options = {
      homeDir: home,
      cwd: home,
      sourceMode: "global" as const,
      includeConfigFrom: false,
    };
    const start = performance.now();
    const cold = await buildAgentInventory(options);
    const coldMs = performance.now() - start;
    const warmStart = performance.now();
    const warm = await buildAgentInventory(options);
    const warmMs = performance.now() - warmStart;
    expect(cold.skills.every((skill) => !skill.path.includes("decoy"))).toBe(
      true
    );
    expect(cold.summary.skillCount).toBeGreaterThanOrEqual(116);
    expect(warm.cache?.hit).toBe(true);
    expect(coldMs).toBeLessThan(2000);
    expect(warmMs).toBeLessThan(300);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 15_000);

test("cache override inside a canonical root never writes there", async () => {
  const { home, root } = await fixture();
  try {
    const before = await snapshot(root);
    const child = cli(home, ["inventory", "--global", "--json"], {
      FACULT_LOCAL_STATE_DIR: root,
    });
    const [stderr, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ stderr, code }).toEqual({ stderr: "", code: 0 });
    expect(await snapshot(root)).toEqual(before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
