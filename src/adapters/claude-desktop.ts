import { generateMcpConfig, parseMcpConfig } from "./mcp";
import type { ToolAdapter } from "./types";
import { detectExplicitVersion } from "./version";

export const claudeDesktopAdapter: ToolAdapter = {
  id: "claude-desktop",
  name: "Claude Desktop",
  versions: ["v1"],
  detectVersion: detectExplicitVersion,
  getDefaultPaths: () => ({
    mcp: "~/Library/Application Support/Claude/claude_desktop_config.json",
  }),
  parseMcp: (config) => parseMcpConfig(config),
  generateMcp: (canonical) => generateMcpConfig(canonical, "mcpServers"),
};
