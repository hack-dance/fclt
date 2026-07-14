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

const SHA256_RE = /^[a-f0-9]{64}$/;
const SOURCE_DRIFT_RE =
  /source discovery changed during evaluation|directory changed between reads/;

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
  const envelope = (await Bun.file(reportPath).json()) as {
    receipt: {
      sourceSnapshot: { evaluatedFiles: { path: string; sha256: string }[] };
    };
  };
  expect(
    envelope.receipt.sourceSnapshot.evaluatedFiles.find(
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
  ).rejects.toThrow(SOURCE_DRIFT_RE);
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

for (const tool of ["claude", "codex"] as const) {
  test(`agent audit ${tool} subprocess disables persistence, isolates homes, and cleans lifecycle artifacts`, async () => {
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

    const recordPath = join(dir, `${tool}-record.json`);
    const pipeFloodMarker = join(dir, `${tool}-pipe-flood`);
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
        `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ args, authEnvironmentPresent, credentialPresent: existsSync(credentialPath), cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), profileEntries: readdirSync(profileDir).sort(), env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } }));`,
        `if (existsSync(${JSON.stringify(pipeFloodMarker)})) { const chunk = "x".repeat(65536); for (let i = 0; i < 20; i += 1) { if (!process.stderr.write(chunk)) await new Promise((resolve) => process.stderr.once("drain", resolve)); } }`,
        tool === "codex"
          ? `writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ passed: true, findings: [], notes: "ok" }));`
          : `console.log(JSON.stringify({ structured_output: { passed: true, findings: [], notes: "ok" }, modelUsage: { stub: {} } }));`,
        "",
      ].join("\n")
    );
    await chmod(executable, 0o755);

    const previousPath = process.env.PATH;
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    const previousClaudeOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    const unrelatedEnvironment = {
      ALL_PROXY: process.env.ALL_PROXY,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      BASH_ENV: process.env.BASH_ENV,
      DATABASE_URL: process.env.DATABASE_URL,
      GH_TOKEN: process.env.GH_TOKEN,
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      SERVICE_TOKEN: process.env.SERVICE_TOKEN,
    };
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.ANTHROPIC_API_KEY =
      tool === "claude" ? "fixture-environment-auth" : undefined;
    process.env.CLAUDE_CODE_OAUTH_TOKEN =
      tool === "claude" ? "fixture-environment-auth" : undefined;
    process.env.OPENAI_API_KEY =
      tool === "codex" ? "fixture-environment-auth" : undefined;
    process.env.ALL_PROXY = "http://fixture.invalid";
    process.env.AWS_SECRET_ACCESS_KEY = "fixture-unrelated-secret";
    process.env.BASH_ENV = join(dir, "fixture-hook");
    process.env.DATABASE_URL = "fixture-unrelated-secret";
    process.env.GH_TOKEN = "fixture-unrelated-secret";
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_SSH_COMMAND = "fixture-unrelated-hook";
    process.env.HTTP_PROXY = "http://fixture.invalid";
    process.env.HTTPS_PROXY = "http://fixture.invalid";
    process.env.NODE_OPTIONS = "--fixture-unrelated-hook";
    process.env.SERVICE_TOKEN = "fixture-unrelated-secret";
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
        envKeys: string[];
        profileEntries: string[];
      };
      expect(record.authEnvironmentPresent).toBe(true);
      expect(record.credentialPresent).toBe(false);
      expect(record.profileEntries).toEqual([]);
      expect(record.envKeys).toContain(
        tool === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"
      );
      for (const excluded of [
        "ALL_PROXY",
        "AWS_SECRET_ACCESS_KEY",
        "BASH_ENV",
        "DATABASE_URL",
        "GH_TOKEN",
        "GIT_CONFIG_COUNT",
        "GIT_SSH_COMMAND",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NODE_OPTIONS",
        "SERVICE_TOKEN",
      ]) {
        expect(record.envKeys).not.toContain(excluded);
      }
      expect(record.envKeys).not.toContain(
        tool === "claude" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"
      );
      if (tool === "claude") {
        expect(record.envKeys).toContain("CLAUDE_CODE_OAUTH_TOKEN");
      } else {
        expect(record.envKeys).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
      }
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
        process.env.CLAUDE_CODE_OAUTH_TOKEN = undefined;
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
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "fixture-environment-auth";
      } else {
        process.env.OPENAI_API_KEY = "fixture-environment-auth";
      }

      await Bun.write(pipeFloodMarker, "1");
      const pipeController = new AbortController();
      const pipeTimeout = setTimeout(() => pipeController.abort(), 5000);
      const flooded = await runAgentAudit({
        argv: ["ok-skill", "--with", tool, "--max-items", "1"],
        cwd: dir,
        homeDir: home,
        runtimeTempRoot: scratch,
        signal: pipeController.signal,
      });
      clearTimeout(pipeTimeout);
      expect(pipeController.signal.aborted).toBe(false);
      expect(flooded.results[0]?.findings[0]?.ruleId).toBe("agent-error");
      expect(flooded.results[0]?.findings[0]?.evidence).toBe(
        "agent-subprocess-output-limit"
      );
      expect(await readdir(scratch)).toEqual([]);
      await rm(pipeFloodMarker);
    } finally {
      process.env.PATH = previousPath;
      process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = previousClaudeOauthToken;
      process.env.OPENAI_API_KEY = previousOpenAiApiKey;
      process.env.ALL_PROXY = unrelatedEnvironment.ALL_PROXY;
      process.env.AWS_SECRET_ACCESS_KEY =
        unrelatedEnvironment.AWS_SECRET_ACCESS_KEY;
      process.env.BASH_ENV = unrelatedEnvironment.BASH_ENV;
      process.env.DATABASE_URL = unrelatedEnvironment.DATABASE_URL;
      process.env.GH_TOKEN = unrelatedEnvironment.GH_TOKEN;
      process.env.GIT_CONFIG_COUNT = unrelatedEnvironment.GIT_CONFIG_COUNT;
      process.env.GIT_SSH_COMMAND = unrelatedEnvironment.GIT_SSH_COMMAND;
      process.env.HTTP_PROXY = unrelatedEnvironment.HTTP_PROXY;
      process.env.HTTPS_PROXY = unrelatedEnvironment.HTTPS_PROXY;
      process.env.NODE_OPTIONS = unrelatedEnvironment.NODE_OPTIONS;
      process.env.SERVICE_TOKEN = unrelatedEnvironment.SERVICE_TOKEN;
    }
  });
}

for (const tool of ["claude", "codex"] as const) {
  for (const selectedSecret of ["q", "qz", "qzx", "qzxv"] as const) {
    test(`agent audit ${tool} redacts ${selectedSecret.length}-byte selected auth at field boundaries and persistence`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "facult-agent-short-auth-"));
      const home = join(dir, "audited-home");
      const bin = join(dir, "bin");
      const scratch = await mkdtemp(
        join(tmpdir(), "facult-agent-short-scratch-")
      );
      const reportRoot = await mkdtemp(
        join(tmpdir(), "facult-agent-short-report-")
      );
      const modePath = join(dir, "mode");
      const hostileMarker = `short-secret-field:${selectedSecret}:end`;
      await mkdir(bin, { recursive: true });
      await writeFile(
        join(home, ".ai", "skills", "ok-skill", "SKILL.md"),
        "Hello\n"
      );
      const executable = join(bin, tool);
      await Bun.write(
        executable,
        [
          `#!${process.execPath}`,
          `import { readFileSync, writeFileSync } from "node:fs";`,
          "const args = process.argv.slice(2);",
          `const tool = ${JSON.stringify(tool)};`,
          `const mode = readFileSync(${JSON.stringify(modePath)}, "utf8").trim();`,
          `const selected = tool === "codex" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;`,
          `const outPath = tool === "codex" ? args[args.indexOf("--output-last-message") + 1] : "";`,
          `const hostile = "short-secret-field:" + selected + ":end";`,
          `if (mode === "nonzero") { console.log(hostile); console.error(hostile); process.exit(7); }`,
          `if (mode === "parse") { console.error(hostile); if (tool === "codex") writeFileSync(outPath, "{invalid:" + hostile); else console.log("{invalid:" + hostile); }`,
          `if (mode === "structured") { const output = { passed: false, findings: [{ severity: "medium", category: selected, message: hostile, recommendation: selected, location: hostile }], notes: hostile }; if (tool === "codex") writeFileSync(outPath, JSON.stringify(output)); else console.log(JSON.stringify({ structured_output: output, modelUsage: { [selected]: {} } })); }`,
          "",
        ].join("\n")
      );
      await chmod(executable, 0o755);

      const previousPath = process.env.PATH;
      const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
      const previousClaudeOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
      process.env.PATH = `${bin}:${previousPath ?? ""}`;
      process.env.ANTHROPIC_API_KEY =
        tool === "claude" ? selectedSecret : undefined;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = undefined;
      process.env.OPENAI_API_KEY =
        tool === "codex" ? selectedSecret : undefined;

      const evaluateMode = async (mode: string) => {
        await Bun.write(modePath, mode);
        return await evaluateAgentAudit({
          argv: ["ok-skill", "--with", tool, "--max-items", "1"],
          cwd: dir,
          homeDir: home,
          runtimeTempRoot: scratch,
        });
      };
      const assertNoSelectedAuth = (value: unknown): void => {
        const strings: string[] = [];
        const collectStrings = (entry: unknown): void => {
          if (typeof entry === "string") {
            strings.push(entry);
            return;
          }
          if (Array.isArray(entry)) {
            for (const nested of entry) {
              collectStrings(nested);
            }
            return;
          }
          if (entry && typeof entry === "object") {
            for (const [key, nested] of Object.entries(entry)) {
              strings.push(key);
              collectStrings(nested);
            }
          }
        };
        collectStrings(value);
        expect(strings).not.toContain(selectedSecret);
        expect(strings.some((entry) => entry.includes(hostileMarker))).toBe(
          false
        );
      };

      try {
        const nonzero = await evaluateMode("nonzero");
        expect(nonzero.report.results[0]?.findings[0]?.evidence).toBe(
          "agent-subprocess-exit"
        );
        assertNoSelectedAuth(nonzero);
        expect(await readdir(scratch)).toEqual([]);

        const parseFailure = await evaluateMode("parse");
        expect(parseFailure.report.results[0]?.findings[0]?.evidence).toBe(
          "agent-subprocess-invalid-output"
        );
        assertNoSelectedAuth(parseFailure);
        expect(await readdir(scratch)).toEqual([]);

        const structured = await evaluateMode("structured");
        const finding = structured.report.results[0]?.findings[0];
        expect(finding?.ruleId).toBe("<redacted>");
        expect(finding?.message).toBe("<redacted>");
        expect(finding?.evidence).toBe("<redacted>");
        expect(finding?.location).toBe("<redacted>");
        expect(structured.report.results[0]?.notes).toBe("<redacted>");
        if (tool === "claude") {
          expect(structured.report.agent.model).toBe("<redacted>");
        } else {
          expect(structured.report.agent.model).toBeUndefined();
        }
        assertNoSelectedAuth(structured);
        expect(await readdir(scratch)).toEqual([]);

        const reportPath = await persistAuditReport({
          ...structured,
          mode: "agent",
          reportRoot,
        });
        const persistedEnvelope = await Bun.file(reportPath).json();
        assertNoSelectedAuth(persistedEnvelope);
      } finally {
        process.env.PATH = previousPath;
        process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = previousClaudeOauthToken;
        process.env.OPENAI_API_KEY = previousOpenAiApiKey;
      }
    });
  }
}

for (const tool of ["claude", "codex"] as const) {
  test(`agent audit ${tool} never exposes hostile child output or errors`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "facult-agent-hostile-output-"));
    const home = join(dir, "audited-home");
    const bin = join(dir, "bin");
    const scratch = await mkdtemp(
      join(tmpdir(), "facult-agent-hostile-scratch-")
    );
    const reportRoot = await mkdtemp(
      join(tmpdir(), "facult-agent-hostile-report-")
    );
    const modePath = join(dir, "mode");
    const selectedSecret = `fixture-selected-auth-${tool}-marker-94731`;
    const unrelatedSecret = "fixture-unrelated-secret-marker-68204";
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(home, ".ai", "skills", "ok-skill", "SKILL.md"),
      "Hello\n"
    );

    const executable = join(bin, tool);
    await Bun.write(
      executable,
      [
        `#!${process.execPath}`,
        `import { readFileSync, writeFileSync } from "node:fs";`,
        "const args = process.argv.slice(2);",
        `const tool = ${JSON.stringify(tool)};`,
        `const mode = readFileSync(${JSON.stringify(modePath)}, "utf8").trim();`,
        `const selected = tool === "codex" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;`,
        `const unrelated = ${JSON.stringify(unrelatedSecret)};`,
        `const hostile = "selected=" + selected + ";unrelated=" + unrelated;`,
        `const outPath = tool === "codex" ? args[args.indexOf("--output-last-message") + 1] : "";`,
        `if (mode === "nonzero") { console.log(hostile); console.error(hostile); process.exit(7); }`,
        `if (mode === "auth") { console.log(hostile); console.error("authentication required " + hostile); process.exit(9); }`,
        `if (mode === "hang") { process.stdout.write(hostile); process.stderr.write(hostile); await new Promise((resolve) => setTimeout(resolve, 60_000)); }`,
        `if (mode === "parse") { console.error(hostile); if (tool === "codex") writeFileSync(outPath, "{invalid:" + hostile); else console.log("{invalid:" + hostile); }`,
        `if (mode === "echo") { const output = { passed: false, findings: [{ severity: "medium", category: hostile, message: hostile, recommendation: hostile, location: hostile }], notes: hostile }; if (tool === "codex") writeFileSync(outPath, JSON.stringify(output)); else console.log(JSON.stringify({ structured_output: output, modelUsage: { [hostile]: {} } })); }`,
        "",
      ].join("\n")
    );
    await chmod(executable, 0o755);

    const previousPath = process.env.PATH;
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    const previousClaudeOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    const previousServiceToken = process.env.SERVICE_TOKEN;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.ANTHROPIC_API_KEY =
      tool === "claude" ? selectedSecret : undefined;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = undefined;
    process.env.OPENAI_API_KEY = tool === "codex" ? selectedSecret : undefined;
    process.env.SERVICE_TOKEN = unrelatedSecret;

    const assertNoHostileValue = (value: unknown) => {
      const serialized = JSON.stringify(value);
      expect(serialized).not.toContain(selectedSecret);
      expect(serialized).not.toContain(unrelatedSecret);
      expect(serialized).not.toContain("selected-auth");
      expect(serialized).not.toContain("unrelated-secret");
    };
    const persistAndAssertSafe = async (
      evaluation: Awaited<ReturnType<typeof evaluateAgentAudit>>
    ) => {
      await persistAuditReport({
        ...evaluation,
        mode: "agent",
        reportRoot,
      });
      const persisted = await Promise.all(
        (await readdir(reportRoot)).map((name) =>
          readFile(join(reportRoot, name), "utf8")
        )
      );
      assertNoHostileValue(persisted);
    };
    const evaluateMode = async (
      mode: string,
      extra?: { signal?: AbortSignal; subprocessTimeoutMs?: number }
    ) => {
      await Bun.write(modePath, mode);
      return await evaluateAgentAudit({
        argv: ["ok-skill", "--with", tool, "--max-items", "1"],
        cwd: dir,
        homeDir: home,
        runtimeTempRoot: scratch,
        ...extra,
      });
    };

    try {
      const nonzero = await evaluateMode("nonzero");
      expect(nonzero.report.results[0]?.findings[0]?.evidence).toBe(
        "agent-subprocess-exit"
      );
      assertNoHostileValue(nonzero);
      await persistAndAssertSafe(nonzero);
      expect(await readdir(scratch)).toEqual([]);

      let authError: unknown;
      try {
        await evaluateMode("auth");
      } catch (error) {
        authError = error;
      }
      expect(String(authError)).toContain("authentication is unavailable");
      assertNoHostileValue(String(authError));
      expect(await readdir(scratch)).toEqual([]);

      const parseFailure = await evaluateMode("parse");
      expect(parseFailure.report.results[0]?.findings[0]?.evidence).toBe(
        "agent-subprocess-invalid-output"
      );
      assertNoHostileValue(parseFailure);
      await persistAndAssertSafe(parseFailure);
      expect(await readdir(scratch)).toEqual([]);

      const echoed = await evaluateMode("echo");
      expect(echoed.report.results[0]?.findings[0]?.message).toBe(
        "selected=<redacted>;unrelated=<redacted>"
      );
      if (tool === "claude") {
        expect(echoed.report.agent.model).not.toContain("selected-auth");
      }
      assertNoHostileValue(echoed);
      await persistAndAssertSafe(echoed);
      expect(await readdir(scratch)).toEqual([]);

      const timeout = await evaluateMode("hang", {
        subprocessTimeoutMs: 25,
      });
      expect(timeout.report.results[0]?.findings[0]?.evidence).toBe(
        "agent-subprocess-timeout"
      );
      assertNoHostileValue(timeout);
      await persistAndAssertSafe(timeout);
      expect(await readdir(scratch)).toEqual([]);

      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 25);
      let abortError: unknown;
      try {
        await evaluateMode("hang", { signal: controller.signal });
      } catch (error) {
        abortError = error;
      } finally {
        clearTimeout(abortTimer);
      }
      expect(String(abortError)).toContain("agent-subprocess-interrupted");
      assertNoHostileValue(String(abortError));
      expect(await readdir(scratch)).toEqual([]);
    } finally {
      process.env.PATH = previousPath;
      process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = previousClaudeOauthToken;
      process.env.OPENAI_API_KEY = previousOpenAiApiKey;
      process.env.SERVICE_TOKEN = previousServiceToken;
    }
  });
}
