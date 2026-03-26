import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { manageTool } from "../manage";
import { facultStateDir } from "../paths";
import { runAuditFix } from "./fix";
import { runStaticAudit } from "./static";
import type { StaticAuditReport } from "./types";

const ORIGINAL_HOME = process.env.HOME;
let tempHome: string | null = null;

async function makeTempHome(): Promise<string> {
  const base = join(process.cwd(), ".tmp-tests");
  await mkdir(base, { recursive: true });
  const dir = join(
    base,
    `audit-fix-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(async () => {
  process.exitCode = undefined;
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
  }
  tempHome = null;
  process.env.HOME = ORIGINAL_HOME;
});

describe("audit fix", () => {
  it("moves inline MCP secrets into a local overlay and keeps future audits clean", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await writeJson(join(rootDir, "mcp", "servers.json"), {
      servers: {
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: "github_pat_test_1234567890",
          },
        },
      },
    });

    await manageTool("codex", { homeDir: tempHome, rootDir });

    const before = await runStaticAudit({
      argv: [],
      homeDir: tempHome,
      minSeverity: "high",
    });
    const beforeFindings = before.results.flatMap((result) =>
      result.findings.map((finding) => ({
        item: result.item,
        path: result.path,
        ruleId: finding.ruleId,
      }))
    );
    expect(
      beforeFindings.some(
        (finding) => finding.ruleId === "mcp-env-inline-secret"
      )
    ).toBe(true);

    const result = await runAuditFix({
      argv: ["mcp:github"],
      cwd: tempHome,
      homeDir: tempHome,
    });

    expect(result.fixed).toBeGreaterThan(0);
    expect(result.trackedPath).toBe(join(rootDir, "mcp", "servers.json"));
    expect(result.localPath).toBe(join(rootDir, "mcp", "servers.local.json"));

    const tracked = (await Bun.file(result.trackedPath!).json()) as {
      servers: Record<string, { env?: Record<string, string> }>;
    };
    expect(
      tracked.servers.github?.env?.GITHUB_PERSONAL_ACCESS_TOKEN
    ).toBeUndefined();

    const local = (await Bun.file(result.localPath!).json()) as {
      servers: Record<string, { env?: Record<string, string> }>;
    };
    expect(local.servers.github?.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe(
      "github_pat_test_1234567890"
    );

    const latest = (await Bun.file(
      join(facultStateDir(tempHome), "audit", "static-latest.json")
    ).json()) as StaticAuditReport;
    expect(
      latest.results.some((entry) =>
        entry.findings.some(
          (finding) => finding.ruleId === "mcp-env-inline-secret"
        )
      )
    ).toBe(false);

    const after = await runStaticAudit({
      argv: [],
      homeDir: tempHome,
      minSeverity: "high",
    });
    expect(
      after.results.some((entry) =>
        entry.findings.some(
          (finding) => finding.ruleId === "mcp-env-inline-secret"
        )
      )
    ).toBe(false);
  });
});
