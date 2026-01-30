import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { FacultIndex, SkillEntry } from "./index-builder";
import { filterSkills, loadIndex } from "./query";

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

describe("query filters", () => {
  it("filters skills by enabledFor, untrusted, flagged, and text", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const tbRoot = join(tempHome, "agents", ".tb");
    await mkdir(tbRoot, { recursive: true });

    const skills: Record<string, SkillEntry> = {
      alpha: {
        name: "alpha",
        path: "/tmp/alpha",
        description: "Alpha skill",
        tags: ["core"],
        enabledFor: ["cursor"],
        trusted: true,
        auditStatus: "flagged",
      } as SkillEntry & {
        enabledFor?: string[];
        trusted?: boolean;
        auditStatus?: string;
      },
      beta: {
        name: "beta",
        path: "/tmp/beta",
        description: "Beta skill",
        tags: ["misc"],
        trusted: false,
      } as SkillEntry & { trusted?: boolean },
    };

    const index: FacultIndex = {
      version: 1,
      updatedAt: new Date().toISOString(),
      skills,
      mcp: { servers: {} },
      agents: {},
      snippets: {},
    };

    await Bun.write(join(tbRoot, "index.json"), JSON.stringify(index));

    const loaded = await loadIndex({ rootDir: tbRoot });
    expect(Object.keys(loaded.skills)).toEqual(["alpha", "beta"]);

    expect(filterSkills(loaded.skills, { enabledFor: "cursor" })).toHaveLength(
      1
    );
    expect(
      filterSkills(loaded.skills, { untrusted: true }).map((s) => s.name)
    ).toEqual(["beta"]);
    expect(
      filterSkills(loaded.skills, { flagged: true }).map((s) => s.name)
    ).toEqual(["alpha"]);
    expect(
      filterSkills(loaded.skills, { text: "alpha" }).map((s) => s.name)
    ).toEqual(["alpha"]);
  });
});
