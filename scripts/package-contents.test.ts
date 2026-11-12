import { expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  requiredPackagePaths,
  verifyPackageContents,
} from "./package-contents";

function report(paths: string[]) {
  return [{ name: "facult", files: paths.map((path) => ({ path })) }];
}

it("requires both launchers and reports every missing runtime file", () => {
  expect(
    verifyPackageContents(report(["bin/fclt.cjs", "bin/facult.cjs"]), [
      "bin/fclt.cjs",
      "bin/facult.cjs",
    ])
  ).toBe(2);
  expect(() =>
    verifyPackageContents(report(["bin/fclt.cjs"]), [
      "bin/facult.cjs",
      "src/index.ts",
    ])
  ).toThrow("bin/facult.cjs\nsrc/index.ts");
});

it.each([
  "src/nested/example.test.ts",
  "test/setup.ts",
  ".ai/index.json",
  ".codex/config.toml",
  ".claude/settings.json",
  ".cursor/rules/generated.md",
  ".agents/skills/example/SKILL.md",
  ".git/config",
  "dist/fclt",
  "node_modules/example/index.js",
])("rejects test and local-state payloads: %s", (path) => {
  expect(() => verifyPackageContents(report([path]), [])).toThrow(path);
});

it.each(
  [
    null,
    [],
    [...report([]), ...report([])],
    [{ name: "another-package", files: [] }],
    [{ name: "facult" }],
    [{ name: "facult", files: [null] }],
    [{ name: "facult", files: [{ path: 42 }] }],
    [{ name: "facult", files: [{ path: "" }] }],
  ].map((value) => ({ value }))
)("rejects malformed or ambiguous npm reports: %j", ({ value }) => {
  expect(() => verifyPackageContents(value, [])).toThrow();
});

it("detects real npm allowlist omissions, including nested source and hidden plugin files", async () => {
  const root = await mkdtemp(join(tmpdir(), "fclt-package-contents-"));
  try {
    const files = [
      "README.md",
      "LICENSE",
      "bin/fclt.cjs",
      "bin/facult.cjs",
      "src/index.ts",
      "src/util/example.ts",
      "src/util/example.test.ts",
      "assets/packs/example/agents/worker/agent.toml",
      "assets/packs/example/skills/example/SKILL.md",
      "plugins/fclt/.codex-plugin/plugin.json",
      "plugins/fclt/.mcp.json",
      "plugins/fclt/scripts/fclt-mcp.cjs",
      "plugins/fclt/assets/mark.png",
    ];
    for (const path of files) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await Bun.write(join(root, path), "fixture\n");
    }
    const required = await requiredPackagePaths(root);
    expect(required).toEqual(
      [
        ...files.filter((path) => !path.endsWith(".test.ts")),
        "package.json",
      ].sort()
    );
    const manifest = {
      name: "facult",
      version: "0.0.0",
      scripts: { prepare: "node -e \"console.log('prepare output')\"" },
      files: ["bin", "src/**/*.ts", "!src/**/*.test.ts", "assets", "plugins"],
    };
    async function pack(filesAllowlist: string[]): Promise<unknown> {
      await Bun.write(
        join(root, "package.json"),
        JSON.stringify({ ...manifest, files: filesAllowlist })
      );
      const proc = Bun.spawn(
        [
          process.platform === "win32" ? "npm.cmd" : "npm",
          "pack",
          "--dry-run",
          "--json",
          "--foreground-scripts=false",
        ],
        {
          cwd: root,
          env: { ...process.env, npm_config_cache: join(root, "npm-cache") },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      if (code !== 0) {
        throw new Error(`npm fixture pack failed (${code}): ${stderr}`);
      }
      return JSON.parse(stdout);
    }
    expect(verifyPackageContents(await pack(manifest.files), required)).toBe(
      required.length
    );
    const incomplete = await pack(["bin"]);
    expect(() => verifyPackageContents(incomplete, required)).toThrow(
      "src/util/example.ts"
    );
    expect(() => verifyPackageContents(incomplete, required)).toThrow(
      "plugins/fclt/.mcp.json"
    );
    expect(() => verifyPackageContents(incomplete, required)).toThrow(
      "assets/packs/example/skills/example/SKILL.md"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
