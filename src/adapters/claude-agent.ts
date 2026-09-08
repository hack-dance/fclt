import { basename, extname } from "node:path";
import { stringify } from "yaml";
import { renderCanonicalText } from "../agents";
import type { RenderManagedAgentOptions } from "./types";

/** Render canonical instructions as a Claude subagent without changing provider permissions or model. */
export async function renderClaudeAgent(
  options: RenderManagedAgentOptions
): Promise<string> {
  const parsed = Bun.TOML.parse(options.raw) as Record<string, unknown>;
  for (const key of [
    "tools",
    "disallowedTools",
    "permissionMode",
    "sandbox_mode",
  ]) {
    if (key in parsed) {
      throw new Error(
        `Claude agent rendering cannot silently drop canonical permission field: ${key}`
      );
    }
  }
  const fallbackName = basename(
    options.targetPath,
    extname(options.targetPath)
  );
  const name = typeof parsed.name === "string" ? parsed.name : fallbackName;
  const description =
    typeof parsed.description === "string" ? parsed.description : name;
  const instructions =
    typeof parsed.developer_instructions === "string"
      ? parsed.developer_instructions
      : "";
  const body = await renderCanonicalText(instructions, {
    homeDir: options.homeDir,
    rootDir: options.rootDir,
    projectRoot: options.projectRoot,
    targetTool: options.tool,
    targetPath: options.targetPath,
  });
  return `---\n${stringify({ name, description, model: "inherit" })}---\n\n${body.trim()}\n`;
}
