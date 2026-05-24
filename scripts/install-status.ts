#!/usr/bin/env bun

import { lstat, readlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { facultInstallStatePath } from "../src/paths";

const CLI_NAME = "fclt";
const DEFAULT_INSTALL_DIR_RELATIVE = ".ai/.facult/bin";

const home = (process.env.HOME ?? "").trim();
if (!home) {
  process.stderr.write(
    "HOME is not set; cannot determine install directory.\n"
  );
  process.exit(1);
}

const installDir = resolve(home, DEFAULT_INSTALL_DIR_RELATIVE);
const targetPath = resolve(installDir, CLI_NAME);
const [current, activeExecutable, installState, packageInfo] =
  await Promise.all([
    readCurrentInstall(targetPath),
    resolveActiveExecutable(),
    readInstallState(home),
    readPackageInfo(),
  ]);

process.stdout.write(
  `Repo package version: ${packageInfo.version ?? "unknown"}\n`
);
process.stdout.write(
  `Active executable: ${activeExecutable ?? "not found on PATH"}\n`
);
process.stdout.write(`Managed install path: ${targetPath}\n`);
if (installState) {
  process.stdout.write(
    `Install state: ${installState.method ?? "unknown"}${installState.packageVersion ? ` ${installState.packageVersion}` : ""}\n`
  );
  if (installState.binaryPath) {
    process.stdout.write(`Install state binary: ${installState.binaryPath}\n`);
  }
}

if (current.status === "missing") {
  process.stdout.write("Managed install: missing\n");
  process.exit(0);
}

if (current.kind === "symlink") {
  const mode = current.linkTarget.endsWith("/dist/fclt")
    ? "bin (symlink)"
    : "symlink";
  process.stdout.write(`Managed install mode: ${mode}\n`);
  process.stdout.write(`Target: ${current.linkTarget}\n`);
  process.exit(0);
}

const isDevWrapper =
  current.content.includes("fclt local-dev shim") ||
  current.content.includes("fclt compatibility shim");
process.stdout.write(
  `Managed install mode: ${isDevWrapper ? "dev (wrapper)" : "file (unknown)"}\n`
);
process.exit(0);

type CurrentInstall =
  | { status: "missing" }
  | { status: "present"; kind: "symlink"; linkTarget: string }
  | { status: "present"; kind: "file"; content: string };

interface InstallState {
  method?: string;
  packageVersion?: string;
  binaryPath?: string;
}

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

function resolveActiveExecutable(): string | null {
  return Bun.which(CLI_NAME) ?? null;
}

async function readInstallState(home: string): Promise<InstallState | null> {
  try {
    return (await Bun.file(
      facultInstallStatePath(home)
    ).json()) as InstallState;
  } catch {
    return null;
  }
}

async function readPackageInfo(): Promise<{ version?: string }> {
  try {
    const pkg = (await Bun.file(
      new URL("../package.json", import.meta.url)
    ).json()) as { version?: string };
    return { version: pkg.version };
  } catch {
    return {};
  }
}
