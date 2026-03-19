#!/usr/bin/env bun

import { chmod, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type InstallMode = "dev" | "bin";

const CLI_NAME = "fclt";
const COMPATIBILITY_CLI_NAMES = ["facult"];
const DEFAULT_INSTALL_DIR_RELATIVE = ".ai/.facult/bin";

interface ParseOk {
  ok: true;
  mode: InstallMode;
  installDirRaw: string | null;
  force: boolean;
}

interface ParseErr {
  ok: false;
  message: string;
}

type CurrentInstall =
  | { status: "missing" }
  | { status: "present"; kind: "symlink"; linkTarget: string }
  | { status: "present"; kind: "file"; content: string };

type DesiredInstall =
  | {
      kind: "wrapper";
      mode: "dev";
      targetPath: string;
      installDir: string;
      content: string;
    }
  | {
      kind: "symlink";
      mode: "bin";
      targetPath: string;
      installDir: string;
      linkTarget: string;
    };

const parsed = parseArgs(Bun.argv.slice(2));
if (parsed.ok) {
  process.exitCode = await main(parsed);
} else {
  process.stderr.write(`${parsed.message}\n`);
  process.exitCode = 1;
}

async function main(parsed: ParseOk): Promise<number> {
  const repoRoot = resolve(import.meta.dir, "..");
  const home = (process.env.HOME ?? "").trim();
  if (!home) {
    process.stderr.write(
      "HOME is not set; cannot determine install directory.\n"
    );
    return 1;
  }

  const installDir = resolveInstallDir({
    home,
    installDirRaw: parsed.installDirRaw,
  });
  await mkdir(installDir, { recursive: true });

  const targetPath = resolve(installDir, CLI_NAME);
  const packageVersion = await readPackageVersion(repoRoot);
  let desired: DesiredInstall;
  try {
    desired = await desiredInstall({
      mode: parsed.mode,
      repoRoot,
      installDir,
      targetPath,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`${message}\n`);
    return 1;
  }

  const current = await readCurrentInstall(targetPath);
  if (current.status === "present" && isSameInstall({ current, desired })) {
    printSuccess({
      mode: parsed.mode,
      installDir,
      targetPath,
      note: "Already installed",
    });
    return 0;
  }

  if (current.status === "present" && !parsed.force) {
    process.stderr.write(`Refusing to overwrite existing '${CLI_NAME}' at:\n`);
    process.stderr.write(`  ${targetPath}\n`);
    process.stderr.write("Re-run with --force to replace it.\n");
    return 1;
  }

  if (current.status === "present") {
    await rm(targetPath, { force: true });
  }

  await applyInstall(desired);
  await installCompatibilityAliases({
    desired,
    installDir,
    force: parsed.force,
  });
  await writeInstallState({
    home,
    method: parsed.mode === "dev" ? "script-dev" : "script-bin",
    packageVersion,
    binaryPath: desired.kind === "symlink" ? desired.linkTarget : targetPath,
  });
  printSuccess({ mode: parsed.mode, installDir, targetPath });
  return 0;
}

function parseArgs(argv: readonly string[]): ParseOk | ParseErr {
  let mode: InstallMode = "dev";
  let installDirRaw: string | null = null;
  let force = false;

  for (const arg of argv) {
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length).trim();
      if (value === "dev" || value === "bin") {
        mode = value;
        continue;
      }
      return {
        ok: false,
        message: `Invalid --mode: ${value} (expected dev|bin)`,
      };
    }
    if (arg.startsWith("--dir=")) {
      const value = arg.slice("--dir=".length).trim();
      if (!value) {
        return { ok: false, message: "Invalid --dir (empty)" };
      }
      installDirRaw = value;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return {
        ok: false,
        message: [
          "Install fclt as a local global command (~/.ai/.facult/bin/fclt by default).",
          "",
          "Usage:",
          "  bun run scripts/install-cli.ts [--mode=dev|bin] [--dir=/path] [--force]",
          "",
          "Modes:",
          "  --mode=dev  Install a wrapper that runs this repo's source via Bun.",
          "  --mode=bin  Install a symlink to dist/fclt (compiled binary).",
          "",
        ].join("\n"),
      };
    }
    return { ok: false, message: `Unknown arg: ${arg}` };
  }

  return { ok: true, mode, installDirRaw, force };
}

function resolveInstallDir(opts: {
  home: string;
  installDirRaw: string | null;
}): string {
  if (opts.installDirRaw?.trim()) {
    return resolve(opts.installDirRaw);
  }
  return resolve(opts.home, DEFAULT_INSTALL_DIR_RELATIVE);
}

async function desiredInstall(opts: {
  mode: InstallMode;
  repoRoot: string;
  installDir: string;
  targetPath: string;
}): Promise<DesiredInstall> {
  if (opts.mode === "dev") {
    const sourceEntry = resolve(opts.repoRoot, "src", "index.ts");
    const content = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "# fclt local-dev shim (auto-generated)",
      `exec bun ${shellQuote(sourceEntry)} "$@"`,
      "",
    ].join("\n");

    return {
      kind: "wrapper",
      mode: "dev",
      installDir: opts.installDir,
      targetPath: opts.targetPath,
      content,
    };
  }

  const linkTarget = resolve(opts.repoRoot, "dist", "fclt");
  if (!(await fileExists(linkTarget))) {
    throw new Error(
      `Missing compiled binary at ${linkTarget}\nRun: bun run build`
    );
  }

  return {
    kind: "symlink",
    mode: "bin",
    installDir: opts.installDir,
    targetPath: opts.targetPath,
    linkTarget,
  };
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

function isSameInstall(opts: {
  current: CurrentInstall;
  desired: DesiredInstall;
}): boolean {
  if (opts.current.status !== "present") {
    return false;
  }
  if (opts.desired.kind === "symlink") {
    return (
      opts.current.kind === "symlink" &&
      resolve(opts.current.linkTarget) === resolve(opts.desired.linkTarget)
    );
  }
  return (
    opts.current.kind === "file" &&
    opts.current.content === opts.desired.content
  );
}

async function applyInstall(desired: DesiredInstall): Promise<void> {
  if (desired.kind === "symlink") {
    await symlink(desired.linkTarget, desired.targetPath);
    return;
  }
  await Bun.write(desired.targetPath, desired.content);
  await chmod(desired.targetPath, 0o755);
}

async function installCompatibilityAliases(args: {
  desired: DesiredInstall;
  installDir: string;
  force: boolean;
}) {
  for (const alias of COMPATIBILITY_CLI_NAMES) {
    const aliasPath = resolve(args.installDir, alias);
    const current = await readCurrentInstall(aliasPath);
    if (current.status === "present") {
      await rm(aliasPath, { force: true });
    }

    if (args.desired.kind === "symlink") {
      await symlink(args.desired.linkTarget, aliasPath);
      continue;
    }

    const aliasContent = args.desired.content.replace(
      "# fclt local-dev shim",
      "# fclt compatibility shim"
    );
    await Bun.write(aliasPath, aliasContent);
    await chmod(aliasPath, 0o755);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function printSuccess(args: {
  mode: InstallMode;
  installDir: string;
  targetPath: string;
  note?: string;
}) {
  if (args.note) {
    process.stdout.write(`${args.note}.\n`);
  } else {
    process.stdout.write(`Installed fclt (${args.mode}).\n`);
  }
  process.stdout.write(`Path: ${args.targetPath}\n`);
  process.stdout.write(`Install dir: ${args.installDir}\n`);
  process.stdout.write(
    `Add to PATH if needed: export PATH="${args.installDir}:$PATH"\n`
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Bun.file(path).stat();
    return true;
  } catch {
    return false;
  }
}

async function readPackageVersion(
  repoRoot: string
): Promise<string | undefined> {
  try {
    const pkg = (await Bun.file(resolve(repoRoot, "package.json")).json()) as {
      version?: string;
    };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

async function writeInstallState(args: {
  home: string;
  method: "script-dev" | "script-bin";
  packageVersion?: string;
  binaryPath?: string;
}) {
  const dir = resolve(args.home, ".ai", ".facult");
  await mkdir(dir, { recursive: true });
  const payload = {
    version: 1,
    method: args.method,
    packageVersion: args.packageVersion,
    binaryPath: args.binaryPath,
    source: "local-script",
    installedAt: new Date().toISOString(),
  };
  await Bun.write(
    resolve(dir, "install.json"),
    `${JSON.stringify(payload, null, 2)}\n`
  );
}
