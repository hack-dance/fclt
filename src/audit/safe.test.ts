import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { facultStateDir } from "../paths";
import type { AgentAuditReport } from "./agent";
import { persistAuditReport } from "./report-persistence";
import { auditSafeCommand, runAuditSafe } from "./safe";
import {
  AuditSourceTracker,
  captureAuditSourceSnapshot,
} from "./source-provenance";
import { loadAuditSuppressions } from "./suppressions";
import type { StaticAuditReport } from "./types";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_FACULT_ROOT_DIR = process.env.FACULT_ROOT_DIR;
const ORIGINAL_FACULT_ROOT_SCOPE = process.env.FACULT_ROOT_SCOPE;
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
  suppressionStorePath?: string;
}): Promise<string[]> {
  const reportRoot = join(
    tmpdir(),
    `fclt-audit-safe-reports-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  await mkdir(reportRoot);
  const paths: string[] = [];
  const suppressionStorePath =
    args.suppressionStorePath ??
    join(facultStateDir(args.homeDir), "audit", "suppressions.json");
  const tracker = new AuditSourceTracker();
  await tracker.protect([args.homeDir]);
  await tracker.capture(suppressionStorePath);
  const sourceSnapshot = tracker.snapshot();
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
  if (ORIGINAL_FACULT_ROOT_DIR === undefined) {
    Reflect.deleteProperty(process.env, "FACULT_ROOT_DIR");
  } else {
    process.env.FACULT_ROOT_DIR = ORIGINAL_FACULT_ROOT_DIR;
  }
  if (ORIGINAL_FACULT_ROOT_SCOPE === undefined) {
    Reflect.deleteProperty(process.env, "FACULT_ROOT_SCOPE");
  } else {
    process.env.FACULT_ROOT_SCOPE = ORIGINAL_FACULT_ROOT_SCOPE;
  }
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
    await chmod(missingReceiptPath, 0o600);
    await expect(
      runAuditSafe({
        argv: ["--all", "--report", missingReceiptPath, "--yes"],
        homeDir: tempHome,
      })
    ).rejects.toThrow("schema or revision is unsupported");
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

  it("writes suppressions to the exact scoped store bound by the report", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const projectRoot = join(tempHome, "project", ".ai");
    const defaultStorePath = join(
      tempHome,
      ".ai",
      ".facult",
      "audit",
      "suppressions.json"
    );
    await mkdir(projectRoot, { recursive: true });
    process.env.FACULT_ROOT_DIR = projectRoot;
    process.env.FACULT_ROOT_SCOPE = "project";
    const scopedStorePath = join(
      facultStateDir(tempHome, projectRoot),
      "audit",
      "suppressions.json"
    );
    const [reportPath] = await writeExactReports({
      homeDir: tempHome,
      suppressionStorePath: scopedStorePath,
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

    process.env.FACULT_ROOT_DIR = join(tempHome, "other", ".ai");
    process.env.FACULT_ROOT_SCOPE = "global";
    await expect(
      runAuditSafe({
        argv: ["alpha", "--report", reportPath!, "--yes"],
        homeDir: tempHome,
      })
    ).rejects.toThrow("does not match the active audit scope");
    expect(
      await loadAuditSuppressions(
        tempHome,
        undefined,
        undefined,
        undefined,
        scopedStorePath
      )
    ).toHaveLength(0);

    process.env.FACULT_ROOT_DIR = projectRoot;
    process.env.FACULT_ROOT_SCOPE = "project";
    const result = await runAuditSafe({
      argv: ["alpha", "--report", reportPath!, "--yes"],
      homeDir: tempHome,
    });

    expect(result.added).toBe(1);
    expect(
      await loadAuditSuppressions(
        tempHome,
        undefined,
        undefined,
        undefined,
        scopedStorePath
      )
    ).toHaveLength(1);
    expect(
      await loadAuditSuppressions(
        tempHome,
        undefined,
        undefined,
        undefined,
        defaultStorePath
      )
    ).toHaveLength(0);
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
