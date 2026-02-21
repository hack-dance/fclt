#!/usr/bin/env bun

import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const distDir = join(repoRoot, "dist");
const binaryPath = join(distDir, "facult");
const taggedPath = join(distDir, `facult-${process.platform}-${process.arch}`);

await mkdir(distDir, { recursive: true });

const build = Bun.spawnSync({
  cmd: ["bun", "build", "./src/index.ts", "--compile", "--outfile", binaryPath],
  cwd: repoRoot,
  stdout: "inherit",
  stderr: "inherit",
});

if (build.exitCode !== 0) {
  process.exit(build.exitCode ?? 1);
}

await chmod(binaryPath, 0o755);
await copyFile(binaryPath, taggedPath);
await chmod(taggedPath, 0o755);

console.log(`Built ${binaryPath}`);
console.log(`Built ${taggedPath}`);
