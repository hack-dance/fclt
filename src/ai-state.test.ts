import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { ensureAiGraphPath, ensureAiIndexPath } from "./ai-state";
import { buildIndex } from "./index-builder";
import { facultAiGraphPath, facultAiIndexPath } from "./paths";

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
    await rm(tempHome, { recursive: true, force: true });
  }
  tempHome = null;
  process.env.HOME = ORIGINAL_HOME;
});

describe("ai-state freshness repair", () => {
  it("rebuilds a project index when merged global assets change", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const globalRoot = join(tempHome, ".ai");
    const projectRoot = join(tempHome, "work", "repo", ".ai");
    const globalAgentDir = join(globalRoot, "agents", "global-agent");
    await mkdir(globalAgentDir, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await Bun.write(
      join(globalAgentDir, "agent.toml"),
      'description = "Global agent"\n'
    );
    await Bun.write(
      join(projectRoot, "AGENTS.global.md"),
      "Project guidance\n"
    );

    await buildIndex({ rootDir: projectRoot, homeDir: tempHome });
    const indexPath = facultAiIndexPath(tempHome, projectRoot);
    const now = Date.now();
    await utimes(indexPath, now / 1000 - 120, now / 1000 - 120);
    await Bun.write(
      join(globalAgentDir, "agent.toml"),
      'description = "Updated global agent"\n'
    );
    await utimes(join(globalAgentDir, "agent.toml"), now / 1000, now / 1000);

    const result = await ensureAiIndexPath({
      homeDir: tempHome,
      rootDir: projectRoot,
      repair: true,
    });

    expect(result).toEqual({
      path: facultAiIndexPath(tempHome, projectRoot),
      repaired: true,
      source: "rebuilt",
    });
  });

  it("rebuilds a project graph when merged global assets change", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const globalRoot = join(tempHome, ".ai");
    const projectRoot = join(tempHome, "work", "repo", ".ai");
    const globalInstructionDir = join(globalRoot, "instructions");
    await mkdir(globalInstructionDir, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await Bun.write(
      join(globalInstructionDir, "GLOBAL.md"),
      "# Global\n\nInitial global instruction.\n"
    );
    await Bun.write(
      join(projectRoot, "AGENTS.global.md"),
      "Project guidance\n"
    );

    await buildIndex({ rootDir: projectRoot, homeDir: tempHome });
    const graphPath = facultAiGraphPath(tempHome, projectRoot);
    const indexPath = facultAiIndexPath(tempHome, projectRoot);
    const now = Date.now();
    await utimes(graphPath, now / 1000 - 120, now / 1000 - 120);
    await utimes(indexPath, now / 1000 - 120, now / 1000 - 120);
    await Bun.write(
      join(globalInstructionDir, "GLOBAL.md"),
      "# Global\n\nUpdated global instruction.\n"
    );
    await utimes(
      join(globalInstructionDir, "GLOBAL.md"),
      now / 1000,
      now / 1000
    );

    const result = await ensureAiGraphPath({
      homeDir: tempHome,
      rootDir: projectRoot,
      repair: true,
    });

    expect(result).toEqual({
      path: facultAiGraphPath(tempHome, projectRoot),
      rebuilt: true,
    });
  });

  it("rebuilds the graph when AGENTS.override.global.md changes", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    await mkdir(rootDir, { recursive: true });
    await Bun.write(join(rootDir, "AGENTS.global.md"), "Global guidance\n");
    await Bun.write(
      join(rootDir, "AGENTS.override.global.md"),
      "Initial override guidance\n"
    );

    await buildIndex({ rootDir, homeDir: tempHome });
    const graphPath = facultAiGraphPath(tempHome, rootDir);
    const indexPath = facultAiIndexPath(tempHome, rootDir);
    const now = Date.now();
    await utimes(graphPath, now / 1000 - 120, now / 1000 - 120);
    await utimes(indexPath, now / 1000 - 120, now / 1000 - 120);
    await Bun.write(
      join(rootDir, "AGENTS.override.global.md"),
      "Updated override guidance\n"
    );
    await utimes(
      join(rootDir, "AGENTS.override.global.md"),
      now / 1000,
      now / 1000
    );

    const result = await ensureAiGraphPath({
      homeDir: tempHome,
      rootDir,
      repair: true,
    });

    expect(result).toEqual({
      path: facultAiGraphPath(tempHome, rootDir),
      rebuilt: true,
    });
  });

  it("rebuilds the graph when AGENTS.override.global.md is removed", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    await mkdir(rootDir, { recursive: true });
    await Bun.write(join(rootDir, "AGENTS.global.md"), "Global guidance\n");
    const overridePath = join(rootDir, "AGENTS.override.global.md");
    await Bun.write(overridePath, "Initial override guidance\n");

    await buildIndex({ rootDir, homeDir: tempHome });
    const graphPath = facultAiGraphPath(tempHome, rootDir);
    const indexPath = facultAiIndexPath(tempHome, rootDir);
    const now = Date.now();
    await utimes(graphPath, now / 1000 - 120, now / 1000 - 120);
    await utimes(indexPath, now / 1000 - 120, now / 1000 - 120);
    await rm(overridePath);

    const result = await ensureAiGraphPath({
      homeDir: tempHome,
      rootDir,
      repair: true,
    });

    expect(result).toEqual({
      path: facultAiGraphPath(tempHome, rootDir),
      rebuilt: true,
    });
  });

  it("rebuilds the graph when config.toml changes", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    await mkdir(rootDir, { recursive: true });
    await Bun.write(join(rootDir, "AGENTS.global.md"), "Global guidance\n");
    await Bun.write(
      join(rootDir, "config.toml"),
      '[refs]\npolicy = "@ai/instructions/WRITING.md"\n'
    );

    await buildIndex({ rootDir, homeDir: tempHome });
    const graphPath = facultAiGraphPath(tempHome, rootDir);
    const indexPath = facultAiIndexPath(tempHome, rootDir);
    const now = Date.now();
    await utimes(graphPath, now / 1000 - 120, now / 1000 - 120);
    await utimes(indexPath, now / 1000 - 120, now / 1000 - 120);
    await Bun.write(
      join(rootDir, "config.toml"),
      '[refs]\npolicy = "@ai/instructions/VERIFICATION.md"\n'
    );
    await utimes(join(rootDir, "config.toml"), now / 1000, now / 1000);

    const result = await ensureAiGraphPath({
      homeDir: tempHome,
      rootDir,
      repair: true,
    });

    expect(result).toEqual({
      path: facultAiGraphPath(tempHome, rootDir),
      rebuilt: true,
    });
  });

  it("rebuilds the graph when tool assets change", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    const toolDir = join(rootDir, "tools", "codex");
    const ruleDir = join(toolDir, "rules");
    await mkdir(ruleDir, { recursive: true });
    await Bun.write(join(rootDir, "AGENTS.global.md"), "Global guidance\n");
    await Bun.write(join(toolDir, "config.toml"), 'name = "Codex"\n');
    await Bun.write(join(ruleDir, "default.rules"), "Rule one\n");

    await buildIndex({ rootDir, homeDir: tempHome });
    const graphPath = facultAiGraphPath(tempHome, rootDir);
    const indexPath = facultAiIndexPath(tempHome, rootDir);
    const now = Date.now();
    await utimes(graphPath, now / 1000 - 120, now / 1000 - 120);
    await utimes(indexPath, now / 1000 - 120, now / 1000 - 120);
    await Bun.write(join(ruleDir, "default.rules"), "Rule two\n");
    await utimes(join(ruleDir, "default.rules"), now / 1000, now / 1000);

    const result = await ensureAiGraphPath({
      homeDir: tempHome,
      rootDir,
      repair: true,
    });

    expect(result).toEqual({
      path: facultAiGraphPath(tempHome, rootDir),
      rebuilt: true,
    });
  });

  it("rebuilds the generated index when an agent manifest is removed", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    const alphaDir = join(rootDir, "agents", "alpha");
    const betaDir = join(rootDir, "agents", "beta");
    await mkdir(alphaDir, { recursive: true });
    await mkdir(betaDir, { recursive: true });
    await Bun.write(join(alphaDir, "agent.toml"), 'description = "Alpha"\n');
    await Bun.write(join(betaDir, "agent.toml"), 'description = "Beta"\n');

    await buildIndex({ rootDir, homeDir: tempHome });
    const indexPath = facultAiIndexPath(tempHome, rootDir);
    const now = Date.now();
    await utimes(indexPath, now / 1000 - 120, now / 1000 - 120);
    await rm(join(betaDir, "agent.toml"));

    const result = await ensureAiIndexPath({
      homeDir: tempHome,
      rootDir,
      repair: true,
    });
    const repaired = JSON.parse(
      await Bun.file(facultAiIndexPath(tempHome, rootDir)).text()
    ) as { agents: Record<string, unknown> };

    expect(result).toEqual({
      path: facultAiIndexPath(tempHome, rootDir),
      repaired: true,
      source: "rebuilt",
    });
    expect(Object.keys(repaired.agents)).toContain("alpha");
    expect(Object.keys(repaired.agents)).not.toContain("beta");
  });
});
