import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  facultBuiltinPackRoot,
  OPERATING_MODEL_AGENTS_GLOBAL_TEMPLATE,
} from "./builtin";
import { BUILTIN_OPERATING_MODEL_FILES } from "./builtin-assets";

test("npm package includes builtin operating-model assets", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    files?: string[];
  };

  expect(packageJson.files).toContain("assets/**/*.md");
  expect(packageJson.files).toContain("assets/**/*.toml");
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
