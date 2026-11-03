import { expect, spyOn, test } from "bun:test";
import fs, { mkdir, mkdtemp, readdir, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
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

async function captureInventoryReads<T>(run: () => Promise<T>) {
  const reads: { operation: string; path: string }[] = [];
  function traced<F extends object>(operation: string, fn: F): F {
    return new Proxy(fn, {
      apply(target, thisArg, args) {
        reads.push({ operation, path: String(args[0]) });
        return Reflect.apply(
          target as (...values: unknown[]) => unknown,
          thisArg,
          args
        );
      },
    });
  }
  const originals = {
    file: Bun.file.bind(Bun),
    readdir: fs.readdir.bind(fs),
    realpath: fs.realpath.bind(fs),
    readlink: fs.readlink.bind(fs),
  };
  const spies = [
    spyOn(Bun, "file").mockImplementation(traced("file", originals.file)),
    spyOn(fs, "readdir").mockImplementation(
      traced("readdir", originals.readdir)
    ),
    spyOn(fs, "realpath").mockImplementation(
      traced("realpath", originals.realpath)
    ),
    spyOn(fs, "readlink").mockImplementation(
      traced("readlink", originals.readlink)
    ),
  ];
  try {
    return { result: await run(), reads };
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
}
async function isolatedReads(
  reads: { operation: string; path: string }[],
  isolated: string
) {
  const root = await fs.realpath(isolated);
  const violations: { operation: string; path: string }[] = [];
  for (const read of reads) {
    // readlink reads the link entry itself; the other operations follow it.
    const actual = await (read.operation === "readlink"
      ? fs
          .realpath(dirname(read.path))
          .then((parent) => join(parent, basename(read.path)))
      : fs.realpath(read.path)
    ).catch(() => null);
    // Resolving the boundary entry itself is metadata-only. Listing that root
    // or accessing anything beneath it would inspect isolated contents.
    if (
      actual &&
      (actual.startsWith(`${root}${sep}`) ||
        (actual === root && read.operation === "readdir"))
    ) {
      violations.push(read);
    }
  }
  return violations;
}

test("layered inventory is read-only and counts canonical symlink content only once", async () => {
  const f = await fixture();
  const canonical = join(f.home, ".ai", "skills", "sample");
  await f.skill(canonical);
  await mkdir(join(f.home, ".agents", "skills"), { recursive: true });
  await symlink(canonical, join(f.home, ".agents", "skills", "sample"));
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
    session?.resources.find((r) => r.definedAt === join(canonical, "SKILL.md"))
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
  await f.skill(join(f.home, ".agents", "skills", "sample"), "x".repeat(2000));
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

test("Claude personal skills override project skills while MCP retains its own order", async () => {
  const f = await fixture();
  await f.skill(join(f.home, ".claude", "skills", "sample"));
  await f.skill(join(f.cwd, ".claude", "skills", "sample"));
  const report = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["claude"],
  });
  expect(report.sessions[0]?.resources.map((r) => [r.layer, r.use])).toEqual([
    ["account", "effective"],
    ["project", "shadowed"],
  ]);
});

test("outside Git, ancestors and account configs are not project sources", async () => {
  const f = await fixture();
  const cwd = join(f.home, "scratch");
  await mkdir(cwd);
  await f.skill(join(f.home, ".claude", "skills", "sample"));
  await f.write(
    join(f.home, ".codex", "config.toml"),
    '[mcp_servers.example]\ncommand="unused"'
  );
  const report = await buildHarnessInventory({ homeDir: f.home, cwd });
  expect(
    report.sessions
      .flatMap((s) => s.resources)
      .some((r) => r.layer === "project")
  ).toBe(false);
});

test("Claude description falls back to the first body line, while Codex requires metadata", async () => {
  const f = await fixture();
  await f.write(
    join(f.home, ".claude", "skills", "sample", "SKILL.md"),
    "---\nname: sample\n---\n\nFixture summary\n"
  );
  await f.write(
    join(f.home, ".agents", "skills", "sample", "SKILL.md"),
    "---\nname: sample\n---\n\nFixture summary\n"
  );
  const report = await buildHarnessInventory({ homeDir: f.home, cwd: f.cwd });
  expect(report.sessions[0]?.resources).toHaveLength(0);
  expect(report.sessions[1]?.resources[0]?.alwaysTokens).toBe(
    Math.ceil("sample: Fixture summary\n".length / 4)
  );
});

test("Claude MCP approval and local toggles exclude unavailable offline catalogs", async () => {
  const f = await fixture();
  await mkdir(join(f.home, ".claude"));
  await f.write(
    join(f.cwd, ".mcp.json"),
    '{"mcpServers":{"example":{"tools":[{"name":"lookup"}]}}}'
  );
  const pending = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["claude"],
  });
  expect(pending.sessions[0]?.resources[0]?.reason).toContain(
    "pending approval"
  );
  expect(pending.sessions[0]?.tokens.alwaysMeasured).toBe(0);
  await f.write(
    join(f.home, ".claude.json"),
    JSON.stringify({
      mcpServers: { user: { tools: [{ name: "lookup" }] } },
      projects: {
        [f.cwd]: {
          enabledMcpjsonServers: ["example"],
          disabledMcpServers: ["user"],
        },
      },
    })
  );
  const approved = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["claude"],
  });
  expect(
    approved.sessions[0]?.resources.find((r) => r.name === "example")?.use
  ).toBe("effective");
  expect(
    approved.sessions[0]?.resources.find((r) => r.name === "user")?.use
  ).toBe("disabled");
  expect(approved.sessions[0]?.tokens.alwaysMeasured).toBeGreaterThan(0);
  await f.write(
    join(f.cwd, ".claude", "settings.json"),
    '{"disabledMcpjsonServers":["example"]}'
  );
  const disabled = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["claude"],
  });
  expect(disabled.sessions[0]?.tokens.alwaysMeasured).toBe(0);
});

test("Codex selectors match by name or expanded home path and last match wins", async () => {
  const f = await fixture();
  const path = join(f.home, ".agents", "skills", "sample");
  await f.skill(path);
  await f.write(
    join(f.home, ".codex", "config.toml"),
    '[[skills.config]]\nname="sample"\nenabled=false\n[[skills.config]]\npath="~/.agents/skills/sample/SKILL.md"\nenabled=true\n'
  );
  const on = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["codex"],
  });
  expect(on.sessions[0]?.resources[0]?.use).toBe("effective");
  expect(on.sessions[0]?.resources[0]?.alwaysTokens).toBe(
    Math.ceil(
      `sample: A fixture skill (${join(path, "SKILL.md")})\n`.length / 4
    )
  );
  await f.write(
    join(f.cwd, ".codex", "config.toml"),
    '[[skills.config]]\nname="sample"\nenabled=false\n[skills]\nmax_context_tokens=20000\n'
  );
  const off = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["codex"],
  });
  expect(off.sessions[0]?.resources[0]?.use).toBe("disabled");
  expect(off.sessions[0]?.tokens.alwaysMeasured).toBe(0);
  expect(off.sessions[0]?.tokens.skillBudgetTokens).toBe(10_000);
});

test("Claude final skillOverrides settings win without listing manual-only skills", async () => {
  const f = await fixture();
  await f.skill(join(f.home, ".claude", "skills", "sample"));
  await f.write(
    join(f.home, ".claude", "settings.json"),
    '{"skillOverrides":{"sample":"off"}}'
  );
  await f.write(
    join(f.cwd, ".claude", "settings.json"),
    '{"skillOverrides":{"sample":"on"}}'
  );
  const on = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["claude"],
  });
  expect(on.sessions[0]?.tokens.alwaysMeasured).toBeGreaterThan(0);
  await f.skill(
    join(f.home, ".claude", "skills", "sample"),
    "A fixture skill",
    "disable-model-invocation: true\n"
  );
  await f.write(
    join(f.cwd, ".claude", "settings.local.json"),
    '{"skillOverrides":{"sample":"name-only"}}'
  );
  const manual = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["claude"],
  });
  expect(manual.sessions[0]?.tokens.alwaysMeasured).toBe(0);
});

test("legacy Codex skill directories remain visible as uncertain candidates", async () => {
  const f = await fixture();
  await f.skill(join(f.home, ".codex", "skills", "sample"));
  await f.skill(join(f.cwd, ".codex", "skills", "sample"));
  const report = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["codex"],
  });
  expect(report.sessions[0]?.resources.map((r) => r.use)).toEqual([
    "unknown",
    "unknown",
  ]);
  expect(report.sessions[0]?.tokens.alwaysMeasured).toBe(0);
});

test("Claude scoped plugin installs resolve this project and retain all declarations", async () => {
  const f = await fixture();
  const account = join(f.home, ".claude");
  const userInstall = join(account, "plugins", "cache", "fixture", "1");
  const projectInstall = join(account, "plugins", "cache", "fixture", "2");
  await f.skill(join(userInstall, "skills", "sample"));
  await f.skill(join(projectInstall, "skills", "sample"), "Project fixture");
  await f.write(
    join(account, "settings.json"),
    '{"enabledPlugins":{"fixture@market":true}}'
  );
  await f.write(
    join(f.cwd, ".claude", "settings.json"),
    '{"enabledPlugins":{"fixture@market":true}}'
  );
  await f.write(
    join(account, "plugins", "installed_plugins.json"),
    JSON.stringify({
      plugins: {
        "fixture@market": [
          { scope: "user", installPath: userInstall },
          { scope: "project", projectPath: f.cwd, installPath: projectInstall },
          {
            scope: "project",
            projectPath: join(f.root, "other"),
            installPath: userInstall,
          },
        ],
      },
    })
  );
  const report = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["claude"],
  });
  expect(
    report.sessions[0]?.resources
      .filter((r) => r.kind === "plugin")
      .map((r) => r.use)
  ).toEqual(["effective", "shadowed"]);
  expect(
    report.sessions[0]?.resources.find((r) => r.kind === "skill")?.definedAt
  ).toContain(join("fixture", "2"));
});

test("missing instruction skill links never fall back to recursive scanning", async () => {
  const f = await fixture();
  await f.skill(join(f.root, "sample"));
  await f.write(join(f.cwd, "AGENTS.md"), "Read [missing](../SKILL.md).\n");
  const report = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["codex"],
  });
  expect(report.sessions[0]?.resources).toHaveLength(0);
  expect(
    report.sessions[0]?.warnings.some((w) =>
      w.startsWith("Missing referenced skill:")
    )
  ).toBe(true);
});

test("isolated account homes are unread by default, including aliases, and require explicit opt-in", async () => {
  const f = await fixture();
  const isolated = join(
    f.home,
    ".local",
    "share",
    "agent-accounts",
    "fixture-ln",
    "codex"
  );
  await f.write(
    join(isolated, "config.toml"),
    '[mcp_servers.isolated_fixture]\ncommand="unused"'
  );
  await f.write(
    join(f.home, ".claude-fixture-ln", "settings.json"),
    '{"mcpServers":{"isolated_fixture":{"command":"unused"}}}'
  );
  await symlink(isolated, join(f.home, ".codex-alias"));
  const before = await snapshot(f.root);
  const report = await buildHarnessInventory({ homeDir: f.home, cwd: f.cwd });
  expect(report.warnings).toEqual(["skipped: ln-isolated"]);
  expect(JSON.stringify(report)).not.toContain("isolated_fixture");
  expect(JSON.stringify(report)).not.toContain("fixture-ln");
  const explicit = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["codex"],
    homes: [isolated],
  });
  expect(explicit.sessions).toHaveLength(0);
  expect(explicit.warnings).toEqual(["skipped: ln-isolated"]);
  const included = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["codex"],
    homes: [isolated],
    includeLn: true,
  });
  expect(included.warnings).toEqual([]);
  expect(included.sessions[0]?.resources[0]?.name).toBe("isolated_fixture");
  expect(await snapshot(f.root)).toEqual(before);
});

test("CLI reads isolated homes only with include-ln", async () => {
  const f = await fixture();
  const account = join(f.home, "fixture-ln");
  await f.write(
    join(account, "config.toml"),
    '[mcp_servers.isolated_fixture]\ncommand="unused"'
  );
  for (const include of [false, true]) {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "index.ts"),
        "inventory",
        "--harness",
        "codex",
        "--home",
        account,
        "--json",
        ...(include ? ["--include-ln"] : []),
      ],
      {
        cwd: f.cwd,
        env: { ...process.env, HOME: f.home },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const report = JSON.parse(stdout);
    expect(report.sessions.length).toBe(include ? 1 : 0);
    expect(report.warnings).toEqual(include ? [] : ["skipped: ln-isolated"]);
  }
});

test("ordinary skill names ending in the isolation suffix are still inventoried", async () => {
  const f = await fixture();
  await f.skill(join(f.home, ".agents", "skills", "fixture-ln"));
  const report = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["codex"],
  });
  expect(report.sessions[0]?.resources[0]?.use).toBe("effective");
  expect(report.warnings).toEqual([]);
});

test("all explicit account boundaries precede reads through earlier-session skill aliases", async () => {
  const f = await fixture();
  const normal = join(f.home, ".codex");
  const isolated = join(f.root, "fixture-ln");
  await f.write(join(normal, "config.toml"), "# Fixture account\n");
  await f.skill(join(isolated, "skills", "private"));
  await f.skill(join(f.cwd, ".agents", "skills", "sample"));
  await mkdir(join(normal, "skills"), { recursive: true });
  await symlink(
    join(isolated, "skills", "private"),
    join(normal, "skills", "alias")
  );
  for (const homes of [
    [normal, isolated],
    [isolated, normal],
  ]) {
    const { result, reads } = await captureInventoryReads(() =>
      buildHarnessInventory({
        homeDir: f.home,
        cwd: f.cwd,
        harnesses: ["codex"],
        homes,
      })
    );
    expect(result.warnings).toEqual(["skipped: ln-isolated"]);
    expect(result.sessions).toHaveLength(1);
    expect(
      result.sessions[0]?.resources.some((resource) =>
        resource.definedAt.includes("alias")
      )
    ).toBe(false);
    for (const operation of ["file", "readdir", "realpath", "readlink"]) {
      expect(reads.some((read) => read.operation === operation)).toBe(true);
    }
    expect(await isolatedReads(reads, isolated)).toEqual([]);
  }
});

test("other-harness environment homes are registered before resource discovery", async () => {
  const f = await fixture();
  const isolated = join(f.root, "fixture-ln");
  await f.skill(join(isolated, "skills", "private"));
  await f.skill(join(f.cwd, ".agents", "skills", "sample"));
  await mkdir(join(f.home, ".codex", "skills"), { recursive: true });
  await symlink(
    join(isolated, "skills", "private"),
    join(f.home, ".codex", "skills", "alias")
  );
  const previous = {
    HOME: process.env.HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  try {
    process.env.HOME = f.home;
    process.env.CODEX_HOME = join(f.home, ".codex");
    process.env.CLAUDE_CONFIG_DIR = isolated;
    const { result, reads } = await captureInventoryReads(() =>
      buildHarnessInventory({
        homeDir: f.home,
        cwd: f.cwd,
        harnesses: ["codex"],
      })
    );
    expect(result.warnings).toEqual(["skipped: ln-isolated"]);
    expect(
      result.sessions[0]?.resources.some((resource) =>
        resource.definedAt.includes("alias")
      )
    ).toBe(false);
    expect(await isolatedReads(reads, isolated)).toEqual([]);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("project names ending in the isolation suffix are not account boundaries", async () => {
  const f = await fixture();
  const cwd = join(f.root, "fixture-ln", "claude");
  await mkdir(join(cwd, ".git"), { recursive: true });
  await f.skill(join(cwd, ".claude", "skills", "sample"));
  const report = await buildHarnessInventory({
    homeDir: f.home,
    cwd,
    harnesses: ["claude"],
  });
  expect(report.warnings).toEqual([]);
  expect(report.sessions[0]?.resources[0]?.use).toBe("effective");
});

test("isolated account aliases register their physical roots before other aliases run", async () => {
  const f = await fixture();
  const physical = join(f.root, "physical-account");
  await f.write(
    join(physical, "config.toml"),
    '[mcp_servers.isolated_fixture]\ncommand="unused"'
  );
  await f.skill(join(physical, "skills", "private"));
  const isolated = join(f.home, ".codex-fixture-ln");
  const normal = join(f.home, ".codex-normal");
  await symlink(physical, isolated);
  await symlink(physical, normal);
  for (const homes of [undefined, [normal, isolated], [isolated, normal]]) {
    const { result, reads } = await captureInventoryReads(() =>
      buildHarnessInventory({
        homeDir: f.home,
        cwd: f.cwd,
        harnesses: ["codex"],
        homes,
      })
    );
    expect(result.sessions).toHaveLength(0);
    expect(result.warnings).toEqual(["skipped: ln-isolated"]);
    expect(JSON.stringify(result)).not.toContain("isolated_fixture");
    await expect(isolatedReads(reads, physical)).resolves.toEqual([]);
  }
  const included = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
    harnesses: ["codex"],
    includeLn: true,
  });
  expect(included.sessions).toHaveLength(2);
  expect(
    included.sessions[0]?.resources.some((r) => r.name === "isolated_fixture")
  ).toBe(true);
});

test("project plugin installations stay effective beneath the repository root", async () => {
  const f = await fixture();
  const account = join(f.home, ".claude");
  const userInstall = join(account, "plugins", "cache", "fixture", "1");
  const projectInstall = join(account, "plugins", "cache", "fixture", "2");
  const nested = join(f.cwd, "src", "nested");
  await mkdir(nested, { recursive: true });
  await f.skill(join(userInstall, "skills", "sample"), "User fixture");
  await f.skill(join(projectInstall, "skills", "sample"), "Project fixture");
  await f.write(
    join(f.cwd, ".claude", "settings.json"),
    '{"enabledPlugins":{"fixture@market":true}}'
  );
  for (const includeUser of [false, true]) {
    await f.write(
      join(account, "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: {
          "fixture@market": [
            {
              scope: "project",
              projectPath: f.cwd,
              installPath: projectInstall,
            },
            ...(includeUser
              ? [{ scope: "user", installPath: userInstall }]
              : []),
            {
              scope: "project",
              projectPath: join(f.root, "other"),
              installPath: userInstall,
            },
          ],
        },
      })
    );
    const rootReport = await buildHarnessInventory({
      homeDir: f.home,
      cwd: f.cwd,
      harnesses: ["claude"],
    });
    const nestedReport = await buildHarnessInventory({
      homeDir: f.home,
      cwd: nested,
      harnesses: ["claude"],
    });
    expect(nestedReport.sessions[0]?.resources).toEqual(
      rootReport.sessions[0]?.resources
    );
    expect(nestedReport.sessions[0]?.tokens).toEqual(
      rootReport.sessions[0]?.tokens
    );
    expect(
      nestedReport.sessions[0]?.resources.find((r) => r.kind === "skill")
        ?.definedAt
    ).toContain(join("fixture", "2"));
  }
});

test("project canonical sources and duplicate locations survive nested invocation", async () => {
  const f = await fixture();
  const canonical = join(f.cwd, ".ai");
  const nested = join(f.cwd, "src", "nested");
  await mkdir(join(nested, ".ai"), { recursive: true });
  await f.skill(join(canonical, "skills", "sample"));
  await f.write(
    join(canonical, "mcp", "servers.json"),
    '{"servers":{"example":{"command":"unused"}}}'
  );
  await f.write(
    join(canonical, "mcp", "servers.local.json"),
    '{"servers":{"overlay":{"command":"unused"}}}'
  );
  for (const directory of [".agents", ".claude"]) {
    await mkdir(join(f.cwd, directory, "skills"), { recursive: true });
    await symlink(
      join(canonical, "skills", "sample"),
      join(f.cwd, directory, "skills", "sample")
    );
  }
  const before = await snapshot(f.root);
  const rootReport = await buildHarnessInventory({
    homeDir: f.home,
    cwd: f.cwd,
  });
  const nestedReport = await buildHarnessInventory({
    homeDir: f.home,
    cwd: nested,
  });
  expect(await snapshot(f.root)).toEqual(before);
  for (const [index, session] of nestedReport.sessions.entries()) {
    expect(rootReport.sessions[index]?.resources).toEqual(session.resources);
    expect(rootReport.sessions[index]?.tokens).toEqual(session.tokens);
    const sources = session.resources.filter((r) => r.use === "canonical-only");
    expect(sources.map((r) => r.name).sort()).toEqual([
      "example",
      "overlay",
      "sample",
    ]);
    expect(sources.every((r) => r.layer === "project")).toBe(true);
    expect(sources.find((r) => r.kind === "skill")?.duplicates).toHaveLength(1);
  }
  const nearer = join(f.cwd, "src", ".ai");
  await f.write(
    join(nearer, "mcp", "servers.json"),
    '{"servers":{"nearer":{"command":"unused"}}}'
  );
  const nearestReport = await buildHarnessInventory({
    homeDir: f.home,
    cwd: nested,
  });
  for (const session of nearestReport.sessions) {
    expect(
      session.resources
        .filter((r) => r.use === "canonical-only")
        .map((r) => r.name)
    ).toEqual(["nearer"]);
  }
});
