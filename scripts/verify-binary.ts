#!/usr/bin/env bun

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const defaultBinary =
  process.platform === "win32" ? "dist/fclt.exe" : "dist/fclt";
const binaryPath = resolve(repoRoot, process.argv[2] ?? defaultBinary);
const tempHome = await mkdtemp(join(tmpdir(), "fclt-binary-verify-"));

async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn([binaryPath, ...args], {
    cwd: tempHome,
    env: {
      ...process.env,
      HOME: tempHome,
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

console.log(`Verified ${binaryPath} (${version})`);
