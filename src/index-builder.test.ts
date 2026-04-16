import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex, parseSkillMarkdown } from "./index-builder";
import {
  facultAiGraphPath,
  facultAiIndexPath,
  facultGeneratedStateDir,
  facultMachineStateDir,
  facultRootDir,
} from "./paths";

const ORIGINAL_HOME = process.env.HOME;
let tempHome: string | null = null;
const DOLLAR = "$";

function fixturePath(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "test", "fixtures", rel);
}

async function makeTempHome(): Promise<string> {
  const base = join(process.cwd(), ".tmp-tests");
  await mkdir(base, { recursive: true });
  const dir = join(
    base,
    `home-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

afterEach(async () => {
  if (tempHome) {
    try {
      await rm(tempHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tempHome = null;
  process.env.HOME = ORIGINAL_HOME;
});

describe("parseSkillMarkdown", () => {
  it("uses frontmatter description and parses tags", () => {
    const md =
      "---\ndescription: Hello world\ntags: [one, two]\n---\n\n# Title\n\nBody.";
    expect(parseSkillMarkdown(md)).toEqual({
      description: "Hello world",
      tags: ["one", "two"],
    });
  });

  it("falls back to first paragraph when no frontmatter description", () => {
    const md =
      "# Skill\n\nThis is the first paragraph.\nStill first paragraph.\n\nSecond paragraph.";
    expect(parseSkillMarkdown(md).description).toBe(
      "This is the first paragraph. Still first paragraph."
    );
  });

  it("parses list-style tags", () => {
    const md = "---\ntags:\n  - alpha\n  - beta\n---\n\nDesc.";
    expect(parseSkillMarkdown(md).tags).toEqual(["alpha", "beta"]);
  });

  it("handles malformed frontmatter (fixture) without crashing", async () => {
    const md = await Bun.file(fixturePath("skills/malformed/SKILL.md")).text();
    const parsed = parseSkillMarkdown(md);
    expect(parsed.tags).toEqual(["also-ok", "ok"]);
    expect(parsed.description).toContain(
      "This is a malformed frontmatter example"
    );
  });
});

describe("buildIndex", () => {
  it("indexes skills, mcp servers, agents, snippets, and instructions under the canonical root", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = facultRootDir(tempHome);
    await mkdir(join(rootDir, "skills", "my-skill"), { recursive: true });
    await Bun.write(
      join(rootDir, "skills", "my-skill", "SKILL.md"),
      "---\ndescription: My skill\ntags: [x]\n---\n\nBody."
    );

    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await Bun.write(
      join(rootDir, "mcp", "servers.json"),
      JSON.stringify({ servers: { "my-server": { command: "node" } } }, null, 2)
    );

    await mkdir(join(rootDir, "agents"), { recursive: true });
    await Bun.write(join(rootDir, "agents", "agent.json"), "{}\n");

    await mkdir(join(rootDir, "snippets"), { recursive: true });
    await Bun.write(join(rootDir, "snippets", "snippet.md"), "hello\n");

    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await Bun.write(
      join(rootDir, "instructions", "FEEDBACK_LOOPS.md"),
      "---\ndescription: Feedback loop doctrine\ntags: [feedback, loops]\n---\n\nUse short loops.\n"
    );

    const { index, outputPath } = await buildIndex({ rootDir });

    expect(outputPath).toBe(facultAiIndexPath(tempHome));
    expect(index.version).toBe(1);
    expect(index.skills["my-skill"]?.description).toBe("My skill");
    expect(index.mcp.servers["my-server"]?.definition).toEqual({
      command: "node",
    });
    expect(index.agents["agent.json"]?.path).toBe(
      join(rootDir, "agents", "agent.json")
    );
    expect(index.snippets["snippet.md"]?.path).toBe(
      join(rootDir, "snippets", "snippet.md")
    );
    expect(index.instructions.FEEDBACK_LOOPS?.path).toBe(
      join(rootDir, "instructions", "FEEDBACK_LOOPS.md")
    );
    expect(index.instructions.FEEDBACK_LOOPS?.description).toBe(
      "Feedback loop doctrine"
    );
    expect(index.instructions.FEEDBACK_LOOPS?.tags).toEqual([
      "feedback",
      "loops",
    ]);

    const written = JSON.parse(
      await Bun.file(outputPath).text()
    ) as typeof index;
    expect(written.skills["my-skill"]?.tags).toEqual(["x"]);
    expect(written.instructions.FEEDBACK_LOOPS?.tags).toEqual([
      "feedback",
      "loops",
    ]);
  });

  it("indexes canonical automations into the graph and resolves their refs", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = facultRootDir(tempHome);
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await Bun.write(
      join(rootDir, "instructions", "FEEDBACK_LOOPS.md"),
      "---\ndescription: Feedback loop doctrine\ntags: [feedback]\n---\n\nUse short loops.\n"
    );

    await mkdir(join(rootDir, "automations", "learning-review"), {
      recursive: true,
    });
    await Bun.write(
      join(rootDir, "automations", "learning-review", "automation.toml"),
      [
        'name = "Learning Review"',
        'prompt = "Read @ai/instructions/FEEDBACK_LOOPS.md before reviewing."',
      ].join("\n")
    );

    const { index, graph, graphPath } = await buildIndex({ rootDir });

    expect(index.automations?.["learning-review"]?.path).toBe(
      join(rootDir, "automations", "learning-review", "automation.toml")
    );

    const nodeId = "automation:global:global:learning-review";
    expect(graph.nodes[nodeId]).toEqual(
      expect.objectContaining({
        id: nodeId,
        kind: "automation",
        canonicalRef: "@ai/automations/learning-review/automation.toml",
      })
    );
    expect(graph.edges).toContainEqual({
      from: nodeId,
      to: "instruction:global:global:FEEDBACK_LOOPS",
      kind: "canonical_ref",
      locator: "@ai/instructions/FEEDBACK_LOOPS.md",
    });

    const writtenGraph = JSON.parse(
      await Bun.file(graphPath).text()
    ) as typeof graph;
    expect(writtenGraph.nodes[nodeId]?.kind).toBe("automation");
  });

  it("preserves enabledFor/trust/audit metadata when rebuilding an existing index", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = facultRootDir(tempHome);
    await mkdir(join(rootDir, "skills", "my-skill"), { recursive: true });
    await Bun.write(
      join(rootDir, "skills", "my-skill", "SKILL.md"),
      "---\ndescription: My skill\ntags: [x]\n---\n\nBody."
    );

    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await Bun.write(
      join(rootDir, "mcp", "servers.json"),
      JSON.stringify({ servers: { "my-server": { command: "node" } } }, null, 2)
    );

    const first = await buildIndex({ rootDir });
    const parsed = JSON.parse(await Bun.file(first.outputPath).text()) as any;
    parsed.skills["my-skill"].enabledFor = ["cursor"];
    parsed.skills["my-skill"].trusted = true;
    parsed.skills["my-skill"].trustedAt = "2026-02-08T00:00:00.000Z";
    parsed.skills["my-skill"].trustedBy = "user";
    parsed.skills["my-skill"].auditStatus = "flagged";
    parsed.skills["my-skill"].lastAuditAt = "2026-02-08T00:00:00.000Z";
    parsed.mcp.servers["my-server"].enabledFor = ["cursor"];
    parsed.mcp.servers["my-server"].trusted = true;
    parsed.mcp.servers["my-server"].auditStatus = "passed";
    await Bun.write(first.outputPath, `${JSON.stringify(parsed, null, 2)}\n`);

    const second = await buildIndex({ rootDir });
    const rebuilt = JSON.parse(await Bun.file(second.outputPath).text()) as any;
    expect(rebuilt.skills["my-skill"].enabledFor).toEqual(["cursor"]);
    expect(rebuilt.skills["my-skill"].trusted).toBe(true);
    expect(rebuilt.skills["my-skill"].auditStatus).toBe("flagged");
    expect(rebuilt.mcp.servers["my-server"].enabledFor).toEqual(["cursor"]);
    expect(rebuilt.mcp.servers["my-server"].trusted).toBe(true);
    expect(rebuilt.mcp.servers["my-server"].auditStatus).toBe("passed");
  });

  it("preserves MCP metadata per server when multiple servers share one config file", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = facultRootDir(tempHome);
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await Bun.write(
      join(rootDir, "mcp", "servers.json"),
      JSON.stringify(
        {
          servers: {
            alpha: { command: "node", args: ["alpha"] },
            beta: { command: "node", args: ["beta"] },
          },
        },
        null,
        2
      )
    );

    const first = await buildIndex({ rootDir });
    const parsed = JSON.parse(await Bun.file(first.outputPath).text()) as any;
    parsed.mcp.servers.alpha.enabledFor = ["cursor"];
    parsed.mcp.servers.alpha.trusted = true;
    parsed.mcp.servers.alpha.auditStatus = "passed";
    parsed.mcp.servers.beta.enabledFor = ["codex"];
    parsed.mcp.servers.beta.trusted = false;
    parsed.mcp.servers.beta.auditStatus = "flagged";
    await Bun.write(first.outputPath, `${JSON.stringify(parsed, null, 2)}\n`);

    const second = await buildIndex({ rootDir });
    const rebuilt = JSON.parse(await Bun.file(second.outputPath).text()) as any;

    expect(rebuilt.mcp.servers.alpha.enabledFor).toEqual(["cursor"]);
    expect(rebuilt.mcp.servers.alpha.trusted).toBe(true);
    expect(rebuilt.mcp.servers.alpha.auditStatus).toBe("passed");
    expect(rebuilt.mcp.servers.beta.enabledFor).toEqual(["codex"]);
    expect(rebuilt.mcp.servers.beta.trusted).toBe(false);
    expect(rebuilt.mcp.servers.beta.auditStatus).toBe("flagged");
  });

  it("does not leak agent trust metadata across source layers that share a name", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const globalRoot = join(tempHome, ".ai");
    await mkdir(join(globalRoot, "agents", "shared-agent"), {
      recursive: true,
    });
    await Bun.write(
      join(globalRoot, "agents", "shared-agent", "agent.toml"),
      'description = "Global agent"\n'
    );

    const projectRoot = join(tempHome, "work", "repo");
    const rootDir = join(projectRoot, ".ai");
    await mkdir(rootDir, { recursive: true });

    const first = await buildIndex({ rootDir, homeDir: tempHome });
    const firstParsed = JSON.parse(
      await Bun.file(first.outputPath).text()
    ) as any;
    firstParsed.agents["shared-agent"].trusted = true;
    firstParsed.agents["shared-agent"].trustedAt = "2026-02-08T00:00:00.000Z";
    firstParsed.agents["shared-agent"].trustedBy = "user";
    await Bun.write(
      first.outputPath,
      `${JSON.stringify(firstParsed, null, 2)}\n`
    );

    await mkdir(join(rootDir, "agents", "shared-agent"), { recursive: true });
    await Bun.write(
      join(rootDir, "agents", "shared-agent", "agent.toml"),
      'description = "Project agent"\n'
    );

    const second = await buildIndex({ rootDir, homeDir: tempHome });
    const rebuilt = JSON.parse(await Bun.file(second.outputPath).text()) as any;

    expect(rebuilt.agents["shared-agent"].sourceKind).toBe("project");
    expect(rebuilt.agents["shared-agent"].trusted).toBe(false);
    expect(rebuilt.agents["shared-agent"].trustedAt).toBeUndefined();
    expect(rebuilt.agents["shared-agent"].trustedBy).toBeUndefined();
    expect(rebuilt.agents["shared-agent"].canonicalRef).toBe(
      "@project/agents/shared-agent/agent.toml"
    );
  });

  it("builds a project-scoped merged index and graph with builtin, global, and project provenance", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const globalRoot = join(tempHome, ".ai");
    await mkdir(join(globalRoot, "instructions"), { recursive: true });
    await Bun.write(
      join(globalRoot, "instructions", "SHARED.md"),
      "---\ndescription: Global shared instruction\ntags: [global]\n---\n\nGlobal guidance.\n"
    );

    const projectRoot = join(tempHome, "work", "repo");
    const rootDir = join(projectRoot, ".ai");
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await mkdir(join(rootDir, "snippets", "global", "core"), {
      recursive: true,
    });
    await mkdir(join(rootDir, "agents", "argument-editor"), {
      recursive: true,
    });
    await Bun.write(
      join(rootDir, "instructions", "SHARED.md"),
      "---\ndescription: Project shared instruction\ntags: [project]\n---\n\nProject guidance.\n"
    );
    await Bun.write(
      join(rootDir, "snippets", "global", "core", "checks.md"),
      "---\ndescription: Checks snippet\ntags: [checks]\n---\n\nRun the concrete checks before finishing.\n"
    );
    await Bun.write(
      join(rootDir, "agents", "argument-editor", "agent.toml"),
      [
        'name = "argument-editor"',
        'description = "Editorial reviewer."',
        "",
        'developer_instructions = """',
        "Read the project instructions before reviewing.",
        '"""',
      ].join("\n")
    );
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[refs]\nshared = "@project/instructions/SHARED.md"\n'
    );
    await Bun.write(
      join(rootDir, "AGENTS.global.md"),
      [
        "<!-- fclty:global/core/checks -->",
        "<!-- /fclty:global/core/checks -->",
        "",
        `Read ${DOLLAR}{refs.shared}.`,
      ].join("\n")
    );
    await mkdir(join(rootDir, "tools", "codex", "rules"), { recursive: true });
    await Bun.write(
      join(rootDir, "tools", "codex", "config.toml"),
      'approval_policy = "never"\n'
    );
    await Bun.write(
      join(rootDir, "tools", "codex", "rules", "default.rules"),
      'prefix_rule(pattern = ["gh"], decision = "prompt")\n'
    );
    await mkdir(facultGeneratedStateDir({ home: tempHome, rootDir }), {
      recursive: true,
    });
    await mkdir(facultMachineStateDir(tempHome, rootDir), { recursive: true });
    await Bun.write(
      join(facultMachineStateDir(tempHome, rootDir), "managed.json"),
      JSON.stringify(
        {
          version: 1,
          tools: {
            codex: {
              tool: "codex",
              managedAt: "2026-03-18T00:00:00.000Z",
              agentsDir: join(projectRoot, ".codex", "agents"),
              toolHome: join(projectRoot, ".codex"),
              globalAgentsPath: join(projectRoot, ".codex", "AGENTS.md"),
              mcpConfig: join(projectRoot, ".codex", "mcp.json"),
              rulesDir: join(projectRoot, ".codex", "rules"),
              toolConfig: join(projectRoot, ".codex", "config.toml"),
            },
          },
        },
        null,
        2
      )
    );

    const { index, outputPath, graph, graphPath } = await buildIndex({
      rootDir,
      homeDir: tempHome,
    });

    expect(outputPath).toBe(facultAiIndexPath(tempHome, rootDir));
    expect(graphPath).toBe(facultAiGraphPath(tempHome, rootDir));
    expect(index.instructions.SHARED?.path).toBe(
      join(rootDir, "instructions", "SHARED.md")
    );
    expect(index.instructions.SHARED?.sourceKind).toBe("project");
    expect(index.instructions.SHARED?.projectSlug).toBe("repo");
    expect(index.agents["argument-editor"]?.projectSlug).toBe("repo");
    expect(index.instructions.INTEGRATION?.sourceKind).toBe("builtin");
    expect(index.instructions.INTEGRATION?.path).toContain(
      join("assets", "packs", "facult-operating-model", "instructions")
    );

    const docNode = Object.values(graph.nodes).find(
      (node) =>
        node.kind === "doc" &&
        node.name === "AGENTS.global.md" &&
        node.sourceKind === "project"
    );
    expect(docNode).toBeTruthy();

    const snippetNode = Object.values(graph.nodes).find(
      (node) =>
        node.kind === "snippet" &&
        node.name === "global/core/checks.md" &&
        node.sourceKind === "project"
    );
    expect(snippetNode).toBeTruthy();

    const sharedInstructionNode = Object.values(graph.nodes).find(
      (node) =>
        node.kind === "instruction" &&
        node.name === "SHARED" &&
        node.sourceKind === "project"
    );
    expect(sharedInstructionNode).toBeTruthy();
    expect(sharedInstructionNode?.projectSlug).toBe("repo");
    expect(sharedInstructionNode?.shadow).toBe(false);

    const shadowedGlobalInstructionNode = Object.values(graph.nodes).find(
      (node) =>
        node.kind === "instruction" &&
        node.name === "SHARED" &&
        node.sourceKind === "global"
    );
    expect(shadowedGlobalInstructionNode?.shadow).toBe(true);

    const renderedAgentNode = Object.values(graph.nodes).find(
      (node) =>
        node.kind === "rendered-target" &&
        node.path ===
          join(projectRoot, ".codex", "agents", "argument-editor.toml")
    );
    expect(renderedAgentNode).toBeTruthy();
    expect(renderedAgentNode?.projectSlug).toBe("repo");
    expect(renderedAgentNode?.shadow).toBe(true);

    const renderedDocNode = Object.values(graph.nodes).find(
      (node) =>
        node.kind === "rendered-target" &&
        node.path === join(projectRoot, ".codex", "AGENTS.md")
    );
    expect(renderedDocNode).toBeTruthy();
    expect(renderedDocNode?.projectSlug).toBe("repo");
    expect(renderedDocNode?.shadow).toBe(true);

    const toolConfigNode = Object.values(graph.nodes).find(
      (node) =>
        node.kind === "tool-config" &&
        node.path === join(rootDir, "tools", "codex", "config.toml")
    );
    expect(toolConfigNode).toBeTruthy();
    expect(toolConfigNode?.projectSlug).toBe("repo");

    const toolRuleNode = Object.values(graph.nodes).find(
      (node) =>
        node.kind === "tool-rule" &&
        node.path === join(rootDir, "tools", "codex", "rules", "default.rules")
    );
    expect(toolRuleNode).toBeTruthy();
    expect(toolRuleNode?.projectSlug).toBe("repo");

    const renderedConfigNode = Object.values(graph.nodes).find(
      (node) =>
        node.kind === "rendered-target" &&
        node.path === join(projectRoot, ".codex", "config.toml")
    );
    expect(renderedConfigNode).toBeTruthy();

    const renderedRuleNode = Object.values(graph.nodes).find(
      (node) =>
        node.kind === "rendered-target" &&
        node.path === join(projectRoot, ".codex", "rules", "default.rules")
    );
    expect(renderedRuleNode).toBeTruthy();

    expect(
      graph.edges.some(
        (edge) =>
          edge.kind === "snippet_marker" &&
          edge.from === docNode?.id &&
          edge.to === snippetNode?.id
      )
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.kind === "ref_symbol" &&
          edge.from === docNode?.id &&
          edge.to === sharedInstructionNode?.id
      )
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.kind === "render_source" &&
          edge.from === "agent:project:project:argument-editor" &&
          edge.to === renderedAgentNode?.id
      )
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.kind === "render_source" &&
          edge.from === "doc:project:project:AGENTS.global.md" &&
          edge.to === renderedDocNode?.id
      )
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.kind === "render_source" &&
          edge.from === "tool-config:project:project:codex/config.toml" &&
          edge.to === renderedConfigNode?.id
      )
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.kind === "render_source" &&
          edge.from === "tool-rule:project:project:codex/rules/default.rules" &&
          edge.to === renderedRuleNode?.id
      )
    ).toBe(true);
  });
});
