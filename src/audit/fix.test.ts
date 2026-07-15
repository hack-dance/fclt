import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  LEGACY_MANAGED_MUTATION_ENV,
  LEGACY_MANAGED_MUTATION_FLAG,
} from "../legacy-mutation-policy";
import { manageTool } from "../manage";
import { facultStateDir } from "../paths";
import { runAuditFix } from "./fix";
import { persistAuditReport } from "./report-persistence";
import { evaluateStaticAudit, runStaticAudit } from "./static";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_LEGACY_MUTATION_ENV = process.env[LEGACY_MANAGED_MUTATION_ENV];
let tempHome: string | null = null;
let tempReportRoot: string | null = null;
let evaluation: Awaited<ReturnType<typeof evaluateStaticAudit>> | null = null;
let legacyPath: string | null = null;
let reportPath: string | null = null;
let rootDir: string | null = null;

async function makeTempHome(): Promise<string> {
  const base = join(tmpdir(), "fclt-audit-fix-tests");
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

async function makeFixBase() {
  tempHome = await makeTempHome();
  process.env.HOME = tempHome;

  rootDir = join(tempHome, ".ai");
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
  legacyPath = join(facultStateDir(tempHome), "audit", "static-latest.json");
  await writeJson(legacyPath, { legacy: true });
}

beforeAll(async () => {
  await makeFixBase();
});

beforeAll(async () => {
  evaluation = await evaluateStaticAudit({
    argv: [],
    homeDir: tempHome!,
    minSeverity: "high",
  });
  tempReportRoot = await mkdtemp(join(tmpdir(), "fclt-audit-fix-report-"));
  reportPath = await persistAuditReport({
    ...evaluation,
    mode: "static",
    reportRoot: tempReportRoot,
  });
});

afterAll(async () => {
  process.exitCode = undefined;
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
  }
  tempHome = null;
  if (tempReportRoot) {
    await rm(tempReportRoot, { recursive: true, force: true });
  }
  tempReportRoot = null;
  evaluation = null;
  legacyPath = null;
  reportPath = null;
  rootDir = null;
  process.env.HOME = ORIGINAL_HOME;
  process.env[LEGACY_MANAGED_MUTATION_ENV] = ORIGINAL_LEGACY_MUTATION_ENV;
});

describe("audit fix", () => {
  it("prepares a fresh exact report for the fix workflow", async () => {
    const beforeFindings = evaluation!.report.results.flatMap((result) =>
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
    expect(await Bun.file(reportPath!).exists()).toBe(true);
  });

  it("rejects deprecated managed-output sync without its explicit mutation flag", async () => {
    process.env[LEGACY_MANAGED_MUTATION_ENV] = undefined;

    await expect(
      runAuditFix({
        argv: ["mcp:github", "--report", reportPath!, "--yes"],
        cwd: tempHome!,
        homeDir: tempHome!,
      })
    ).rejects.toThrow("fclt audit fix managed-output sync is a deprecated");
  });

  it("moves inline MCP secrets into a local overlay and keeps future audits clean", async () => {
    process.env[LEGACY_MANAGED_MUTATION_ENV] = undefined;
    const result = await runAuditFix({
      argv: [
        "mcp:github",
        "--report",
        reportPath!,
        "--yes",
        LEGACY_MANAGED_MUTATION_FLAG,
      ],
      cwd: tempHome!,
      homeDir: tempHome!,
    });

    expect(result.fixed).toBeGreaterThan(0);
    expect(result.trackedPath).toBe(join(rootDir!, "mcp", "servers.json"));
    expect(result.localPath).toBe(join(rootDir!, "mcp", "servers.local.json"));

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

    expect(await Bun.file(legacyPath!).json()).toEqual({ legacy: true });

    const after = await runStaticAudit({
      argv: [],
      homeDir: tempHome!,
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

  it("rejects a verified report from a different mutation root", async () => {
    const sourceHome = await makeTempHome();
    const targetHome = await makeTempHome();
    const sourceRoot = join(sourceHome, ".ai");
    const targetRoot = join(targetHome, ".ai");
    const isolatedReportRoot = await mkdtemp(
      join(tmpdir(), "fclt-audit-fix-cross-root-")
    );
    try {
      for (const [candidateRoot, marker] of [
        [sourceRoot, "source_fixture_value_1234567890"],
        [targetRoot, "target_fixture_value_1234567890"],
      ] as const) {
        await writeJson(join(candidateRoot, "mcp", "servers.json"), {
          servers: {
            github: {
              command: "fixture-command",
              env: { GITHUB_PERSONAL_ACCESS_TOKEN: marker },
            },
          },
        });
        await manageTool("codex", {
          allowLegacyManagedMutation: true,
          homeDir: dirname(candidateRoot),
          rootDir: candidateRoot,
        });
      }

      const sourceEvaluation = await evaluateStaticAudit({
        argv: [],
        cwd: sourceHome,
        homeDir: sourceHome,
        minSeverity: "high",
      });
      const sourceReportPath = await persistAuditReport({
        ...sourceEvaluation,
        mode: "static",
        reportRoot: isolatedReportRoot,
      });
      const targetTrackedPath = join(targetRoot, "mcp", "servers.json");
      const targetBefore = await Bun.file(targetTrackedPath).text();

      await expect(
        runAuditFix({
          argv: [
            "mcp:github",
            "--report",
            sourceReportPath,
            "--yes",
            LEGACY_MANAGED_MUTATION_FLAG,
          ],
          cwd: targetHome,
          homeDir: targetHome,
        })
      ).rejects.toThrow(
        "Audit fix report does not match the active mutation root"
      );
      expect(await Bun.file(targetTrackedPath).text()).toBe(targetBefore);
      expect(
        await Bun.file(join(targetRoot, "mcp", "servers.local.json")).exists()
      ).toBe(false);
    } finally {
      await rm(sourceHome, { force: true, recursive: true });
      await rm(targetHome, { force: true, recursive: true });
      await rm(isolatedReportRoot, { force: true, recursive: true });
    }
  }, 15_000);
});
