import { generateMcpConfig, parseMcpConfig } from "./mcp";
import { parseSkillsDir } from "./skills";
import type { ToolAdapter } from "./types";
import { detectExplicitVersion } from "./version";

export const claudeCliAdapter: ToolAdapter = {
  id: "claude",
  name: "Claude CLI",
  versions: ["v1"],
  detectVersion: detectExplicitVersion,
  getDefaultPaths: () => ({
    mcp: "~/.claude.json",
    skills: "~/.claude/skills",
  }),
  parseMcp: (config) => parseMcpConfig(config),
  generateMcp: (canonical) => generateMcpConfig(canonical, "mcpServers"),
  parseSkills: async (skillsDir) => await parseSkillsDir(skillsDir),
};
