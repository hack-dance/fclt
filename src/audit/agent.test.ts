import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runAgentAudit } from "./agent";

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

  for (const tool of ["claude", "codex"] as const) {
    const recordPath = join(dir, `${tool}-record.json`);
    const executable = join(bin, tool);
    await Bun.write(
      executable,
      [
        `#!${process.execPath}`,
        `import { writeFileSync } from "node:fs";`,
        "const args = process.argv.slice(2);",
        `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ args, cwd: process.cwd(), env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } }));`,
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
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
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
        cwd: string;
        env: Record<string, string | undefined>;
      };
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
        const interrupted = await runAgentAudit({
          argv: ["ok-skill", "--with", tool, "--max-items", "1"],
          cwd: dir,
          homeDir: home,
          runtimeTempRoot: scratch,
          signal: controller.signal,
        });
        expect(interrupted.results[0]?.findings[0]?.ruleId).toBe("agent-error");
        expect(await readdir(scratch)).toEqual([]);
      }
    } finally {
      process.env.PATH = previousPath;
      process.env.FCLT_AGENT_STUB_FAIL = previousFail;
      process.env.FCLT_AGENT_STUB_HANG = previousHang;
    }
  }
});
