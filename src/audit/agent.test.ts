import { afterAll, beforeAll, expect, test } from "bun:test";
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
import { basename, delimiter, dirname, join } from "node:path";
import {
  evaluateAgentAudit,
  makeAgentRuntimeDir,
  runAgentAudit,
} from "./agent";
import { persistAuditReport } from "./report-persistence";

const SHA256_RE = /^[a-f0-9]{64}$/;
const AUDIT_DISCOVERY_DRIFT_RE =
  /Audit (?:source discovery changed during evaluation|directory changed between reads:)/;

async function writeFile(p: string, content: string) {
  await mkdir(dirname(p), { recursive: true });
  await Bun.write(p, content);
}

async function snapshotFixtureTree(root: string): Promise<string[]> {
  const snapshot: string[] = [];
  const walk = async (dir: string, prefix = ""): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const metadata = await stat(path);
      if (entry.isDirectory()) {
        snapshot.push(`d:${relativePath}:${metadata.mode}`);
        await walk(path, relativePath);
      } else if (entry.isFile()) {
        snapshot.push(
          `f:${relativePath}:${metadata.mode}:${(await readFile(path)).toString("base64")}`
        );
      } else {
        throw new Error(`Unsupported fixture entry: ${relativePath}`);
      }
    }
  };
  await walk(root);
  return snapshot;
}

interface SupportLimitFixture {
  dir: string;
  home: string;
}

const supportLimitFixtures = new Map<
  "exact" | "overflow",
  SupportLimitFixture
>();

beforeAll(async () => {
  const createdRoots: string[] = [];
  try {
    for (const [kind, count] of [
      ["exact", 2048],
      ["overflow", 2049],
    ] as const) {
      const dir = await mkdtemp(
        join(tmpdir(), `facult-agent-support-limit-${kind}-`)
      );
      createdRoots.push(dir);
      const home = join(dir, "home");
      const skillDir = join(home, ".ai", "skills", "bounded-skill");
      const referencesDir = join(skillDir, "references");
      await writeFile(join(skillDir, "SKILL.md"), "Hello\n");
      await mkdir(referencesDir, { recursive: true });
      for (let start = 0; start < count; start += 128) {
        const batchSize = Math.min(128, count - start);
        await Promise.all(
          Array.from({ length: batchSize }, (_, offset) =>
            Bun.write(join(referencesDir, `${start + offset}.txt`), "")
          )
        );
      }
      supportLimitFixtures.set(kind, { dir, home });
    }
  } catch (error) {
    await Promise.all(
      createdRoots.map((root) => rm(root, { force: true, recursive: true }))
    );
    supportLimitFixtures.clear();
    throw error;
  }
}, 15_000);

afterAll(async () => {
  await Promise.all(
    [...supportLimitFixtures.values()].map((fixture) =>
      rm(fixture.dir, { force: true, recursive: true })
    )
  );
  supportLimitFixtures.clear();
});

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

async function supportingFileFixture() {
  const dir = await mkdtemp(join(tmpdir(), "facult-agent-provenance-"));
  const home = join(dir, "home");
  const skillDir = join(home, ".ai", "skills", "ok-skill");
  const supportA = join(skillDir, "references", "a.md");
  const supportB = join(skillDir, "scripts", "b.ts");
  await writeFile(join(skillDir, "SKILL.md"), "Hello\n");
  await writeFile(supportB, "export const b = 1;\n");
  await writeFile(supportA, "alpha\n");
  return { dir, home, skillDir, supportA, supportB };
}

test("agent audit binds deterministic supporting-file bytes", async () => {
  const { dir, home, skillDir, supportA, supportB } =
    await supportingFileFixture();

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
});

test("agent audit accepts the exact support-entry budget", async () => {
  const fixture = supportLimitFixtures.get("exact")!;
  let runnerCalls = 0;
  const exactLimit = await runAgentAudit({
    argv: ["bounded-skill", "--with", "claude", "--max-items", "1"],
    cwd: fixture.dir,
    from: [join(fixture.home, ".ai")],
    homeDir: fixture.home,
    includeConfigFrom: false,
    runner: () => {
      runnerCalls += 1;
      return Promise.resolve({
        output: { passed: true, findings: [], notes: "ok" },
      });
    },
  });
  expect(exactLimit.results[0]?.passed).toBe(true);
  expect(runnerCalls).toBe(1);
});

test("agent audit rejects support-entry overflow before materialization", async () => {
  const fixture = supportLimitFixtures.get("overflow")!;
  let runnerCalls = 0;
  await expect(
    runAgentAudit({
      argv: ["bounded-skill", "--with", "claude", "--max-items", "1"],
      cwd: fixture.dir,
      from: [join(fixture.home, ".ai")],
      homeDir: fixture.home,
      includeConfigFrom: false,
      runner: () => {
        runnerCalls += 1;
        return Promise.resolve({
          output: { passed: true, findings: [], notes: "ok" },
        });
      },
    })
  ).rejects.toThrow("Audit discovery tree exceeds entry limit");
  expect(runnerCalls).toBe(0);
});

test("agent audit rejects supporting-file drift before persistence", async () => {
  const { dir, home, supportA } = await supportingFileFixture();

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
});

test("agent audit rejects supporting-file drift during an agent call", async () => {
  const { dir, home, supportA } = await supportingFileFixture();

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

test("agent audit rejects a previously undiscovered top-level skill added during a long agent call", async () => {
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
  ).rejects.toThrow(AUDIT_DISCOVERY_DRIFT_RE);
});

test("agent audit aborts after final discovery before snapshot validation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-agent-final-abort-"));
  const home = join(dir, "home");
  const skillPath = join(home, ".ai", "skills", "initial", "SKILL.md");
  await writeFile(skillPath, "initial\n");
  const controller = new AbortController();

  await expect(
    evaluateAgentAudit({
      afterFinalDiscovery: async () => {
        controller.abort();
        await Bun.write(skillPath, "drift after final discovery\n");
      },
      argv: ["initial", "--with", "claude", "--max-items", "1"],
      cwd: dir,
      homeDir: home,
      runner: async () => ({
        output: { passed: true, findings: [], notes: "ok" },
      }),
      signal: controller.signal,
    })
  ).rejects.toThrow("agent-subprocess-interrupted");
});

test("agent runtime setup removes partial temporary directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "facult-agent-runtime-fault-"));
  try {
    await expect(
      makeAgentRuntimeDir(root, (path) => {
        if (basename(path) === "codex-home") {
          return Promise.reject(new Error("fixture runtime setup failure"));
        }
        return Promise.resolve();
      })
    ).rejects.toThrow("fixture runtime setup failure");
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
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
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
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

type SubprocessLifecyclePhase =
  | "environment-auth"
  | "native-auth"
  | "profile-precondition"
  | "pipe-flood";

interface SubprocessLifecycleFixture {
  authMarkers: { claude: string; codex: string };
  bin: string;
  dir: string;
  home: string;
  pipeFloodMarker: string;
  recordPath: string;
  scratch: string;
  scratchCanonical: string;
}

const subprocessLifecycleFixtures = new Map<
  string,
  SubprocessLifecycleFixture
>();

function subprocessLifecycleLauncher(args: {
  nodeRuntime: string;
  platform: "posix" | "win32";
  sourcePath: string;
  tool: "claude" | "codex";
}): { contents: string; fileName: string } {
  if (args.platform === "win32") {
    const nodeRuntime = args.nodeRuntime.replaceAll("%", "%%");
    const sourcePath = args.sourcePath.replaceAll("%", "%%");
    return {
      contents: `@echo off\r\n"${nodeRuntime}" "${sourcePath}" %*\r\n`,
      fileName: `${args.tool}.cmd`,
    };
  }
  const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  return {
    contents: `#!/bin/sh\nexec ${shellQuote(args.nodeRuntime)} ${shellQuote(args.sourcePath)} "$@"\n`,
    fileName: args.tool,
  };
}

beforeAll(async () => {
  const createdRoots: string[] = [];
  try {
    const nodeRuntime = Bun.which("node");
    if (!nodeRuntime) {
      throw new Error("Node is required for the cross-platform agent fixture");
    }
    for (const tool of ["claude", "codex"] as const) {
      for (const phase of [
        "environment-auth",
        "native-auth",
        "profile-precondition",
        "pipe-flood",
      ] as const) {
        const dir = await mkdtemp(
          join(tmpdir(), `facult-agent-subprocess-${tool}-${phase}-`)
        );
        createdRoots.push(dir);
        const home = join(dir, "audited-home");
        const bin = join(dir, "bin");
        const scratch = await mkdtemp(
          join(tmpdir(), `facult-agent-scratch-${tool}-${phase}-`)
        );
        createdRoots.push(scratch);
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
        if (phase !== "pipe-flood") {
          await writeFile(authMarkers[tool], `{"fixture":"${tool}-profile"}\n`);
        }

        const recordPath = join(dir, `${tool}-record.json`);
        const pipeFloodMarker = join(dir, `${tool}-pipe-flood`);
        const sourcePath = join(dir, `${tool}-fixture.cjs`);
        await Bun.write(
          sourcePath,
          [
            `const { existsSync, readdirSync, writeFileSync } = require("node:fs");`,
            `const { join } = require("node:path");`,
            "void (async () => {",
            "const args = process.argv.slice(2);",
            `const credentialPath = ${JSON.stringify(tool)} === "codex" ? join(process.env.CODEX_HOME, "auth.json") : join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json");`,
            `const profileDir = ${JSON.stringify(tool)} === "codex" ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR;`,
            `const authEnvironmentPresent = ${JSON.stringify(tool)} === "codex" ? Boolean(process.env.OPENAI_API_KEY) : Boolean(process.env.ANTHROPIC_API_KEY);`,
            `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ args, authEnvironmentPresent, credentialPresent: existsSync(credentialPath), cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), profileEntries: readdirSync(profileDir).sort(), env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } }));`,
            `if (existsSync(${JSON.stringify(pipeFloodMarker)})) { const flood = "x".repeat(1_048_576); if (!process.stderr.write(flood)) await new Promise((resolve) => process.stderr.once("drain", resolve)); await new Promise(() => {}); }`,
            tool === "codex"
              ? `writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ passed: true, findings: [], notes: "ok" }));`
              : `console.log(JSON.stringify({ structured_output: { passed: true, findings: [], notes: "ok" }, modelUsage: { stub: {} } }));`,
            "})().catch(() => { process.exitCode = 1; });",
            "",
          ].join("\n")
        );
        const launcher = subprocessLifecycleLauncher({
          nodeRuntime,
          platform: process.platform === "win32" ? "win32" : "posix",
          sourcePath,
          tool,
        });
        const executable = join(bin, launcher.fileName);
        await Bun.write(executable, launcher.contents);
        if (process.platform !== "win32") {
          await chmod(executable, 0o755);
        }
        subprocessLifecycleFixtures.set(`${tool}:${phase}`, {
          authMarkers,
          bin,
          dir,
          home,
          pipeFloodMarker,
          recordPath,
          scratch,
          scratchCanonical,
        });
      }
    }
  } catch (error) {
    await Promise.all(
      createdRoots.map((root) => rm(root, { force: true, recursive: true }))
    );
    subprocessLifecycleFixtures.clear();
    throw error;
  }
}, 15_000);

afterAll(async () => {
  await Promise.all(
    [...subprocessLifecycleFixtures.values()].flatMap((fixture) => [
      rm(fixture.dir, { force: true, recursive: true }),
      rm(fixture.scratch, { force: true, recursive: true }),
    ])
  );
  subprocessLifecycleFixtures.clear();
});

test("agent subprocess lifecycle fixture has a native Windows Node launcher contract", () => {
  const launcher = subprocessLifecycleLauncher({
    nodeRuntime: "C:\\Program Files\\nodejs\\node.exe",
    platform: "win32",
    sourcePath: "C:\\fixture\\agent.cjs",
    tool: "codex",
  });
  expect(launcher.fileName).toBe("codex.cmd");
  expect(launcher.contents).toContain('"C:\\Program Files\\nodejs\\node.exe"');
  expect(launcher.contents).toContain('"C:\\fixture\\agent.cjs" %*');
  expect(launcher.contents).not.toContain("#!/bin/sh");
});

for (const tool of ["claude", "codex"] as const) {
  for (const phase of [
    "environment-auth",
    "native-auth",
    "profile-precondition",
    "pipe-flood",
  ] as const) {
    test(`agent audit ${tool} subprocess ${phase} lifecycle is isolated and cleaned`, async () => {
      const {
        authMarkers,
        bin,
        dir,
        home,
        pipeFloodMarker,
        recordPath,
        scratch,
        scratchCanonical,
      } = subprocessLifecycleFixtures.get(`${tool}:${phase}`)!;
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
      process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
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
        if (phase === "environment-auth") {
          const report = await runAgentAudit({
            argv: ["ok-skill", "--with", tool, "--max-items", "1"],
            cwd: dir,
            homeDir: home,
            includeConfigFrom: false,
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
          expect(
            (record.env.CODEX_HOME ?? "").startsWith(scratchCanonical)
          ).toBe(true);
          expect(
            (record.env.XDG_CONFIG_HOME ?? "").startsWith(scratchCanonical)
          ).toBe(true);
          expect(await readdir(scratch)).toEqual([]);
          expect(await readFile(authMarkers[tool], "utf8")).toBe(
            `{"fixture":"${tool}-profile"}\n`
          );
        }

        if (phase === "native-auth") {
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
            includeConfigFrom: false,
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
        }

        if (phase === "profile-precondition") {
          if (tool === "claude") {
            process.env.ANTHROPIC_API_KEY = undefined;
            process.env.CLAUDE_CODE_OAUTH_TOKEN = undefined;
          } else {
            process.env.OPENAI_API_KEY = undefined;
          }
          await expect(
            runAgentAudit({
              argv: ["ok-skill", "--with", tool, "--max-items", "1"],
              cwd: dir,
              homeDir: home,
              includeConfigFrom: false,
              runtimeTempRoot: scratch,
            })
          ).rejects.toThrow(
            "file-backed profile authentication is unsupported"
          );
          expect(await Bun.file(recordPath).exists()).toBe(false);
          expect(await readdir(scratch)).toEqual([]);
        }

        if (phase === "pipe-flood") {
          await Bun.write(pipeFloodMarker, "1");
          const pipeController = new AbortController();
          const pipeTimeout = setTimeout(() => pipeController.abort(), 4500);
          const auditStartedAt = performance.now();
          let childStartedAt: number | null = null;
          let childCompletedAt: number | null = null;
          let flooded: Awaited<ReturnType<typeof runAgentAudit>> | undefined;
          let runError: unknown;
          try {
            flooded = await runAgentAudit({
              argv: ["ok-skill", "--with", tool, "--max-items", "1"],
              cwd: dir,
              homeDir: home,
              includeConfigFrom: false,
              onProgress: ({ phase: progressPhase }) => {
                if (progressPhase === "start") {
                  childStartedAt = performance.now();
                }
                if (progressPhase === "done") {
                  childCompletedAt = performance.now();
                }
              },
              runtimeTempRoot: scratch,
              signal: pipeController.signal,
            });
          } catch (error) {
            runError = error;
          } finally {
            clearTimeout(pipeTimeout);
          }
          const auditCompletedAt = performance.now();
          if (pipeController.signal.aborted) {
            const preChildMs =
              childStartedAt === null ? null : childStartedAt - auditStartedAt;
            const collectorMs =
              childStartedAt === null || childCompletedAt === null
                ? null
                : childCompletedAt - childStartedAt;
            const finalDiscoveryAndSnapshotMs =
              childCompletedAt === null
                ? null
                : auditCompletedAt - childCompletedAt;
            throw new Error(
              `Pipe-flood audit exceeded 4500ms (preChild=${preChildMs?.toFixed(1) ?? "incomplete"}ms, collector=${collectorMs?.toFixed(1) ?? "incomplete"}ms, finalDiscoveryAndSnapshot=${finalDiscoveryAndSnapshotMs?.toFixed(1) ?? "incomplete"}ms)`
            );
          }
          expect(pipeController.signal.aborted).toBe(false);
          expect(childStartedAt).not.toBeNull();
          expect(childCompletedAt).not.toBeNull();
          if (runError) {
            throw runError;
          }
          if (!flooded) {
            throw new Error("Pipe-flood audit returned no report");
          }
          expect(flooded.results[0]?.findings[0]?.ruleId).toBe("agent-error");
          expect(flooded.results[0]?.findings[0]?.evidence).toBe(
            "agent-subprocess-output-limit"
          );
          expect(await readdir(scratch)).toEqual([]);
        }
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
}

function hostileAgentFixture(args: {
  modePath: string;
  platform?: "posix" | "win32";
  structuredSelectedFields?: boolean;
  tool: "claude" | "codex";
  unrelatedSecret: string;
}): { contents: string; fileName: string } {
  const platform =
    args.platform ?? (process.platform === "win32" ? "win32" : "posix");
  if (platform === "win32") {
    const modePath = args.modePath.replaceAll("%", "%%");
    const unrelated = args.unrelatedSecret.replaceAll("%", "%%");
    const hostileAssignment = args.structuredSelectedFields
      ? 'set "hostile=short-secret-field:%selected%:end"'
      : 'set "hostile=selected=%selected%;unrelated=%unrelated%"';
    const structuredValue = args.structuredSelectedFields
      ? "%selected%"
      : "%hostile%";
    return {
      contents: [
        "@echo off",
        "setlocal EnableExtensions DisableDelayedExpansion",
        `set /p mode=<"${modePath}"`,
        `set "tool=${args.tool}"`,
        `set "unrelated=${unrelated}"`,
        'if "%tool%"=="codex" (set "selected=%OPENAI_API_KEY%") else (set "selected=%ANTHROPIC_API_KEY%")',
        hostileAssignment,
        'set "out_path="',
        'set "want_output="',
        ":parse_args",
        'if "%~1"=="" goto args_done',
        'if defined want_output (set "out_path=%~1" & goto args_done)',
        'if "%~1"=="--output-last-message" set "want_output=1"',
        "shift",
        "goto parse_args",
        ":args_done",
        'if "%mode%"=="nonzero" (echo %hostile% & echo %hostile% 1>&2 & exit /b 7)',
        'if "%mode%"=="auth" (echo %hostile% & echo authentication required %hostile% 1>&2 & exit /b 9)',
        // Windows child-tree termination is not assumed. Keep the inherited-pipe
        // descendant longer than the test ceiling but bound its orphan lifetime.
        'if "%mode%"=="hang" (set /p "=%hostile%" <nul & set /p "=%hostile%" <nul 1>&2 & "%SystemRoot%\\System32\\ping.exe" -n 11 127.0.0.1 >nul & exit /b 0)',
        'if "%mode%"=="parse" goto parse_output',
        "goto echo_output",
        ":parse_output",
        'if "%tool%"=="codex" (>"%out_path%" echo {invalid:%hostile%) else (echo {invalid:%hostile%)',
        "exit /b 0",
        ":echo_output",
        'if "%tool%"=="codex" goto codex_output',
        `echo {"structured_output":{"passed":false,"findings":[{"severity":"medium","category":"${structuredValue}","message":"%hostile%","recommendation":"${structuredValue}","location":"%hostile%"}],"notes":"%hostile%"},"modelUsage":{"${structuredValue}":{}}}`,
        "exit /b 0",
        ":codex_output",
        '>"%out_path%" echo {"passed":false,"findings":[{"severity":"medium","category":"%hostile%","message":"%hostile%","recommendation":"%hostile%","location":"%hostile%"}],"notes":"%hostile%"}',
        "exit /b 0",
        "",
      ].join("\r\n"),
      fileName: `${args.tool}.cmd`,
    };
  }
  const hostileAssignment = args.structuredSelectedFields
    ? 'hostile="short-secret-field:$selected:end"'
    : 'hostile="selected=$selected;unrelated=$unrelated"';
  const structuredArgument = args.structuredSelectedFields
    ? '"$selected"'
    : '"$hostile"';
  return {
    contents: [
      "#!/bin/sh",
      `mode=$(cat ${JSON.stringify(args.modePath)})`,
      `tool=${JSON.stringify(args.tool)}`,
      `unrelated=${JSON.stringify(args.unrelatedSecret)}`,
      'if [ "$tool" = "codex" ]; then selected=$OPENAI_API_KEY; else selected=$ANTHROPIC_API_KEY; fi',
      hostileAssignment,
      'out_path=""',
      'want_output=""',
      'for arg in "$@"; do',
      '  if [ "$want_output" = "1" ]; then out_path=$arg; break; fi',
      '  if [ "$arg" = "--output-last-message" ]; then want_output="1"; fi',
      "done",
      'if [ "$mode" = "nonzero" ]; then printf "%s\\n" "$hostile"; printf "%s\\n" "$hostile" >&2; exit 7; fi',
      'if [ "$mode" = "auth" ]; then printf "%s\\n" "$hostile"; printf "authentication required %s\\n" "$hostile" >&2; exit 9; fi',
      // Keep a real descendant alive with inherited pipes. Timeout cleanup must
      // close both readers and terminate the detached POSIX process group.
      'if [ "$mode" = "hang" ]; then printf "%s" "$hostile"; printf "%s" "$hostile" >&2; sleep 60; exit 0; fi',
      'if [ "$mode" = "parse" ]; then',
      '  if [ "$tool" = "codex" ]; then printf "{invalid:%s" "$hostile" > "$out_path"; else printf "{invalid:%s\\n" "$hostile"; fi',
      "  exit 0",
      "fi",
      'if [ "$tool" = "codex" ]; then',
      `  printf '{"passed":false,"findings":[{"severity":"medium","category":"%s","message":"%s","recommendation":"%s","location":"%s"}],"notes":"%s"}' ${structuredArgument} "$hostile" ${structuredArgument} "$hostile" "$hostile" > "$out_path"`,
      "else",
      `  printf '{"structured_output":{"passed":false,"findings":[{"severity":"medium","category":"%s","message":"%s","recommendation":"%s","location":"%s"}],"notes":"%s"},"modelUsage":{"%s":{}}}\\n' ${structuredArgument} "$hostile" ${structuredArgument} "$hostile" "$hostile" ${structuredArgument}`,
      "fi",
      "",
    ].join("\n"),
    fileName: args.tool,
  };
}

test("hostile-output fake CLI has a native Windows command contract", () => {
  const fixture = hostileAgentFixture({
    modePath: "C:\\fixture\\mode",
    platform: "win32",
    tool: "codex",
    unrelatedSecret: "fixture-unrelated",
  });
  expect(fixture.fileName).toBe("codex.cmd");
  expect(fixture.contents).toContain("%OPENAI_API_KEY%");
  expect(fixture.contents).toContain("--output-last-message");
  expect(fixture.contents).toContain("%SystemRoot%\\System32\\ping.exe");
  expect(fixture.contents).not.toContain("#!/bin/sh");
});

interface ShortAuthFixture {
  bin: string;
  dir: string;
  home: string;
  modePath: string;
  reportRoot: string;
  scratch: string;
}

const shortAuthFixtures = new Map<"claude" | "codex", ShortAuthFixture>();
const shortAuthPersistenceQueue: {
  assertNoSelectedAuth: (value: unknown) => void;
  evaluation: Awaited<ReturnType<typeof evaluateAgentAudit>>;
  reportRoot: string;
}[] = [];
let codexColdStartReceipt: {
  deadlineFired: boolean;
  environmentRestored: boolean;
  evidence: string | undefined;
  reportRootEmpty: boolean;
  scratchEmpty: boolean;
  sourceUnchanged: boolean;
} | null = null;

beforeAll(async () => {
  const createdRoots: string[] = [];
  try {
    for (const tool of ["claude", "codex"] as const) {
      const dir = await mkdtemp(join(tmpdir(), `facult-agent-short-${tool}-`));
      createdRoots.push(dir);
      const home = join(dir, "audited-home");
      const bin = join(dir, "bin");
      const scratch = await mkdtemp(
        join(tmpdir(), `facult-agent-short-scratch-${tool}-`)
      );
      createdRoots.push(scratch);
      const reportRoot = await mkdtemp(
        join(tmpdir(), `facult-agent-short-report-${tool}-`)
      );
      createdRoots.push(reportRoot);
      const modePath = join(dir, "mode");
      await mkdir(bin, { recursive: true });
      await writeFile(
        join(home, ".ai", "skills", "ok-skill", "SKILL.md"),
        "Hello\n"
      );
      const fixture = hostileAgentFixture({
        modePath,
        structuredSelectedFields: true,
        tool,
        unrelatedSecret: "fixture-unrelated-short-auth",
      });
      const executable = join(bin, fixture.fileName);
      await Bun.write(executable, fixture.contents);
      if (process.platform !== "win32") {
        await chmod(executable, 0o755);
      }
      shortAuthFixtures.set(tool, {
        bin,
        dir,
        home,
        modePath,
        reportRoot,
        scratch,
      });
    }
  } catch (error) {
    await Promise.all(
      createdRoots.map((root) => rm(root, { force: true, recursive: true }))
    );
    shortAuthFixtures.clear();
    throw error;
  }
}, 15_000);

beforeAll(async () => {
  const { bin, dir, home, modePath, reportRoot, scratch } =
    shortAuthFixtures.get("codex")!;
  const previousEnvironment = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    PATH: process.env.PATH,
  };
  const before = await snapshotFixtureTree(home);
  await Bun.write(modePath, "parse");
  const controller = new AbortController();
  let deadlineFired = false;
  const deadline = setTimeout(() => {
    deadlineFired = true;
    controller.abort();
  }, 10_000);
  let evaluation: Awaited<ReturnType<typeof evaluateAgentAudit>> | undefined;
  let commandError: unknown;
  process.env.PATH = `${bin}${delimiter}${previousEnvironment.PATH ?? ""}`;
  process.env.ANTHROPIC_API_KEY = undefined;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = undefined;
  process.env.OPENAI_API_KEY = "fixture-codex-cold-start-auth";
  try {
    evaluation = await evaluateAgentAudit({
      argv: ["ok-skill", "--with", "codex", "--max-items", "1"],
      cwd: dir,
      homeDir: home,
      includeConfigFrom: false,
      runtimeTempRoot: scratch,
      signal: controller.signal,
    });
  } catch (error) {
    commandError = error;
  } finally {
    clearTimeout(deadline);
    process.env.PATH = previousEnvironment.PATH;
    process.env.ANTHROPIC_API_KEY = previousEnvironment.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN =
      previousEnvironment.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.OPENAI_API_KEY = previousEnvironment.OPENAI_API_KEY;
  }
  if (commandError) {
    throw commandError;
  }
  codexColdStartReceipt = {
    deadlineFired,
    environmentRestored:
      process.env.ANTHROPIC_API_KEY === previousEnvironment.ANTHROPIC_API_KEY &&
      process.env.CLAUDE_CODE_OAUTH_TOKEN ===
        previousEnvironment.CLAUDE_CODE_OAUTH_TOKEN &&
      process.env.OPENAI_API_KEY === previousEnvironment.OPENAI_API_KEY &&
      process.env.PATH === previousEnvironment.PATH,
    evidence: evaluation?.report.results[0]?.findings[0]?.evidence,
    reportRootEmpty: (await readdir(reportRoot)).length === 0,
    scratchEmpty: (await readdir(scratch)).length === 0,
    sourceUnchanged:
      JSON.stringify(await snapshotFixtureTree(home)) ===
      JSON.stringify(before),
  };
  if (
    codexColdStartReceipt.deadlineFired ||
    !codexColdStartReceipt.environmentRestored ||
    codexColdStartReceipt.evidence !== "agent-subprocess-invalid-output" ||
    !codexColdStartReceipt.reportRootEmpty ||
    !codexColdStartReceipt.scratchEmpty ||
    !codexColdStartReceipt.sourceUnchanged
  ) {
    throw new Error("Codex cold-start isolation receipt failed");
  }
}, 15_000);

test("agent audit Codex cold start preserves source bytes and environment", () => {
  expect(codexColdStartReceipt).toEqual({
    deadlineFired: false,
    environmentRestored: true,
    evidence: "agent-subprocess-invalid-output",
    reportRootEmpty: true,
    scratchEmpty: true,
    sourceUnchanged: true,
  });
});

afterAll(async () => {
  try {
    // Persistence is an aggregate postcondition with no child process. Each
    // agent command above keeps its independent 4.5-second abort deadline.
    for (const queued of shortAuthPersistenceQueue) {
      const reportPath = await persistAuditReport({
        ...queued.evaluation,
        mode: "agent",
        reportRoot: queued.reportRoot,
      });
      queued.assertNoSelectedAuth(await Bun.file(reportPath).json());
    }
  } finally {
    for (const fixture of shortAuthFixtures.values()) {
      await rm(fixture.dir, { force: true, recursive: true });
      await rm(fixture.reportRoot, { force: true, recursive: true });
      await rm(fixture.scratch, { force: true, recursive: true });
    }
    shortAuthFixtures.clear();
    shortAuthPersistenceQueue.length = 0;
    codexColdStartReceipt = null;
  }
}, 60_000);

for (const tool of ["claude", "codex"] as const) {
  for (const selectedSecret of ["q", "qz", "qzx", "qzxv"] as const) {
    for (const mode of ["nonzero", "parse", "structured"] as const) {
      test(`agent audit ${tool} redacts ${selectedSecret.length}-byte selected auth for ${mode} output`, async () => {
        const { bin, dir, home, modePath, reportRoot, scratch } =
          shortAuthFixtures.get(tool)!;
        const hostileMarker = `short-secret-field:${selectedSecret}:end`;

        const previousEnvironment = {
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
          OPENAI_API_KEY: process.env.OPENAI_API_KEY,
          PATH: process.env.PATH,
        };
        const evaluateMode = async (signal: AbortSignal) => {
          return await evaluateAgentAudit({
            argv: ["ok-skill", "--with", tool, "--max-items", "1"],
            cwd: dir,
            homeDir: home,
            includeConfigFrom: false,
            runtimeTempRoot: scratch,
            signal,
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

        const commandController = new AbortController();
        let commandDeadlineFired = false;
        const commandDeadline = setTimeout(() => {
          commandDeadlineFired = true;
          commandController.abort();
        }, 4500);
        let commandError: unknown;
        let evaluation:
          | Awaited<ReturnType<typeof evaluateAgentAudit>>
          | undefined;
        try {
          process.env.PATH = `${bin}${delimiter}${previousEnvironment.PATH ?? ""}`;
          process.env.ANTHROPIC_API_KEY =
            tool === "claude" ? selectedSecret : undefined;
          process.env.CLAUDE_CODE_OAUTH_TOKEN = undefined;
          process.env.OPENAI_API_KEY =
            tool === "codex" ? selectedSecret : undefined;
          await Bun.write(modePath, mode);
          evaluation = await evaluateMode(commandController.signal);
        } catch (error) {
          commandError = error;
        } finally {
          clearTimeout(commandDeadline);
          process.env.PATH = previousEnvironment.PATH;
          process.env.ANTHROPIC_API_KEY = previousEnvironment.ANTHROPIC_API_KEY;
          process.env.CLAUDE_CODE_OAUTH_TOKEN =
            previousEnvironment.CLAUDE_CODE_OAUTH_TOKEN;
          process.env.OPENAI_API_KEY = previousEnvironment.OPENAI_API_KEY;
        }

        expect({
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
          OPENAI_API_KEY: process.env.OPENAI_API_KEY,
          PATH: process.env.PATH,
        }).toEqual(previousEnvironment);
        expect(commandDeadlineFired).toBe(false);
        if (commandError) {
          throw commandError;
        }
        if (!evaluation) {
          throw new Error("Agent audit command returned no evaluation");
        }

        if (mode === "nonzero") {
          expect(evaluation.report.results[0]?.findings[0]?.evidence).toBe(
            "agent-subprocess-exit"
          );
        } else if (mode === "parse") {
          expect(evaluation.report.results[0]?.findings[0]?.evidence).toBe(
            "agent-subprocess-invalid-output"
          );
        } else {
          const finding = evaluation.report.results[0]?.findings[0];
          expect(finding?.ruleId).toBe("<redacted>");
          expect(finding?.message).toBe("<redacted>");
          expect(finding?.evidence).toBe("<redacted>");
          expect(finding?.location).toBe("<redacted>");
          expect(evaluation.report.results[0]?.notes).toBe("<redacted>");
          if (tool === "claude") {
            expect(evaluation.report.agent.model).toBe("<redacted>");
          } else {
            expect(evaluation.report.agent.model).toBeUndefined();
          }
        }
        assertNoSelectedAuth(evaluation);
        expect(await readdir(scratch)).toEqual([]);

        if (mode === "structured") {
          shortAuthPersistenceQueue.push({
            assertNoSelectedAuth,
            evaluation,
            reportRoot,
          });
        }
      }, 15_000);
    }
  }
}

for (const tool of ["claude", "codex"] as const) {
  for (const mode of [
    "nonzero",
    "auth",
    "parse",
    "echo",
    "timeout",
    "abort",
  ] as const) {
    test(`agent audit ${tool} does not expose hostile child output for ${mode}`, async () => {
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

      const fixture = hostileAgentFixture({
        modePath,
        tool,
        unrelatedSecret,
      });
      const executable = join(bin, fixture.fileName);
      await Bun.write(executable, fixture.contents);
      if (process.platform !== "win32") {
        await chmod(executable, 0o755);
      }

      const previousPath = process.env.PATH;
      const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
      const previousClaudeOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
      const previousServiceToken = process.env.SERVICE_TOKEN;
      process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
      process.env.ANTHROPIC_API_KEY =
        tool === "claude" ? selectedSecret : undefined;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = undefined;
      process.env.OPENAI_API_KEY =
        tool === "codex" ? selectedSecret : undefined;
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
          from: [join(home, ".ai")],
          homeDir: home,
          includeConfigFrom: false,
          runtimeTempRoot: scratch,
          ...extra,
        });
      };

      try {
        if (mode === "auth") {
          let authError: unknown;
          try {
            await evaluateMode("auth");
          } catch (error) {
            authError = error;
          }
          expect(String(authError)).toContain("authentication is unavailable");
          assertNoHostileValue(String(authError));
        } else if (mode === "abort") {
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
        } else {
          const evaluation = await evaluateMode(
            mode === "timeout" ? "hang" : mode,
            mode === "timeout" ? { subprocessTimeoutMs: 25 } : undefined
          );
          if (mode === "nonzero") {
            expect(evaluation.report.results[0]?.findings[0]?.evidence).toBe(
              "agent-subprocess-exit"
            );
          } else if (mode === "parse") {
            expect(evaluation.report.results[0]?.findings[0]?.evidence).toBe(
              "agent-subprocess-invalid-output"
            );
          } else if (mode === "timeout") {
            expect(evaluation.report.results[0]?.findings[0]?.evidence).toBe(
              "agent-subprocess-timeout"
            );
          } else {
            expect(evaluation.report.results[0]?.findings[0]?.message).toBe(
              "selected=<redacted>;unrelated=<redacted>"
            );
            if (tool === "claude") {
              expect(evaluation.report.agent.model).not.toContain(
                "selected-auth"
              );
            }
          }
          assertNoHostileValue(evaluation);
          await persistAndAssertSafe(evaluation);
        }
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
}
