import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { FacultIndex } from "./index-builder";
import { facultAiIndexPath } from "./paths";
import { applyTrust } from "./trust";

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

describe("trust/untrust", () => {
  it("marks skills and MCP servers as trusted/untrusted in index.json", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, "agents", ".facult");
    await mkdir(join(rootDir, "skills", "alpha"), { recursive: true });
    await mkdir(join(rootDir, "mcp"), { recursive: true });

    const index: FacultIndex = {
      version: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        alpha: {
          name: "alpha",
          path: join(rootDir, "skills", "alpha"),
          description: "Alpha",
          tags: [],
          auditStatus: "pending",
          trusted: false,
        },
      },
      mcp: {
        servers: {
          test: {
            name: "test",
            path: join(rootDir, "mcp", "mcp.json"),
            definition: { command: "node" },
            auditStatus: "pending",
            trusted: false,
          },
        },
      },
      agents: {},
      snippets: {},
      instructions: {},
    };

    await Bun.write(
      facultAiIndexPath(tempHome),
      JSON.stringify(index, null, 2)
    );

    await applyTrust({
      names: ["alpha", "mcp:test"],
      mode: "trust",
      homeDir: tempHome,
    });

    const trusted = JSON.parse(
      await Bun.file(facultAiIndexPath(tempHome)).text()
    ) as FacultIndex;
    expect((trusted.skills.alpha as any).trusted).toBe(true);
    expect(typeof (trusted.skills.alpha as any).trustedAt).toBe("string");
    expect((trusted.mcp.servers.test as any).trusted).toBe(true);

    await applyTrust({
      names: ["alpha", "mcp:test"],
      mode: "untrust",
      homeDir: tempHome,
    });

    const untrusted = JSON.parse(
      await Bun.file(facultAiIndexPath(tempHome)).text()
    ) as FacultIndex;
    expect((untrusted.skills.alpha as any).trusted).toBe(false);
    expect((untrusted.skills.alpha as any).trustedAt).toBeUndefined();
    expect((untrusted.mcp.servers.test as any).trusted).toBe(false);
  });
});
