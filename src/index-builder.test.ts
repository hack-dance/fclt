import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  buildIndex,
  parseSkillMarkdown,
  tackleboxRootDir,
} from "./index-builder";

const ORIGINAL_HOME = process.env.HOME;
let tempHome: string | null = null;

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
});

describe("buildIndex", () => {
  it("indexes skills, mcp servers, agents, and snippets under ~/agents/.tb", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const tbRoot = tackleboxRootDir(tempHome);
    await mkdir(join(tbRoot, "skills", "my-skill"), { recursive: true });
    await Bun.write(
      join(tbRoot, "skills", "my-skill", "SKILL.md"),
      "---\ndescription: My skill\ntags: [x]\n---\n\nBody."
    );

    await mkdir(join(tbRoot, "mcp"), { recursive: true });
    await Bun.write(
      join(tbRoot, "mcp", "servers.json"),
      JSON.stringify({ servers: { "my-server": { command: "node" } } }, null, 2)
    );

    await mkdir(join(tbRoot, "agents"), { recursive: true });
    await Bun.write(join(tbRoot, "agents", "agent.json"), "{}\n");

    await mkdir(join(tbRoot, "snippets"), { recursive: true });
    await Bun.write(join(tbRoot, "snippets", "snippet.md"), "hello\n");

    const { index, outputPath } = await buildIndex({ rootDir: tbRoot });

    expect(outputPath).toBe(join(tbRoot, "index.json"));
    expect(index.version).toBe(1);
    expect(index.skills["my-skill"]?.description).toBe("My skill");
    expect(index.mcp.servers["my-server"]?.definition).toEqual({
      command: "node",
    });
    expect(index.agents["agent.json"]?.path).toBe(
      join(tbRoot, "agents", "agent.json")
    );
    expect(index.snippets["snippet.md"]?.path).toBe(
      join(tbRoot, "snippets", "snippet.md")
    );

    const written = JSON.parse(
      await Bun.file(outputPath).text()
    ) as typeof index;
    expect(written.skills["my-skill"]?.tags).toEqual(["x"]);
  });
});
