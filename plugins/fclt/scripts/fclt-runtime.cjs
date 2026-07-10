"use strict";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const PLUGIN_PROTOCOL_VERSION = 1;
const STATE_SCHEMA_VERSION = 1;
const REPOSITORY = "hack-dance/fclt";
const MAX_BINARY_BYTES = 256 * 1024 * 1024;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 15_000;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const NEWLINE_RE = /\r?\n/;
const CHECKSUM_LINE_RE = /^([a-fA-F0-9]{64})\s+\*?(.+)$/;
const WINDOWS_SHIM_RE = /\.(?:bat|cmd)$/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pluginVersion() {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "..", ".codex-plugin", "plugin.json"),
        "utf8"
      )
    );
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

function runtimeStateRoot(env = process.env, platform = process.platform) {
  if (env.FCLT_PLUGIN_RUNTIME_DIR) {
    return path.resolve(env.FCLT_PLUGIN_RUNTIME_DIR);
  }
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      "fclt",
      "plugin-runtime"
    );
  }
  if (platform === "win32") {
    return path.join(
      env.LOCALAPPDATA || path.join(home, "AppData", "Local"),
      "fclt",
      "plugin-runtime"
    );
  }
  return path.join(
    env.XDG_STATE_HOME || path.join(home, ".local", "state"),
    "fclt",
    "plugin-runtime"
  );
}

function installStatePaths(env = process.env, platform = process.platform) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (platform === "darwin") {
    return [
      path.join(home, "Library", "Application Support", "fclt", "install.json"),
    ];
  }
  if (platform === "win32") {
    return [
      path.join(
        env.LOCALAPPDATA || path.join(home, "AppData", "Local"),
        "fclt",
        "install.json"
      ),
    ];
  }
  return [
    path.join(
      env.XDG_STATE_HOME || path.join(home, ".local", "state"),
      "fclt",
      "install.json"
    ),
    path.join(home, ".local", "share", "fclt", "install.json"),
  ];
}

function isSubpath(child, parent) {
  const relative = path.relative(parent, child);
  return (
    relative === "" || !(relative.startsWith("..") || path.isAbsolute(relative))
  );
}

async function assertManagedPath(target, root) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!isSubpath(resolvedTarget, resolvedRoot)) {
    throw new Error("Runtime path escapes the managed runtime root.");
  }

  const relative = path.relative(resolvedRoot, path.dirname(resolvedTarget));
  const segments = relative ? relative.split(path.sep) : [];
  let cursor = resolvedRoot;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    try {
      if ((await fsp.lstat(cursor)).isSymbolicLink()) {
        throw new Error("Runtime path traverses a symbolic link.");
      }
    } catch (error) {
      if (error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return resolvedTarget;
}

async function readJson(pathValue) {
  try {
    const value = JSON.parse(await fsp.readFile(pathValue, "utf8"));
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

async function runtimePolicy(options = {}) {
  const root = runtimeStateRoot(options.env, options.platform);
  const persisted = await readJson(path.join(root, "policy.json"));
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    updateChecksEnabled: persisted?.updateChecksEnabled !== false,
    pinnedVersion:
      typeof persisted?.pinnedVersion === "string" &&
      persisted.pinnedVersion.trim()
        ? normalizeVersion(persisted.pinnedVersion)
        : null,
  };
}

function commandNames(platform = process.platform) {
  return platform === "win32"
    ? ["fclt.exe", "fclt.cmd", "facult.exe", "facult.cmd"]
    : ["fclt", "facult"];
}

function pathCandidates(env = process.env, platform = process.platform) {
  const values = [];
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    for (const name of commandNames(platform)) {
      values.push(path.join(directory, name));
    }
  }
  return values;
}

function candidateSource(candidate) {
  const normalized = candidate.split("\\").join("/");
  if (normalized.includes("/plugin-runtime/versions/")) {
    return "plugin_runtime";
  }
  if (normalized.includes("/mise/") || normalized.includes("/mise/installs/")) {
    return "mise";
  }
  if (
    normalized.includes("/Cellar/") ||
    normalized.startsWith("/opt/homebrew/")
  ) {
    return "homebrew";
  }
  if (normalized.includes("/node_modules/") || normalized.includes("/npm/")) {
    return "npm";
  }
  if (normalized.includes("/.ai/.facult/bin/")) {
    return "canonical_install";
  }
  return "path";
}

async function activeRuntimeCandidate(root) {
  const active = await readJson(path.join(root, "active.json"));
  if (typeof active?.executable !== "string" || !active.executable.trim()) {
    return null;
  }
  const executable = path.resolve(active.executable);
  if (!isSubpath(executable, path.join(root, "versions"))) {
    return null;
  }
  return {
    executable,
    source: "plugin_runtime",
    expectedSha256: active.sha256,
    active,
  };
}

async function persistedInstallCandidates(
  env = process.env,
  platform = process.platform
) {
  const candidates = [];
  for (const statePath of installStatePaths(env, platform)) {
    const state = await readJson(statePath);
    if (typeof state?.binaryPath === "string" && state.binaryPath.trim()) {
      candidates.push({
        executable: path.resolve(state.binaryPath),
        source:
          typeof state.source === "string" ? state.source : "install_metadata",
        installStatePath: statePath,
      });
    }
  }
  return candidates;
}

async function runtimeCandidates(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const root = runtimeStateRoot(env, platform);
  const candidates = [];
  let configuredPathCandidate = null;

  if (env.FCLT_BIN?.trim()) {
    const explicit = env.FCLT_BIN.trim();
    if (path.isAbsolute(explicit) || explicit.includes(path.sep)) {
      candidates.push({
        executable: path.resolve(explicit),
        source: "explicit",
      });
    } else {
      const resolved = pathCandidates(env, platform).find(
        (candidate) =>
          path.basename(candidate) === explicit && fs.existsSync(candidate)
      );
      configuredPathCandidate = {
        executable: resolved || explicit,
        source: "configured_path",
      };
    }
  }

  const active = await activeRuntimeCandidate(root);
  if (active) {
    candidates.push(active);
  }
  if (configuredPathCandidate) {
    candidates.push(configuredPathCandidate);
  }
  candidates.push(...(await persistedInstallCandidates(env, platform)));
  candidates.push(
    ...pathCandidates(env, platform).map((executable) => ({
      executable,
      source: candidateSource(executable),
    }))
  );

  for (const executable of [
    path.join(home, ".ai", ".facult", "bin", commandNames(platform)[0]),
    ...(platform === "darwin"
      ? ["/opt/homebrew/bin/fclt", "/usr/local/bin/fclt"]
      : platform === "win32"
        ? []
        : ["/usr/local/bin/fclt", "/usr/bin/fclt"]),
  ]) {
    candidates.push({ executable, source: candidateSource(executable) });
  }

  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = path.resolve(candidate.executable);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(candidate);
    }
  }
  return unique;
}

function runCommand(executable, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      const platform = options.platform || process.platform;
      const windowsShim =
        platform === "win32" && WINDOWS_SHIM_RE.test(executable);
      const command = windowsShim
        ? options.env?.ComSpec || process.env.ComSpec || "cmd.exe"
        : executable;
      const commandArgs = windowsShim
        ? [
            "/d",
            "/v:off",
            "/s",
            "/c",
            [executable, ...args]
              .map(
                (value) =>
                  `"${String(value)
                    .replaceAll("%", "%%")
                    .replace(/[\^&|<>()!"]/g, "^$&")}"`
              )
              .join(" "),
          ]
        : args;
      child = spawn(command, commandArgs, {
        cwd: options.cwd || process.cwd(),
        env: options.env || process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: 1, stdout: "", stderr: error.message });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(
      () => child.kill("SIGTERM"),
      options.timeoutMs || COMMAND_TIMEOUT_MS
    );
    const finish = (code, error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr: [stderr.trim(), error].filter(Boolean).join("\n"),
      });
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_METADATA_BYTES) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_METADATA_BYTES) {
        child.kill("SIGTERM");
      }
    });
    child.on("error", (error) => finish(1, error.message));
    child.on("close", (code) => finish(code ?? 1));
  });
}

function parseProtocolReport(raw) {
  try {
    const report = JSON.parse(raw);
    if (
      !isPlainObject(report) ||
      report.schemaVersion !== 1 ||
      typeof report.packageVersion !== "string" ||
      !isPlainObject(report.protocol) ||
      !Number.isInteger(report.protocol.version) ||
      !Number.isInteger(report.protocol.minimumPluginVersion) ||
      !Number.isInteger(report.protocol.maximumPluginVersion)
    ) {
      return null;
    }
    return report;
  } catch {
    return null;
  }
}

function protocolCompatibility(report) {
  if (!report) {
    return { compatible: false, reason: "missing_protocol_handshake" };
  }
  const compatible =
    report.protocol.minimumPluginVersion <= PLUGIN_PROTOCOL_VERSION &&
    report.protocol.maximumPluginVersion >= PLUGIN_PROTOCOL_VERSION;
  return {
    compatible,
    reason: compatible ? "compatible" : "protocol_version_skew",
  };
}

async function inspectCandidate(candidate, options = {}) {
  const executable = path.resolve(candidate.executable);
  try {
    const stat = await fsp.stat(executable);
    if (!stat.isFile()) {
      return {
        ...candidate,
        executable,
        available: false,
        compatible: false,
        reason: "not_a_file",
      };
    }
  } catch {
    return {
      ...candidate,
      executable,
      available: false,
      compatible: false,
      reason: "not_found",
    };
  }

  if (candidate.source === "plugin_runtime") {
    if (
      typeof candidate.expectedSha256 !== "string" ||
      !SHA256_RE.test(candidate.expectedSha256)
    ) {
      return {
        ...candidate,
        executable,
        available: true,
        compatible: false,
        reason: "missing_checksum",
      };
    }
    try {
      const actualSha256 = sha256(await fsp.readFile(executable));
      if (actualSha256 !== candidate.expectedSha256) {
        return {
          ...candidate,
          executable,
          available: true,
          compatible: false,
          reason: "checksum_mismatch",
        };
      }
    } catch {
      return {
        ...candidate,
        executable,
        available: false,
        compatible: false,
        reason: "checksum_unreadable",
      };
    }
  }

  const result = await runCommand(executable, ["protocol", "--json"], options);
  const report =
    result.code === 0 ? parseProtocolReport(result.stdout.trim()) : null;
  const compatibility = protocolCompatibility(report);
  return {
    ...candidate,
    executable,
    available: true,
    compatible: compatibility.compatible,
    reason: compatibility.reason,
    packageVersion: report?.packageVersion,
    protocol: report?.protocol,
    platform: report?.runtime?.platform,
    architecture: report?.runtime?.architecture,
  };
}

async function discoverRuntime(options = {}) {
  const policy = await runtimePolicy(options);
  const inspected = [];
  for (const candidate of await runtimeCandidates(options)) {
    const result = await inspectCandidate(candidate, options);
    inspected.push(result);
    if (result.compatible) {
      return {
        schemaVersion: STATE_SCHEMA_VERSION,
        plugin: {
          version: pluginVersion(),
          protocolVersion: PLUGIN_PROTOCOL_VERSION,
        },
        policy,
        selected: result,
        compatible: true,
        requiresFreshSession: false,
        candidates: inspected,
      };
    }
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    plugin: {
      version: pluginVersion(),
      protocolVersion: PLUGIN_PROTOCOL_VERSION,
    },
    policy,
    selected: null,
    compatible: false,
    requiresFreshSession: false,
    candidates: inspected,
  };
}

function releaseTarget(
  platform = process.platform,
  architecture = process.arch
) {
  if (
    platform === "darwin" &&
    (architecture === "arm64" || architecture === "x64")
  ) {
    return { platform: "darwin", architecture, extension: "" };
  }
  if (platform === "linux" && architecture === "x64") {
    return { platform: "linux", architecture, extension: "" };
  }
  if (platform === "win32" && architecture === "x64") {
    return { platform: "windows", architecture, extension: ".exe" };
  }
  throw new Error(
    `Unsupported plugin runtime target: ${platform}/${architecture}`
  );
}

function normalizeVersion(version) {
  const normalized = version?.startsWith("v") ? version.slice(1) : version;
  if (!(normalized && SEMVER_RE.test(normalized))) {
    throw new Error("Runtime version must be an explicit semantic version.");
  }
  return normalized;
}

function assertAllowedUrl(urlValue) {
  const url = new URL(urlValue);
  if (url.protocol !== "https:" || !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new Error(
      "Runtime downloads are restricted to approved HTTPS release hosts."
    );
  }
  return url;
}

function downloadBuffer(urlValue, options = {}) {
  const maxBytes = options.maxBytes || MAX_METADATA_BYTES;
  const redirectsRemaining = options.redirectsRemaining ?? 5;
  const url = assertAllowedUrl(urlValue);
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          accept: options.accept || "application/octet-stream",
          "user-agent": "fclt-codex-plugin",
        },
      },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          if (redirectsRemaining <= 0) {
            reject(new Error("Runtime download exceeded the redirect limit."));
            return;
          }
          const redirected = new URL(response.headers.location, url).toString();
          downloadBuffer(redirected, {
            ...options,
            redirectsRemaining: redirectsRemaining - 1,
          }).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(
              `Runtime download failed with HTTP ${response.statusCode}.`
            )
          );
          return;
        }
        const declaredLength = Number(response.headers["content-length"] || 0);
        if (declaredLength > maxBytes) {
          response.resume();
          reject(new Error("Runtime download exceeds the allowed size."));
          return;
        }
        const chunks = [];
        let total = 0;
        response.on("data", (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            request.destroy(
              new Error("Runtime download exceeds the allowed size.")
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve(Buffer.concat(chunks)));
      }
    );
    request.setTimeout(options.timeoutMs || DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(new Error("Runtime download timed out."));
    });
    request.on("error", reject);
  });
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function checksumForAsset(checksums, assetName) {
  for (const line of checksums.split(NEWLINE_RE)) {
    const match = CHECKSUM_LINE_RE.exec(line.trim());
    if (match?.[2] === assetName) {
      return match[1].toLowerCase();
    }
  }
  throw new Error(`Published checksums do not include ${assetName}.`);
}

async function withMutationLock(root, action) {
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = await assertManagedPath(
    path.join(root, "mutation.lock"),
    root
  );
  let handle;
  try {
    handle = await fsp.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(
        "Another fclt plugin runtime mutation is already in progress."
      );
    }
    throw error;
  }
  try {
    return await action();
  } finally {
    await handle.close();
    await fsp.rm(lockPath, { force: true });
  }
}

async function writeJsonAtomic(pathValue, value, root) {
  const target = await assertManagedPath(pathValue, root);
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${crypto.randomUUID()}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await fsp.rename(temporary, target);
}

function releaseUrls(version, target) {
  const tag = `v${version}`;
  const assetName = `fclt-${version}-${target.platform}-${target.architecture}${target.extension}`;
  const base = `https://github.com/${REPOSITORY}/releases/download/${tag}`;
  return {
    tag,
    assetName,
    binaryUrl: `${base}/${assetName}`,
    checksumUrl: `${base}/SHA256SUMS`,
  };
}

function releaseMetadataUrl(version) {
  return `https://api.github.com/repos/${REPOSITORY}/releases/tags/v${version}`;
}

function releaseAssets(metadata, version, target) {
  if (
    !isPlainObject(metadata) ||
    metadata.tag_name !== `v${version}` ||
    !Array.isArray(metadata.assets)
  ) {
    throw new Error(
      "Release metadata does not match the requested immutable tag."
    );
  }
  const expected = releaseUrls(version, target);
  const findAsset = (name) =>
    metadata.assets.find(
      (asset) =>
        isPlainObject(asset) &&
        asset.name === name &&
        typeof asset.browser_download_url === "string"
    );
  const binary = findAsset(expected.assetName);
  const checksums = findAsset("SHA256SUMS");
  if (!(binary && checksums)) {
    throw new Error(
      "Release metadata is missing the required runtime or checksum asset."
    );
  }
  assertAllowedUrl(binary.browser_download_url);
  assertAllowedUrl(checksums.browser_download_url);
  return { binary, checksums, expected };
}

function verifyPublishedDigest(asset, bytes) {
  if (typeof asset.digest !== "string" || !asset.digest.trim()) {
    return null;
  }
  const [algorithm, expected] = asset.digest.toLowerCase().split(":");
  if (algorithm !== "sha256" || !SHA256_RE.test(expected || "")) {
    throw new Error(`Release asset ${asset.name} has an unsupported digest.`);
  }
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new Error(
      `Release asset ${asset.name} does not match its published digest.`
    );
  }
  return asset.digest.toLowerCase();
}

async function resolveLatestVersion(fetchBuffer = downloadBuffer) {
  const bytes = await fetchBuffer(
    `https://api.github.com/repos/${REPOSITORY}/releases/latest`,
    {
      maxBytes: MAX_METADATA_BYTES,
      accept: "application/vnd.github+json",
    }
  );
  const metadata = JSON.parse(bytes.toString("utf8"));
  if (!isPlainObject(metadata) || typeof metadata.tag_name !== "string") {
    throw new Error("Latest release metadata did not include a tag.");
  }
  return normalizeVersion(metadata.tag_name);
}

async function checkRuntimeUpdate(options = {}) {
  const discovery = await discoverRuntime(options);
  if (!discovery.policy.updateChecksEnabled) {
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      action: "check",
      skipped: true,
      reason: "update_checks_disabled",
      currentVersion: discovery.selected?.packageVersion || null,
      pinnedVersion: discovery.policy.pinnedVersion,
      mutates: false,
    };
  }
  const latestVersion =
    discovery.policy.pinnedVersion ||
    (await resolveLatestVersion(options.fetchBuffer || downloadBuffer));
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    action: "check",
    currentVersion: discovery.selected?.packageVersion || null,
    latestVersion,
    channel: discovery.policy.pinnedVersion ? "pinned" : "latest",
    updateAvailable: discovery.selected?.packageVersion !== latestVersion,
    selected: discovery.selected,
    mutates: false,
  };
}

async function stageRuntime(options) {
  if (options.approve !== true) {
    throw new Error("Staging a runtime download requires approve=true.");
  }
  const version = normalizeVersion(options.version);
  const target = releaseTarget(options.platform, options.architecture);
  const root = runtimeStateRoot(options.env, options.platform);
  const fetchBuffer = options.fetchBuffer || downloadBuffer;
  const urls = releaseUrls(version, target);
  const policy = await runtimePolicy(options);
  if (policy.pinnedVersion && policy.pinnedVersion !== version) {
    throw new Error(`Runtime policy is pinned to ${policy.pinnedVersion}.`);
  }

  return await withMutationLock(root, async () => {
    const metadataBytes = await fetchBuffer(releaseMetadataUrl(version), {
      maxBytes: MAX_METADATA_BYTES,
      accept: "application/vnd.github+json",
    });
    const metadata = JSON.parse(metadataBytes.toString("utf8"));
    const assets = releaseAssets(metadata, version, target);
    const [checksumBytes, binaryBytes] = await Promise.all([
      fetchBuffer(assets.checksums.browser_download_url, {
        maxBytes: MAX_METADATA_BYTES,
      }),
      fetchBuffer(assets.binary.browser_download_url, {
        maxBytes: MAX_BINARY_BYTES,
      }),
    ]);
    const checksumDigest = verifyPublishedDigest(
      assets.checksums,
      checksumBytes
    );
    const binaryDigest = verifyPublishedDigest(assets.binary, binaryBytes);
    const expectedSha256 = checksumForAsset(
      checksumBytes.toString("utf8"),
      urls.assetName
    );
    const actualSha256 = sha256(binaryBytes);
    if (expectedSha256 !== actualSha256) {
      throw new Error(
        "Downloaded runtime checksum does not match the published SHA256SUMS entry."
      );
    }

    const stageDir = await assertManagedPath(
      path.join(root, "staged", version),
      root
    );
    await fsp.rm(stageDir, { recursive: true, force: true });
    await fsp.mkdir(stageDir, { recursive: true, mode: 0o700 });
    const executable = await assertManagedPath(
      path.join(stageDir, target.platform === "windows" ? "fclt.exe" : "fclt"),
      root
    );
    await fsp.writeFile(executable, binaryBytes, { mode: 0o700 });
    if (target.platform !== "windows") {
      await fsp.chmod(executable, 0o700);
    }

    const inspected = await inspectCandidate(
      { executable, source: "staged_plugin_runtime" },
      { env: options.env, timeoutMs: options.timeoutMs }
    );
    if (!inspected.compatible || inspected.packageVersion !== version) {
      await fsp.rm(stageDir, { recursive: true, force: true });
      throw new Error(
        "Staged runtime failed version or protocol verification."
      );
    }

    const manifest = {
      schemaVersion: STATE_SCHEMA_VERSION,
      version,
      tag: urls.tag,
      assetName: urls.assetName,
      executable,
      sha256: actualSha256,
      source: {
        repository: REPOSITORY,
        releaseMetadataUrl: releaseMetadataUrl(version),
        binaryUrl: assets.binary.browser_download_url,
        binaryAssetId: assets.binary.id ?? null,
        binaryDigest,
        checksumUrl: assets.checksums.browser_download_url,
        checksumAssetId: assets.checksums.id ?? null,
        checksumDigest,
      },
      protocol: inspected.protocol,
      platform: target.platform,
      architecture: target.architecture,
      stagedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(path.join(stageDir, "manifest.json"), manifest, root);
    return { action: "stage", mutatesActiveRuntime: false, manifest };
  });
}

async function verifyManifestExecutable(manifest, root, expectedParent) {
  if (
    !isPlainObject(manifest) ||
    manifest.schemaVersion !== STATE_SCHEMA_VERSION ||
    typeof manifest.version !== "string" ||
    typeof manifest.executable !== "string" ||
    typeof manifest.sha256 !== "string" ||
    !SHA256_RE.test(manifest.sha256)
  ) {
    throw new Error("Runtime manifest is missing required verification data.");
  }
  const executable = path.resolve(manifest.executable);
  if (!isSubpath(executable, expectedParent)) {
    throw new Error(
      "Runtime manifest executable escapes its expected directory."
    );
  }
  await assertManagedPath(executable, root);
  const bytes = await fsp.readFile(executable);
  if (sha256(bytes) !== manifest.sha256) {
    throw new Error("Runtime manifest checksum does not match its executable.");
  }
  const inspected = await inspectCandidate({
    executable,
    source: "plugin_runtime",
    expectedSha256: manifest.sha256,
  });
  if (!inspected.compatible || inspected.packageVersion !== manifest.version) {
    throw new Error(
      "Runtime manifest executable failed protocol verification."
    );
  }
  return inspected;
}

async function setRuntimePolicy(options = {}) {
  if (options.approve !== true) {
    throw new Error("Changing runtime update policy requires approve=true.");
  }
  const root = runtimeStateRoot(options.env, options.platform);
  return await withMutationLock(root, async () => {
    const current = await runtimePolicy(options);
    const next = {
      schemaVersion: STATE_SCHEMA_VERSION,
      updateChecksEnabled:
        typeof options.updateChecksEnabled === "boolean"
          ? options.updateChecksEnabled
          : current.updateChecksEnabled,
      pinnedVersion: options.clearPin
        ? null
        : options.pinnedVersion
          ? normalizeVersion(options.pinnedVersion)
          : current.pinnedVersion,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(path.join(root, "policy.json"), next, root);
    return { action: "policy", previous: current, policy: next };
  });
}

async function applyStagedRuntime(options) {
  if (options.approve !== true) {
    throw new Error("Applying a runtime requires approve=true.");
  }
  const version = normalizeVersion(options.version);
  const root = runtimeStateRoot(options.env, options.platform);
  return await withMutationLock(root, async () => {
    const stageDir = path.join(root, "staged", version);
    const manifest = await readJson(path.join(stageDir, "manifest.json"));
    if (!manifest) {
      throw new Error(`No staged runtime exists for ${version}.`);
    }
    if (options.expectedSha256 !== manifest.sha256) {
      throw new Error(
        "Staged runtime precondition failed: expected checksum changed."
      );
    }
    await verifyManifestExecutable(manifest, root, stageDir);

    const activePath = path.join(root, "active.json");
    const previous = await readJson(activePath);
    const versionDir = await assertManagedPath(
      path.join(root, "versions", version),
      root
    );
    await fsp.mkdir(versionDir, { recursive: true, mode: 0o700 });
    const executable = await assertManagedPath(
      path.join(versionDir, path.basename(manifest.executable)),
      root
    );
    const temporary = `${executable}.tmp-${crypto.randomUUID()}`;
    await fsp.copyFile(manifest.executable, temporary);
    if (process.platform !== "win32") {
      await fsp.chmod(temporary, 0o700);
    }
    await fsp.rename(temporary, executable);
    const activeManifest = {
      ...manifest,
      executable,
      activatedAt: new Date().toISOString(),
      previous:
        typeof previous?.version === "string" &&
        typeof previous?.executable === "string"
          ? {
              version: previous.version,
              executable: previous.executable,
              sha256: previous.sha256,
            }
          : null,
    };
    await writeJsonAtomic(activePath, activeManifest, root);
    const inspected = await verifyManifestExecutable(
      activeManifest,
      root,
      versionDir
    );
    return {
      action: "apply",
      active: inspected,
      previous: activeManifest.previous,
      rollbackAvailable: Boolean(activeManifest.previous),
      requiresFreshSession: false,
    };
  });
}

async function rollbackRuntime(options = {}) {
  if (options.approve !== true) {
    throw new Error("Rolling back a runtime requires approve=true.");
  }
  const root = runtimeStateRoot(options.env, options.platform);
  return await withMutationLock(root, async () => {
    const activePath = path.join(root, "active.json");
    const active = await readJson(activePath);
    if (!isPlainObject(active?.previous)) {
      throw new Error(
        "The active plugin runtime does not have a retained rollback target."
      );
    }
    if (
      options.expectedActiveVersion &&
      options.expectedActiveVersion !== active.version
    ) {
      throw new Error(
        "Runtime rollback precondition failed: active version changed."
      );
    }
    const previous = {
      schemaVersion: STATE_SCHEMA_VERSION,
      version: active.previous.version,
      executable: active.previous.executable,
      sha256: active.previous.sha256,
      previous: {
        version: active.version,
        executable: active.executable,
        sha256: active.sha256,
      },
      rolledBackAt: new Date().toISOString(),
    };
    const previousDir = path.dirname(path.resolve(previous.executable));
    const inspected = await verifyManifestExecutable(
      previous,
      root,
      previousDir
    );
    await writeJsonAtomic(activePath, previous, root);
    return {
      action: "rollback",
      active: inspected,
      rolledBackFrom: active.version,
      rollbackAvailable: true,
      requiresFreshSession: false,
    };
  });
}

module.exports = {
  PLUGIN_PROTOCOL_VERSION,
  applyStagedRuntime,
  assertManagedPath,
  checkRuntimeUpdate,
  checksumForAsset,
  discoverRuntime,
  downloadBuffer,
  normalizeVersion,
  parseProtocolReport,
  pluginVersion,
  protocolCompatibility,
  releaseTarget,
  rollbackRuntime,
  runtimeCandidates,
  runtimePolicy,
  runtimeStateRoot,
  setRuntimePolicy,
  sha256,
  stageRuntime,
};
