import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildCompiledCliFixture,
  type CompiledCliFixture,
} from "../../test/compiled-cli-fixture";
import { saveManagedState } from "../manage";
import { runAuditFix } from "./fix";
import { persistAuditReport } from "./report-persistence";
import { evaluateStaticAudit } from "./static";

const ORIGINAL_HOME = process.env.HOME;
let tempHome: string | null = null;
let tempReportRoot: string | null = null;
let evaluation: Awaited<ReturnType<typeof evaluateStaticAudit>> | null = null;
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
}

async function makeAuthorizedFixture(
  marker = "fixture_secret_1234567890",
  options?: {
    localMode?: number;
    localServer?: Record<string, unknown>;
    serverName?: string;
    sourceRoot?: Record<string, unknown>;
  }
) {
  const home = await makeTempHome();
  const root = join(home, ".ai");
  const trackedPath = join(root, "mcp", "servers.json");
  const localPath = join(root, "mcp", "servers.local.json");
  const serverName = options?.serverName ?? "github";
  await writeJson(
    trackedPath,
    options?.sourceRoot ?? {
      servers: {
        [serverName]: {
          command: "fixture-command",
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: marker },
        },
      },
    }
  );
  if (options?.localServer) {
    await writeJson(localPath, {
      servers: { [serverName]: options.localServer },
    });
    if (options.localMode !== undefined) {
      await chmod(localPath, options.localMode);
    }
  }
  const audit = await evaluateStaticAudit({
    argv: [],
    cwd: home,
    from: [root],
    homeDir: home,
    includeConfigFrom: false,
    minSeverity: "high",
  });
  const reportRoot = await mkdtemp(join(tmpdir(), "fclt-audit-fix-exact-"));
  const exactReportPath = await persistAuditReport({
    ...audit,
    mode: "static",
    reportRoot,
  });
  return {
    cleanup: async () => {
      await rm(home, { force: true, recursive: true });
      await rm(reportRoot, { force: true, recursive: true });
    },
    exactReportPath,
    home,
    localPath,
    reportRoot,
    root,
    serverName,
    trackedPath,
  };
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
  reportPath = null;
  rootDir = null;
  process.env.HOME = ORIGINAL_HOME;
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

  it("remediates only canonical MCP files and preserves managed tool bytes", async () => {
    const managedToolPath = join(managedHome!, ".codex", "mcp.json");
    const managedToolBefore = await Bun.file(managedToolPath).text();

    const result = await runAuditFix({
      argv: ["mcp:github", "--report", managedReportPath!, "--yes"],
      cwd: managedHome!,
      homeDir: managedHome!,
    });
    expect(result.fixed).toBe(1);
    expect(await Bun.file(managedToolPath).text()).toBe(managedToolBefore);
    expect(
      await Bun.file(join(managedRoot!, "mcp", "servers.local.json")).exists()
    ).toBe(true);
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

  it("rejects a receipt binding that does not match its exact finding", async () => {
    const fixture = await makeAuthorizedFixture();
    try {
      const envelope = (await Bun.file(fixture.exactReportPath).json()) as {
        receipt: {
          remediationBindings: Array<{ envKey: string }>;
        };
      };
      const binding = envelope.receipt.remediationBindings[0];
      expect(binding).toBeDefined();
      if (!binding) {
        throw new Error("Expected an exact remediation binding fixture");
      }
      binding.envKey = "DIFFERENT_TOKEN";
      await Bun.write(
        fixture.exactReportPath,
        `${JSON.stringify(envelope, null, 2)}\n`
      );
      await chmod(fixture.exactReportPath, 0o600);
      await expect(
        runAuditFix({
          argv: ["mcp:github", "--report", fixture.exactReportPath, "--yes"],
          cwd: fixture.home,
          homeDir: fixture.home,
        })
      ).rejects.toThrow("schema or revision is unsupported");
      expect(await Bun.file(fixture.localPath).exists()).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("moves the exact secret, preserves reports, and leaves a clean future audit", async () => {
    const fixture = await makeAuthorizedFixture();
    try {
      const reportBefore = await readFile(fixture.exactReportPath, "utf8");
      const result = await runAuditFix({
        argv: ["mcp:github", "--report", fixture.exactReportPath, "--yes"],
        cwd: fixture.home,
        homeDir: fixture.home,
      });
      expect(result.fixed).toBe(1);
      expect(result.trackedPath).toBe(fixture.trackedPath);
      expect(result.localPath).toBe(fixture.localPath);
      expect(await Bun.file(fixture.trackedPath).json()).toEqual({
        servers: { github: { command: "fixture-command" } },
      });
      expect(await Bun.file(fixture.localPath).json()).toEqual({
        servers: {
          github: {
            env: {
              GITHUB_PERSONAL_ACCESS_TOKEN: "fixture_secret_1234567890",
            },
          },
        },
      });
      expect(await readFile(fixture.exactReportPath, "utf8")).toBe(
        reportBefore
      );
      const future = await evaluateStaticAudit({
        argv: [],
        cwd: fixture.home,
        from: [fixture.root],
        homeDir: fixture.home,
        includeConfigFrom: false,
        minSeverity: "high",
      });
      expect(
        future.report.results.flatMap((entry) => entry.findings)
      ).not.toContainEqual(
        expect.objectContaining({ ruleId: "mcp-env-inline-secret" })
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("secures an existing readable local destination to owner-only mode", async () => {
    const fixture = await makeAuthorizedFixture("fixture_secret_1234567890", {
      localMode: 0o644,
      localServer: { env: { NON_SECRET_SETTING: "preserve" } },
    });
    try {
      await runAuditFix({
        argv: ["mcp:github", "--report", fixture.exactReportPath, "--yes"],
        cwd: fixture.home,
        homeDir: fixture.home,
      });
      expect((await lstat(fixture.localPath)).mode % 0o1000).toBe(0o600);
      expect(await Bun.file(fixture.localPath).json()).toEqual({
        servers: {
          github: {
            env: {
              GITHUB_PERSONAL_ACCESS_TOKEN: "fixture_secret_1234567890",
              NON_SECRET_SETTING: "preserve",
            },
          },
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("binds colon-bearing server names without location ambiguity", async () => {
    const fixture = await makeAuthorizedFixture("fixture_secret_1234567890", {
      serverName: "team:github",
    });
    try {
      const result = await runAuditFix({
        argv: [
          "--item",
          "team:github",
          "--report",
          fixture.exactReportPath,
          "--yes",
        ],
        cwd: fixture.home,
        homeDir: fixture.home,
      });
      expect(result.fixed).toBe(1);
      const local = (await Bun.file(fixture.localPath).json()) as {
        servers: Record<string, unknown>;
      };
      expect(local.servers["team:github"]).toEqual({
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: "fixture_secret_1234567890",
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("remediates the auditor-supported dotted MCP server container", async () => {
    const fixture = await makeAuthorizedFixture("fixture_secret_1234567890", {
      sourceRoot: {
        servers: "unrelated metadata",
        "mcp.servers": {
          github: {
            command: "fixture-command",
            env: {
              GITHUB_PERSONAL_ACCESS_TOKEN: "fixture_secret_1234567890",
            },
          },
        },
      },
    });
    try {
      const result = await runAuditFix({
        argv: ["mcp:github", "--report", fixture.exactReportPath, "--yes"],
        cwd: fixture.home,
        homeDir: fixture.home,
      });
      expect(result.fixed).toBe(1);
      expect(await Bun.file(fixture.trackedPath).json()).toEqual({
        servers: "unrelated metadata",
        "mcp.servers": { github: { command: "fixture-command" } },
      });
      expect(await Bun.file(fixture.localPath).json()).toEqual({
        servers: {
          github: {
            env: {
              GITHUB_PERSONAL_ACCESS_TOKEN: "fixture_secret_1234567890",
            },
          },
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("remediates the active container shared by runtime and static audit", async () => {
    const fixture = await makeAuthorizedFixture("fixture_secret_1234567890", {
      sourceRoot: {
        servers: {
          github: {
            command: "fixture-command",
            env: {
              GITHUB_PERSONAL_ACCESS_TOKEN: "fixture_secret_1234567890",
            },
          },
        },
        "mcp.servers": {
          github: {
            command: "decoy-command",
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: "decoy_secret_1234567890" },
          },
        },
      },
    });
    try {
      const result = await runAuditFix({
        argv: ["mcp:github", "--report", fixture.exactReportPath, "--yes"],
        cwd: fixture.home,
        homeDir: fixture.home,
      });
      expect(result.fixed).toBe(1);
      expect(await Bun.file(fixture.trackedPath).json()).toEqual({
        servers: {
          github: {
            command: "fixture-command",
          },
        },
        "mcp.servers": {
          github: {
            command: "decoy-command",
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: "decoy_secret_1234567890" },
          },
        },
      });
      expect(await Bun.file(fixture.localPath).json()).toEqual({
        servers: {
          github: {
            env: {
              GITHUB_PERSONAL_ACCESS_TOKEN: "fixture_secret_1234567890",
            },
          },
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("uses the report's global canonical root from a project working directory", async () => {
    const fixture = await makeAuthorizedFixture();
    const project = join(fixture.home, "project");
    try {
      await mkdir(join(project, ".ai", "mcp"), { recursive: true });
      const result = await runAuditFix({
        argv: ["mcp:github", "--report", fixture.exactReportPath, "--yes"],
        cwd: project,
        homeDir: fixture.home,
      });
      expect(result.fixed).toBe(1);
      expect(await Bun.file(fixture.localPath).exists()).toBe(true);
      expect(
        await Bun.file(
          join(project, ".ai", "mcp", "servers.local.json")
        ).exists()
      ).toBe(false);
    } finally {
      await fixture.cleanup();
    }
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

  it("rejects replay of a report after its authorized source changed", async () => {
    const trackedPath = join(managedRoot!, "mcp", "servers.json");
    const localPath = join(managedRoot!, "mcp", "servers.local.json");
    const managedToolPath = join(managedHome!, ".codex", "mcp.json");
    const managedToolBefore = await Bun.file(managedToolPath).text();
    const result = await runFixCli(
      ["mcp:github", "--report", managedReportPath!, "--yes"],
      managedHome!,
      managedRoot!
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Audit requested path changed");
    expect(await Bun.file(localPath).exists()).toBe(true);
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
      ).rejects.toThrow("does not match the report-authorized canonical root");
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
      await expect(
        runAuditFix({
          argv: ["mcp:github", "--report", reportPath!, "--yes"],
          beforeSourceValidation: async () => {
            await writeJson(trackedPath, {
              servers: {
                github: {
                  command: "drifted-command",
                  env: {
                    GITHUB_PERSONAL_ACCESS_TOKEN:
                      "drifted_fixture_value_1234567890",
                  },
                },
              },
            });
          },
          cwd: tempHome!,
          homeDir: tempHome!,
        })
      ).rejects.toThrow("Audit evaluated context changed");
      const drifted = await Bun.file(trackedPath).text();

      expect(await Bun.file(trackedPath).text()).toBe(drifted);
      expect(
        await Bun.file(join(rootDir!, "mcp", "servers.local.json")).exists()
      ).toBe(false);
    } finally {
      await Bun.write(trackedPath, original);
    }
  });

  it("does not rewrite an unchanged replacement at the before-open seam", async () => {
    const fixture = await makeAuthorizedFixture();
    const movedPath = `${fixture.trackedPath}.moved`;
    try {
      const replacement = `${JSON.stringify(
        {
          servers: {
            github: {
              command: "replacement-command",
              env: {
                GITHUB_PERSONAL_ACCESS_TOKEN: "replacement_secret_1234567890",
              },
            },
          },
        },
        null,
        2
      )}\n`;
      await expect(
        runAuditFix({
          afterReportValidation: async () => {
            await rename(fixture.trackedPath, movedPath);
            await Bun.write(fixture.trackedPath, replacement);
          },
          argv: ["mcp:github", "--report", fixture.exactReportPath, "--yes"],
          cwd: fixture.home,
          homeDir: fixture.home,
        })
      ).rejects.toThrow();
      expect(await Bun.file(fixture.trackedPath).text()).toBe(replacement);
      expect(await Bun.file(fixture.localPath).exists()).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails closed on an ancestor swap after the directory is bound", async () => {
    const fixture = await makeAuthorizedFixture();
    const mcpRoot = join(fixture.root, "mcp");
    const movedRoot = join(fixture.root, "mcp.moved");
    try {
      await expect(
        runAuditFix({
          afterBoundOpen: async () => {
            await rename(mcpRoot, movedRoot);
            await writeJson(join(mcpRoot, "servers.json"), {
              servers: {
                github: {
                  command: "replacement-command",
                  env: {
                    GITHUB_PERSONAL_ACCESS_TOKEN:
                      "replacement_secret_1234567890",
                  },
                },
              },
            });
          },
          argv: ["mcp:github", "--report", fixture.exactReportPath, "--yes"],
          cwd: fixture.home,
          homeDir: fixture.home,
        })
      ).rejects.toThrow();
      expect(await Bun.file(join(mcpRoot, "servers.json")).json()).toEqual(
        expect.objectContaining({
          servers: expect.objectContaining({
            github: expect.objectContaining({
              command: "replacement-command",
            }),
          }),
        })
      );
      expect(
        await Bun.file(join(movedRoot, "servers.local.json")).exists()
      ).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rolls back the destination when the final source commit is interrupted", async () => {
    const fixture = await makeAuthorizedFixture();
    try {
      const trackedBefore = await Bun.file(fixture.trackedPath).text();
      await expect(
        runAuditFix({
          argv: ["mcp:github", "--report", fixture.exactReportPath, "--yes"],
          beforeSourceCommit: () => {
            throw new Error("injected final commit interruption");
          },
          cwd: fixture.home,
          homeDir: fixture.home,
        })
      ).rejects.toThrow("injected final commit interruption");
      expect(await Bun.file(fixture.trackedPath).text()).toBe(trackedBefore);
      expect(await Bun.file(fixture.localPath).exists()).toBe(false);
      expect(
        (await readdir(join(fixture.root, "mcp"))).some((name) =>
          name.endsWith(".tmp")
        )
      ).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails closed on source permission drift after bound open", async () => {
    const fixture = await makeAuthorizedFixture();
    try {
      const trackedBefore = await Bun.file(fixture.trackedPath).text();
      await expect(
        runAuditFix({
          afterBoundOpen: async () => {
            await chmod(fixture.trackedPath, 0o666);
          },
          argv: ["mcp:github", "--report", fixture.exactReportPath, "--yes"],
          cwd: fixture.home,
          homeDir: fixture.home,
        })
      ).rejects.toThrow();
      expect(await Bun.file(fixture.trackedPath).text()).toBe(trackedBefore);
      expect(await Bun.file(fixture.localPath).exists()).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails closed without blocking when a FIFO replaces the bound source", async () => {
    const fixture = await makeAuthorizedFixture();
    const movedPath = `${fixture.trackedPath}.moved`;
    try {
      const attempt = runAuditFix({
        afterReportValidation: async () => {
          await rename(fixture.trackedPath, movedPath);
          const proc = Bun.spawn(["mkfifo", fixture.trackedPath], {
            stderr: "pipe",
            stdout: "pipe",
          });
          expect(await proc.exited).toBe(0);
        },
        argv: ["mcp:github", "--report", fixture.exactReportPath, "--yes"],
        cwd: fixture.home,
        homeDir: fixture.home,
      });
      await expect(
        Promise.race([
          attempt,
          Bun.sleep(1000).then(() => {
            throw new Error("audit fix blocked on FIFO replacement");
          }),
        ])
      ).rejects.toThrow();
      expect((await lstat(fixture.trackedPath)).isFIFO()).toBe(true);
      expect(await Bun.file(fixture.localPath).exists()).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });
});
