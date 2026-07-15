import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  LEGACY_MANAGED_MUTATION_ENV,
  LEGACY_MANAGED_MUTATION_FLAG,
} from "../legacy-mutation-policy";
import { loadManagedState, manageTool } from "../manage";
import { facultStateDir } from "../paths";
import {
  AUDIT_FIX_MUTATION_DISABLED_MESSAGE,
  fixInlineMcpSecrets,
  runAuditFix,
} from "./fix";
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
}, 30_000);

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
}, 30_000);

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

  it("fails closed before deprecated managed-output sync can mutate", async () => {
    process.env[LEGACY_MANAGED_MUTATION_ENV] = undefined;

    await expect(
      runAuditFix({
        argv: ["mcp:github", "--report", reportPath!, "--yes"],
        cwd: tempHome!,
        homeDir: tempHome!,
      })
    ).rejects.toThrow(AUDIT_FIX_MUTATION_DISABLED_MESSAGE);
  }, 30_000);

  it("preserves canonical, local, and managed bytes for --yes while dry-run remains available", async () => {
    process.env[LEGACY_MANAGED_MUTATION_ENV] = undefined;
    const trackedPath = join(rootDir!, "mcp", "servers.json");
    const localPath = join(rootDir!, "mcp", "servers.local.json");
    const managedState = await loadManagedState(tempHome!, rootDir!);
    const managedPath = managedState.tools.codex?.mcpConfig;
    expect(managedPath).toBeString();
    const trackedBefore = await Bun.file(trackedPath).text();
    const managedBefore = await Bun.file(managedPath!).text();

    const dryRun = await runAuditFix({
      argv: ["mcp:github", "--report", reportPath!, "--dry-run"],
      cwd: tempHome!,
      homeDir: tempHome!,
    });
    expect(dryRun.matched).toBeGreaterThan(0);
    expect(dryRun.fixed).toBe(0);

    await expect(
      runAuditFix({
        argv: [
          "mcp:github",
          "--report",
          reportPath!,
          "--yes",
          LEGACY_MANAGED_MUTATION_FLAG,
        ],
        cwd: tempHome!,
        homeDir: tempHome!,
      })
    ).rejects.toThrow(AUDIT_FIX_MUTATION_DISABLED_MESSAGE);

    expect(await Bun.file(trackedPath).text()).toBe(trackedBefore);
    expect(await Bun.file(localPath).exists()).toBe(false);
    expect(await Bun.file(managedPath!).text()).toBe(managedBefore);
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
    ).toBe(true);
  }, 30_000);

  it("blocks direct and TUI mutation paths for unsafe existing local overlays", async () => {
    const result = evaluation!.report.results.find((entry) =>
      entry.findings.some(
        (finding) => finding.ruleId === "mcp-env-inline-secret"
      )
    );
    const finding = result?.findings.find(
      (entry) => entry.ruleId === "mcp-env-inline-secret"
    );
    if (!(result && finding)) {
      throw new Error("Fixture report is missing its inline-secret finding");
    }
    const trackedPath = join(rootDir!, "mcp", "servers.json");
    const localPath = join(rootDir!, "mcp", "servers.local.json");
    const localContents = `${JSON.stringify(
      {
        servers: {
          github: {
            env: { FIXTURE_VALUE: "local_overlay_fixture_1234567890" },
          },
        },
      },
      null,
      2
    )}\n`;
    await Bun.write(localPath, localContents);
    try {
      for (const mode of [0o644, 0o666]) {
        await chmod(localPath, mode);
        const trackedBefore = await Bun.file(trackedPath).text();
        const localBefore = await Bun.file(localPath).text();

        await expect(
          fixInlineMcpSecrets({
            findings: [{ result, finding }],
            homeDir: tempHome!,
            rootDir: rootDir!,
          })
        ).rejects.toThrow(AUDIT_FIX_MUTATION_DISABLED_MESSAGE);

        expect(await Bun.file(trackedPath).text()).toBe(trackedBefore);
        expect(await Bun.file(localPath).text()).toBe(localBefore);
        expect((await stat(localPath)).mode % 0o1000).toBe(mode);
      }
    } finally {
      await rm(localPath, { force: true });
    }
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
      ).rejects.toThrow(AUDIT_FIX_MUTATION_DISABLED_MESSAGE);
      expect(await Bun.file(targetTrackedPath).text()).toBe(targetBefore);
      expect(
        await Bun.file(join(targetRoot, "mcp", "servers.local.json")).exists()
      ).toBe(false);
    } finally {
      await rm(sourceHome, { force: true, recursive: true });
      await rm(targetHome, { force: true, recursive: true });
      await rm(isolatedReportRoot, { force: true, recursive: true });
    }
  }, 30_000);
});
