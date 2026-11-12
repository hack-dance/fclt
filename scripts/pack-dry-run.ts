#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  requiredPackagePaths,
  verifyPackageContents,
} from "./package-contents";

const repoRoot = resolve(import.meta.dir, "..");
const cacheDir = await mkdtemp(join(tmpdir(), "fclt-npm-pack-"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

try {
  // Keep lifecycle output out of npm's JSON report while still running the hooks.
  const child = Bun.spawn(
    [npmCommand, "pack", "--dry-run", "--json", "--foreground-scripts=false"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HUSKY: "0",
        npm_config_cache: cacheDir,
      },
      stdin: "inherit",
      stdout: "pipe",
      stderr: "inherit",
    }
  );
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0) {
    process.stdout.write(stdout);
    process.exitCode = exitCode;
  } else {
    const count = verifyPackageContents(
      JSON.parse(stdout),
      await requiredPackagePaths(repoRoot)
    );
    console.log(`Verified ${count} npm package files.`);
  }
} finally {
  await rm(cacheDir, { recursive: true, force: true });
}
