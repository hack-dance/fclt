import { generateMcpConfig, parseMcpConfig } from "./mcp";
import { parseSkillsDir } from "./skills";
import type { ToolAdapter } from "./types";
import { detectExplicitVersion } from "./version";

export const clawdbotAdapter: ToolAdapter = {
  id: "clawdbot",
  name: "Clawdbot",
  versions: ["v1"],
  detectVersion: detectExplicitVersion,
  getDefaultPaths: () => ({
    mcp: "~/.clawdbot/mcp.json",
    skills: "~/.clawdbot/skills",
  }),
  parseMcp: (config) => parseMcpConfig(config),
  generateMcp: (canonical) => generateMcpConfig(canonical, "mcpServers"),
  parseSkills: async (skillsDir) => await parseSkillsDir(skillsDir),
};
