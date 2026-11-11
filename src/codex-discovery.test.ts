import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  inspectCodexDiscovery,
  parseCodexDiscoveryArgs,
} from "./codex-discovery";
import { buildDoctorReport } from "./doctor";

const homes: string[] = [];
const sessionId = "fixture-host-session";
const READ_ONLY_EVIDENCE_ERROR_RE =
  /requires doctor --json|doctor --json is read-only/;

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

async function write(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, contents);
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "fclt-discovery-"));
  homes.push(home);
  const pluginRoot = join(home, "plugins", "fclt");
  const configPath = join(home, ".codex", "config.toml");
  await write(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    '{"name":"fclt","version":"1.0.0"}'
  );
  await write(
    join(pluginRoot, ".mcp.json"),
    '{"mcpServers":{"fclt":{"command":"node","args":["scripts/server.cjs"]}}}'
  );
  await write(
    join(pluginRoot, "scripts", "server.cjs"),
    "// fixture payload\n"
  );
  await write(configPath, '[plugins."fclt@fixture"]\nenabled = true\n');
  const options = { homeDir: home, cwd: home, scope: "global" as const };
  const baseline = await buildDoctorReport(options);
  const evidencePath = join(home, "proof.json");
  const evidence = {
    version: 1,
    source: "external_session_observer",
    observer: "fixture host observer",
    sessionId,
    observedAt: new Date().toISOString(),
    installationFingerprint:
      baseline.loop.integrations.codex.discovery.installationFingerprint,
    discoveredTools: ["fclt_status", "fclt_setup"],
    successfulTools: ["fclt_status"],
  };
  await write(evidencePath, JSON.stringify(evidence));
  return {
    home,
    pluginRoot,
    configPath,
    options,
    baseline,
    evidencePath,
    evidence,
  };
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        files[relative] = "directory";
        await visit(join(directory, entry.name), relative);
      } else {
        files[relative] = await readFile(join(directory, entry.name), "utf8");
      }
    }
  }
  await visit(root, "");
  return files;
}

test("registration alone retains v2 states and does not claim host discovery", async () => {
  const { baseline } = await fixture();
  expect(baseline.version).toBe(2);
  expect(baseline.loop.integrations.codex).toMatchObject({
    state: "registered_unverified",
    registered: true,
    pluginPayloadPresent: true,
    mcpDeclared: true,
    freshSessionDiscovery: "requires_fresh_session",
    discovery: { state: "unverified", maxAgeSeconds: 3600 },
  });
  expect(baseline.loop.integrations.codex.repair).toContain(
    "Registration is present"
  );
});

test("external current-session evidence changes only Codex proof, stays read-only and never sticks", async () => {
  const { options, home, evidencePath, baseline } = await fixture();
  const before = await snapshot(home);
  const report = await buildDoctorReport({
    ...options,
    codexDiscoveryEvidencePath: evidencePath,
    codexSessionId: sessionId,
  });
  expect(report.version).toBe(2);
  expect(report.loop.integrations.codex).toMatchObject({
    state: "ready",
    registered: true,
    freshSessionDiscovery: "not_applicable",
    discovery: {
      state: "externally_proven",
      proof: { source: "external_session_observer", sessionId },
    },
  });
  expect(report.loop.integrations.codex.repair).toBeUndefined();
  expect(report.health).toEqual(baseline.health);
  expect(report.health.ok).toBe(false);
  expect(report.loop.blockers).toEqual(baseline.loop.blockers);
  expect((await buildDoctorReport(options)).loop.integrations.codex.state).toBe(
    "registered_unverified"
  );
  expect(await snapshot(home)).toEqual(before);
});

test.each([
  ["session_mismatch", { sessionId: "another-host-session" }],
  [
    "installation_mismatch",
    { installationFingerprint: `sha256:${"a".repeat(64)}` },
  ],
  [
    "stale_evidence",
    { observedAt: new Date(Date.now() - 3_600_001).toISOString() },
  ],
  [
    "future_evidence",
    { observedAt: new Date(Date.now() + 60_000).toISOString() },
  ],
  ["invalid_evidence", { version: 2 }],
  ["invalid_evidence", { source: "mcp_self_test" }],
  ["invalid_evidence", { observer: "" }],
  ["invalid_evidence", { observedAt: "not-a-date" }],
  ["missing_tool_proof", { discoveredTools: ["fclt_status"] }],
  ["missing_tool_proof", { successfulTools: [] }],
  ["missing_tool_proof", { successfulTools: ["fclt_doctor"] }],
])("rejects %s without treating registration as runtime failure (%j)", async (reason, override) => {
  const { options, evidencePath, evidence } = await fixture();
  await write(evidencePath, JSON.stringify({ ...evidence, ...override }));
  const report = await buildDoctorReport({
    ...options,
    codexDiscoveryEvidencePath: evidencePath,
    codexSessionId: sessionId,
  });
  expect(report.loop.integrations.codex).toMatchObject({
    state: "registered_unverified",
    registered: true,
    freshSessionDiscovery: "requires_fresh_session",
    discovery: { state: "rejected", reason },
  });
});

test("requires a separate expected session and rejects absent, malformed or oversized files", async () => {
  const { home, evidencePath } = await fixture();
  const options = { homeDir: home, installationReady: true, evidencePath };
  expect((await inspectCodexDiscovery(options)).reason).toBe(
    "session_required"
  );
  expect(
    (
      await inspectCodexDiscovery({
        ...options,
        sessionId,
        evidencePath: join(home, "absent.json"),
      })
    ).reason
  ).toBe("evidence_unreadable");
  await write(evidencePath, "{");
  expect((await inspectCodexDiscovery({ ...options, sessionId })).reason).toBe(
    "evidence_unreadable"
  );
  await write(evidencePath, " ".repeat(16_385));
  expect((await inspectCodexDiscovery({ ...options, sessionId })).reason).toBe(
    "invalid_evidence"
  );
});

test("accepts the age boundary and rejects the next millisecond", async () => {
  const { home, evidencePath, evidence } = await fixture();
  const options = {
    homeDir: home,
    installationReady: true,
    evidencePath,
    sessionId,
  };
  const observed = Date.parse(evidence.observedAt);
  expect(
    (await inspectCodexDiscovery({ ...options, now: observed + 3_600_000 }))
      .state
  ).toBe("externally_proven");
  expect(
    (await inspectCodexDiscovery({ ...options, now: observed + 3_600_001 }))
      .reason
  ).toBe("stale_evidence");
  expect(
    (await inspectCodexDiscovery({ ...options, now: observed - 1 })).reason
  ).toBe("future_evidence");
});

test.each([
  "scripts/server.cjs",
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "new-file.md",
  "config",
])("invalidates proof when %s changes", async (file) => {
  const { home, pluginRoot, configPath, evidencePath } = await fixture();
  const path = file === "config" ? configPath : join(pluginRoot, file);
  await write(
    path,
    `${await Bun.file(path)
      .text()
      .catch(() => "")}\n`
  );
  const result = await inspectCodexDiscovery({
    homeDir: home,
    installationReady: true,
    evidencePath,
    sessionId,
  });
  expect(result.state).toBe("rejected");
  expect(result.reason).toBe("installation_mismatch");
});

test("cannot transfer evidence to another home or override disabled registration", async () => {
  const original = await fixture();
  const other = await fixture();
  expect(
    (
      await inspectCodexDiscovery({
        homeDir: other.home,
        installationReady: true,
        evidencePath: original.evidencePath,
        sessionId,
      })
    ).reason
  ).toBe("installation_mismatch");
  await write(
    original.configPath,
    '[plugins."fclt@fixture"]\nenabled = false\n'
  );
  const report = await buildDoctorReport({
    ...original.options,
    codexDiscoveryEvidencePath: original.evidencePath,
    codexSessionId: sessionId,
  });
  expect(report.loop.integrations.codex).toMatchObject({
    state: "misconfigured",
    registered: false,
    discovery: { state: "rejected", reason: "installation_unavailable" },
  });
});

test("unsupported symlink payloads fail closed without affecting registration", async () => {
  const { options, pluginRoot, evidencePath } = await fixture();
  await symlink("server.cjs", join(pluginRoot, "scripts", "alias.cjs"));
  const report = await buildDoctorReport({
    ...options,
    codexDiscoveryEvidencePath: evidencePath,
    codexSessionId: sessionId,
  });
  expect(report.loop.integrations.codex).toMatchObject({
    state: "registered_unverified",
    discovery: { state: "rejected", reason: "installation_unavailable" },
  });
});

test("CLI reads explicit proof in both flag forms without changing the fixture home", async () => {
  const { home, evidencePath } = await fixture();
  const before = await snapshot(home);
  for (const flags of [
    ["--codex-discovery-evidence", evidencePath, "--codex-session", sessionId],
    ["--codex-discovery-evidence=proof.json", `--codex-session=${sessionId}`],
  ]) {
    const proc = Bun.spawn(
      ["bun", join(import.meta.dir, "index.ts"), "doctor", "--json", ...flags],
      {
        cwd: home,
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout).loop.integrations.codex.discovery.state).toBe(
      "externally_proven"
    );
  }
  expect(await snapshot(home)).toEqual(before);
}, 10_000);

test("evidence cannot enable repair or enter the mutating doctor path", async () => {
  const { home, evidencePath } = await fixture();
  const before = await snapshot(home);
  for (const flags of [[], ["--repair"], ["--json", "--repair"]]) {
    const proc = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "index.ts"),
        "doctor",
        ...flags,
        "--codex-discovery-evidence",
        evidencePath,
        "--codex-session",
        sessionId,
      ],
      {
        cwd: home,
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toMatch(READ_ONLY_EVIDENCE_ERROR_RE);
  }
  expect(await snapshot(home)).toEqual(before);
}, 10_000);

test("discovery flag parsing rejects missing values and duplicate bindings", () => {
  for (const argv of [
    ["--codex-session"],
    ["--codex-session="],
    ["--codex-session", "--json"],
    ["--codex-session=a", "--codex-session=b"],
  ]) {
    expect(() => parseCodexDiscoveryArgs(argv)).toThrow();
  }
});
