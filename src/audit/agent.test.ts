import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { evaluateAgentAudit, runAgentAudit } from "./agent";
import { persistAuditReport } from "./report-persistence";

const JSON_SUFFIX_RE = /\.json$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

async function writeFile(p: string, content: string) {
  await mkdir(dirname(p), { recursive: true });
  await Bun.write(p, content);
}

test("agent audit runs over discovered skills and MCP servers (with injected runner)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-agent-audit-"));
  const home = join(dir, "home");

  // Canonical store (test-only).
  const skillDir = join(home, ".ai", "skills", "ok-skill");
  await mkdir(skillDir, { recursive: true });
  await Bun.write(join(skillDir, "SKILL.md"), "Hello\\n");

  const mcpDir = join(home, ".ai", "mcp");
  await mkdir(mcpDir, { recursive: true });
  await writeFile(
    join(mcpDir, "mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          test: {
            command: "node",
            args: ["server.js"],
            env: { OPENAI_API_KEY: "sk-1234567890" },
          },
        },
      },
      null,
      2
    )
  );

  const report = await runAgentAudit({
    argv: ["--with", "claude", "--max-items", "10"],
    homeDir: home,
    cwd: dir,
    runner: async (_tool, _prompt) => ({
      output: {
        passed: true,
        findings: [],
        notes: "ok",
      },
      model: "test-model",
    }),
  });

  expect(report.mode).toBe("agent");
  expect(report.agent.tool).toBe("claude");
  expect(
    report.results.some((r) => r.type === "skill" && r.item === "ok-skill")
  ).toBe(true);
  expect(
    report.results.some((r) => r.type === "mcp" && r.item === "test")
  ).toBe(true);

  const outPath = join(home, ".ai", ".facult", "audit", "agent-latest.json");
  expect(await Bun.file(outPath).exists()).toBe(false);
});

test("agent audit respects requested skill filter (does not audit MCP servers)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-agent-audit-"));
  const home = join(dir, "home");

  const okSkillDir = join(home, ".ai", "skills", "ok-skill");
  await mkdir(okSkillDir, { recursive: true });
  await Bun.write(join(okSkillDir, "SKILL.md"), "Hello\\n");

  const otherSkillDir = join(home, ".ai", "skills", "other-skill");
  await mkdir(otherSkillDir, { recursive: true });
  await Bun.write(join(otherSkillDir, "SKILL.md"), "Other\\n");

  const mcpDir = join(home, ".ai", "mcp");
  await mkdir(mcpDir, { recursive: true });
  await writeFile(
    join(mcpDir, "mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          test: {
            command: "node",
            args: ["server.js"],
            env: { OPENAI_API_KEY: "sk-1234567890" },
          },
        },
      },
      null,
      2
    )
  );

  const report = await runAgentAudit({
    argv: ["ok-skill", "--with", "claude", "--max-items", "50"],
    homeDir: home,
    cwd: dir,
    runner: async (_tool, _prompt) => ({
      output: {
        passed: true,
        findings: [],
        notes: "ok",
      },
      model: "test-model",
    }),
  });

  expect(report.results.map((r) => `${r.type}:${r.item}`)).toEqual([
    "skill:ok-skill",
  ]);
});

test("agent audit respects requested MCP filter (does not audit skills)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-agent-audit-"));
  const home = join(dir, "home");

  const skillDir = join(home, ".ai", "skills", "ok-skill");
  await mkdir(skillDir, { recursive: true });
  await Bun.write(join(skillDir, "SKILL.md"), "Hello\\n");

  const mcpDir = join(home, ".ai", "mcp");
  await mkdir(mcpDir, { recursive: true });
  await writeFile(
    join(mcpDir, "mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          test: {
            command: "node",
            args: ["server.js"],
            env: { OPENAI_API_KEY: "sk-1234567890" },
          },
          other: {
            command: "node",
            args: ["other.js"],
          },
        },
      },
      null,
      2
    )
  );

  const report = await runAgentAudit({
    argv: ["mcp:test", "--with", "claude", "--max-items", "50"],
    homeDir: home,
    cwd: dir,
    runner: async (_tool, _prompt) => ({
      output: {
        passed: true,
        findings: [],
        notes: "ok",
      },
      model: "test-model",
    }),
  });

  expect(report.results.map((r) => `${r.type}:${r.item}`)).toEqual([
    "mcp:test",
  ]);
});

test("agent audit binds deterministic supporting-file bytes and rejects long-call drift", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-agent-provenance-"));
  const home = join(dir, "home");
  const skillDir = join(home, ".ai", "skills", "ok-skill");
  const supportA = join(skillDir, "references", "a.md");
  const supportB = join(skillDir, "scripts", "b.ts");
  await writeFile(join(skillDir, "SKILL.md"), "Hello\n");
  await writeFile(supportB, "export const b = 1;\n");
  await writeFile(supportA, "alpha\n");

  const evaluation = await evaluateAgentAudit({
    argv: ["ok-skill", "--with", "claude", "--max-items", "1"],
    cwd: dir,
    homeDir: home,
    runner: (_tool, prompt) => {
      expect(prompt.indexOf("FILE: references/a.md")).toBeLessThan(
        prompt.indexOf("FILE: scripts/b.ts")
      );
      return Promise.resolve({
        output: { passed: true, findings: [], notes: "ok" },
      });
    },
  });
  const evaluatedPaths = evaluation.sourceSnapshot.evaluatedFiles.map(
    (entry) => entry.path
  );
  const canonicalSkill = await realpath(join(skillDir, "SKILL.md"));
  const canonicalSupportA = await realpath(supportA);
  const canonicalSupportB = await realpath(supportB);
  expect(evaluatedPaths.indexOf(canonicalSkill)).toBeLessThan(
    evaluatedPaths.indexOf(canonicalSupportA)
  );
  expect(evaluatedPaths.indexOf(canonicalSupportA)).toBeLessThan(
    evaluatedPaths.indexOf(canonicalSupportB)
  );

  const reportRoot = await mkdtemp(join(tmpdir(), "facult-agent-report-"));
  const reportPath = await persistAuditReport({
    ...evaluation,
    mode: "agent",
    reportRoot,
  });
  const receipt = (await Bun.file(
    reportPath.replace(JSON_SUFFIX_RE, ".receipt.json")
  ).json()) as {
    sourceSnapshot: { evaluatedFiles: { path: string; sha256: string }[] };
  };
  expect(
    receipt.sourceSnapshot.evaluatedFiles.find(
      (entry) => entry.path === supportA || entry.path === canonicalSupportA
    )?.sha256
  ).toMatch(SHA256_RE);

  const driftEvaluation = await evaluateAgentAudit({
    argv: ["ok-skill", "--with", "claude", "--max-items", "1"],
    cwd: dir,
    homeDir: home,
    runner: async () => ({
      output: { passed: true, findings: [], notes: "ok" },
    }),
  });
  const driftReportRoot = await mkdtemp(
    join(tmpdir(), "facult-agent-drift-report-")
  );
  const parentBefore = await stat(dirname(supportA));
  await Bun.write(supportA, "delta\n");
  const parentAfter = await stat(dirname(supportA));
  expect(parentAfter.mtimeMs).toBe(parentBefore.mtimeMs);
  await expect(
    persistAuditReport({
      ...driftEvaluation,
      mode: "agent",
      reportRoot: driftReportRoot,
    })
  ).rejects.toThrow("evaluated context changed");
  expect(await readdir(driftReportRoot)).toEqual([]);
  await Bun.write(supportA, "alpha\n");

  await expect(
    evaluateAgentAudit({
      argv: ["ok-skill", "--with", "claude", "--max-items", "1"],
      cwd: dir,
      homeDir: home,
      runner: async () => {
        await Bun.write(supportA, "omega\n");
        return { output: { passed: true, findings: [], notes: "ok" } };
      },
    })
  ).rejects.toThrow("evaluated context changed");
});

test("agent audit rejects discovery drift during a long agent call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-agent-discovery-drift-"));
  const home = join(dir, "home");
  const skillsRoot = join(home, ".ai", "skills");
  await writeFile(join(skillsRoot, "initial", "SKILL.md"), "initial\n");

  await expect(
    evaluateAgentAudit({
      argv: ["initial", "--with", "claude", "--max-items", "1"],
      cwd: dir,
      homeDir: home,
      runner: async () => {
        await writeFile(join(skillsRoot, "appeared", "SKILL.md"), "appeared\n");
        return { output: { passed: true, findings: [], notes: "ok" } };
      },
    })
  ).rejects.toThrow("source discovery changed during evaluation");
});

test("agent audit rejects symlinks in supporting skill trees", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-agent-symlink-"));
  const home = join(dir, "home");
  const skillDir = join(home, ".ai", "skills", "ok-skill");
  const outside = join(dir, "outside.md");
  await writeFile(join(skillDir, "SKILL.md"), "Hello\n");
  await writeFile(outside, "outside\n");
  await mkdir(join(skillDir, "references"), { recursive: true });
  await symlink(outside, join(skillDir, "references", "escape.md"));

  await expect(
    evaluateAgentAudit({
      argv: ["ok-skill", "--with", "claude", "--max-items", "1"],
      cwd: dir,
      homeDir: home,
      runner: async () => ({
        output: { passed: true, findings: [], notes: "ok" },
      }),
    })
  ).rejects.toThrow("regular file or directory");
});

test("agent CLI authentication preconditions leave the explicit report root empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-agent-auth-cli-"));
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const reportRoot = join(dir, "reports");
  const runtimeRoot = await mkdtemp(join(tmpdir(), "facult-auth-runtime-"));
  const invocationMarker = join(dir, "claude-invoked");
  const skillPath = join(home, ".ai", "skills", "ok-skill", "SKILL.md");
  await writeFile(skillPath, "Hello\n");
  await writeFile(
    join(home, ".claude", ".credentials.json"),
    '{"fixture":"profile-marker"}\n'
  );
  await mkdir(bin, { recursive: true });
  await mkdir(reportRoot);
  const executable = join(bin, "claude");
  await Bun.write(
    executable,
    [
      `#!${process.execPath}`,
      `await Bun.write(${JSON.stringify(invocationMarker)}, "invoked");`,
      `console.error("authentication required");`,
      "process.exit(9);",
      "",
    ].join("\n")
  );
  await chmod(executable, 0o755);

  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "..", "index.ts"),
      "audit",
      "--non-interactive",
      "ok-skill",
      "--with",
      "claude",
      "--no-config-from",
      "--from",
      join(home, ".ai"),
      "--report-root",
      reportRoot,
      "--json",
    ],
    cwd: dir,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: undefined,
      CODEX_HOME: undefined,
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      FACULT_ROOT_DIR: join(home, ".ai"),
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TEMP: runtimeRoot,
      TMP: runtimeRoot,
      TMPDIR: runtimeRoot,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("file-backed profile authentication is unsupported");
  expect(stderr).not.toContain("profile-marker");
  expect(await Bun.file(invocationMarker).exists()).toBe(false);
  expect(await readdir(reportRoot)).toEqual([]);
  expect(await readFile(skillPath, "utf8")).toBe("Hello\n");
});

test("agent audit subprocesses disable persistence, isolate homes, and clean lifecycle artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-agent-subprocess-"));
  const home = join(dir, "audited-home");
  const bin = join(dir, "bin");
  const scratch = await mkdtemp(join(tmpdir(), "facult-agent-scratch-"));
  const scratchCanonical = await realpath(scratch);
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(home, ".ai", "skills", "ok-skill", "SKILL.md"),
    "Hello\n"
  );
  const authMarkers = {
    claude: join(home, ".claude", ".credentials.json"),
    codex: join(home, ".codex", "auth.json"),
  } as const;
  await writeFile(authMarkers.claude, '{"fixture":"claude-profile"}\n');
  await writeFile(authMarkers.codex, '{"fixture":"codex-profile"}\n');

  for (const tool of ["claude", "codex"] as const) {
    const recordPath = join(dir, `${tool}-record.json`);
    const executable = join(bin, tool);
    await Bun.write(
      executable,
      [
        `#!${process.execPath}`,
        `import { existsSync, readdirSync, writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        "const args = process.argv.slice(2);",
        `const credentialPath = ${JSON.stringify(tool)} === "codex" ? join(process.env.CODEX_HOME, "auth.json") : join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json");`,
        `const profileDir = ${JSON.stringify(tool)} === "codex" ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR;`,
        `const authEnvironmentPresent = ${JSON.stringify(tool)} === "codex" ? Boolean(process.env.OPENAI_API_KEY) : Boolean(process.env.ANTHROPIC_API_KEY);`,
        `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ args, authEnvironmentPresent, credentialPresent: existsSync(credentialPath), cwd: process.cwd(), profileEntries: readdirSync(profileDir).sort(), env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } }));`,
        `if (process.env.FCLT_AGENT_STUB_AUTH_FAIL === "1") { console.error("authentication required"); process.exit(9); }`,
        `if (process.env.FCLT_AGENT_STUB_FAIL === "1") process.exit(7);`,
        `if (process.env.FCLT_AGENT_STUB_HANG === "1") await new Promise((resolve) => setTimeout(resolve, 60_000));`,
        tool === "codex"
          ? `writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ passed: true, findings: [], notes: "ok" }));`
          : `console.log(JSON.stringify({ structured_output: { passed: true, findings: [], notes: "ok" }, modelUsage: { stub: {} } }));`,
        "",
      ].join("\n")
    );
    await chmod(executable, 0o755);

    const previousPath = process.env.PATH;
    const previousFail = process.env.FCLT_AGENT_STUB_FAIL;
    const previousHang = process.env.FCLT_AGENT_STUB_HANG;
    const previousAuthFail = process.env.FCLT_AGENT_STUB_AUTH_FAIL;
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.ANTHROPIC_API_KEY =
      tool === "claude" ? "fixture-environment-auth" : undefined;
    process.env.OPENAI_API_KEY =
      tool === "codex" ? "fixture-environment-auth" : undefined;
    try {
      const report = await runAgentAudit({
        argv: ["ok-skill", "--with", tool, "--max-items", "1"],
        cwd: dir,
        homeDir: home,
        runtimeTempRoot: scratch,
      });
      expect(report.results[0]?.passed).toBe(true);
      const record = (await Bun.file(recordPath).json()) as {
        args: string[];
        authEnvironmentPresent: boolean;
        credentialPresent: boolean;
        cwd: string;
        env: Record<string, string | undefined>;
        profileEntries: string[];
      };
      expect(record.authEnvironmentPresent).toBe(true);
      expect(record.credentialPresent).toBe(false);
      expect(record.profileEntries).toEqual([]);
      const isolatedHome = record.env.HOME ?? "";
      expect(record.args).toContain(
        tool === "claude" ? "--no-session-persistence" : "--ephemeral"
      );
      expect(record.cwd.startsWith(scratchCanonical)).toBe(true);
      expect(isolatedHome.startsWith(scratchCanonical)).toBe(true);
      expect(isolatedHome.startsWith(home)).toBe(false);
      expect(
        (record.env.CLAUDE_CONFIG_DIR ?? "").startsWith(scratchCanonical)
      ).toBe(true);
      expect((record.env.CODEX_HOME ?? "").startsWith(scratchCanonical)).toBe(
        true
      );
      expect(
        (record.env.XDG_CONFIG_HOME ?? "").startsWith(scratchCanonical)
      ).toBe(true);
      expect(await readdir(scratch)).toEqual([]);
      expect(await readFile(authMarkers[tool], "utf8")).toBe(
        `{"fixture":"${tool}-profile"}\n`
      );

      await rm(recordPath);
      const profileBackup = `${authMarkers[tool]}.disabled`;
      await rename(authMarkers[tool], profileBackup);
      if (tool === "claude") {
        process.env.ANTHROPIC_API_KEY = undefined;
      } else {
        process.env.OPENAI_API_KEY = undefined;
      }
      const nativeReport = await runAgentAudit({
        argv: ["ok-skill", "--with", tool, "--max-items", "1"],
        cwd: dir,
        homeDir: home,
        runtimeTempRoot: scratch,
      });
      expect(nativeReport.results[0]?.passed).toBe(true);
      const nativeRecord = (await Bun.file(recordPath).json()) as {
        authEnvironmentPresent: boolean;
        credentialPresent: boolean;
        profileEntries: string[];
      };
      expect(nativeRecord.authEnvironmentPresent).toBe(false);
      expect(nativeRecord.credentialPresent).toBe(false);
      expect(nativeRecord.profileEntries).toEqual([]);
      expect(await readdir(scratch)).toEqual([]);
      await rename(profileBackup, authMarkers[tool]);
      await rm(recordPath);

      await expect(
        runAgentAudit({
          argv: ["ok-skill", "--with", tool, "--max-items", "1"],
          cwd: dir,
          homeDir: home,
          runtimeTempRoot: scratch,
        })
      ).rejects.toThrow("file-backed profile authentication is unsupported");
      expect(await Bun.file(recordPath).exists()).toBe(false);
      expect(await readdir(scratch)).toEqual([]);
      if (tool === "claude") {
        process.env.ANTHROPIC_API_KEY = "fixture-environment-auth";
      } else {
        process.env.OPENAI_API_KEY = "fixture-environment-auth";
      }

      process.env.FCLT_AGENT_STUB_AUTH_FAIL = "1";
      await expect(
        runAgentAudit({
          argv: ["ok-skill", "--with", tool, "--max-items", "1"],
          cwd: dir,
          homeDir: home,
          runtimeTempRoot: scratch,
        })
      ).rejects.toThrow("authentication is unavailable");
      expect(await readdir(scratch)).toEqual([]);
      process.env.FCLT_AGENT_STUB_AUTH_FAIL = undefined;

      process.env.FCLT_AGENT_STUB_FAIL = "1";
      const failed = await runAgentAudit({
        argv: ["ok-skill", "--with", tool, "--max-items", "1"],
        cwd: dir,
        homeDir: home,
        runtimeTempRoot: scratch,
      });
      expect(failed.results[0]?.findings[0]?.ruleId).toBe("agent-error");
      expect(await readdir(scratch)).toEqual([]);

      if (tool === "codex") {
        process.env.FCLT_AGENT_STUB_FAIL = undefined;
        process.env.FCLT_AGENT_STUB_HANG = "1";
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 50);
        await expect(
          runAgentAudit({
            argv: ["ok-skill", "--with", tool, "--max-items", "1"],
            cwd: dir,
            homeDir: home,
            runtimeTempRoot: scratch,
            signal: controller.signal,
          })
        ).rejects.toThrow();
        expect(await readdir(scratch)).toEqual([]);
      }
    } finally {
      process.env.PATH = previousPath;
      process.env.FCLT_AGENT_STUB_FAIL = previousFail;
      process.env.FCLT_AGENT_STUB_HANG = previousHang;
      process.env.FCLT_AGENT_STUB_AUTH_FAIL = previousAuthFail;
      process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
      process.env.OPENAI_API_KEY = previousOpenAiApiKey;
    }
  }
});
