import { expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runFixtureGit } from "../test/git-fixture";
import { manageTool } from "./manage";
import {
  facultAiEvolutionReviewDir,
  facultAiIndexPath,
  facultAiReconciliationStatePath,
  facultAiWritebackQueuePath,
  facultAiWritebackReviewDir,
} from "./paths";

test("doctor distinguishes invalid reconciliation config and state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-reconciliation-"));
  const aiRoot = join(dir, ".ai");
  const env = { ...process.env, HOME: dir };
  try {
    const setup = Bun.spawn(
      [
        "bun",
        "run",
        "./src/index.ts",
        "setup",
        "--global-only",
        "--no-codex-plugin",
        "--json",
      ],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    expect(await setup.exited).toBe(0);

    await Bun.write(join(aiRoot, "reconciliation.json"), "{invalid-config");
    const invalidConfig = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const configReport = JSON.parse(
      await new Response(invalidConfig.stdout).text()
    ) as {
      issues: Array<{ code: string }>;
      actions: Array<{ command: string }>;
    };
    await invalidConfig.exited;
    expect(configReport.issues.map((issue) => issue.code)).toContain(
      "reconciliation-config-invalid"
    );
    expect(configReport.actions.map((action) => action.command)).toContain(
      "fclt ai review init --force"
    );

    await Bun.write(
      join(aiRoot, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "writebacks", type: "writebacks" }],
      })
    );
    await Bun.write(
      facultAiReconciliationStatePath(dir, aiRoot),
      "{invalid-state"
    );
    const invalidState = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const stateReport = JSON.parse(
      await new Response(invalidState.stdout).text()
    ) as { issues: Array<{ code: string }>; loop: { blockers: string[] } };
    await invalidState.exited;
    expect(stateReport.issues.map((issue) => issue.code)).toContain(
      "reconciliation-state-invalid"
    );
    expect(stateReport.loop.blockers).toContain("reconciliation_state_invalid");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

const BROKEN_CUSTOM_REF = ["$", "{refs.private_custom}"].join("");
const BROKEN_LEARNING_REF = ["$", "{refs.learning_writeback}"].join("");
const BROKEN_VERIFICATION_REF = ["$", "{refs.verification}"].join("");
const AGENTS_GLOBAL_BACKUP_RE = /^AGENTS\.global\./;
const FEEDBACK_LOOPS_BACKUP_RE = /^instructions__FEEDBACK_LOOPS\.md\./;

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
    await symlink(
      join(dir, "missing-imagegen-source"),
      join(dir, ".codex", "skills", "imagegen")
    );
    await mkdir(join(dir, ".agents", "skills"), { recursive: true });
    await symlink(
      join(dir, "missing-imagegen-destination"),
      join(dir, ".agents", "skills", "imagegen")
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
      (await lstat(join(dir, ".codex", "skills", "imagegen"))).isSymbolicLink()
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
    await mkdir(join(aiRoot, "automations", "project-check"), {
      recursive: true,
    });
    await Bun.write(
      join(aiRoot, "automations", "project-check", "automation.toml"),
      [
        "version = 1",
        'id = "project-check"',
        'name = "Project check"',
        'prompt = "Inspect the repo"',
        'status = "ACTIVE"',
        'rrule = "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0"',
      ].join("\n")
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
          automations?: string[];
          mcp_servers?: string[];
          global_docs?: boolean;
          tool_rules?: boolean;
          tool_config?: boolean;
        };
      };
    };

    expect(config.project_sync?.codex?.skills).toEqual(["project-skill"]);
    expect(config.project_sync?.codex?.agents).toEqual(["reviewer"]);
    expect(config.project_sync?.codex?.automations).toEqual(["project-check"]);
    expect(config.project_sync?.codex?.mcp_servers).toEqual(["project-server"]);
    expect(config.project_sync?.codex?.global_docs).toBe(true);
    expect(config.project_sync?.codex?.tool_rules).toBe(true);
    expect(config.project_sync?.codex?.tool_config).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor --json reports read-only setup health", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-json-"));

  try {
    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json"],
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
    const report = JSON.parse(out) as {
      version: number;
      health: { state: string; ok: boolean };
      rootDir: string;
      checks: { generatedIndexSource: string };
      issues: Array<{ code: string }>;
      actions: Array<{ id: string; risk: string }>;
    };
    expect(report.version).toBe(1);
    expect(report.rootDir).toBe(join(dir, ".ai"));
    expect(report.health.state).toBe("uninitialized");
    expect(report.health.ok).toBe(false);
    expect(report.checks.generatedIndexSource).toBe("missing");
    expect(report.issues.map((issue) => issue.code)).toContain("missing-root");
    expect(report.actions).toContainEqual(
      expect.objectContaining({
        id: "init-global-operating-model",
        risk: "canonical_write",
      })
    );
    expect(await Bun.file(join(dir, ".ai")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor detects Linear in canonical mcp.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-linear-mcp-"));
  const aiRoot = join(dir, ".ai");

  try {
    await mkdir(join(aiRoot, "mcp"), { recursive: true });
    await writeJson(join(aiRoot, "mcp", "mcp.json"), {
      mcpServers: {
        linear: {
          command: "linear-mcp",
        },
      },
    });
    const env = {
      ...process.env,
      HOME: dir,
      LINEAR_API_KEY: "",
      LINEAR_ACCESS_TOKEN: "",
      LINEAR_TOKEN: "",
    };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json", "--root", aiRoot],
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
    const report = JSON.parse(out) as {
      loop: {
        integrations: {
          linear: { state: string; message: string };
        };
      };
    };
    expect(report.loop.integrations.linear.state).toBe("configured_unverified");
    expect(report.loop.integrations.linear.message).toContain(
      "Linear configuration was detected"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor detects Linear in the documented MCP local overlay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-linear-local-mcp-"));
  const aiRoot = join(dir, ".ai");

  try {
    await mkdir(join(aiRoot, "mcp"), { recursive: true });
    await writeJson(join(aiRoot, "mcp", "mcp.json"), {
      mcpServers: {},
    });
    await writeJson(join(aiRoot, "mcp", "servers.local.json"), {
      servers: {
        linear: {
          command: "linear-mcp",
        },
      },
    });
    const env = {
      ...process.env,
      HOME: dir,
      LINEAR_API_KEY: "",
      LINEAR_ACCESS_TOKEN: "",
      LINEAR_TOKEN: "",
    };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json", "--root", aiRoot],
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
    const report = JSON.parse(out) as {
      loop: {
        integrations: {
          linear: { state: string; message: string };
        };
      };
    };
    expect(report.loop.integrations.linear.state).toBe("configured_unverified");
    expect(report.loop.integrations.linear.message).toContain(
      "Linear configuration was detected"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor health is non-OK when loop readiness is blocked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-loop-blocked-"));

  try {
    const env = { ...process.env, HOME: dir };
    const setup = Bun.spawn(
      [
        "bun",
        "run",
        "./src/index.ts",
        "setup",
        "--global-only",
        "--no-codex-plugin",
        "--json",
      ],
      {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [setupCode, setupErr] = await Promise.all([
      setup.exited,
      new Response(setup.stderr).text(),
      new Response(setup.stdout).text(),
    ]);
    expect(setupCode).toBe(0);
    expect(setupErr).toBe("");

    await rm(join(dir, ".ai", "skills", "capability-evolution"), {
      recursive: true,
      force: true,
    });

    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json"],
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
    const report = JSON.parse(out) as {
      health: { state: string; ok: boolean };
      loop: { state: string; blockers: string[] };
    };
    expect(report.health).toEqual({ state: "loop_blocked", ok: false });
    expect(report.loop.state).toBe("blocked");
    expect(report.loop.blockers).toContain("evolution_skill_missing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("project doctor accepts loop skills inherited from the global root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-inherited-loop-"));
  const repo = join(dir, "work", "repo");
  const cliEntry = join(import.meta.dir, "index.ts");

  try {
    await mkdir(repo, { recursive: true });
    await runFixtureGit({
      argv: ["init", repo],
      repoDir: repo,
      homeDir: join(dir, ".git-home"),
    });

    const env = { ...process.env, HOME: dir };
    const setup = Bun.spawn(
      ["bun", "run", cliEntry, "setup", "--no-codex-plugin", "--json"],
      {
        cwd: repo,
        env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [setupCode, setupOut, setupErr] = await Promise.all([
      setup.exited,
      new Response(setup.stdout).text(),
      new Response(setup.stderr).text(),
    ]);
    expect(setupErr).toBe("");
    expect(setupCode).toBe(0);
    expect(setupOut).not.toBe("");

    await Promise.all([
      rm(join(repo, ".ai", "skills", "fclt-writeback"), {
        recursive: true,
        force: true,
      }),
      rm(join(repo, ".ai", "skills", "capability-evolution"), {
        recursive: true,
        force: true,
      }),
    ]);

    const proc = Bun.spawn(
      ["bun", "run", cliEntry, "doctor", "--project", "--json"],
      {
        cwd: repo,
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
    const report = JSON.parse(out) as {
      health: { ok: boolean };
      loop: {
        state: string;
        blockers: string[];
        capabilities: { writebackSkill: boolean; evolutionSkill: boolean };
      };
    };
    expect(report.health.ok).toBe(true);
    expect(report.loop.state).toBe("ready");
    expect(report.loop.blockers).not.toContain("writeback_skill_missing");
    expect(report.loop.blockers).not.toContain("evolution_skill_missing");
    expect(report.loop.capabilities.writebackSkill).toBe(true);
    expect(report.loop.capabilities.evolutionSkill).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor blocks loop readiness when reconciliation has no enabled sources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-no-sources-"));
  const repo = join(dir, "work", "repo");
  const cliEntry = join(import.meta.dir, "index.ts");

  try {
    await mkdir(repo, { recursive: true });
    await runFixtureGit({
      argv: ["init", repo],
      repoDir: repo,
      homeDir: join(dir, ".git-home"),
    });
    const env = { ...process.env, HOME: dir };
    const setup = Bun.spawn(
      ["bun", "run", cliEntry, "setup", "--no-codex-plugin", "--json"],
      { cwd: repo, env, stdout: "pipe", stderr: "pipe" }
    );
    expect(await setup.exited).toBe(0);
    await Bun.write(
      join(repo, ".ai", "reconciliation.json"),
      JSON.stringify({ version: 1, sources: [] })
    );
    const proc = Bun.spawn(
      ["bun", "run", cliEntry, "doctor", "--project", "--json"],
      { cwd: repo, env, stdout: "pipe", stderr: "pipe" }
    );
    const [code, out] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as {
      loop: { state: string; blockers: string[] };
    };
    expect(report.loop.state).toBe("blocked");
    expect(report.loop.blockers).toContain("reconciliation_sources_missing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor --json flags invalid canonical global guidance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-global-docs-"));
  const aiRoot = join(dir, ".ai");

  try {
    await mkdir(aiRoot, { recursive: true });
    await Bun.write(
      join(aiRoot, "AGENTS.global.md"),
      [
        "# Global Agent Instructions",
        "",
        "<!-- fclty:global/core/work-units -->",
        "<!-- /fclty:global/core/work-units -->",
        "",
        `- For verification, read ${BROKEN_VERIFICATION_REF}.`,
      ].join("\n")
    );

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json"],
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
    const report = JSON.parse(out) as {
      health: { state: string; ok: boolean };
      checks: {
        canonicalGlobalDocsValid: boolean;
        canonicalGlobalDocsIssueCodes: string[];
        canonicalTemplateRefsValid: boolean;
        canonicalTemplateRefsIssueCodes: string[];
        canonicalTemplateRefsIssuePaths: string[];
      };
      issues: Array<{ code: string }>;
      actions: Array<{ id: string; command: string }>;
    };
    expect(report.health.state).toBe("canonical_source_attention");
    expect(report.health.ok).toBe(false);
    expect(report.checks.canonicalGlobalDocsValid).toBe(false);
    expect(report.checks.canonicalGlobalDocsIssueCodes).toEqual([
      "canonical-global-docs-empty-managed-sections",
    ]);
    expect(report.checks.canonicalTemplateRefsValid).toBe(true);
    expect(report.checks.canonicalTemplateRefsIssueCodes).toEqual([]);
    expect(report.checks.canonicalTemplateRefsIssuePaths).toEqual([]);
    expect(report.issues.map((issue) => issue.code)).toContain(
      "canonical-global-docs-empty-managed-sections"
    );
    expect(report.actions).toContainEqual(
      expect.objectContaining({
        id: "refresh-global-operating-model",
        command: "fclt templates init operating-model --global --force",
      })
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor --json accepts renderable templated canonical global guidance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-global-template-"));
  const aiRoot = join(dir, ".ai");

  try {
    await mkdir(join(aiRoot, "snippets", "global", "core"), {
      recursive: true,
    });
    await Bun.write(
      join(aiRoot, "AGENTS.global.md"),
      [
        "# Global Agent Instructions",
        "",
        "<!-- fclty:global/core/work-units -->",
        "<!-- /fclty:global/core/work-units -->",
        "",
        `- For learning, read ${BROKEN_LEARNING_REF}.`,
      ].join("\n")
    );
    await Bun.write(
      join(aiRoot, "snippets", "global", "core", "work-units.md"),
      `- For deeper guidance, read ${BROKEN_LEARNING_REF}.\n`
    );

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json"],
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
    const report = JSON.parse(out) as {
      health: { state: string; ok: boolean };
      checks: {
        canonicalGlobalDocsValid: boolean;
        canonicalGlobalDocsIssueCodes: string[];
      };
    };
    expect(report.health.state).not.toBe("canonical_source_attention");
    expect(report.checks.canonicalGlobalDocsValid).toBe(true);
    expect(report.checks.canonicalGlobalDocsIssueCodes).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor exits nonzero for invalid canonical global guidance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-global-docs-text-"));
  const aiRoot = join(dir, ".ai");

  try {
    await mkdir(aiRoot, { recursive: true });
    await Bun.write(
      join(aiRoot, "AGENTS.global.md"),
      [
        "# Global Agent Instructions",
        "",
        "<!-- fclty:global/core/writeback -->",
        "<!-- /fclty:global/core/writeback -->",
      ].join("\n")
    );

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(["bun", "run", "./src/index.ts", "doctor"], {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(code).toBe(1);
    expect(err).toBe("");
    expect(out).toContain("empty fclty managed sections");
    expect(out).toContain("templates init operating-model --global --force");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor --json flags unresolved refs in canonical markdown sources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-source-refs-"));
  const aiRoot = join(dir, ".ai");

  try {
    await mkdir(join(aiRoot, "instructions"), { recursive: true });
    await Bun.write(
      join(aiRoot, "AGENTS.global.md"),
      "# Global Agent Instructions\n\n- Source is otherwise valid.\n"
    );
    await Bun.write(
      join(aiRoot, "instructions", "FEEDBACK_LOOPS.md"),
      `# Feedback Loops\n\nRead ${BROKEN_CUSTOM_REF}.\n`
    );

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json"],
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
    const report = JSON.parse(out) as {
      health: { state: string; ok: boolean };
      checks: {
        canonicalGlobalDocsValid: boolean;
        canonicalTemplateRefsValid: boolean;
        canonicalTemplateRefsIssueCodes: string[];
        canonicalTemplateRefsIssuePaths: string[];
      };
      issues: Array<{ code: string; message: string }>;
      actions: Array<{ id: string; command: string }>;
    };
    expect(report.health.state).toBe("canonical_source_attention");
    expect(report.health.ok).toBe(false);
    expect(report.checks.canonicalGlobalDocsValid).toBe(true);
    expect(report.checks.canonicalTemplateRefsValid).toBe(false);
    expect(report.checks.canonicalTemplateRefsIssueCodes).toEqual([
      "canonical-source-unresolved-template-ref",
    ]);
    expect(report.checks.canonicalTemplateRefsIssuePaths).toEqual([
      "instructions/FEEDBACK_LOOPS.md",
    ]);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "canonical-source-unresolved-template-ref",
        message: expect.stringContaining("instructions/FEEDBACK_LOOPS.md"),
      })
    );
    expect(report.actions).toContainEqual(
      expect.objectContaining({
        id: "repair-canonical-template-refs",
        command: "fclt doctor --repair",
      })
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor --repair refreshes invalid canonical global guidance and review artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-self-heal-"));
  const aiRoot = join(dir, ".ai");

  try {
    await mkdir(aiRoot, { recursive: true });
    await Bun.write(
      join(aiRoot, "AGENTS.global.md"),
      [
        "# Global Agent Instructions",
        "",
        "<!-- fclty:global/core/writeback -->",
        "<!-- /fclty:global/core/writeback -->",
        "",
        `- Read ${BROKEN_LEARNING_REF}.`,
      ].join("\n")
    );
    await mkdir(join(aiRoot, "instructions"), { recursive: true });
    await Bun.write(
      join(aiRoot, "instructions", "FEEDBACK_LOOPS.md"),
      [
        "# Feedback Loops",
        "",
        `For verification, read ${BROKEN_VERIFICATION_REF}.`,
        `For learning, read ${BROKEN_LEARNING_REF}.`,
      ].join("\n")
    );
    await mkdir(join(aiRoot, "snippets", "global", "core"), {
      recursive: true,
    });
    await Bun.write(
      join(aiRoot, "snippets", "global", "core", "feedback-loops.md"),
      `- For deeper guidance, read ${BROKEN_LEARNING_REF}.\n`
    );
    await mkdir(join(aiRoot, "snippets", "global", "core"), {
      recursive: true,
    });
    await Bun.write(
      join(aiRoot, "snippets", "global", "core", "writeback.md"),
      "\n"
    );

    const queuePath = facultAiWritebackQueuePath(dir, aiRoot);
    await mkdir(dirname(queuePath), { recursive: true });
    await Bun.write(
      queuePath,
      `${JSON.stringify({
        id: "WB-00001",
        ts: "2026-06-19T00:00:00.000Z",
        scope: "global",
        kind: "capability_gap",
        summary: "Self-heal test writeback",
        evidence: [{ type: "test", ref: "doctor" }],
        confidence: "medium",
        source: "facult:test",
        tags: [],
        status: "recorded",
      })}\n`
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
    expect(out).toContain("Repaired canonical AGENTS.global.md");
    expect(out).toContain("Resolved canonical template refs in:");
    expect(out).toContain("instructions/FEEDBACK_LOOPS.md");
    expect(out).toContain("Refreshed AI review artifacts: 1 writebacks");

    const repaired = await readFile(join(aiRoot, "AGENTS.global.md"), "utf8");
    expect(repaired).toContain("# Global Agent Instructions");
    expect(repaired).toContain(BROKEN_LEARNING_REF);
    expect(repaired).toContain("<!-- fclty:global/core/writeback -->");
    expect(
      await Bun.file(
        join(aiRoot, "snippets", "global", "core", "writeback.md")
      ).exists()
    ).toBe(true);
    const repairedWritebackSnippet = await readFile(
      join(aiRoot, "snippets", "global", "core", "writeback.md"),
      "utf8"
    );
    expect(repairedWritebackSnippet).toContain(
      "Do not end at output if something important was learned."
    );
    const repairedInstruction = await readFile(
      join(aiRoot, "instructions", "FEEDBACK_LOOPS.md"),
      "utf8"
    );
    expect(repairedInstruction).toContain(
      join(aiRoot, "instructions", "VERIFICATION.md")
    );
    expect(repairedInstruction).toContain(
      join(aiRoot, "instructions", "LEARNING_AND_WRITEBACK.md")
    );
    expect(repairedInstruction).not.toContain("${refs.");

    const backupEntries = await readdir(
      join(aiRoot, ".facult", "backups", "doctor")
    );
    expect(backupEntries).toContainEqual(
      expect.stringMatching(AGENTS_GLOBAL_BACKUP_RE)
    );
    expect(backupEntries).toContainEqual(
      expect.stringMatching(FEEDBACK_LOOPS_BACKUP_RE)
    );

    const review = await readFile(
      join(facultAiWritebackReviewDir(dir, aiRoot), "WB-00001.md"),
      "utf8"
    );
    expect(review).toContain("Self-heal test writeback");
    expect(await readdir(facultAiEvolutionReviewDir(dir, aiRoot))).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor --repair does not replace project AGENTS.global.md with global defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-project-docs-"));
  const repoDir = join(dir, "repo");
  const aiRoot = join(repoDir, ".ai");
  const agentsPath = join(aiRoot, "AGENTS.global.md");
  const projectGuidance = [
    "# Project Agent Instructions",
    "",
    "Keep this project-specific guidance.",
    "",
    "<!-- fclty:global/core/writeback -->",
    "<!-- /fclty:global/core/writeback -->",
  ].join("\n");

  try {
    await mkdir(aiRoot, { recursive: true });
    await Bun.write(agentsPath, projectGuidance);

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
    expect(out).toContain("project AGENTS.global.md");
    expect(out).toContain(
      `fclt templates init project-ai --project-root '${repoDir}' --force`
    );
    expect(out).not.toContain("Repaired canonical AGENTS.global.md");
    expect(await readFile(agentsPath, "utf8")).toBe(projectGuidance);
    expect(
      await Bun.file(join(aiRoot, ".facult", "backups", "doctor")).exists()
    ).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor flags generated-only project ai roots as unsafe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-generated-only-"));
  const projectRoot = join(dir, "work", "repo");
  const aiRoot = join(projectRoot, ".ai");

  try {
    await mkdir(join(aiRoot, ".facult", "ai"), { recursive: true });
    await Bun.write(
      join(aiRoot, ".facult", "ai", "index.json"),
      JSON.stringify(
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
      )
    );

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--root", aiRoot],
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

    expect(code).toBe(1);
    expect(err).toBe("");
    expect(out).toContain("generated state only");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor --json flags generated-only project ai roots without exiting nonzero", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "facult-doctor-json-generated-only-")
  );
  const projectRoot = join(dir, "work", "repo");
  const aiRoot = join(projectRoot, ".ai");

  try {
    await mkdir(join(aiRoot, ".facult", "ai"), { recursive: true });
    await Bun.write(
      join(aiRoot, ".facult", "ai", "index.json"),
      JSON.stringify(
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
      )
    );

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--json", "--root", aiRoot],
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
    const report = JSON.parse(out) as {
      health: { state: string; ok: boolean };
      projectRoot: string | null;
      checks: { generatedOnlyProjectRoot: boolean };
      issues: Array<{ code: string }>;
      actions: Array<{ id: string; command: string }>;
    };
    expect(report.health.state).toBe("project_generated_only");
    expect(report.health.ok).toBe(false);
    expect(report.projectRoot).toBe(projectRoot);
    expect(report.checks.generatedOnlyProjectRoot).toBe(true);
    expect(report.issues.map((issue) => issue.code)).toContain(
      "project-generated-only"
    );
    expect(report.actions).toContainEqual(
      expect.objectContaining({
        id: "init-project-ai",
        command: `fclt templates init project-ai --project-root '${projectRoot}'`,
      })
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor does not flag project ai roots with rules as generated-only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-rules-source-"));
  const projectRoot = join(dir, "work", "repo");
  const aiRoot = join(projectRoot, ".ai");

  try {
    await mkdir(join(aiRoot, ".facult", "ai"), { recursive: true });
    await Bun.write(
      join(aiRoot, ".facult", "ai", "index.json"),
      JSON.stringify(
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
      )
    );
    await mkdir(join(aiRoot, "rules"), { recursive: true });
    await Bun.write(join(aiRoot, "rules", "POLICY.md"), "Project policy.\n");

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--root", aiRoot],
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
    expect(out).not.toContain("generated state only");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);
