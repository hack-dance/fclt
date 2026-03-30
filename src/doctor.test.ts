import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manageTool } from "./manage";
import { facultAiIndexPath } from "./paths";

async function writeJson(p: string, data: unknown) {
  await mkdir(join(p, ".."), { recursive: true }).catch(() => null);
  await Bun.write(p, `${JSON.stringify(data, null, 2)}\n`);
}

test("doctor --repair migrates a legacy root index into generated ai state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-"));
  const rootDir = join(dir, "root");
  const legacyIndex = join(rootDir, "index.json");
  const generatedIndex = facultAiIndexPath(dir, rootDir);

  try {
    await mkdir(rootDir, { recursive: true });
    await Bun.write(
      legacyIndex,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          skills: {},
          mcp: { servers: {} },
          agents: {},
          snippets: {},
          instructions: {},
        },
        null,
        2
      )}\n`
    );

    const env = { ...process.env, HOME: dir, FACULT_ROOT_DIR: rootDir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--repair"],
      {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("Repaired generated AI index");

    const repaired = JSON.parse(await readFile(generatedIndex, "utf8")) as {
      version: number;
    };
    expect(repaired.version).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor --repair updates legacy root config to ~/.ai when present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-config-"));
  const aiRoot = join(dir, ".ai");

  try {
    await mkdir(join(aiRoot, "agents"), { recursive: true });
    await writeJson(join(dir, ".facult", "config.json"), {
      rootDir: join(dir, "agents", ".facult"),
    });

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--repair"],
      {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain(`Updated fclt root config to ${aiRoot}`);

    const config = JSON.parse(
      await readFile(join(dir, ".ai", ".facult", "config.json"), "utf8")
    ) as { rootDir: string };
    expect(config.rootDir).toBe(aiRoot);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor --repair migrates legacy codex skill and plugin layouts into .agents and plugins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-codex-layout-"));
  const aiRoot = join(dir, ".ai");

  try {
    await mkdir(join(aiRoot, "mcp"), { recursive: true });
    await Bun.write(
      join(aiRoot, "mcp", "servers.json"),
      JSON.stringify({ servers: {} }, null, 2)
    );

    await mkdir(join(dir, ".codex", "skills", "legacy-skill"), {
      recursive: true,
    });
    await Bun.write(
      join(dir, ".codex", "skills", "legacy-skill", "SKILL.md"),
      "# Legacy Skill\n"
    );

    await mkdir(
      join(dir, ".codex", "plugins", "autoresearch", ".codex-plugin"),
      {
        recursive: true,
      }
    );
    await Bun.write(
      join(
        dir,
        ".codex",
        "plugins",
        "autoresearch",
        ".codex-plugin",
        "plugin.json"
      ),
      JSON.stringify({ name: "autoresearch", version: "0.1.0" }, null, 2)
    );

    await mkdir(join(dir, ".agents", "plugins"), { recursive: true });
    await Bun.write(
      join(dir, ".agents", "plugins", "marketplace.json"),
      JSON.stringify(
        {
          name: "local",
          interface: { displayName: "Local Plugins" },
          plugins: [
            {
              name: "autoresearch",
              source: {
                source: "local",
                path: "./.codex/plugins/autoresearch",
              },
              policy: {
                installation: "AVAILABLE",
                authentication: "ON_INSTALL",
              },
              category: "Productivity",
            },
          ],
        },
        null,
        2
      )
    );

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--repair"],
      {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("Migrated legacy Codex authoring paths");

    expect(
      await Bun.file(
        join(dir, ".agents", "skills", "legacy-skill", "SKILL.md")
      ).exists()
    ).toBe(true);
    expect(
      await Bun.file(
        join(dir, "plugins", "autoresearch", ".codex-plugin", "plugin.json")
      ).exists()
    ).toBe(true);

    const marketplace = await readFile(
      join(dir, ".agents", "plugins", "marketplace.json"),
      "utf8"
    );
    expect(marketplace).toContain('"path": "./plugins/autoresearch"');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor --repair materializes explicit project sync config for managed project roots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-project-sync-"));
  const projectRoot = join(dir, "work", "repo");
  const aiRoot = join(projectRoot, ".ai");

  try {
    await mkdir(join(aiRoot, "skills", "project-skill"), { recursive: true });
    await Bun.write(
      join(aiRoot, "skills", "project-skill", "SKILL.md"),
      "---\ndescription: Project skill\n---\n\n# Project skill\n"
    );

    await mkdir(join(aiRoot, "agents", "reviewer"), { recursive: true });
    await Bun.write(
      join(aiRoot, "agents", "reviewer", "agent.toml"),
      'name = "reviewer"\n'
    );

    await mkdir(join(aiRoot, "mcp"), { recursive: true });
    await Bun.write(
      join(aiRoot, "mcp", "servers.json"),
      JSON.stringify(
        {
          servers: {
            "project-server": {
              command: "node",
              args: ["server.js"],
            },
          },
        },
        null,
        2
      )
    );

    await Bun.write(join(aiRoot, "AGENTS.global.md"), "# Project docs\n");
    await mkdir(join(aiRoot, "tools", "codex", "rules"), { recursive: true });
    await Bun.write(
      join(aiRoot, "tools", "codex", "rules", "project.rules"),
      "Project rules.\n"
    );
    await Bun.write(
      join(aiRoot, "tools", "codex", "config.toml"),
      'approval_policy = "never"\n'
    );

    await manageTool("codex", { homeDir: dir, rootDir: aiRoot });

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--repair", "--root", aiRoot],
      {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("Materialized explicit project sync policy");

    const config = Bun.TOML.parse(
      await readFile(join(aiRoot, "config.local.toml"), "utf8")
    ) as {
      project_sync?: {
        codex?: {
          skills?: string[];
          agents?: string[];
          mcp_servers?: string[];
          global_docs?: boolean;
          tool_rules?: boolean;
          tool_config?: boolean;
        };
      };
    };

    expect(config.project_sync?.codex?.skills).toEqual(["project-skill"]);
    expect(config.project_sync?.codex?.agents).toEqual(["reviewer"]);
    expect(config.project_sync?.codex?.mcp_servers).toEqual(["project-server"]);
    expect(config.project_sync?.codex?.global_docs).toBe(true);
    expect(config.project_sync?.codex?.tool_rules).toBe(true);
    expect(config.project_sync?.codex?.tool_config).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);
