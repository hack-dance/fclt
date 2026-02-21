#!/usr/bin/env bun

import { lstat, readlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const CLI_NAME = "facult";
const DEFAULT_INSTALL_DIR_RELATIVE = ".facult/bin";

const home = (process.env.HOME ?? "").trim();
if (!home) {
  process.stderr.write(
    "HOME is not set; cannot determine install directory.\n"
  );
  process.exit(1);
}

const installDir = resolve(home, DEFAULT_INSTALL_DIR_RELATIVE);
const targetPath = resolve(installDir, CLI_NAME);
const current = await readCurrentInstall(targetPath);

if (current.status === "missing") {
  process.stdout.write(`No install found at:\n  ${targetPath}\n`);
  process.exit(0);
}

if (current.kind === "symlink") {
  const mode = current.linkTarget.endsWith("/dist/facult")
    ? "bin (symlink)"
    : "symlink";
  process.stdout.write(`Install mode: ${mode}\n`);
  process.stdout.write(`Path: ${targetPath}\n`);
  process.stdout.write(`Target: ${current.linkTarget}\n`);
  process.exit(0);
}

const isDevWrapper = current.content.includes("facult local-dev shim");
process.stdout.write(
  `Install mode: ${isDevWrapper ? "dev (wrapper)" : "file (unknown)"}\n`
);
process.stdout.write(`Path: ${targetPath}\n`);
process.exit(0);

type CurrentInstall =
  | { status: "missing" }
  | { status: "present"; kind: "symlink"; linkTarget: string }
  | { status: "present"; kind: "file"; content: string };

async function readCurrentInstall(targetPath: string): Promise<CurrentInstall> {
  try {
    const stat = await lstat(targetPath);
    if (stat.isSymbolicLink()) {
      const linkTargetRaw = await readlink(targetPath);
      const linkTarget = resolve(dirname(targetPath), linkTargetRaw);
      return { status: "present", kind: "symlink", linkTarget };
    }
    const content = await Bun.file(targetPath).text();
    return { status: "present", kind: "file", content };
  } catch {
    return { status: "missing" };
  }
}
