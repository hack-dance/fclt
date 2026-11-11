import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const installScript = join(repoRoot, "scripts", "install.sh");
const roots: string[] = [];
const existingBinary = "existing primary binary\n";
const existingCompatibilityBinary = "existing compatibility binary\n";
const existingReceipt = '{"version":1,"method":"existing-install"}\n';

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

function releasePlatform(): { arch: string; os: string } {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return { arch, os };
}

type ChecksumFixture =
  | "valid"
  | "mismatch"
  | "missing"
  | "duplicate"
  | "short"
  | "non-hex"
  | "uppercase"
  | "primary-only";

function checksumContent(args: {
  kind: ChecksumFixture;
  digest: string;
  selectedAsset: string;
  primaryAsset: string;
}): string {
  const valid = `${args.digest}  ${args.selectedAsset}\n`;
  switch (args.kind) {
    case "valid":
      return valid;
    case "mismatch":
      return `${"0".repeat(64)}  ${args.selectedAsset}\n`;
    case "missing":
      return `${args.digest}  unrelated-asset\n`;
    case "duplicate":
      return valid + valid;
    case "short":
      return `${args.digest.slice(0, 63)}  ${args.selectedAsset}\n`;
    case "non-hex":
      return `${"g".repeat(64)}  ${args.selectedAsset}\n`;
    case "uppercase":
      return `${args.digest.toUpperCase()}  ${args.selectedAsset}\n`;
    case "primary-only":
      return `${args.digest}  ${args.primaryAsset}\n`;
    default: {
      const exhaustive: never = args.kind;
      throw new Error(`Unknown checksum fixture: ${exhaustive}`);
    }
  }
}

async function runInstaller(
  args: {
    checksum?: ChecksumFixture;
    compatibilityFallback?: boolean;
    failBinaryDownload?: boolean;
    failChecksumDownload?: boolean;
    existingInstall?: boolean;
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "fclt-install-checksum-"));
  roots.push(root);
  const home = join(root, "home");
  const installDir = join(root, "install");
  const stateDir = join(root, "state");
  const receiptPath =
    process.platform === "darwin"
      ? join(home, "Library", "Application Support", "fclt", "install.json")
      : join(stateDir, "fclt", "install.json");
  const mockBin = join(root, "mock-bin");
  const binaryFixture = join(root, "binary-fixture");
  const checksumFixture = join(root, "SHA256SUMS");
  const requestsPath = join(root, "requests");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(installDir, { recursive: true }),
    mkdir(mockBin, { recursive: true }),
  ]);
  if (args.existingInstall) {
    await mkdir(resolve(receiptPath, ".."), { recursive: true });
    await Bun.write(join(installDir, "fclt"), existingBinary);
    await Bun.write(join(installDir, "facult"), existingCompatibilityBinary);
    await Bun.write(receiptPath, existingReceipt);
  }
  const version = "9.8.7";
  const platform = releasePlatform();
  const primaryAsset = `fclt-${version}-${platform.os}-${platform.arch}`;
  const compatibilityAsset = `facult-${version}-${platform.os}-${platform.arch}`;
  const selectedAsset = args.compatibilityFallback
    ? compatibilityAsset
    : primaryAsset;
  const binary = "#!/usr/bin/env bash\nprintf 'fixture binary\\n'\n";
  const digest = createHash("sha256").update(binary).digest("hex");
  await Bun.write(binaryFixture, binary);
  await Bun.write(
    checksumFixture,
    checksumContent({
      kind: args.checksum ?? "valid",
      digest,
      selectedAsset,
      primaryAsset,
    })
  );
  const curlPath = join(mockBin, "curl");
  await Bun.write(
    curlPath,
    `#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -o)
      output="$2"
      shift 2
      ;;
    http*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
base="https://github.com/hack-dance/fclt/releases/download/v9.8.7"
case "$url" in
  "$base/$FCLT_TEST_PRIMARY"|"$base/$FCLT_TEST_COMPATIBILITY"|"$base/SHA256SUMS") ;;
  *) exit 22 ;;
esac
printf '%s\\n' "$url" >> "$FCLT_TEST_REQUESTS"
if [[ "$url" == "$base/SHA256SUMS" ]]; then
  if [[ "$FCLT_TEST_FAIL_CHECKSUM" == 1 ]]; then exit 22; fi
  cp "$FCLT_TEST_CHECKSUMS" "$output"
else
  if [[ "$FCLT_TEST_FAIL_BINARY" == 1 ]]; then exit 22; fi
  if [[ "$FCLT_TEST_FALLBACK" == 1 && "$url" == "$base/$FCLT_TEST_PRIMARY" ]]; then exit 22; fi
  cp "$FCLT_TEST_BINARY" "$output"
fi
`
  );
  await chmod(curlPath, 0o755);
  const proc = Bun.spawn(["bash", installScript], {
    cwd: root,
    env: {
      ...process.env,
      FACULT_DOWNLOAD_RETRIES: "1",
      FACULT_INSTALL_DIR: installDir,
      FACULT_VERSION: version,
      FCLT_TEST_BINARY: binaryFixture,
      FCLT_TEST_CHECKSUMS: checksumFixture,
      FCLT_TEST_PRIMARY: primaryAsset,
      FCLT_TEST_COMPATIBILITY: compatibilityAsset,
      FCLT_TEST_REQUESTS: requestsPath,
      FCLT_TEST_FAIL_BINARY: args.failBinaryDownload ? "1" : "0",
      FCLT_TEST_FAIL_CHECKSUM: args.failChecksumDownload ? "1" : "0",
      FCLT_TEST_FALLBACK: args.compatibilityFallback ? "1" : "0",
      HOME: home,
      XDG_STATE_HOME: stateDir,
      PATH: `${mockBin}:${process.env.PATH ?? ""}`,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, stderr, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  const requests = (await readFile(requestsPath, "utf8"))
    .trim()
    .split("\n")
    .map((url) => url.slice(url.lastIndexOf("/") + 1));
  return {
    code,
    installDir,
    receiptPath,
    stderr,
    stdout,
    requests,
    primaryAsset,
    compatibilityAsset,
    selectedAsset,
    binary,
  };
}

const preservedInstall = {
  code: 1,
  verified: false,
  installed: false,
  primary: existingBinary,
  compatibility: existingCompatibilityBinary,
  receipt: existingReceipt,
};

async function rejectedInstallState(
  result: Awaited<ReturnType<typeof runInstaller>>
) {
  return {
    code: result.code,
    verified: result.stdout.includes("Verified "),
    installed: result.stdout.includes("Installed fclt"),
    primary: await Bun.file(join(result.installDir, "fclt")).text(),
    compatibility: await Bun.file(join(result.installDir, "facult")).text(),
    receipt: await Bun.file(result.receiptPath).text(),
  };
}

describe("release installer checksum verification", () => {
  it("installs both commands and a receipt after verifying the primary asset", async () => {
    const result = await runInstaller();
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Verified ${result.primaryAsset}`);
    expect(result.requests).toEqual([result.primaryAsset, "SHA256SUMS"]);
    for (const command of ["fclt", "facult"]) {
      expect(await Bun.file(join(result.installDir, command)).text()).toBe(
        result.binary
      );
    }
    expect(await Bun.file(result.receiptPath).json()).toMatchObject({
      version: 1,
      method: "release-script",
      packageVersion: "9.8.7",
      binaryPath: join(result.installDir, "fclt"),
      source: "github-release",
    });
  });

  it("verifies the selected compatibility asset before replacing an installation", async () => {
    const result = await runInstaller({
      compatibilityFallback: true,
      existingInstall: true,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Verified ${result.compatibilityAsset}`);
    expect(result.requests).toEqual([
      result.primaryAsset,
      result.compatibilityAsset,
      "SHA256SUMS",
    ]);
    for (const command of ["fclt", "facult"]) {
      expect(await Bun.file(join(result.installDir, command)).text()).toBe(
        result.binary
      );
    }
    expect(await Bun.file(result.receiptPath).json()).toMatchObject({
      method: "release-script",
      packageVersion: "9.8.7",
    });
  });

  it("accepts uppercase checksum digests", async () => {
    const result = await runInstaller({ checksum: "uppercase" });
    expect(result.code, result.stderr).toBe(0);
    expect(await Bun.file(join(result.installDir, "fclt")).text()).toBe(
      result.binary
    );
  });

  it.each([
    "missing",
    "duplicate",
    "short",
    "non-hex",
  ] as const)("preserves an existing installation when the checksum entry is %s", async (checksum) => {
    const result = await runInstaller({ checksum, existingInstall: true });
    expect(result.stderr).toContain("SHA256SUMS");
    expect(result.stderr).toContain("digest");
    expect(await rejectedInstallState(result)).toEqual(preservedInstall);
  });

  it("preserves an existing installation when the digest does not match", async () => {
    const result = await runInstaller({
      checksum: "mismatch",
      existingInstall: true,
    });
    expect(result.stderr).toContain("Checksum verification failed");
    expect(await rejectedInstallState(result)).toEqual(preservedInstall);
  });

  it("requires the fallback asset's own checksum entry", async () => {
    const result = await runInstaller({
      checksum: "primary-only",
      compatibilityFallback: true,
      existingInstall: true,
    });
    expect(result.stderr).toContain(result.compatibilityAsset);
    expect(await rejectedInstallState(result)).toEqual(preservedInstall);
  });

  it("preserves an existing installation when checksum download fails", async () => {
    const result = await runInstaller({
      failChecksumDownload: true,
      existingInstall: true,
    });
    expect(result.stderr).toContain("Failed to download");
    expect(result.requests).toEqual([result.primaryAsset, "SHA256SUMS"]);
    expect(await rejectedInstallState(result)).toEqual(preservedInstall);
  });

  it("stops before checksum retrieval when both asset downloads fail", async () => {
    const result = await runInstaller({
      failBinaryDownload: true,
      existingInstall: true,
    });
    expect(result.stderr).toContain("Failed to download");
    expect(result.requests).toEqual([
      result.primaryAsset,
      result.compatibilityAsset,
    ]);
    expect(await rejectedInstallState(result)).toEqual(preservedInstall);
  });

  it("does not create binaries or a receipt for a rejected fresh install", async () => {
    const result = await runInstaller({ checksum: "mismatch" });
    expect(result.code).toBe(1);
    for (const path of [
      join(result.installDir, "fclt"),
      join(result.installDir, "facult"),
      result.receiptPath,
    ]) {
      expect(await Bun.file(path).exists()).toBe(false);
    }
  });
});
