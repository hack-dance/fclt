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
