import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const REPO_OWNER = "hack-dance";
const REPO_NAME = "facult";
const FORMULA_NAME = "fclt";
const LEADING_V_RE = /^v/;
const NEWLINE_RE = /\r?\n/;
const SHA256_LINE_RE = /^([a-f0-9]{64})\s+(.+)$/i;

interface ParsedArgs {
  version: string;
  assetsDir: string;
  output: string;
}

interface ReleaseChecksums {
  darwinArm64: string;
  darwinX64: string;
  linuxX64: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let version = "";
  let assetsDir = "";
  let output = "";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }

    if (arg === "--version") {
      version = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--version=")) {
      version = arg.slice("--version=".length);
      continue;
    }

    if (arg === "--assets-dir") {
      assetsDir = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--assets-dir=")) {
      assetsDir = arg.slice("--assets-dir=".length);
      continue;
    }

    if (arg === "--output") {
      output = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--output=")) {
      output = arg.slice("--output=".length);
    }
  }

  if (!version.trim()) {
    throw new Error("--version is required.");
  }
  if (!assetsDir.trim()) {
    throw new Error("--assets-dir is required.");
  }
  if (!output.trim()) {
    throw new Error("--output is required.");
  }

  return {
    version: version.trim().replace(LEADING_V_RE, ""),
    assetsDir: resolve(assetsDir.trim()),
    output: resolve(output.trim()),
  };
}

function parseChecksums(text: string, version: string): ReleaseChecksums {
  const required = {
    darwinArm64: `fclt-${version}-darwin-arm64`,
    darwinX64: `fclt-${version}-darwin-x64`,
    linuxX64: `fclt-${version}-linux-x64`,
  };

  const entries = new Map<string, string>();
  for (const rawLine of text.split(NEWLINE_RE)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = line.match(SHA256_LINE_RE);
    if (!match) {
      continue;
    }
    const [, checksum, filename] = match;
    if (!(checksum && filename)) {
      continue;
    }
    entries.set(filename, checksum.toLowerCase());
  }

  const darwinArm64 = entries.get(required.darwinArm64);
  const darwinX64 = entries.get(required.darwinX64);
  const linuxX64 = entries.get(required.linuxX64);

  if (!(darwinArm64 && darwinX64 && linuxX64)) {
    throw new Error(
      `Missing one or more required checksums for ${version} in SHA256SUMS.`
    );
  }

  return { darwinArm64, darwinX64, linuxX64 };
}

export function renderHomebrewFormula(
  version: string,
  checksums: ReleaseChecksums
): string {
  const base = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/v${version}`;
  return `class Fclt < Formula
  desc "Build and evolve AI faculties across tools, users, and projects"
  homepage "https://github.com/${REPO_OWNER}/${REPO_NAME}"
  version "${version}"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "${base}/fclt-${version}-darwin-arm64"
      sha256 "${checksums.darwinArm64}"
    else
      url "${base}/fclt-${version}-darwin-x64"
      sha256 "${checksums.darwinX64}"
    end
  end

  on_linux do
    url "${base}/fclt-${version}-linux-x64"
    sha256 "${checksums.linuxX64}"
  end

  def install
    bin.install cached_download => "fclt"
    bin.install_symlink "fclt" => "facult"
  end

  test do
    assert_match "fclt", shell_output("#{bin}/fclt --help")
  end
end
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const checksumsText = await readFile(
    join(args.assetsDir, "SHA256SUMS"),
    "utf8"
  );
  const checksums = parseChecksums(checksumsText, args.version);
  const formula = renderHomebrewFormula(args.version, checksums);
  await mkdir(dirname(args.output), { recursive: true });
  await Bun.write(args.output, formula);
}

if (import.meta.main) {
  await main();
}
