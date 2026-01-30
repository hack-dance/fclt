import { generateMcpConfig, parseMcpConfig } from "./mcp";
import { parseSkillsDir } from "./skills";
import type { ToolAdapter } from "./types";
import { detectExplicitVersion } from "./version";

export const cursorAdapter: ToolAdapter = {
  id: "cursor",
  name: "Cursor",
  versions: ["v1"],
  detectVersion: detectExplicitVersion,
  getDefaultPaths: () => ({
    mcp: "~/.cursor/mcp.json",
    skills: "~/.cursor/skills",
  }),
  parseMcp: (config) => parseMcpConfig(config),
  generateMcp: (canonical) => generateMcpConfig(canonical, "mcpServers"),
  parseSkills: async (skillsDir) => await parseSkillsDir(skillsDir),
};
