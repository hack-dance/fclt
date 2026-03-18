import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderAiRefs, renderCanonicalText } from "./agents";

const DOLLAR = "$";

function placeholder(name: string): string {
  return `${DOLLAR}{${name}}`;
}

const REFS_WRITING_RULE = placeholder("refs.writing_rule");
const VARS_VOICE = placeholder("vars.voice");
const AI_ROOT_VAR = placeholder("AI_ROOT");
const HOME_VAR = placeholder("HOME");
const TARGET_TOOL_VAR = placeholder("TARGET_TOOL");
const TARGET_PATH_VAR = placeholder("TARGET_PATH");

async function createTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "facult-agents-"));
}

describe("renderAiRefs", () => {
  it("renders canonical @ai refs to absolute paths", () => {
    const rendered = renderAiRefs(
      "Before reviewing, read @ai/rules/WRITING.md.\nThen inspect @ai/scripts/check-style.sh.",
      "/Users/hack/.ai"
    );

    expect(rendered).toBe(
      "Before reviewing, read /Users/hack/.ai/rules/WRITING.md.\nThen inspect /Users/hack/.ai/scripts/check-style.sh."
    );
  });

  it("leaves unrelated text unchanged", () => {
    const input =
      "Use @aix/rules/WRITING.md, literal @ai, and email@example.com as-is.";

    expect(renderAiRefs(input, "/Users/hack/.ai")).toBe(input);
  });
});

describe("renderCanonicalText", () => {
  it("renders config-backed refs to absolute paths", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(rootDir, { recursive: true });
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[refs]\nwriting_rule = "@ai/rules/WRITING.md"\n'
    );

    const rendered = await renderCanonicalText(
      `Before reviewing, read ${REFS_WRITING_RULE}.`,
      {
        homeDir: home,
        rootDir,
      }
    );

    expect(rendered).toBe(
      `Before reviewing, read ${join(rootDir, "rules", "WRITING.md")}.`
    );
  });

  it("prefers config.local.toml over tracked config values", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(rootDir, { recursive: true });
    await Bun.write(
      join(rootDir, "config.toml"),
      'version = 1\n\n[vars]\nvoice = "global"\n'
    );
    await Bun.write(
      join(rootDir, "config.local.toml"),
      'version = 1\n\n[vars]\nvoice = "local"\n'
    );

    const rendered = await renderCanonicalText(`Use the ${VARS_VOICE} tone.`, {
      homeDir: home,
      rootDir,
    });

    expect(rendered).toBe("Use the local tone.");
  });

  it("injects built-in values during render", async () => {
    const home = await createTempDir();
    const rootDir = join(home, ".ai");

    await mkdir(rootDir, { recursive: true });
    await Bun.write(join(rootDir, "config.toml"), "version = 1\n");

    const rendered = await renderCanonicalText(
      `Root ${AI_ROOT_VAR} Home ${HOME_VAR} Tool ${TARGET_TOOL_VAR} Path ${TARGET_PATH_VAR}.`,
      {
        homeDir: home,
        rootDir,
        targetTool: "codex",
        targetPath: join(home, ".codex", "agents", "alpha.toml"),
      }
    );

    expect(rendered).toBe(
      `Root ${rootDir} Home ${home} Tool codex Path ${join(home, ".codex", "agents", "alpha.toml")}.`
    );
  });
});
