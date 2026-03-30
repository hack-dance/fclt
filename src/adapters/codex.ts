import { generateMcpConfig, parseMcpConfig } from "./mcp";
import { parseSkillsDir } from "./skills";
import type { ToolAdapter } from "./types";
import { detectExplicitVersion } from "./version";

export const codexAdapter: ToolAdapter = {
  id: "codex",
  name: "Codex",
  versions: ["v1"],
  detectVersion: detectExplicitVersion,
  getDefaultPaths: () => ({
    mcp: "~/.codex/mcp.json",
    skills: ["~/.agents/skills", "~/.codex/skills"],
    agents: "~/.codex/agents",
    config: "~/.config/openai/codex.json",
  }),
  parseMcp: (config) => parseMcpConfig(config),
  generateMcp: (canonical) => generateMcpConfig(canonical, "mcpServers"),
  parseSkills: async (skillsDir) => await parseSkillsDir(skillsDir),
};
