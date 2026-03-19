import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
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
  expect(await Bun.file(outPath).exists()).toBe(true);
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
