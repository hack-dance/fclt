#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const cacheDir = await mkdtemp(join(tmpdir(), "fclt-npm-pack-"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

try {
  const child = Bun.spawn([npmCommand, "pack", "--dry-run"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HUSKY: "0",
      npm_config_cache: cacheDir,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
} finally {
  await rm(cacheDir, { recursive: true, force: true });
}
