export interface CanonicalMcpServer {
  transport?: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  vendorExtensions?: Record<string, unknown>;
}

export interface CanonicalMcpConfig {
  servers: Record<string, CanonicalMcpServer>;
  vendorExtensions?: Record<string, unknown>;
}

export interface CanonicalSkill {
  name: string;
  body?: string;
  path?: string;
}

export interface AdapterDefaultPaths {
  mcp?: string;
  skills?: string | string[];
  agents?: string | string[];
  config?: string;
}

export interface ToolAdapter {
  id: string;
  name: string;
  versions: string[];
  detectVersion?: (configPath: string) => Promise<string | null>;
  parseMcp?: (config: unknown, version?: string) => CanonicalMcpConfig;
  parseSkills?: (skillsDir: string) => Promise<CanonicalSkill[]>;
  generateMcp?: (canonical: CanonicalMcpConfig, version?: string) => unknown;
  generateSkillsDir?: (skills: CanonicalSkill[]) => Promise<void>;
  getDefaultPaths?: () => AdapterDefaultPaths;
}

export interface ResolveVersionOptions {
  fallbackVersion?: string;
  warn?: (message: string) => void;
}
