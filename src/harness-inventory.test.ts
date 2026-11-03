import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildHarnessInventory } from "./harness-inventory";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-inventory-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  await mkdir(join(cwd, ".git"), { recursive: true });
  await mkdir(home, { recursive: true });
  async function write(path: string, content: string) {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, content);
  }
  async function skill(
    path: string,
    description = "A fixture skill",
    extra = ""
  ) {
    await write(
      join(path, "SKILL.md"),
      `---\nname: sample\ndescription: ${description}\n${extra}---\nFixture body\n`
    );
  }
  return { root, home, cwd, write, skill };
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(path: string) {
    const info = await stat(path);
    result[path] = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    if (info.isDirectory()) {
      for (const name of await readdir(path)) {
        await walk(join(path, name));
      }
    }
  }
  await walk(root);
  return result;
}

test("layered inventory is read-only and counts canonical symlink content only once", async () => {
  const f = await fixture();
  const canonical = join(f.home, ".ai", "skills", "sample");
  await f.skill(canonical);
  await mkdir(join(f.home, ".codex", "skills"), { recursive: true });
  await symlink(canonical, join(f.home, ".codex", "skills", "sample"));
  await f.skill(join(f.cwd, ".agents", "skills", "sample"));
  await f.write(
    join(f.home, ".codex", "config.toml"),
    '[mcp_servers.example]\ncommand="must-never-run"\n[mcp_servers.example.env]\nAPI_KEY="fixture-private-value"\n'
  );
  await f.write(
    join(f.cwd, ".codex", "config.toml"),
    "[mcp_servers.example]\nenabled=false\n"
  );
  const before = await snapshot(f.root);
  const report = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["codex"],
  });
  expect(await snapshot(f.root)).toEqual(before);
  const session = report.sessions[0];
  expect(session?.resources.filter((r) => r.kind === "skill")).toHaveLength(3);
  expect(
    session?.resources.filter(
      (r) => r.kind === "skill" && r.use === "effective"
    )
  ).toHaveLength(2);
  expect(
    session?.resources.find((r) => r.kind === "skill" && r.layer === "global")
      ?.use
  ).toBe("canonical-only");
  expect(
    session?.resources.filter((r) => r.kind === "mcp").map((r) => r.use)
  ).toEqual(["disabled", "shadowed"]);
  expect(JSON.stringify(report)).not.toContain("fixture-private-value");
  expect(JSON.stringify(report)).not.toContain("must-never-run");
});

test("discovers multiple account homes and never mixes their MCP definitions", async () => {
  const f = await fixture();
  for (const name of [".codex", ".codex-secondary"]) {
    await f.write(
      join(f.home, name, "config.toml"),
      `[mcp_servers."${name}"]\ncommand="unused"`
    );
  }
  await f.write(
    join(
      f.home,
      ".local",
      "share",
      "agent-accounts",
      "seat",
      "codex",
      "config.toml"
    ),
    '[mcp_servers.third]\ncommand="unused"'
  );
  const report = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["codex"],
  });
  expect(report.sessions).toHaveLength(3);
  for (const session of report.sessions) {
    expect(session.resources.filter((r) => r.kind === "mcp")).toHaveLength(1);
    expect(session.tokens.unmeasuredMcpServers).toBe(1);
    expect(session.tokens.completeness).toBe("partial");
  }
});

test("models budgets, truncation and separately deferred skill bodies", async () => {
  const f = await fixture();
  await f.skill(join(f.home, ".claude", "skills", "sample"), "x".repeat(2000));
  await f.skill(join(f.home, ".codex", "skills", "sample"), "x".repeat(2000));
  const report = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    contextTokens: 1000,
  });
  const [codex, claude] = report.sessions;
  expect(codex?.tokens.skillBudgetTokens).toBe(20);
  expect(codex?.tokens.skillListing).toBe(20);
  expect(claude?.tokens.skillBudgetTokens).toBe(10);
  expect(claude?.tokens.skillListingBeforeBudget).toBe(
    Math.ceil(("sample: ".length + 1536 + 1) / 4)
  );
  expect(claude?.tokens.deferredMeasured).toBeGreaterThan(500);
  await f.write(
    join(f.home, ".codex", "config.toml"),
    "[skills]\nmax_context_tokens=7\n"
  );
  const configured = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["codex"],
  });
  expect(configured.sessions[0]?.tokens.skillListing).toBe(7);
});

test("Claude local MCP overrides project and user; offline schema totals omit secrets", async () => {
  const f = await fixture();
  await mkdir(join(f.home, ".claude"));
  await f.write(
    join(f.home, ".claude.json"),
    JSON.stringify({
      mcpServers: { example: { command: "unused" } },
      projects: {
        [f.cwd]: {
          mcpServers: {
            example: {
              tools: [{ name: "lookup", inputSchema: { type: "object" } }],
              instructions: "Lookup fixtures",
            },
          },
        },
      },
    })
  );
  await f.write(
    join(f.cwd, ".mcp.json"),
    JSON.stringify({ mcpServers: { example: { command: "unused" } } })
  );
  const report = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["claude"],
  });
  const session = report.sessions[0];
  expect(session?.resources.filter((r) => r.use === "effective")).toHaveLength(
    1
  );
  expect(session?.resources.find((r) => r.use === "effective")?.definedAt).toBe(
    join(f.home, ".claude.json")
  );
  expect(session?.tokens.mcpNamesAndInstructions).toBeGreaterThan(0);
  expect(session?.tokens.deferredMeasured).toBeGreaterThan(0);
  expect(session?.tokens.unmeasuredMcpServers).toBe(0);
});

test("enabled installed plugins expose their offline skills and MCP without executing them", async () => {
  const f = await fixture();
  const account = join(f.home, ".claude");
  const installed = join(account, "plugins", "cache", "fixture", "1");
  await f.skill(join(installed, "skills", "sample"));
  await f.write(
    join(installed, ".mcp.json"),
    '{"mcpServers":{"example":{"command":"must-never-run"}}}'
  );
  await f.write(
    join(account, "settings.json"),
    '{"enabledPlugins":{"fixture@market":true,"off@market":false}}'
  );
  await f.write(
    join(account, "plugins", "installed_plugins.json"),
    JSON.stringify({
      plugins: { "fixture@market": [{ installPath: installed }] },
    })
  );
  const report = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["claude"],
  });
  expect(report.sessions[0]?.resources.map((r) => r.kind)).toEqual([
    "mcp",
    "plugin",
    "plugin",
    "skill",
  ]);
  expect(
    report.sessions[0]?.resources.find((r) => r.name === "off@market")?.use
  ).toBe("disabled");
  expect(JSON.stringify(report)).not.toContain("must-never-run");
});

test("CLI JSON and table reports leave fixture HOME and project unchanged", async () => {
  const f = await fixture();
  await f.skill(join(f.home, ".codex", "skills", "sample"));
  const cli = join(import.meta.dir, "index.ts");
  const before = await snapshot(f.root);
  for (const flags of [["--json"], []]) {
    const child = Bun.spawn(
      [process.execPath, cli, "inventory", "--harness", "codex", ...flags],
      {
        cwd: f.cwd,
        env: {
          ...process.env,
          HOME: f.home,
          CODEX_HOME: join(f.home, ".codex"),
          CLAUDE_CONFIG_DIR: join(f.home, ".claude"),
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    if (flags.length) {
      expect(JSON.parse(stdout).sessions[0].resources[0].name).toBe("sample");
    } else {
      expect(stdout).toContain("KIND\tNAME\tLAYER");
      expect(stdout).toContain("Estimated measured tokens");
    }
  }
  expect(await snapshot(f.root)).toEqual(before);
});

test("instruction references are visible without claiming native loading", async () => {
  const f = await fixture();
  await f.skill(join(f.cwd, "references", "sample"));
  await f.write(
    join(f.cwd, "AGENTS.md"),
    "Read [sample](references/sample/SKILL.md).\n"
  );
  const report = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["codex"],
  });
  expect(report.sessions[0]?.resources[0]?.use).toBe("unknown");
  expect(report.sessions[0]?.tokens.alwaysMeasured).toBe(0);
});

test("custom Claude homes use their internal user config", async () => {
  const f = await fixture();
  const account = join(f.home, "custom");
  await f.write(
    join(account, ".claude.json"),
    '{"mcpServers":{"internal":{"command":"unused"}}}'
  );
  const report = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["claude"],
    homes: [account],
  });
  expect(report.sessions[0]?.resources[0]?.name).toBe("internal");
  expect(report.sessions[0]?.tokens.unmeasuredMcpServers).toBe(1);
});

test("Codex plugins resolve a single offline cache version and namespace its skills", async () => {
  const f = await fixture();
  const account = join(f.home, ".codex");
  await f.write(
    join(account, "config.toml"),
    '[plugins."fixture@market"]\nenabled=true\n'
  );
  await f.skill(
    join(
      account,
      "plugins",
      "cache",
      "market",
      "fixture",
      "1",
      "skills",
      "sample"
    )
  );
  const report = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["codex"],
  });
  expect(
    report.sessions[0]?.resources.find((r) => r.kind === "skill")?.name
  ).toBe("fixture:sample");
  expect(report.sessions[0]?.tokens.alwaysMeasured).toBeGreaterThan(0);
  await f.skill(
    join(
      account,
      "plugins",
      "cache",
      "market",
      "fixture",
      "2",
      "skills",
      "sample"
    )
  );
  const ambiguous = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["codex"],
  });
  expect(ambiguous.sessions[0]?.resources[0]?.use).toBe("unknown");
  expect(ambiguous.sessions[0]?.tokens.alwaysMeasured).toBe(0);
});
