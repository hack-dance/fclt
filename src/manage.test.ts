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
import { facultBuiltinPackRoot } from "./builtin";
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
  });

  it("syncs builtin operating-model skills, agents, and global docs by default", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    await mkdir(rootDir, { recursive: true });

    await manageTool("codex", {
      homeDir: home,
      rootDir,
    });

    const skillLink = join(home, ".codex", "skills", "capability-evolution");
    const skillStat = await lstat(skillLink);
    expect(skillStat.isSymbolicLink()).toBe(true);
    expect(await readlink(skillLink)).toContain(
      join(
        "assets",
        "packs",
        "facult-operating-model",
        "skills",
        "capability-evolution"
      )
    );

    const agentText = await readFile(
      join(home, ".codex", "agents", "writeback-curator.toml"),
      "utf8"
    );
    expect(agentText).toContain('name = "writeback-curator"');

    const globalAgents = await readFile(
      join(home, ".codex", "AGENTS.md"),
      "utf8"
    );
    expect(globalAgents).toContain(
      join(facultBuiltinPackRoot(), "instructions", "EVOLUTION.md")
    );
  });

  it("can disable builtin default sync via config", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    await mkdir(rootDir, { recursive: true });
    await Bun.write(
      join(rootDir, "config.toml"),
      "version = 1\n\n[builtin]\nsync_defaults = false\n"
    );

    await manageTool("codex", {
      homeDir: home,
      rootDir,
    });

    expect(
      await Bun.file(
        join(home, ".codex", "skills", "capability-evolution", "SKILL.md")
      ).exists()
    ).toBe(false);
    expect(
      await Bun.file(
        join(home, ".codex", "agents", "writeback-curator.toml")
      ).exists()
    ).toBe(false);
    expect(await Bun.file(join(home, ".codex", "AGENTS.md")).exists()).toBe(
      false
    );
  });

  it("preserves local edits on builtin-backed global docs unless overwrite is requested", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    await mkdir(rootDir, { recursive: true });

    await manageTool("codex", {
      homeDir: home,
      rootDir,
    });

    const targetPath = join(home, ".codex", "AGENTS.md");
    const original = await readFile(targetPath, "utf8");
    await Bun.write(targetPath, `${original}\nLocal note.\n`);

    await syncManagedTools({ homeDir: home, rootDir, tool: "codex" });
    const preserved = await readFile(targetPath, "utf8");
    expect(preserved).toContain("Local note.");

    await syncManagedTools({
      homeDir: home,
      rootDir,
      tool: "codex",
      builtinConflictMode: "overwrite",
    });
    const overwritten = await readFile(targetPath, "utf8");
    expect(overwritten).not.toContain("Local note.");
    expect(overwritten).toContain(
      join(facultBuiltinPackRoot(), "instructions", "EVOLUTION.md")
    );
  });

  it("renders and reconciles Claude global docs via the default CLAUDE.md surface", async () => {
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
      `Read ${REFS_WRITING_RULE}.\nTarget tool: ${placeholder("TARGET_TOOL")}.\n`
    );
    await Bun.write(
      join(rootDir, "AGENTS.override.global.md"),
      "Unused Claude override.\n"
    );

    await manageTool("claude", {
      homeDir: home,
      rootDir,
    });

    const globalClaude = await readFile(
      join(home, ".claude", "CLAUDE.md"),
      "utf8"
    );
    expect(globalClaude).toContain(join(rootDir, "instructions", "WRITING.md"));
    expect(globalClaude).toContain("Target tool: claude.");
    expect(
      await Bun.file(join(home, ".claude", "CLAUDE.override.md")).exists()
    ).toBe(false);

    await Bun.write(
      join(rootDir, "AGENTS.global.md"),
      `Updated for ${placeholder("TARGET_TOOL")}.\nRead ${REFS_WRITING_RULE} again.\n`
    );
    await syncManagedTools({ homeDir: home, rootDir, tool: "claude" });

    const updatedClaude = await readFile(
      join(home, ".claude", "CLAUDE.md"),
      "utf8"
    );
    expect(updatedClaude).toContain("Updated for claude.");
  });

  it("renders and reconciles Cursor global docs by default and config/rules when explicitly configured", async () => {
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
      `Read ${REFS_WRITING_RULE}.\nTarget tool: ${placeholder("TARGET_TOOL")}.\n`
    );
    await Bun.write(
      join(rootDir, "AGENTS.override.global.md"),
      `Override for ${placeholder("TARGET_TOOL")}.\n`
    );
    await mkdir(join(rootDir, "tools", "cursor", "rules"), { recursive: true });
    await Bun.write(
      join(rootDir, "tools", "cursor", "rules", "default.rules"),
      'prefix_rule(pattern = ["gh"], decision = "prompt")\n'
    );
    await Bun.write(
      join(rootDir, "tools", "cursor", "config.toml"),
      'approval_policy = "never"\n'
    );

    await manageTool("cursor", {
      homeDir: home,
      rootDir,
      toolPaths: {
        cursor: {
          tool: "cursor",
          rulesDir: join(home, ".cursor", "rules"),
          toolConfig: join(home, ".cursor", "config.toml"),
        },
      },
    });

    const globalAgents = await readFile(
      join(home, ".cursor", "AGENTS.md"),
      "utf8"
    );
    expect(globalAgents).toContain(join(rootDir, "instructions", "WRITING.md"));
    expect(globalAgents).toContain("Target tool: cursor.");

    const globalOverride = await readFile(
      join(home, ".cursor", "AGENTS.override.md"),
      "utf8"
    );
    expect(globalOverride).toContain("Override for cursor.");

    const toolConfig = await readFile(
      join(home, ".cursor", "config.toml"),
      "utf8"
    );
    expect(toolConfig).toContain('approval_policy = "never"');

    const rule = await readFile(
      join(home, ".cursor", "rules", "default.rules"),
      "utf8"
    );
    expect(rule).toContain('pattern = ["gh"]');

    await Bun.write(
      join(rootDir, "AGENTS.global.md"),
      `Updated for ${placeholder("TARGET_TOOL")}.\nRead ${REFS_WRITING_RULE} again.\n`
    );
    await Bun.write(
      join(rootDir, "AGENTS.override.global.md"),
      `Updated override for ${placeholder("TARGET_TOOL")}.\n`
    );
    await Bun.write(
      join(rootDir, "tools", "cursor", "rules", "default.rules"),
      'prefix_rule(pattern = ["gh", "git"], decision = "prompt")\n'
    );
    await Bun.write(
      join(rootDir, "tools", "cursor", "config.toml"),
      'approval_policy = "trusted-only"\n'
    );

    await syncManagedTools({ homeDir: home, rootDir, tool: "cursor" });

    const updatedGlobalAgents = await readFile(
      join(home, ".cursor", "AGENTS.md"),
      "utf8"
    );
    expect(updatedGlobalAgents).toContain("Updated for cursor.");

    const updatedOverride = await readFile(
      join(home, ".cursor", "AGENTS.override.md"),
      "utf8"
    );
    expect(updatedOverride).toContain("Updated override for cursor.");

    const updatedConfig = await readFile(
      join(home, ".cursor", "config.toml"),
      "utf8"
    );
    expect(updatedConfig).toContain('approval_policy = "trusted-only"');

    const updatedRule = await readFile(
      join(home, ".cursor", "rules", "default.rules"),
      "utf8"
    );
    expect(updatedRule).toContain('"git"');
  });
});

describe("manage/unmanage", () => {
  it("adopts existing tool-native skills into the canonical store when requested during managed-mode entry", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    const toolSkills = join(home, ".codex", "skills");
    await mkdir(join(toolSkills, "legacy-skill"), { recursive: true });
    await Bun.write(
      join(toolSkills, "legacy-skill", "SKILL.md"),
      [
        "---",
        "description: Legacy skill carried over from the live Codex install.",
        "tags: [legacy]",
        "---",
        "",
        "# Legacy Skill",
      ].join("\n")
    );
    await mkdir(join(toolSkills, ".system"), { recursive: true });
    await Bun.write(
      join(toolSkills, ".system", ".codex-system-skills.marker"),
      ""
    );

    await manageTool("codex", {
      homeDir: home,
      rootDir,
      adoptExisting: true,
    });

    const adoptedSkillPath = join(
      rootDir,
      "skills",
      "legacy-skill",
      "SKILL.md"
    );
    const adoptedSkill = await readFile(adoptedSkillPath, "utf8");
    expect(adoptedSkill).toContain("Legacy skill carried over");

    const liveLinkPath = join(toolSkills, "legacy-skill");
    const liveLinkStat = await lstat(liveLinkPath);
    expect(liveLinkStat.isSymbolicLink()).toBe(true);
    expect(await readlink(liveLinkPath)).toBe(
      join(rootDir, "skills", "legacy-skill")
    );

    const indexRaw = await readFile(
      join(home, ".ai", ".facult", "ai", "index.json"),
      "utf8"
    );
    const index = JSON.parse(indexRaw) as {
      skills: Record<string, { path: string }>;
    };
    expect(index.skills["legacy-skill"]?.path).toBe(
      join(rootDir, "skills", "legacy-skill")
    );

    const preservedSystemMarker = await readFile(
      join(toolSkills, ".system", ".codex-system-skills.marker"),
      "utf8"
    );
    expect(preservedSystemMarker).toBe("");
  });

  it("requires preflight adoption review before managing when live skills already exist", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    const toolSkills = join(home, ".codex", "skills");
    await mkdir(join(toolSkills, "legacy-skill"), { recursive: true });
    await Bun.write(
      join(toolSkills, "legacy-skill", "SKILL.md"),
      "# Legacy Skill\n"
    );

    await expect(
      manageTool("codex", {
        homeDir: home,
        rootDir,
      })
    ).rejects.toThrow("must be reviewed before entering managed mode");

    const managed = await loadManagedState(home, rootDir);
    expect(managed.tools.codex).toBeUndefined();
  });

  it("requires explicit conflict policy when adopting existing conflicting skills", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "skills", "shared-skill"), { recursive: true });
    await Bun.write(
      join(rootDir, "skills", "shared-skill", "SKILL.md"),
      "# Canonical Skill\n"
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    const toolSkills = join(home, ".codex", "skills");
    await mkdir(join(toolSkills, "shared-skill"), { recursive: true });
    await Bun.write(
      join(toolSkills, "shared-skill", "SKILL.md"),
      "# Live Skill\n"
    );

    await expect(
      manageTool("codex", {
        homeDir: home,
        rootDir,
        adoptExisting: true,
      })
    ).rejects.toThrow(
      'Rerun with "--existing-conflicts keep-canonical" or "--existing-conflicts keep-existing"'
    );

    await manageTool("codex", {
      homeDir: home,
      rootDir,
      adoptExisting: true,
      existingConflictMode: "keep-existing",
    });

    const canonical = await readFile(
      join(rootDir, "skills", "shared-skill", "SKILL.md"),
      "utf8"
    );
    expect(canonical).toBe("# Live Skill\n");
  });

  it("adopts existing managed content across skills, agents, docs, rules, config, and mcp", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    await mkdir(join(home, ".codex"), { recursive: true });

    await mkdir(join(home, ".codex", "skills", "legacy-skill"), {
      recursive: true,
    });
    await Bun.write(
      join(home, ".codex", "skills", "legacy-skill", "SKILL.md"),
      "# Legacy Skill\n"
    );

    await mkdir(join(home, ".codex", "agents"), { recursive: true });
    await Bun.write(
      join(home, ".codex", "agents", "legacy-agent.toml"),
      'name = "legacy-agent"\n'
    );

    await Bun.write(join(home, ".codex", "AGENTS.md"), "# Legacy Global\n");
    await mkdir(join(home, ".codex", "rules"), { recursive: true });
    await Bun.write(
      join(home, ".codex", "rules", "default.rules"),
      'prefix_rule(pattern = ["gh"], decision = "prompt")\n'
    );
    await Bun.write(
      join(home, ".codex", "config.toml"),
      'approval_policy = "never"\n'
    );
    await writeJson(join(home, ".codex", "mcp.json"), {
      mcpServers: {
        github: { command: "node", args: ["server.js"] },
      },
    });

    await manageTool("codex", {
      homeDir: home,
      rootDir,
      adoptExisting: true,
      existingConflictMode: "keep-existing",
    });

    expect(
      await readFile(
        join(rootDir, "skills", "legacy-skill", "SKILL.md"),
        "utf8"
      )
    ).toBe("# Legacy Skill\n");
    expect(
      await readFile(
        join(rootDir, "agents", "legacy-agent", "agent.toml"),
        "utf8"
      )
    ).toContain('name = "legacy-agent"');
    expect(await readFile(join(rootDir, "AGENTS.global.md"), "utf8")).toBe(
      "# Legacy Global\n"
    );
    expect(
      await readFile(
        join(rootDir, "tools", "codex", "rules", "default.rules"),
        "utf8"
      )
    ).toContain('pattern = ["gh"]');
    expect(
      await readFile(join(rootDir, "tools", "codex", "config.toml"), "utf8")
    ).toContain('approval_policy = "never"');

    const canonicalMcp = JSON.parse(
      await readFile(join(rootDir, "mcp", "servers.json"), "utf8")
    ) as {
      servers: Record<string, { command: string }>;
    };
    expect(canonicalMcp.servers.github?.command).toBe("node");
  });

  it("requires preflight review for existing non-skill managed content", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    await mkdir(join(home, ".codex"), { recursive: true });

    await Bun.write(join(home, ".codex", "AGENTS.md"), "# Legacy Global\n");

    await expect(
      manageTool("codex", {
        homeDir: home,
        rootDir,
      })
    ).rejects.toThrow("must be reviewed before entering managed mode");
  });

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

    const indexPath = join(home, ".ai", ".facult", "ai", "index.json");

    await writeJson(indexPath, {
      skills: {
        alpha: {
          name: "alpha",
          path: skill,
          enabledFor: ["codex"],
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
      adoptExisting: true,
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

    await manageTool("codex", {
      homeDir: home,
      rootDir,
      adoptExisting: true,
      existingConflictMode: "keep-canonical",
    });

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
    expect(legacyRuleExists).toBe(true);

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
  it("preserves hidden tool-owned skill entries during sync planning", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "skills", "alpha"), { recursive: true });
    await Bun.write(join(rootDir, "skills", "alpha", "SKILL.md"), "# Alpha\n");
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    const codexSkillsDir = join(home, ".codex", "skills");
    await mkdir(join(codexSkillsDir, ".system"), { recursive: true });
    await Bun.write(
      join(codexSkillsDir, ".system", ".codex-system-skills.marker"),
      ""
    );

    await saveManagedState(
      {
        version: 1,
        tools: {
          codex: {
            tool: "codex",
            managedAt: "2026-03-19T00:13:23.457Z",
            skillsDir: codexSkillsDir,
          },
        },
      },
      home,
      rootDir
    );

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      await syncManagedTools({
        homeDir: home,
        rootDir,
        tool: "codex",
        dryRun: true,
      });
    } finally {
      console.log = originalLog;
    }

    expect(
      logs.some((line) => line.includes("would remove skill .system"))
    ).toBe(false);
  });

  it("manages project-local codex artifacts from a repo-local .ai root", async () => {
    const home = await createTempDir();
    const projectRoot = join(home, "work", "repo");
    const rootDir = join(projectRoot, ".ai");

    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[refs]\nwriting_rule = "@project/instructions/WRITING.md"\n'
    );
    await Bun.write(
      join(rootDir, "instructions", "WRITING.md"),
      "Project-specific writing guidance.\n"
    );
    await mkdir(join(rootDir, "agents", "alpha"), { recursive: true });
    await Bun.write(
      join(rootDir, "agents", "alpha", "agent.toml"),
      `name = "alpha"\n\ndeveloper_instructions = """\nRead \${refs.writing_rule}.\nTarget tool: \${TARGET_TOOL}.\n"""\n`
    );
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    await manageTool("codex", { homeDir: home, rootDir });

    const rendered = await readFile(
      join(projectRoot, ".codex", "agents", "alpha.toml"),
      "utf8"
    );
    expect(rendered).toContain(join(rootDir, "instructions", "WRITING.md"));
    expect(rendered).toContain("Target tool: codex.");

    const managedRaw = await readFile(
      join(projectRoot, ".ai", ".facult", "managed.json"),
      "utf8"
    );
    expect(JSON.parse(managedRaw).tools.codex.agentsDir).toBe(
      join(projectRoot, ".codex", "agents")
    );
  });

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

    const globalAgents = await readFile(
      join(home, ".codex", "AGENTS.md"),
      "utf8"
    );
    expect(globalAgents).toContain(
      join(facultBuiltinPackRoot(), "instructions", "EVOLUTION.md")
    );

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

  it("adopts backed-up managed skills back into the canonical store during sync repair", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    const backupSkillsDir = join(home, ".codex", "skills.bak");
    await mkdir(join(backupSkillsDir, "legacy-skill"), { recursive: true });
    await Bun.write(
      join(backupSkillsDir, "legacy-skill", "SKILL.md"),
      [
        "---",
        "description: Skill rescued from managed backup.",
        "tags: [legacy]",
        "---",
        "",
        "# Legacy Skill",
      ].join("\n")
    );

    await mkdir(join(home, ".codex", "skills"), { recursive: true });

    await saveManagedState(
      {
        version: 1,
        tools: {
          codex: {
            tool: "codex",
            managedAt: "2026-02-21T18:27:27.874Z",
            skillsDir: join(home, ".codex", "skills"),
            skillsBackup: backupSkillsDir,
          },
        },
      },
      home
    );

    await syncManagedTools({ homeDir: home, rootDir, tool: "codex" });

    const adoptedSkill = await readFile(
      join(rootDir, "skills", "legacy-skill", "SKILL.md"),
      "utf8"
    );
    expect(adoptedSkill).toContain("managed backup");

    const liveLinkPath = join(home, ".codex", "skills", "legacy-skill");
    const liveLinkStat = await lstat(liveLinkPath);
    expect(liveLinkStat.isSymbolicLink()).toBe(true);
    expect(await readlink(liveLinkPath)).toBe(
      join(rootDir, "skills", "legacy-skill")
    );
  });

  it("adopts backed-up managed agents, docs, rules, config, and mcp during sync repair", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");
    await mkdir(rootDir, { recursive: true });

    const backupAgentsDir = join(home, ".codex", "agents.bak");
    await mkdir(backupAgentsDir, { recursive: true });
    await Bun.write(
      join(backupAgentsDir, "legacy-agent.toml"),
      'name = "legacy-agent"\n'
    );

    const backupGlobalAgents = join(home, ".codex", "AGENTS.md.bak");
    await mkdir(join(home, ".codex"), { recursive: true });
    await Bun.write(backupGlobalAgents, "# Legacy Global\n");

    const backupRulesDir = join(home, ".codex", "rules.bak");
    await mkdir(backupRulesDir, { recursive: true });
    await Bun.write(
      join(backupRulesDir, "default.rules"),
      'prefix_rule(pattern = ["gh"], decision = "prompt")\n'
    );

    const backupToolConfig = join(home, ".codex", "config.toml.bak");
    await Bun.write(backupToolConfig, 'approval_policy = "never"\n');

    const backupMcp = join(home, ".codex", "mcp.json.bak");
    await writeJson(backupMcp, {
      mcpServers: {
        github: { command: "node", args: ["server.js"] },
      },
    });

    await mkdir(join(home, ".codex", "agents"), { recursive: true });
    await mkdir(join(home, ".codex", "rules"), { recursive: true });

    await saveManagedState(
      {
        version: 1,
        tools: {
          codex: {
            tool: "codex",
            managedAt: "2026-02-21T18:27:27.874Z",
            agentsDir: join(home, ".codex", "agents"),
            agentsBackup: backupAgentsDir,
            toolHome: join(home, ".codex"),
            globalAgentsPath: join(home, ".codex", "AGENTS.md"),
            globalAgentsBackup: backupGlobalAgents,
            rulesDir: join(home, ".codex", "rules"),
            rulesBackup: backupRulesDir,
            toolConfig: join(home, ".codex", "config.toml"),
            toolConfigBackup: backupToolConfig,
            mcpConfig: join(home, ".codex", "mcp.json"),
            mcpBackup: backupMcp,
          },
        },
      },
      home
    );

    await syncManagedTools({ homeDir: home, rootDir, tool: "codex" });

    expect(
      await readFile(
        join(rootDir, "agents", "legacy-agent", "agent.toml"),
        "utf8"
      )
    ).toContain('name = "legacy-agent"');
    expect(await readFile(join(rootDir, "AGENTS.global.md"), "utf8")).toBe(
      "# Legacy Global\n"
    );
    expect(
      await readFile(
        join(rootDir, "tools", "codex", "rules", "default.rules"),
        "utf8"
      )
    ).toContain('pattern = ["gh"]');
    expect(
      await readFile(join(rootDir, "tools", "codex", "config.toml"), "utf8")
    ).toContain('approval_policy = "never"');

    const canonicalMcp = JSON.parse(
      await readFile(join(rootDir, "mcp", "servers.json"), "utf8")
    ) as {
      servers: Record<string, { command: string }>;
    };
    expect(canonicalMcp.servers.github?.command).toBe("node");

    expect(
      await readFile(
        join(home, ".codex", "agents", "legacy-agent.toml"),
        "utf8"
      )
    ).toContain('name = "legacy-agent"');
    expect(await readFile(join(home, ".codex", "AGENTS.md"), "utf8")).toBe(
      "# Legacy Global\n"
    );
  });
});
