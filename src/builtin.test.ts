import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  facultBuiltinCodexPluginRoot,
  facultBuiltinPackRoot,
  OPERATING_MODEL_AGENTS_GLOBAL_TEMPLATE,
} from "./builtin";
import {
  BUILTIN_FCLT_CODEX_PLUGIN_BINARY_FILES,
  BUILTIN_FCLT_CODEX_PLUGIN_FILES,
  BUILTIN_OPERATING_MODEL_FILES,
} from "./builtin-assets";

test("npm package includes builtin operating-model assets", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    files?: string[];
  };

  expect(packageJson.files).toContain("assets/**/*.md");
  expect(packageJson.files).toContain("assets/**/*.toml");
  expect(packageJson.files).toContain("plugins/fclt/**/*.cjs");
  expect(packageJson.files).toContain("plugins/fclt/**/*.png");
  expect(
    await Bun.file(
      join(facultBuiltinPackRoot(), "instructions", "EVOLUTION.md")
    ).exists()
  ).toBe(true);
  expect(
    await Bun.file(
      join(facultBuiltinPackRoot(), "agents", "evolution-planner", "agent.toml")
    ).exists()
  ).toBe(true);
  expect(
    await Bun.file(
      join(facultBuiltinPackRoot(), OPERATING_MODEL_AGENTS_GLOBAL_TEMPLATE)
    ).exists()
  ).toBe(true);
  expect(
    await Bun.file(join(facultBuiltinPackRoot(), "AGENTS.global.md")).exists()
  ).toBe(false);
});

test("embedded builtin assets match source pack files", async () => {
  const root = facultBuiltinPackRoot();
  for (const [relativePath, content] of Object.entries(
    BUILTIN_OPERATING_MODEL_FILES
  )) {
    expect(await Bun.file(join(root, relativePath)).text()).toBe(content);
  }
});

test("embedded builtin codex plugin assets match source plugin files", async () => {
  const root = facultBuiltinCodexPluginRoot();
  for (const [relativePath, content] of Object.entries(
    BUILTIN_FCLT_CODEX_PLUGIN_FILES
  )) {
    expect(await Bun.file(join(root, relativePath)).text()).toBe(content);
  }
  for (const [relativePath, base64] of Object.entries(
    BUILTIN_FCLT_CODEX_PLUGIN_BINARY_FILES
  )) {
    expect(
      Buffer.from(await Bun.file(join(root, relativePath)).arrayBuffer())
    ).toEqual(Buffer.from(base64, "base64"));
  }
});
