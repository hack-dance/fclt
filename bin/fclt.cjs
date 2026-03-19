#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const pkg = require("../package.json");

const REPO_OWNER = "hack-dance";
const REPO_NAME = "facult";
const PACKAGE_NAME = "fclt";
const DOWNLOAD_RETRIES = 12;
const DOWNLOAD_RETRY_DELAY_MS = 5000;

async function main() {
  const resolved = resolveTarget();
  if (!resolved.ok) {
    console.error(resolved.message);
    process.exit(1);
  }

  const version = String(pkg.version || "").trim();
  if (!version) {
    console.error("Invalid package version.");
    process.exit(1);
  }

  const home = os.homedir();
  const cacheRoot = path.join(home, ".ai", ".facult", "runtime");
  const installDir = path.join(
    cacheRoot,
    version,
    `${resolved.platform}-${resolved.arch}`
  );
  const binaryName = resolved.platform === "windows" ? "fclt.exe" : "fclt";
  const binaryPath = path.join(installDir, binaryName);

  if (!(await fileExists(binaryPath))) {
    const tag = `v${version}`;
    const assetName = `${PACKAGE_NAME}-${version}-${resolved.platform}-${resolved.arch}${resolved.ext}`;
    const url = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${tag}/${assetName}`;

    await fsp.mkdir(installDir, { recursive: true });
    const tmpPath = `${binaryPath}.tmp-${Date.now()}`;
    try {
      await downloadWithRetry(url, tmpPath, {
        attempts: DOWNLOAD_RETRIES,
        delayMs: DOWNLOAD_RETRY_DELAY_MS,
      });
      if (resolved.platform !== "windows") {
        await fsp.chmod(tmpPath, 0o755);
      }
      await fsp.rename(tmpPath, binaryPath);
    } catch (error) {
      await safeUnlink(tmpPath);
      const message =
        error instanceof Error ? error.message : String(error ?? "");
      console.error(
        [
          "Unable to download the fclt binary for this platform.",
          `Expected asset: ${assetName}`,
          `URL: ${url}`,
          `Reason: ${message}`,
          "",
          "Try installing directly from releases:",
          "https://github.com/hack-dance/facult/releases",
        ].join("\n")
      );
      process.exit(1);
    }
  }

  const packageManager = detectPackageManager();
  await writeInstallState({
    method: "npm-binary-cache",
    version,
    binaryPath,
    packageManager,
  });

  const args = process.argv.slice(2);
  const result = spawnSync(binaryPath, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      FACULT_INSTALL_METHOD: "npm-binary-cache",
      FACULT_NPM_PACKAGE_VERSION: version,
      FACULT_RUNTIME_BINARY: binaryPath,
      FACULT_INSTALL_PM: packageManager,
    },
  });

  if (typeof result.status === "number") {
    process.exit(result.status);
  }
  process.exit(1);
}

function resolveTarget() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin" && arch === "arm64") {
    return { ok: true, platform: "darwin", arch: "arm64", ext: "" };
  }
  if (platform === "darwin" && arch === "x64") {
    return { ok: true, platform: "darwin", arch: "x64", ext: "" };
  }
  if (platform === "linux" && arch === "x64") {
    return { ok: true, platform: "linux", arch: "x64", ext: "" };
  }
  if (platform === "win32" && arch === "x64") {
    return { ok: true, platform: "windows", arch: "x64", ext: ".exe" };
  }
  return {
    ok: false,
    message: [
      `Unsupported platform/arch: ${platform}/${arch}`,
      "Prebuilt binaries are currently available for:",
      "  - darwin/x64",
      "  - darwin/arm64",
      "  - linux/x64",
      "  - windows/x64",
    ].join("\n"),
  };
}

function detectPackageManager() {
  const forced = String(process.env.FACULT_INSTALL_PM || "").trim();
  if (forced === "bun" || forced === "npm") {
    return forced;
  }

  const userAgent = String(process.env.npm_config_user_agent || "");
  if (userAgent.startsWith("bun/")) {
    return "bun";
  }
  if (userAgent.startsWith("npm/")) {
    return "npm";
  }
  if (__filename.includes(`${path.sep}.bun${path.sep}`)) {
    return "bun";
  }
  return "npm";
}

function buildRequestHeaders() {
  return {
    "user-agent": "fclt-installer",
    accept: "application/octet-stream",
  };
}

async function download(url, destinationPath) {
  await new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: buildRequestHeaders(),
      },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          download(response.headers.location, destinationPath)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(
              `HTTP ${response.statusCode ?? "unknown"} while downloading`
            )
          );
          return;
        }

        const file = fs.createWriteStream(destinationPath);
        response.pipe(file);
        file.on("finish", () => {
          file.close((err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve(undefined);
          });
        });
        file.on("error", (err) => reject(err));
      }
    );

    request.on("error", (err) => reject(err));
  });
}

async function downloadWithRetry(url, destinationPath, options) {
  let lastError = null;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      await safeUnlink(destinationPath);
      await download(url, destinationPath);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= options.attempts) {
        break;
      }
      await sleep(options.delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function safeUnlink(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch {
    // Ignore missing temp files during retries and cleanup.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeInstallState(state) {
  const home = os.homedir();
  const installStateDir = path.join(home, ".ai", ".facult");
  const installStatePath = path.join(installStateDir, "install.json");
  await fsp.mkdir(installStateDir, { recursive: true });
  await fsp.writeFile(
    `${installStatePath}.tmp`,
    JSON.stringify(state, null, 2)
  );
  await fsp.rename(`${installStatePath}.tmp`, installStatePath);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  console.error(message);
  process.exit(1);
});
