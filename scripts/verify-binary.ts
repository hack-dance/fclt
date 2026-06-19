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

async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn([binaryPath, ...args], {
    cwd: tempHome,
    env: {
      ...process.env,
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
  if (code !== 0) {
    throw new Error(
      `${binaryPath} ${args.join(" ")} failed with ${code}\n${stderr || stdout}`
    );
  }
  return stdout;
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

await run(["manage", "codex", "--global"]);
await run(["sync", "codex", "--global"]);

const codexAgentsPath = join(tempHome, ".codex", "AGENTS.md");
const capabilityEvolutionSkillPath = join(
  tempHome,
  ".agents",
  "skills",
  "capability-evolution",
  "SKILL.md"
);
const codexAgents = await Bun.file(codexAgentsPath).text();
const expectedCodexGuidance = [
  "# Global Agent Instructions",
  "Treat every task as a work unit",
  "record a writeback before ending the task",
];
const normalizedCodexAgents = codexAgents.replaceAll("\\", "/");
if (
  !expectedCodexGuidance.every((text) =>
    normalizedCodexAgents.includes(text)
  ) ||
  /\$\{refs\.[^}]+}/.test(codexAgents)
) {
  throw new Error(`Expected builtin AGENTS guidance in ${codexAgentsPath}`);
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
