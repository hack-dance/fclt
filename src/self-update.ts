import { mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  legacyExternalFacultStateDir,
  preferredGlobalFacultStateDir,
} from "./paths";

const REPO_OWNER = "hack-dance";
const REPO_NAME = "facult";
const PACKAGE_NAME = "facult";
const DOWNLOAD_RETRIES = 12;
const DOWNLOAD_RETRY_DELAY_MS = 5000;
const CLI_BASENAME_PATTERN = /^(fclt|facult)(\.exe)?$/;

type InstallMethod =
  | "script-dev"
  | "script-bin"
  | "release-script"
  | "npm-binary-cache"
  | "unknown";

interface InstallState {
  version: number;
  method?: string;
  packageVersion?: string;
  binaryPath?: string;
  packageManager?: string;
  source?: string;
  installedAt?: string;
}

interface ParsedArgs {
  dryRun: boolean;
  requestedVersion?: string;
}

interface DetectInstallMethodContext {
  envInstallMethod?: string;
  executablePath?: string;
  homeDir?: string;
}

function printHelp() {
  console.log(`fclt self-update — update fclt itself based on install method

Usage:
  fclt self-update [--version <x.y.z|latest>] [--dry-run]
  fclt update --self [--version <x.y.z|latest>] [--dry-run]

Options:
  --version   Target version (defaults to latest)
  --dry-run   Print update actions without changing anything
`);
}

export function parseSelfUpdateArgs(argv: string[]): ParsedArgs {
  let dryRun = false;
  let requestedVersion: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--version") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--version requires a value.");
      }
      requestedVersion = next.trim();
      i += 1;
      continue;
    }
    if (arg.startsWith("--version=")) {
      requestedVersion = arg.slice("--version=".length).trim();
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return { dryRun, requestedVersion };
}

async function loadInstallState(home: string): Promise<InstallState | null> {
  const paths = [
    join(preferredGlobalFacultStateDir(home), "install.json"),
    join(legacyExternalFacultStateDir(home), "install.json"),
  ];
  for (const path of paths) {
    try {
      const txt = await Bun.file(path).text();
      return JSON.parse(txt) as InstallState;
    } catch {
      // Ignore unreadable or malformed persisted install state and try the next location.
    }
  }
  return null;
}

export function detectInstallMethod(
  state: InstallState | null,
  context: DetectInstallMethodContext = {}
): InstallMethod {
  const envMethod =
    context.envInstallMethod ?? process.env.FACULT_INSTALL_METHOD?.trim();
  if (envMethod === "script-dev" || envMethod === "script-bin") {
    return envMethod;
  }
  if (envMethod === "npm-binary-cache") {
    return "npm-binary-cache";
  }
  const raw = state?.method?.trim();
  if (
    raw === "script-dev" ||
    raw === "script-bin" ||
    raw === "release-script" ||
    raw === "npm-binary-cache"
  ) {
    return raw;
  }

  const exec = context.executablePath ?? process.execPath;
  const home = context.homeDir ?? homedir();
  const facultBins = [
    join(preferredGlobalFacultStateDir(home), "bin"),
    join(legacyExternalFacultStateDir(home), "bin"),
  ];
  if (
    facultBins.some(
      (facultBin) =>
        exec.startsWith(facultBin + sep) &&
        CLI_BASENAME_PATTERN.test(basename(exec))
    )
  ) {
    return "release-script";
  }

  return "unknown";
}

function resolvePlatformTarget(): {
  platform: string;
  arch: string;
  ext: string;
} {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return { platform: "darwin", arch, ext: "" };
  }
  if (platform === "linux" && arch === "x64") {
    return { platform: "linux", arch, ext: "" };
  }
  if (platform === "win32" && arch === "x64") {
    return { platform: "windows", arch, ext: ".exe" };
  }
  throw new Error(
    [
      `Unsupported platform/arch: ${platform}/${arch}`,
      "Prebuilt binaries are currently available for:",
      "  - darwin/x64",
      "  - darwin/arm64",
      "  - linux/x64",
      "  - windows/x64",
    ].join("\n")
  );
}

async function resolveLatestTag(): Promise<string> {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "fclt-self-update",
      accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to resolve latest release tag: HTTP ${res.status}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  const tag = typeof json.tag_name === "string" ? json.tag_name.trim() : "";
  if (!tag) {
    throw new Error("Latest release did not include a tag.");
  }
  return tag;
}

export function normalizeVersionTag(requested?: string): string | null {
  if (!requested || requested === "latest") {
    return null;
  }
  return requested.startsWith("v") ? requested : `v${requested}`;
}

export function stripTagPrefix(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

async function writeInstallState(args: {
  home: string;
  method: InstallMethod;
  packageVersion?: string;
  binaryPath?: string;
}) {
  const dir = preferredGlobalFacultStateDir(args.home);
  await mkdir(dir, { recursive: true });
  const payload: InstallState = {
    version: 1,
    method: args.method,
    packageVersion: args.packageVersion,
    binaryPath: args.binaryPath,
    source: args.method === "npm-binary-cache" ? "npm" : "direct",
    installedAt: new Date().toISOString(),
  };
  await Bun.write(
    join(dir, "install.json"),
    `${JSON.stringify(payload, null, 2)}\n`
  );
}

async function selfUpdateBinary(args: {
  home: string;
  state: InstallState | null;
  method: InstallMethod;
  requestedVersion?: string;
  dryRun: boolean;
}) {
  const target = resolvePlatformTarget();
  const explicitTag = normalizeVersionTag(args.requestedVersion);
  const tag = explicitTag ?? (await resolveLatestTag());
  const version = stripTagPrefix(tag);
  const assetNames = [
    `${PACKAGE_NAME}-${version}-${target.platform}-${target.arch}${target.ext}`,
    `facult-${version}-${target.platform}-${target.arch}${target.ext}`,
  ];
  const urls = assetNames.map(
    (assetName) =>
      `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${tag}/${assetName}`
  );

  const defaultBinaryName = target.platform === "windows" ? "fclt.exe" : "fclt";
  const fallbackPath = join(
    preferredGlobalFacultStateDir(args.home),
    "bin",
    defaultBinaryName
  );
  const currentExec = process.execPath;
  const preferredPath =
    args.state?.binaryPath ||
    (CLI_BASENAME_PATTERN.test(basename(currentExec))
      ? currentExec
      : fallbackPath);
  const binaryPath = resolve(preferredPath);

  if (args.dryRun) {
    console.log(`[dry-run] Would download ${urls[0]}`);
    console.log(`[dry-run] Would replace ${binaryPath}`);
    return;
  }

  await mkdir(dirname(binaryPath), { recursive: true });
  const bytes = await fetchFirstReleaseBinaryWithRetry(urls);
  const tmpPath = `${binaryPath}.tmp-${Date.now()}`;
  await Bun.write(tmpPath, Buffer.from(bytes));
  if (target.platform !== "windows") {
    await Bun.$`chmod +x ${tmpPath}`.quiet();
  }
  await rename(tmpPath, binaryPath);
  await writeInstallState({
    home: args.home,
    method: args.method === "unknown" ? "release-script" : args.method,
    packageVersion: version,
    binaryPath,
  });
  console.log(`Updated fclt binary to ${version}`);
  console.log(`Path: ${binaryPath}`);
}

type PackageManager = "npm" | "bun";

function chooseGlobalPackageManager(preferred?: string): PackageManager {
  const forced = process.env.FACULT_INSTALL_PM?.trim();
  if (forced === "npm" || forced === "bun") {
    return forced;
  }

  if (preferred === "npm" && Bun.which("npm")) {
    return "npm";
  }
  if (preferred === "bun" && Bun.which("bun")) {
    return "bun";
  }

  if (Bun.which("npm")) {
    return "npm";
  }
  if (Bun.which("bun")) {
    return "bun";
  }
  return "npm";
}

async function selfUpdateViaPackageManager(args: {
  requestedVersion?: string;
  dryRun: boolean;
  preferredPackageManager?: string;
}) {
  const pm = chooseGlobalPackageManager(args.preferredPackageManager);
  const targetVersion =
    args.requestedVersion && args.requestedVersion !== "latest"
      ? stripTagPrefix(args.requestedVersion)
      : "latest";

  const installSpec = `${PACKAGE_NAME}@${targetVersion}`;
  const cmd =
    pm === "npm"
      ? ["npm", "install", "-g", installSpec]
      : ["bun", "add", "-g", installSpec];

  if (args.dryRun) {
    console.log(`[dry-run] Would run: ${cmd.join(" ")}`);
    return;
  }

  const proc = Bun.spawn({
    cmd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Self-update failed via ${pm} (exit ${code}).`);
  }
  console.log(`Updated fclt via ${pm}: ${installSpec}`);
}

async function fetchReleaseBinaryWithRetry(url: string): Promise<ArrayBuffer> {
  let lastStatus: number | null = null;
  let lastError: unknown;

  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "fclt-self-update",
          accept: "application/octet-stream",
        },
      });
      if (response.ok) {
        return await response.arrayBuffer();
      }

      lastStatus = response.status;
      if (response.status >= 500 && attempt < DOWNLOAD_RETRIES) {
        await sleep(DOWNLOAD_RETRY_DELAY_MS);
        continue;
      }
      if (response.status === 404 && attempt < DOWNLOAD_RETRIES) {
        await sleep(DOWNLOAD_RETRY_DELAY_MS);
        continue;
      }

      throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt >= DOWNLOAD_RETRIES) {
        break;
      }
      await sleep(DOWNLOAD_RETRY_DELAY_MS);
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  const statusDetail = lastStatus ? ` HTTP ${lastStatus}` : "";
  throw new Error(`Failed to download ${url}.${statusDetail}`);
}

async function fetchFirstReleaseBinaryWithRetry(
  urls: string[]
): Promise<ArrayBuffer> {
  let lastError: unknown;
  for (const url of urls) {
    try {
      return await fetchReleaseBinaryWithRetry(url);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Download failed.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function selfUpdateCommand(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printHelp();
    return;
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseSelfUpdateArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const home = homedir();
  const state = await loadInstallState(home);
  const method = detectInstallMethod(state);

  try {
    if (method === "script-dev") {
      console.log("Detected dev-wrapper install.");
      console.log(
        "Self-update is not automated for dev mode. Update your repo and rerun install:dev."
      );
      return;
    }
    if (method === "npm-binary-cache") {
      await selfUpdateViaPackageManager({
        ...parsed,
        preferredPackageManager:
          process.env.FACULT_INSTALL_PM?.trim() || state?.packageManager,
      });
      return;
    }
    await selfUpdateBinary({
      home,
      state,
      method,
      requestedVersion: parsed.requestedVersion,
      dryRun: parsed.dryRun,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
