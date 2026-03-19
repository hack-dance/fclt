import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { FacultIndex, SkillEntry } from "./index-builder";
import { facultAiIndexPath } from "./paths";
import {
  filterInstructions,
  filterSkills,
  findCapabilities,
  loadIndex,
} from "./query";

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

function trustChecksum(payload: Record<string, unknown>): string {
  function sortValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((v) => sortValue(v));
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  const stable = JSON.stringify(sortValue(payload));
  return createHash("sha256").update(stable).digest("hex");
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

    const rootDir = join(tempHome, "agents", ".facult");
    await mkdir(rootDir, { recursive: true });

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
      instructions: {},
    };

    await Bun.write(facultAiIndexPath(tempHome), JSON.stringify(index));

    const loaded = await loadIndex({ rootDir, homeDir: tempHome });
    expect(Object.keys(loaded.skills)).toEqual(["alpha", "beta"]);

    expect(
      filterSkills(loaded.skills, { enabledFor: "cursor" }).map((s) => s.name)
    ).toEqual(["alpha", "beta"]);
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

  it("applies checksum-verified org trust list with local override precedence", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, "agents", ".facult");
    await mkdir(rootDir, { recursive: true });

    const index: FacultIndex = {
      version: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        alpha: {
          name: "alpha",
          path: "/tmp/alpha",
          description: "Alpha skill",
          tags: [],
        } as SkillEntry,
        beta: {
          name: "beta",
          path: "/tmp/beta",
          description: "Beta skill",
          tags: [],
          trusted: false,
          trustedBy: "user",
        } as SkillEntry & { trusted?: boolean; trustedBy?: string },
      },
      mcp: {
        servers: {
          github: {
            name: "github",
            path: "/tmp/mcp.json",
            definition: { command: "node" },
          },
        },
      },
      agents: {},
      snippets: {},
      instructions: {},
    };

    await Bun.write(facultAiIndexPath(tempHome), JSON.stringify(index));

    const trustPayload = {
      version: 1,
      issuer: "acme-sec",
      generatedAt: "2026-02-21T10:00:00.000Z",
      skills: ["alpha", "beta"],
      mcp: ["github"],
    };
    const orgTrust = {
      ...trustPayload,
      checksum: `sha256:${trustChecksum(trustPayload)}`,
    };

    const trustDir = join(tempHome, ".facult", "trust");
    await mkdir(trustDir, { recursive: true });
    await Bun.write(
      join(trustDir, "org-list.json"),
      `${JSON.stringify(orgTrust, null, 2)}\n`
    );

    const loaded = await loadIndex({ rootDir, homeDir: tempHome });
    const alpha = loaded.skills.alpha as SkillEntry & {
      trusted?: boolean;
      trustedBy?: string;
      trustedAt?: string;
    };
    const beta = loaded.skills.beta as SkillEntry & {
      trusted?: boolean;
      trustedBy?: string;
    };
    const github = loaded.mcp.servers.github as {
      trusted?: boolean;
      trustedBy?: string;
    };

    expect(alpha.trusted).toBe(true);
    expect(alpha.trustedBy).toBe("org:acme-sec");
    expect(alpha.trustedAt).toBe("2026-02-21T10:00:00.000Z");

    // Local explicit untrust remains authoritative.
    expect(beta.trusted).toBe(false);
    expect(beta.trustedBy).toBe("user");

    expect(github.trusted).toBe(true);
    expect(github.trustedBy).toBe("org:acme-sec");
  });

  it("ignores org trust list when checksum is invalid", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, "agents", ".facult");
    await mkdir(rootDir, { recursive: true });

    const index: FacultIndex = {
      version: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        alpha: {
          name: "alpha",
          path: "/tmp/alpha",
          description: "Alpha skill",
          tags: [],
        } as SkillEntry,
      },
      mcp: { servers: {} },
      agents: {},
      snippets: {},
      instructions: {},
    };
    await Bun.write(facultAiIndexPath(tempHome), JSON.stringify(index));

    const trustDir = join(tempHome, ".facult", "trust");
    await mkdir(trustDir, { recursive: true });
    await Bun.write(
      join(trustDir, "org-list.json"),
      JSON.stringify(
        {
          version: 1,
          issuer: "acme-sec",
          skills: ["alpha"],
          mcp: [],
          checksum: "sha256:deadbeef",
        },
        null,
        2
      )
    );

    const loaded = await loadIndex({ rootDir, homeDir: tempHome });
    const alpha = loaded.skills.alpha as SkillEntry & { trusted?: boolean };
    expect(alpha.trusted).toBeUndefined();
  });

  it("repairs a legacy root index into generated ai state on read", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, "agents", ".facult");
    await mkdir(rootDir, { recursive: true });

    const legacyIndex: FacultIndex = {
      version: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        alpha: {
          name: "alpha",
          path: "/tmp/alpha",
          description: "Alpha skill",
          tags: [],
        } as SkillEntry,
      },
      mcp: { servers: {} },
      agents: {},
      snippets: {},
      instructions: {},
    };

    await Bun.write(join(rootDir, "index.json"), JSON.stringify(legacyIndex));
    const loaded = await loadIndex({ rootDir, homeDir: tempHome });
    expect(Object.keys(loaded.skills)).toEqual(["alpha"]);

    const repaired = JSON.parse(
      await Bun.file(facultAiIndexPath(tempHome)).text()
    ) as FacultIndex;
    expect(Object.keys(repaired.skills)).toEqual(["alpha"]);
  });

  it("filters instructions and finds capabilities across asset types", () => {
    const index: FacultIndex = {
      version: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        "feedback-loop-setup": {
          name: "feedback-loop-setup",
          path: "/tmp/skill",
          description: "Set up short feedback loops",
          tags: ["feedback"],
          sourceKind: "global",
          scope: "global",
        },
      },
      mcp: { servers: {} },
      agents: {
        "feedback-loop-designer": {
          name: "feedback-loop-designer",
          path: "/tmp/agent.toml",
          description: "Design tighter feedback loops",
          sourceKind: "project",
          scope: "project",
        },
      },
      snippets: {
        "global/core/verification.md": {
          name: "global/core/verification.md",
          path: "/tmp/snippet.md",
          description: "Verification loop snippet",
          tags: ["verification"],
          sourceKind: "builtin",
          scope: "global",
        },
      },
      instructions: {
        FEEDBACK_LOOPS: {
          name: "FEEDBACK_LOOPS",
          path: "/tmp/FEEDBACK_LOOPS.md",
          description: "Feedback loops doctrine",
          tags: ["feedback", "loops"],
          sourceKind: "project",
          scope: "project",
        },
      },
    };

    expect(
      filterInstructions(index.instructions, { text: "feedback" }).map(
        (entry) => entry.name
      )
    ).toEqual(["FEEDBACK_LOOPS"]);

    expect(
      findCapabilities(index, { text: "feedback" }).map(
        (entry) => `${entry.kind}:${entry.name}`
      )
    ).toEqual([
      "agents:feedback-loop-designer",
      "instructions:FEEDBACK_LOOPS",
      "skills:feedback-loop-setup",
    ]);

    expect(
      findCapabilities(index, {
        text: "feedback",
        sourceKind: "project",
      }).map((entry) => `${entry.kind}:${entry.name}`)
    ).toEqual(["agents:feedback-loop-designer", "instructions:FEEDBACK_LOOPS"]);

    expect(
      findCapabilities(index, {
        text: "feedback",
        scope: "project",
      }).map((entry) => `${entry.kind}:${entry.name}`)
    ).toEqual(["agents:feedback-loop-designer", "instructions:FEEDBACK_LOOPS"]);
  });
});
