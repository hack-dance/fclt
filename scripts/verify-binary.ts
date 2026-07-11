#!/usr/bin/env bun

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const defaultBinary =
  process.platform === "win32" ? "dist/fclt.exe" : "dist/fclt";
const binaryPath = resolve(repoRoot, process.argv[2] ?? defaultBinary);
const tempHome = await mkdtemp(join(tmpdir(), "fclt-binary-verify-"));
const tempProcessTmp = join(tempHome, "tmp");
const legacyManagedMutationFlag = "--allow-legacy-managed-mutation";

async function execute(args: string[]): Promise<{
  code: number;
  stderr: string;
  stdout: string;
}> {
  const env = { ...process.env };
  env.FCLT_ALLOW_LEGACY_MANAGED_MUTATION = undefined;
  const proc = Bun.spawn([binaryPath, ...args], {
    cwd: tempHome,
    env: {
      ...env,
      HOME: tempHome,
      USERPROFILE: tempHome,
      APPDATA: join(tempHome, "AppData", "Roaming"),
      LOCALAPPDATA: join(tempHome, "AppData", "Local"),
      TEMP: tempProcessTmp,
      TMP: tempProcessTmp,
      FACULT_CACHE_DIR: join(tempHome, ".cache", "fclt"),
      FACULT_LOCAL_STATE_DIR: join(tempHome, ".local", "state", "fclt"),
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stderr, stdout };
}

async function run(args: string[]): Promise<string> {
  const { code, stderr, stdout } = await execute(args);
  if (code !== 0) {
    throw new Error(
      `${binaryPath} ${args.join(" ")} failed with ${code}\n${stderr || stdout}`
    );
  }
  return stdout;
}

async function runBlocked(args: string[]): Promise<string> {
  const { code, stderr, stdout } = await execute(args);
  if (code === 0) {
    throw new Error(`${binaryPath} ${args.join(" ")} unexpectedly succeeded`);
  }
  return stderr || stdout;
}

await run(["--help"]);

const version = (await run(["--version"])).trim();
if (!/^\d+\.\d+\.\d+/.test(version)) {
  throw new Error(
    `Expected semver from --version, got ${JSON.stringify(version)}`
  );
}

const status = JSON.parse(await run(["status", "--json"])) as {
  packageVersion?: string;
  version?: number;
};
if (status.version !== 1) {
  throw new Error(
    `Expected status version 1, got ${JSON.stringify(status.version)}`
  );
}
if (status.packageVersion !== version) {
  throw new Error(
    `Expected status packageVersion ${version}, got ${JSON.stringify(status.packageVersion)}`
  );
}

const setup = JSON.parse(
  await run(["setup", "--global-only", "--no-codex-plugin", "--json"])
) as {
  health?: string;
  readiness?: { global?: { loop?: { state?: string } } };
};
if (
  setup.health !== "ready" ||
  setup.readiness?.global?.loop?.state !== "ready"
) {
  throw new Error(
    `Expected compiled setup readiness, got ${JSON.stringify(setup)}`
  );
}

const blockedManage = await runBlocked(["manage", "codex", "--global"]);
if (!blockedManage.includes("deprecated broad managed-mode mutation")) {
  throw new Error(`Expected managed-mode containment, got ${blockedManage}`);
}
const codexAgentsPath = join(tempHome, ".codex", "AGENTS.md");
if (await Bun.file(codexAgentsPath).exists()) {
  throw new Error(`Blocked manage unexpectedly wrote ${codexAgentsPath}`);
}

await run(["manage", "codex", "--global", legacyManagedMutationFlag]);
await run(["sync", "codex", "--global", legacyManagedMutationFlag]);

const capabilityEvolutionSkillPath = join(
  tempHome,
  ".agents",
  "skills",
  "capability-evolution",
  "SKILL.md"
);
const codexAgents = await Bun.file(codexAgentsPath).text();
const normalizedCodexAgents = codexAgents.replaceAll("\\", "/");
const missingCodexGuidance = [
  "Global Agent Instructions",
  "Treat every task as a work unit",
  "For any task, identify the highest-signal feedback loops available",
  "When a high-signal learning clearly points at a canonical asset",
].filter((text) => !normalizedCodexAgents.includes(text));
const hasUnresolvedRefs = /\$\{refs\.[^}]+}/.test(codexAgents);
const hasEmptyFcltyBlock =
  /<!--\s*fclty:([^>]+?)\s*-->\s*<!--\s*\/fclty:\1\s*-->/.test(
    normalizedCodexAgents
  );
if (
  missingCodexGuidance.length > 0 ||
  hasUnresolvedRefs ||
  hasEmptyFcltyBlock
) {
  const details = [
    `Expected builtin AGENTS guidance in ${codexAgentsPath}`,
    missingCodexGuidance.length > 0
      ? `Missing: ${missingCodexGuidance.join(", ")}`
      : "",
    hasUnresolvedRefs
      ? "Rendered guidance still contains unresolved refs."
      : "",
    hasEmptyFcltyBlock
      ? "Rendered guidance still contains empty fclty blocks."
      : "",
    `Preview:\n${normalizedCodexAgents.slice(0, 1200)}`,
  ].filter(Boolean);
  throw new Error(details.join("\n"));
}
const capabilityEvolutionSkill = await Bun.file(
  capabilityEvolutionSkillPath
).text();
if (!capabilityEvolutionSkill.includes("tool-call-audit")) {
  throw new Error(
    `Expected builtin capability-evolution skill in ${capabilityEvolutionSkillPath}`
  );
}

console.log(`Verified ${binaryPath} (${version})`);
