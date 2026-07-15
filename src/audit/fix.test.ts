import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildCompiledCliFixture,
  type CompiledCliFixture,
} from "../../test/compiled-cli-fixture";
import { LEGACY_MANAGED_MUTATION_ENV } from "../legacy-mutation-policy";
import { saveManagedState } from "../manage";
import { facultStateDir } from "../paths";
import { runAuditFix } from "./fix";
import { persistAuditReport } from "./report-persistence";
import { evaluateStaticAudit } from "./static";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_LEGACY_MUTATION_ENV = process.env[LEGACY_MANAGED_MUTATION_ENV];
let tempHome: string | null = null;
let tempReportRoot: string | null = null;
let evaluation: Awaited<ReturnType<typeof evaluateStaticAudit>> | null = null;
let legacyPath: string | null = null;
let managedHome: string | null = null;
let managedReportPath: string | null = null;
let managedReportRoot: string | null = null;
let managedRoot: string | null = null;
let reportPath: string | null = null;
let rootDir: string | null = null;
let cliFixture: CompiledCliFixture | null = null;

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

async function writeManagedCodexState(homeDir: string, aiRoot: string) {
  await saveManagedState(
    {
      version: 1,
      tools: {
        codex: {
          tool: "codex",
          managedAt: "2026-01-01T00:00:00.000Z",
          mcpConfig: join(homeDir, ".codex", "mcp.json"),
        },
      },
    },
    homeDir,
    aiRoot
  );
}

async function runFixCli(args: string[], home = tempHome!, root = rootDir!) {
  const base = dirname(home);
  const proc = Bun.spawn({
    cmd: [cliFixture!.entryPath, "audit", "fix", ...args],
    cwd: home,
    env: {
      ...process.env,
      APPDATA: join(base, "appdata"),
      BUN_INSTALL: join(base, "bun-install"),
      BUN_INSTALL_CACHE_DIR: join(base, "bun-cache"),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(base, "bun-runtime-cache"),
      CLAUDE_CONFIG_DIR: join(base, "claude-config"),
      CODEX_HOME: join(base, "codex-home"),
      FACULT_CACHE_DIR: join(base, "facult-cache"),
      FACULT_LOCAL_STATE_DIR: join(base, "facult-state"),
      FACULT_ROOT_DIR: root,
      FACULT_ROOT_SCOPE: "global",
      HOME: home,
      LOCALAPPDATA: join(base, "local-appdata"),
      XDG_CACHE_HOME: join(base, "xdg-cache"),
      XDG_CONFIG_HOME: join(base, "xdg-config"),
      XDG_STATE_HOME: join(base, "xdg-state"),
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), 15_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stderr, stdout };
  } finally {
    clearTimeout(timeout);
  }
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

  legacyPath = join(facultStateDir(tempHome), "audit", "static-latest.json");
  await writeJson(legacyPath, { legacy: true });
}

beforeAll(async () => {
  await makeFixBase();
});

beforeAll(async () => {
  cliFixture = await buildCompiledCliFixture();
}, 15_000);

beforeAll(async () => {
  evaluation = await evaluateStaticAudit({
    argv: [],
    from: [rootDir!],
    homeDir: tempHome!,
    includeConfigFrom: false,
    minSeverity: "high",
  });
  tempReportRoot = await mkdtemp(join(tmpdir(), "fclt-audit-fix-report-"));
  reportPath = await persistAuditReport({
    ...evaluation,
    mode: "static",
    reportRoot: tempReportRoot,
  });
});

beforeAll(async () => {
  managedHome = await makeTempHome();
  managedRoot = join(managedHome, ".ai");
  await writeJson(join(managedRoot, "mcp", "servers.json"), {
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
  await writeJson(join(managedHome, ".codex", "mcp.json"), {
    sentinel: "preserve-managed-tool-bytes",
  });
  await writeManagedCodexState(managedHome, managedRoot);
  const managedEvaluation = await evaluateStaticAudit({
    argv: [],
    from: [managedRoot],
    homeDir: managedHome,
    includeConfigFrom: false,
    minSeverity: "high",
  });
  managedReportRoot = await mkdtemp(
    join(tmpdir(), "fclt-audit-fix-managed-report-")
  );
  managedReportPath = await persistAuditReport({
    ...managedEvaluation,
    mode: "static",
    reportRoot: managedReportRoot,
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
  if (managedHome) {
    await rm(managedHome, { recursive: true, force: true });
  }
  managedHome = null;
  if (managedReportRoot) {
    await rm(managedReportRoot, { recursive: true, force: true });
  }
  managedReportRoot = null;
  managedReportPath = null;
  managedRoot = null;
  evaluation = null;
  legacyPath = null;
  reportPath = null;
  rootDir = null;
  process.env.HOME = ORIGINAL_HOME;
  process.env[LEGACY_MANAGED_MUTATION_ENV] = ORIGINAL_LEGACY_MUTATION_ENV;
});

afterAll(async () => {
  await cliFixture?.cleanup();
  cliFixture = null;
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

  it("fails closed before deprecated managed-output sync", async () => {
    process.env[LEGACY_MANAGED_MUTATION_ENV] = undefined;
    const managedToolPath = join(managedHome!, ".codex", "mcp.json");
    const managedToolBefore = await Bun.file(managedToolPath).text();

    await expect(
      runAuditFix({
        argv: ["mcp:github", "--report", managedReportPath!, "--yes"],
        cwd: managedHome!,
        homeDir: managedHome!,
      })
    ).rejects.toThrow("audit fix mutation is temporarily disabled");
    expect(await Bun.file(managedToolPath).text()).toBe(managedToolBefore);
    expect(
      await Bun.file(join(managedRoot!, "mcp", "servers.local.json")).exists()
    ).toBe(false);
  });

  it("reports exact matches in dry-run mode without changing MCP state", async () => {
    const trackedPath = join(rootDir!, "mcp", "servers.json");
    const localPath = join(rootDir!, "mcp", "servers.local.json");
    const trackedBefore = await Bun.file(trackedPath).text();
    const result = await runAuditFix({
      argv: ["mcp:github", "--report", reportPath!, "--dry-run"],
      cwd: tempHome!,
      homeDir: tempHome!,
    });

    expect(result.matched).toBeGreaterThan(0);
    expect(result.fixed).toBe(0);
    expect(await Bun.file(trackedPath).text()).toBe(trackedBefore);
    expect(await Bun.file(localPath).exists()).toBe(false);
  });

  it("disables inline MCP mutation with zero writes", async () => {
    process.env[LEGACY_MANAGED_MUTATION_ENV] = undefined;
    const trackedPath = join(rootDir!, "mcp", "servers.json");
    const localPath = join(rootDir!, "mcp", "servers.local.json");
    const trackedBefore = await Bun.file(trackedPath).text();

    await expect(
      runAuditFix({
        argv: ["mcp:github", "--report", reportPath!, "--yes"],
        cwd: tempHome!,
        homeDir: tempHome!,
      })
    ).rejects.toThrow("audit fix mutation is temporarily disabled");

    expect(await Bun.file(trackedPath).text()).toBe(trackedBefore);
    expect(await Bun.file(localPath).exists()).toBe(false);
    expect(await Bun.file(legacyPath!).json()).toEqual({ legacy: true });
  });

  it("keeps the CLI dry-run path zero-write", async () => {
    const trackedPath = join(rootDir!, "mcp", "servers.json");
    const localPath = join(rootDir!, "mcp", "servers.local.json");
    const trackedBefore = await Bun.file(trackedPath).text();
    const result = await runFixCli([
      "mcp:github",
      "--report",
      reportPath!,
      "--dry-run",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Matched");
    expect(await Bun.file(trackedPath).text()).toBe(trackedBefore);
    expect(await Bun.file(localPath).exists()).toBe(false);
  });

  it("makes the CLI --yes path reject before any MCP or tool write", async () => {
    const trackedPath = join(managedRoot!, "mcp", "servers.json");
    const localPath = join(managedRoot!, "mcp", "servers.local.json");
    const managedToolPath = join(managedHome!, ".codex", "mcp.json");
    const trackedBefore = await Bun.file(trackedPath).text();
    const managedToolBefore = await Bun.file(managedToolPath).text();
    const result = await runFixCli(
      ["mcp:github", "--report", managedReportPath!, "--yes"],
      managedHome!,
      managedRoot!
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "audit fix mutation is temporarily disabled"
    );
    expect(await Bun.file(trackedPath).text()).toBe(trackedBefore);
    expect(await Bun.file(localPath).exists()).toBe(false);
    expect(await Bun.file(managedToolPath).text()).toBe(managedToolBefore);
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
      }

      const sourceEvaluation = await evaluateStaticAudit({
        argv: [],
        cwd: sourceHome,
        from: [sourceRoot],
        homeDir: sourceHome,
        includeConfigFrom: false,
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
          argv: ["mcp:github", "--report", sourceReportPath, "--yes"],
          cwd: targetHome,
          homeDir: targetHome,
        })
      ).rejects.toThrow("audit fix mutation is temporarily disabled");
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

  it("does not rewrite MCP bytes that drift after exact-report evaluation", async () => {
    const trackedPath = join(rootDir!, "mcp", "servers.json");
    const original = await Bun.file(trackedPath).text();
    try {
      await writeJson(trackedPath, {
        servers: {
          github: {
            command: "drifted-command",
            env: {
              GITHUB_PERSONAL_ACCESS_TOKEN: "drifted_fixture_value_1234567890",
            },
          },
        },
      });
      const drifted = await Bun.file(trackedPath).text();

      await expect(
        runAuditFix({
          argv: ["mcp:github", "--report", reportPath!, "--yes"],
          cwd: tempHome!,
          homeDir: tempHome!,
        })
      ).rejects.toThrow("Audit evaluated context changed");

      expect(await Bun.file(trackedPath).text()).toBe(drifted);
      expect(
        await Bun.file(join(rootDir!, "mcp", "servers.local.json")).exists()
      ).toBe(false);
    } finally {
      await Bun.write(trackedPath, original);
    }
  });
});
