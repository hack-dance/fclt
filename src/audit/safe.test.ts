import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { facultStateDir } from "../paths";
import type { AgentAuditReport } from "./agent";
import { auditSafeCommand, runAuditSafe } from "./safe";
import { loadAuditSuppressions } from "./suppressions";
import type { StaticAuditReport } from "./types";

const ORIGINAL_HOME = process.env.HOME;
let tempHome: string | null = null;

async function makeTempHome(): Promise<string> {
  const base = join(process.cwd(), ".tmp-tests");
  await mkdir(base, { recursive: true });
  const dir = join(
    base,
    `audit-safe-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeLatestReports(args: {
  homeDir: string;
  staticReport?: StaticAuditReport;
  agentReport?: AgentAuditReport;
}) {
  const auditDir = join(facultStateDir(args.homeDir), "audit");
  await mkdir(auditDir, { recursive: true });
  if (args.staticReport) {
    await Bun.write(
      join(auditDir, "static-latest.json"),
      `${JSON.stringify(args.staticReport, null, 2)}\n`
    );
  }
  if (args.agentReport) {
    await Bun.write(
      join(auditDir, "agent-latest.json"),
      `${JSON.stringify(args.agentReport, null, 2)}\n`
    );
  }
}

afterEach(async () => {
  process.exitCode = undefined;
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
  }
  tempHome = null;
  process.env.HOME = ORIGINAL_HOME;
});

describe("audit safe", () => {
  it("records a suppression from the latest static audit report", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    await writeLatestReports({
      homeDir: tempHome,
      staticReport: {
        timestamp: "2026-03-26T17:00:00.000Z",
        mode: "static",
        results: [
          {
            item: "alpha",
            type: "skill",
            path: "/tmp/alpha",
            passed: false,
            findings: [
              {
                severity: "high",
                ruleId: "credential-access",
                message: "Possible credential access instruction",
                location: "SKILL.md:12",
              },
            ],
          },
        ],
        summary: {
          totalItems: 1,
          totalFindings: 1,
          flaggedItems: 1,
          bySeverity: { critical: 0, high: 1, medium: 0, low: 0 },
        },
      },
    });

    const result = await runAuditSafe({
      argv: ["alpha", "--rule", "credential-access", "--note", "reviewed"],
      homeDir: tempHome,
    });

    expect(result.matched).toBe(1);
    expect(result.added).toBe(1);

    const suppressions = await loadAuditSuppressions(tempHome);
    expect(suppressions).toHaveLength(1);

    const latest = (await Bun.file(
      join(facultStateDir(tempHome), "audit", "static-latest.json")
    ).json()) as StaticAuditReport;
    expect(latest.results[0]?.findings).toHaveLength(0);
    expect(latest.results[0]?.passed).toBe(true);
  });

  it("matches combined-view rule ids against future raw reports", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    await writeLatestReports({
      homeDir: tempHome,
      staticReport: {
        timestamp: "2026-03-26T17:00:00.000Z",
        mode: "static",
        results: [
          {
            item: "alpha",
            type: "skill",
            path: "/tmp/alpha",
            passed: false,
            findings: [
              {
                severity: "high",
                ruleId: "credential-access",
                message: "Possible credential access instruction",
                location: "SKILL.md:12",
              },
            ],
          },
        ],
        summary: {
          totalItems: 1,
          totalFindings: 1,
          flaggedItems: 1,
          bySeverity: { critical: 0, high: 1, medium: 0, low: 0 },
        },
      },
      agentReport: {
        timestamp: "2026-03-26T17:00:00.000Z",
        mode: "agent",
        agent: { tool: "codex" },
        scope: { from: [], maxItems: 50 },
        results: [
          {
            item: "alpha",
            type: "skill",
            path: "/tmp/alpha",
            passed: true,
            findings: [],
          },
        ],
        summary: {
          totalItems: 1,
          totalFindings: 0,
          flaggedItems: 0,
          bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
        },
      },
    });

    const result = await runAuditSafe({
      argv: [
        "alpha",
        "--rule",
        "static:credential-access",
        "--source",
        "combined",
      ],
      homeDir: tempHome,
    });

    expect(result.source).toBe("combined");
    expect(result.matched).toBe(1);

    const latestStatic = (await Bun.file(
      join(facultStateDir(tempHome), "audit", "static-latest.json")
    ).json()) as StaticAuditReport;
    expect(latestStatic.results[0]?.findings).toHaveLength(0);
  });

  it("supports a direct non-interactive audit safe command", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    await writeLatestReports({
      homeDir: tempHome,
      staticReport: {
        timestamp: "2026-03-26T17:00:00.000Z",
        mode: "static",
        results: [
          {
            item: "alpha",
            type: "skill",
            path: "/tmp/alpha",
            passed: false,
            findings: [
              {
                severity: "medium",
                ruleId: "non-https-url",
                message: "Safe in local dev",
              },
            ],
          },
        ],
        summary: {
          totalItems: 1,
          totalFindings: 1,
          flaggedItems: 1,
          bySeverity: { critical: 0, high: 0, medium: 1, low: 0 },
        },
      },
    });

    await auditSafeCommand(["alpha", "--rule", "non-https-url"], {
      homeDir: tempHome,
    });

    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
    const suppressions = await loadAuditSuppressions(tempHome);
    expect(suppressions).toHaveLength(1);
  });
});
