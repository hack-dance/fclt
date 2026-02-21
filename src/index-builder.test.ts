import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex, parseSkillMarkdown } from "./index-builder";
import { facultRootDir } from "./paths";

const ORIGINAL_HOME = process.env.HOME;
let tempHome: string | null = null;

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
  it("indexes skills, mcp servers, agents, and snippets under the canonical root", async () => {
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

    const { index, outputPath } = await buildIndex({ rootDir });

    expect(outputPath).toBe(join(rootDir, "index.json"));
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

    const written = JSON.parse(
      await Bun.file(outputPath).text()
    ) as typeof index;
    expect(written.skills["my-skill"]?.tags).toEqual(["x"]);
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
});
