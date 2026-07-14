import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAuditReport } from "./agent";
import { persistAuditReport } from "./report-persistence";
import { auditSafeCommand, runAuditSafe } from "./safe";
import { captureAuditSourceSnapshot } from "./source-provenance";
import { loadAuditSuppressions } from "./suppressions";
import type { StaticAuditReport } from "./types";

const ORIGINAL_HOME = process.env.HOME;
let tempHome: string | null = null;

async function makeTempHome(): Promise<string> {
  const base = join(tmpdir(), "fclt-audit-safe-tests");
  await mkdir(base, { recursive: true });
  const dir = join(
    base,
    `audit-safe-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeExactReports(args: {
  homeDir: string;
  staticReport?: StaticAuditReport;
  agentReport?: AgentAuditReport;
}): Promise<string[]> {
  const reportRoot = join(
    tmpdir(),
    `fclt-audit-safe-reports-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  await mkdir(reportRoot);
  const paths: string[] = [];
  const sourceSnapshot = await captureAuditSourceSnapshot({
    protectedRoots: [args.homeDir],
  });
  if (args.staticReport) {
    args.staticReport.timestamp = new Date().toISOString();
    paths.push(
      await persistAuditReport({
        auditedRoots: [args.homeDir],
        mode: "static",
        report: args.staticReport,
        reportRoot,
        sourceSnapshot,
      })
    );
  }
  if (args.agentReport) {
    args.agentReport.timestamp = new Date().toISOString();
    paths.push(
      await persistAuditReport({
        auditedRoots: [args.homeDir],
        mode: "agent",
        report: args.agentReport,
        reportRoot,
        sourceSnapshot,
      })
    );
  }
  return paths;
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
  it("rejects legacy latest, missing receipts, stale reports, and changed sources", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const legacyPath = join(
      tempHome,
      ".ai",
      ".facult",
      "audit",
      "static-latest.json"
    );
    await mkdir(join(legacyPath, ".."), { recursive: true });
    await Bun.write(legacyPath, "{}\n");
    await expect(
      runAuditSafe({ argv: ["alpha", "--yes"], homeDir: tempHome })
    ).rejects.toThrow("requires --report");

    const sourcePath = join(tempHome, ".ai", "skills", "alpha", "SKILL.md");
    await mkdir(join(sourcePath, ".."), { recursive: true });
    await Bun.write(sourcePath, "# Alpha\n");
    const reportRoot = await mkdtemp(
      join(tmpdir(), "fclt-audit-safe-invalid-")
    );
    const report: StaticAuditReport = {
      timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      mode: "static",
      results: [],
      summary: {
        totalItems: 0,
        totalFindings: 0,
        flaggedItems: 0,
        bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
      },
    };
    const stalePath = await persistAuditReport({
      auditedRoots: [sourcePath],
      mode: "static",
      report,
      reportRoot,
      sourceSnapshot: await captureAuditSourceSnapshot({
        evaluatedFiles: [sourcePath],
        protectedRoots: [sourcePath],
      }),
    });
    await expect(
      runAuditSafe({
        argv: ["--all", "--report", stalePath, "--yes"],
        homeDir: tempHome,
      })
    ).rejects.toThrow("stale");

    report.timestamp = new Date().toISOString();
    const freshPath = await persistAuditReport({
      auditedRoots: [sourcePath],
      mode: "static",
      report,
      reportRoot,
      sourceSnapshot: await captureAuditSourceSnapshot({
        evaluatedFiles: [sourcePath],
        protectedRoots: [sourcePath],
      }),
    });
    await Bun.write(sourcePath, "# Changed\n");
    await expect(
      runAuditSafe({
        argv: ["--all", "--report", freshPath, "--yes"],
        homeDir: tempHome,
      })
    ).rejects.toThrow("evaluated context changed");

    const missingReceiptPath = join(reportRoot, "static-missing.json");
    await Bun.write(missingReceiptPath, `${JSON.stringify(report)}\n`);
    await expect(
      runAuditSafe({
        argv: ["--all", "--report", missingReceiptPath, "--yes"],
        homeDir: tempHome,
      })
    ).rejects.toThrow("receipt is missing");
  });

  it("records a suppression from the latest static audit report", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const [reportPath] = await writeExactReports({
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
      argv: [
        "alpha",
        "--rule",
        "credential-access",
        "--note",
        "reviewed",
        "--report",
        reportPath!,
        "--yes",
      ],
      homeDir: tempHome,
    });

    expect(result.matched).toBe(1);
    expect(result.added).toBe(1);

    const suppressions = await loadAuditSuppressions(tempHome);
    expect(suppressions).toHaveLength(1);
  });

  it("matches combined-view rule ids against future raw reports", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const reportPaths = await writeExactReports({
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
        "--report",
        reportPaths[0]!,
        "--report",
        reportPaths[1]!,
        "--yes",
      ],
      homeDir: tempHome,
    });

    expect(result.source).toBe("combined");
    expect(result.matched).toBe(1);
  });

  it("supports a direct non-interactive audit safe command", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const [reportPath] = await writeExactReports({
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

    await auditSafeCommand(
      ["alpha", "--rule", "non-https-url", "--report", reportPath!, "--yes"],
      { homeDir: tempHome }
    );

    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
    const suppressions = await loadAuditSuppressions(tempHome);
    expect(suppressions).toHaveLength(1);
  });
});
