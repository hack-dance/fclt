import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHomebrewFormula } from "./render-homebrew-formula";

describe("renderHomebrewFormula", () => {
  it("renders a binary formula for fclt with a facult alias", () => {
    const formula = renderHomebrewFormula("2.0.0", {
      darwinArm64:
        "b0dee9e2b955a1c31f1771fdf4dc62cb3a89df42c704be5820839052d3b6bfbc",
      darwinX64:
        "6f705a974cc88f304b0d9f768a88e4cd599edf8d791967969164bcd3740c8200",
      linuxX64:
        "4b614cb5cdbcb72d02bfe1f38ec4bfab57b7bb8494ce9902781c876de508b4f5",
    });

    expect(formula).toContain("class Fclt < Formula");
    expect(formula).toContain(
      'url "https://github.com/hack-dance/fclt/releases/download/v2.0.0/fclt-2.0.0-darwin-arm64"'
    );
    expect(formula).toContain('bin.install cached_download => "fclt"');
    expect(formula).toContain('bin.install_symlink "fclt" => "facult"');
  });
});

const version = "9.8.7";
const platforms = ["darwin-arm64", "darwin-x64", "linux-x64"] as const;
const digests = ["ab".repeat(32), "cd".repeat(32), "ef".repeat(32)] as const;
const checksumLines = platforms.map(
  (platform, index) => `${digests[index]}  fclt-${version}-${platform}`
);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createFormulaFixture(checksums?: string) {
  const root = await mkdtemp(join(tmpdir(), "fclt-homebrew-formula-"));
  temporaryRoots.push(root);
  const assets = join(root, "release assets");
  const output = join(root, "nested output", "Formula", "fclt.rb");
  await mkdir(assets);
  if (checksums !== undefined) {
    await Bun.write(join(assets, "SHA256SUMS"), checksums);
  }
  return {
    output,
    async run(
      argv = ["--version", version, "--assets-dir", assets, "--output", output]
    ) {
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "render-homebrew-formula.ts"),
          ...argv,
        ],
        { cwd: root, env: { ...process.env }, stdout: "pipe", stderr: "pipe" }
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    },
    assets,
  };
}

describe("Homebrew formula CLI", () => {
  for (const inline of [false, true]) {
    it(`maps release checksums with ${inline ? "inline" : "separate"} arguments`, async () => {
      const fixture = await createFormulaFixture(
        [
          `${"11".repeat(32)}  fclt-0.0.1-darwin-arm64`,
          checksumLines[2],
          "unrelated metadata",
          `${digests[0].toUpperCase()}  fclt-${version}-darwin-arm64`,
          "",
          checksumLines[1],
        ].join("\r\n")
      );
      const pairs = [
        ["--version", ` v${version} `],
        ["--assets-dir", fixture.assets],
        ["--output", fixture.output],
      ] as const;
      const result = await fixture.run(
        pairs.flatMap(([flag, value]) =>
          inline ? [`${flag}=${value}`] : [flag, value]
        )
      );
      expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
      const formula = await Bun.file(fixture.output).text();
      expect(formula).toContain(`version "${version}"`);
      const branches = ["if Hardware::CPU.arm?", "else", "on_linux do"];
      for (const [index, platform] of platforms.entries()) {
        const indent = platform === "linux-x64" ? "    " : "      ";
        expect(formula).toContain(
          `${branches[index]}\n${indent}url "https://github.com/hack-dance/fclt/releases/download/v${version}/fclt-${version}-${platform}"\n${indent}sha256 "${digests[index]}"`
        );
      }
      expect(formula).not.toContain("fclt-0.0.1");
    });
  }

  for (const flag of ["--version", "--assets-dir", "--output"]) {
    it(`rejects a missing ${flag} before creating a formula`, async () => {
      const fixture = await createFormulaFixture(checksumLines.join("\n"));
      const pairs = [
        ["--version", version],
        ["--assets-dir", fixture.assets],
        ["--output", fixture.output],
      ];
      const result = await fixture.run(
        pairs.filter(([name]) => name !== flag).flat()
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(`${flag} is required.`);
      expect(await Bun.file(fixture.output).exists()).toBe(false);
    });
  }

  it("rejects a missing checksum file without creating a formula", async () => {
    const fixture = await createFormulaFixture();
    const result = await fixture.run();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("SHA256SUMS");
    expect(await Bun.file(fixture.output).exists()).toBe(false);
  });

  for (const [index, platform] of platforms.entries()) {
    for (const invalid of [
      { name: "missing", line: "" },
      { name: "short", line: `${"a".repeat(63)}  fclt-${version}-${platform}` },
      {
        name: "nonhex",
        line: `${"z".repeat(64)}  fclt-${version}-${platform}`,
      },
      {
        name: "wrong-version",
        line: `${digests[index]}  fclt-0.0.1-${platform}`,
      },
    ]) {
      it(`preserves the existing formula with ${invalid.name} ${platform} checksum`, async () => {
        const lines = [...checksumLines];
        lines[index] = invalid.line;
        const fixture = await createFormulaFixture(lines.join("\n"));
        const original = "# Previously verified formula\n";
        await Bun.write(fixture.output, original);
        const result = await fixture.run();
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain(
          `Missing one or more required checksums for ${version}`
        );
        expect(await Bun.file(fixture.output).text()).toBe(original);
      });
    }
  }
});
