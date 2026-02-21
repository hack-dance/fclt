import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { FacultIndex } from "../index-builder";
import type { AuditItemResult } from "./types";
import { updateIndexFromAuditReport } from "./update-index";

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

describe("audit index updates", () => {
  it("updates auditStatus and lastAuditAt for matching canonical items", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, "agents", ".facult");
    const skillPath = join(rootDir, "skills", "alpha");
    const mcpPath = join(rootDir, "mcp", "mcp.json");
    await mkdir(skillPath, { recursive: true });
    await mkdir(join(rootDir, "mcp"), { recursive: true });

    const index: FacultIndex = {
      version: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        alpha: {
          name: "alpha",
          path: skillPath,
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
            path: mcpPath,
            definition: { command: "node" },
            auditStatus: "pending",
            trusted: false,
          },
        },
      },
      agents: {},
      snippets: {},
    };

    await Bun.write(
      join(rootDir, "index.json"),
      JSON.stringify(index, null, 2)
    );

    const results: AuditItemResult[] = [
      {
        item: "alpha",
        type: "skill",
        path: skillPath,
        passed: false,
        findings: [
          {
            severity: "high",
            ruleId: "credential-access",
            message: "bad",
          },
        ],
      },
      {
        item: "test",
        type: "mcp",
        path: mcpPath,
        passed: true,
        findings: [],
      },
    ];

    const ts = "2026-02-08T00:00:00.000Z";
    const updated = await updateIndexFromAuditReport({
      homeDir: tempHome,
      timestamp: ts,
      results,
    });
    expect(updated.updated).toBe(true);

    const next = JSON.parse(
      await Bun.file(join(rootDir, "index.json")).text()
    ) as FacultIndex;
    expect((next.skills.alpha as any).auditStatus).toBe("flagged");
    expect((next.skills.alpha as any).lastAuditAt).toBe(ts);
    expect((next.mcp.servers.test as any).auditStatus).toBe("passed");
    expect((next.mcp.servers.test as any).lastAuditAt).toBe(ts);
  });

  it("treats agent errors as pending (not passed)", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, "agents", ".facult");
    const skillPath = join(rootDir, "skills", "alpha");
    await mkdir(skillPath, { recursive: true });

    const index: FacultIndex = {
      version: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        alpha: {
          name: "alpha",
          path: skillPath,
          description: "Alpha",
          tags: [],
          auditStatus: "pending",
          trusted: false,
        },
      },
      mcp: { servers: {} },
      agents: {},
      snippets: {},
    };

    await Bun.write(
      join(rootDir, "index.json"),
      JSON.stringify(index, null, 2)
    );

    const results: AuditItemResult[] = [
      {
        item: "alpha",
        type: "skill",
        path: skillPath,
        passed: false,
        findings: [
          {
            severity: "medium",
            ruleId: "agent-error",
            message: "oops",
          },
        ],
      },
    ];

    const ts = "2026-02-08T00:00:00.000Z";
    await updateIndexFromAuditReport({
      homeDir: tempHome,
      timestamp: ts,
      results,
    });

    const next = JSON.parse(
      await Bun.file(join(rootDir, "index.json")).text()
    ) as FacultIndex;
    expect((next.skills.alpha as any).auditStatus).toBe("pending");
  });
});
