import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { facultBuiltinPackRoot } from "./builtin";

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
});
