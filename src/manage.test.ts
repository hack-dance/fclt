import { describe, expect, it } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  loadManagedState,
  managedStatePath,
  manageTool,
  saveManagedState,
  syncManagedTools,
  unmanageTool,
} from "./manage";

const DOLLAR = "$";

function placeholder(name: string): string {
  return `${DOLLAR}{${name}}`;
}

const REFS_WRITING_RULE = placeholder("refs.writing_rule");
const HOME_VAR = placeholder("HOME");

async function createTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "facult-manage-"));
}

async function writeJson(p: string, data: unknown) {
  await mkdir(dirname(p), { recursive: true });
  await Bun.write(p, `${JSON.stringify(data, null, 2)}\n`);
}

describe("managed state", () => {
  it("loads default state when missing", async () => {
    const home = await createTempDir();
    const state = await loadManagedState(home);
    expect(state.version).toBe(1);
    expect(state.tools).toEqual({});
  });

  it("writes managed.json after managing", async () => {
    const home = await createTempDir();
    const rootDir = join(home, "agents", ".facult");
    const skillsRoot = join(rootDir, "skills", "alpha");
    await mkdir(skillsRoot, { recursive: true });
    await Bun.write(join(skillsRoot, "SKILL.md"), "# Alpha\n");

    const serversPath = join(rootDir, "mcp", "servers.json");
    await writeJson(serversPath, {
      servers: { test: { command: "node", args: ["server.js"] } },
    });

    await manageTool("cursor", {
      homeDir: home,
      rootDir,
      toolPaths: {
        cursor: {
          tool: "cursor",
          skillsDir: join(home, "tool", "skills"),
          mcpConfig: join(home, "tool", "mcp.json"),
        },
      },
    });

    const managedPath = managedStatePath(home);
    const raw = await readFile(managedPath, "utf8");
    const parsed = JSON.parse(raw) as { tools: Record<string, unknown> };
    expect(parsed.tools.cursor).toBeTruthy();
  });

  it("renders codex agents into the default managed output dir", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "agents", "argument-editor"), {
      recursive: true,
    });
    await Bun.write(
      join(rootDir, "agents", "argument-editor", "agent.toml"),
      `name = "argument-editor"\n\ndeveloper_instructions = """\nBefore reviewing, read \${refs.writing_rule}.\nTarget tool: \${TARGET_TOOL}.\n"""\n`
    );

    await mkdir(join(rootDir, "rules"), { recursive: true });
    await Bun.write(join(rootDir, "rules", "WRITING.md"), "House rules.\n");
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[refs]\nwriting_rule = "@ai/rules/WRITING.md"\n'
    );

    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    await mkdir(join(home, ".codex", "agents"), { recursive: true });
    await Bun.write(join(home, ".codex", "agents", "stale.toml"), "stale\n");

    await manageTool("codex", {
      homeDir: home,
      rootDir,
    });

    const managedPath = managedStatePath(home);
    const raw = await readFile(managedPath, "utf8");
    const parsed = JSON.parse(raw) as {
      tools: Record<string, { agentsDir?: string }>;
    };
    expect(parsed.tools.codex?.agentsDir).toBe(join(home, ".codex", "agents"));

    const rendered = await readFile(
      join(home, ".codex", "agents", "argument-editor.toml"),
      "utf8"
    );
    expect(rendered).toContain(join(rootDir, "rules", "WRITING.md"));
    expect(rendered).toContain("Target tool: codex.");
    expect(rendered).not.toContain(REFS_WRITING_RULE);

    const staleExists = await Bun.file(
      join(home, ".codex", "agents", "stale.toml")
    ).exists();
    expect(staleExists).toBe(false);
  });
});

describe("manage/unmanage", () => {
  it("backs up, renders, and restores", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    const skill = join(rootDir, "skills", "alpha");
    await mkdir(skill, { recursive: true });
    await Bun.write(join(skill, "SKILL.md"), "# Alpha\n");

    const agent = join(rootDir, "agents", "alpha");
    await mkdir(agent, { recursive: true });
    await Bun.write(
      join(agent, "agent.toml"),
      `name = "alpha"\n\ndeveloper_instructions = """\nBefore reviewing, read \${refs.writing_rule}.\nTarget file: \${TARGET_PATH}\n"""\n`
    );

    await mkdir(join(rootDir, "rules"), { recursive: true });
    await Bun.write(join(rootDir, "rules", "WRITING.md"), "House rules.\n");
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[refs]\nwriting_rule = "@ai/rules/WRITING.md"\n'
    );

    const indexPath = join(home, ".facult", "ai", "index.json");
    await writeJson(indexPath, {
      skills: {
        alpha: {
          name: "alpha",
          path: skill,
          enabledFor: ["cursor"],
        },
      },
    });

    const serversPath = join(rootDir, "mcp", "servers.json");
    await writeJson(serversPath, {
      servers: {
        alpha: { command: "node", args: ["server.js"], enabledFor: ["cursor"] },
        beta: { command: "node", args: ["skip.js"], enabledFor: ["codex"] },
      },
    });

    const toolRoot = join(home, "tool");
    const toolSkills = join(toolRoot, "skills");
    const toolMcp = join(toolRoot, "mcp.json");
    const toolAgents = join(toolRoot, "agents");
    await mkdir(toolSkills, { recursive: true });
    await Bun.write(join(toolSkills, "legacy.txt"), "old");
    await writeJson(toolMcp, { servers: { legacy: { command: "old" } } });
    await mkdir(toolAgents, { recursive: true });
    await Bun.write(join(toolAgents, "legacy.toml"), "old");

    await manageTool("codex", {
      homeDir: home,
      rootDir,
      toolPaths: {
        codex: {
          tool: "codex",
          skillsDir: toolSkills,
          mcpConfig: toolMcp,
          agentsDir: toolAgents,
        },
      },
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    const linkPath = join(toolSkills, "alpha");
    const st = await lstat(linkPath);
    expect(st.isSymbolicLink()).toBe(true);
    const target = await readlink(linkPath);
    expect(target).toBe(skill);

    const renderedAgent = await readFile(
      join(toolAgents, "alpha.toml"),
      "utf8"
    );
    expect(renderedAgent).toContain(join(rootDir, "rules", "WRITING.md"));
    expect(renderedAgent).toContain(join(toolAgents, "alpha.toml"));

    const newMcp = JSON.parse(await readFile(toolMcp, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(newMcp.mcpServers).length).toBeGreaterThan(0);

    await unmanageTool("codex", {
      homeDir: home,
      toolPaths: {
        codex: {
          tool: "codex",
          skillsDir: toolSkills,
          mcpConfig: toolMcp,
          agentsDir: toolAgents,
        },
      },
    });

    const restored = await readFile(join(toolSkills, "legacy.txt"), "utf8");
    expect(restored).toBe("old");
    const restoredMcp = JSON.parse(await readFile(toolMcp, "utf8")) as {
      servers: Record<string, unknown>;
    };
    expect(Object.keys(restoredMcp.servers)).toEqual(["legacy"]);

    const restoredAgent = await readFile(
      join(toolAgents, "legacy.toml"),
      "utf8"
    );
    expect(restoredAgent).toBe("old");
  });

  it("manages global codex AGENTS.md and rules with backups", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    await mkdir(rootDir, { recursive: true });
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[refs]\nwriting_rule = "@ai/instructions/WRITING.md"\n'
    );
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await Bun.write(
      join(rootDir, "instructions", "WRITING.md"),
      "Write directly.\n"
    );
    await mkdir(join(rootDir, "snippets", "global", "codex"), {
      recursive: true,
    });
    await Bun.write(
      join(rootDir, "snippets", "global", "codex", "base.md"),
      "Always show the active instruction sources before editing.\n"
    );
    await Bun.write(
      join(rootDir, "AGENTS.global.md"),
      [
        "# Global Instructions",
        "",
        "<!-- fclty:global/codex/base -->",
        "OLD",
        "<!-- /fclty:global/codex/base -->",
        "",
        `Read ${REFS_WRITING_RULE}.`,
      ].join("\n")
    );
    await mkdir(join(rootDir, "tools", "codex", "rules"), { recursive: true });
    await Bun.write(
      join(rootDir, "tools", "codex", "config.toml"),
      [
        'project_doc_fallback_filenames = ["TEAM_GUIDE.md", "team_guide.md", ".agents.md"]',
        "project_doc_max_bytes = 65536",
      ].join("\n")
    );
    await Bun.write(
      join(rootDir, "tools", "codex", "rules", "default.rules"),
      [
        "prefix_rule(",
        `    pattern = ["python3", "${HOME_VAR}/.codex/skills/.system/skill-creator/scripts/init_skill.py"],`,
        '    decision = "prompt",',
        ")",
      ].join("\n")
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    await mkdir(join(home, ".codex", "rules"), { recursive: true });
    await Bun.write(join(home, ".codex", "AGENTS.md"), "legacy global\n");
    await Bun.write(
      join(home, ".codex", "config.toml"),
      `${[
        'approval_policy = "never"',
        "",
        '[projects."/Users/hack/dev/hack-dance/facult"]',
        'trust_level = "trusted"',
      ].join("\n")}\n`
    );
    await Bun.write(join(home, ".codex", "rules", "legacy.rules"), "legacy\n");

    await manageTool("codex", { homeDir: home, rootDir });

    const globalAgents = await readFile(
      join(home, ".codex", "AGENTS.md"),
      "utf8"
    );
    expect(globalAgents).toContain(
      "Always show the active instruction sources before editing."
    );
    expect(globalAgents).toContain(join(rootDir, "instructions", "WRITING.md"));
    expect(globalAgents).not.toContain(REFS_WRITING_RULE);

    const defaultRule = await readFile(
      join(home, ".codex", "rules", "default.rules"),
      "utf8"
    );
    expect(defaultRule).toContain(
      `pattern = ["python3", "${join(home, ".codex", "skills", ".system", "skill-creator", "scripts", "init_skill.py")}"]`
    );
    expect(defaultRule).not.toContain(HOME_VAR);

    const toolConfig = await readFile(
      join(home, ".codex", "config.toml"),
      "utf8"
    );
    expect(toolConfig).toContain('approval_policy = "never"');
    expect(toolConfig).toContain("TEAM_GUIDE.md");
    expect(toolConfig).toContain("team_guide.md");
    expect(toolConfig).toContain("project_doc_max_bytes = 65536");
    expect(toolConfig).toContain(
      '[projects."/Users/hack/dev/hack-dance/facult"]'
    );
    expect(toolConfig).toContain('trust_level = "trusted"');

    const legacyRuleExists = await Bun.file(
      join(home, ".codex", "rules", "legacy.rules")
    ).exists();
    expect(legacyRuleExists).toBe(false);

    await unmanageTool("codex", { homeDir: home });

    const restoredGlobalAgents = await readFile(
      join(home, ".codex", "AGENTS.md"),
      "utf8"
    );
    expect(restoredGlobalAgents).toBe("legacy global\n");
    const restoredToolConfig = await readFile(
      join(home, ".codex", "config.toml"),
      "utf8"
    );
    expect(restoredToolConfig).toBe(
      [
        'approval_policy = "never"',
        "",
        '[projects."/Users/hack/dev/hack-dance/facult"]',
        'trust_level = "trusted"',
        "",
      ].join("\n")
    );
    const restoredLegacyRule = await readFile(
      join(home, ".codex", "rules", "legacy.rules"),
      "utf8"
    );
    expect(restoredLegacyRule).toBe("legacy\n");
  });
});

describe("syncManagedTools", () => {
  it("reconciles rendered codex agents on sync", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "agents", "alpha"), { recursive: true });
    await Bun.write(
      join(rootDir, "agents", "alpha", "agent.toml"),
      `name = "alpha"\n\ndeveloper_instructions = """\nBefore reviewing, read \${refs.writing_rule}.\n"""\n`
    );
    await mkdir(join(rootDir, "agents", "beta"), { recursive: true });
    await Bun.write(
      join(rootDir, "agents", "beta", "agent.toml"),
      `name = "beta"\n\ndeveloper_instructions = """\nBefore reviewing, read \${refs.writing_rule}.\n"""\n`
    );
    await mkdir(join(rootDir, "rules"), { recursive: true });
    await Bun.write(join(rootDir, "rules", "WRITING.md"), "House rules.\n");
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[refs]\nwriting_rule = "@ai/rules/WRITING.md"\n'
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    await manageTool("codex", { homeDir: home, rootDir });

    await rm(join(rootDir, "agents", "beta"), { recursive: true, force: true });
    await Bun.write(
      join(rootDir, "agents", "alpha", "agent.toml"),
      `name = "alpha"\n\ndeveloper_instructions = """\nBefore reviewing, read \${refs.writing_rule} and check \${refs.writing_rule} again.\n"""\n`
    );

    await syncManagedTools({ homeDir: home, rootDir, tool: "codex" });

    const alpha = await readFile(
      join(home, ".codex", "agents", "alpha.toml"),
      "utf8"
    );
    expect(alpha).toContain(join(rootDir, "rules", "WRITING.md"));
    expect(alpha).toContain("check");

    const betaExists = await Bun.file(
      join(home, ".codex", "agents", "beta.toml")
    ).exists();
    expect(betaExists).toBe(false);
  });

  it("reconciles global codex docs and rules on sync", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(rootDir, { recursive: true });
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[refs]\nwriting_rule = "@ai/instructions/WRITING.md"\n'
    );
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await Bun.write(
      join(rootDir, "instructions", "WRITING.md"),
      "Write directly.\n"
    );
    await Bun.write(
      join(rootDir, "AGENTS.global.md"),
      `Read ${REFS_WRITING_RULE}.\n`
    );
    await Bun.write(
      join(rootDir, "tools", "codex", "config.toml"),
      'project_doc_fallback_filenames = ["TEAM_GUIDE.md", ".agents.md"]\n'
    );
    await mkdir(join(rootDir, "tools", "codex", "rules"), { recursive: true });
    await Bun.write(
      join(rootDir, "tools", "codex", "rules", "default.rules"),
      'prefix_rule(pattern = ["gh"], decision = "prompt")\n'
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    await manageTool("codex", { homeDir: home, rootDir });

    await rm(join(rootDir, "AGENTS.global.md"), { force: true });
    const liveConfigPath = join(home, ".codex", "config.toml");
    const existingLiveConfig = await readFile(liveConfigPath, "utf8");
    await Bun.write(
      liveConfigPath,
      `${existingLiveConfig}\napproval_policy = "trusted-only"\n`
    );
    await rm(join(rootDir, "tools", "codex", "config.toml"), { force: true });
    await rm(join(rootDir, "tools", "codex", "rules", "default.rules"), {
      force: true,
    });

    await syncManagedTools({ homeDir: home, rootDir, tool: "codex" });

    const globalAgentsExists = await Bun.file(
      join(home, ".codex", "AGENTS.md")
    ).exists();
    expect(globalAgentsExists).toBe(false);

    const ruleExists = await Bun.file(
      join(home, ".codex", "rules", "default.rules")
    ).exists();
    expect(ruleExists).toBe(false);

    const toolConfig = await readFile(
      join(home, ".codex", "config.toml"),
      "utf8"
    );
    expect(toolConfig).toContain('approval_policy = "trusted-only"');
  });

  it("repairs legacy managed codex state and adopts new global surfaces on sync", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[refs]\nwriting_rule = "@ai/instructions/WRITING.md"\n'
    );
    await Bun.write(
      join(rootDir, "instructions", "WRITING.md"),
      "Write directly.\n"
    );
    await Bun.write(
      join(rootDir, "AGENTS.global.md"),
      `Read ${REFS_WRITING_RULE}.\n`
    );
    await mkdir(join(rootDir, "tools", "codex", "rules"), { recursive: true });
    await Bun.write(
      join(rootDir, "tools", "codex", "config.toml"),
      'project_doc_fallback_filenames = ["TEAM_GUIDE.md"]\n'
    );
    await Bun.write(
      join(rootDir, "tools", "codex", "rules", "default.rules"),
      'prefix_rule(pattern = ["gh"], decision = "prompt")\n'
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    await mkdir(join(home, ".codex", "skills"), { recursive: true });
    await mkdir(join(home, ".codex", "rules"), { recursive: true });
    await Bun.write(join(home, ".codex", "AGENTS.md"), "legacy global\n");
    await Bun.write(
      join(home, ".codex", "config.toml"),
      'approval_policy = "never"\n'
    );

    await saveManagedState(
      {
        version: 1,
        tools: {
          codex: {
            tool: "codex",
            managedAt: "2026-02-21T18:27:27.874Z",
            skillsDir: join(home, ".codex", "skills"),
            mcpConfig: join(home, ".codex", "mcp.json"),
            skillsBackup: join(home, ".codex", "skills.bak"),
            mcpBackup: null,
          },
        },
      },
      home
    );

    await syncManagedTools({ homeDir: home, rootDir, tool: "codex" });

    const repairedState = await loadManagedState(home);
    expect(repairedState.tools.codex?.globalAgentsPath).toBe(
      join(home, ".codex", "AGENTS.md")
    );
    expect(repairedState.tools.codex?.toolConfig).toBe(
      join(home, ".codex", "config.toml")
    );
    expect(repairedState.tools.codex?.rulesDir).toBe(
      join(home, ".codex", "rules")
    );

    const globalAgents = await readFile(
      join(home, ".codex", "AGENTS.md"),
      "utf8"
    );
    expect(globalAgents).toContain(join(rootDir, "instructions", "WRITING.md"));

    const toolConfig = await readFile(
      join(home, ".codex", "config.toml"),
      "utf8"
    );
    expect(toolConfig).toContain('approval_policy = "never"');
    expect(toolConfig).toContain("TEAM_GUIDE.md");

    const rulesFile = await readFile(
      join(home, ".codex", "rules", "default.rules"),
      "utf8"
    );
    expect(rulesFile).toContain('pattern = ["gh"]');
  });
});
