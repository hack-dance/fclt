export interface Provenance {
  /** Tool/source id (e.g. "cursor", "claude-desktop"). */
  sourceId: string;
  /** Path to the config file this item came from (if applicable). */
  sourcePath: string;
  /** ISO timestamp when facult imported/consolidated this item. */
  importedAt: string;
  /** Optional source file mtime at import time (ISO). */
  sourceModifiedAt?: string;
}

export type McpTransport = "stdio" | "http" | "sse";

export interface CanonicalMcpServer {
  name: string;

  // Known/common fields (cross-tool)
  transport?: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;

  /** Unknown/tool-specific fields preserved losslessly for round-tripping. */
  vendorExtensions?: Record<string, unknown>;

  /** Where this server definition came from. */
  provenance?: Provenance;
}

export interface CanonicalMcpRegistry {
  /** Schema version for the canonical MCP registry format. */
  version: 1;
  updatedAt: string;
  mcpServers: Record<string, CanonicalMcpServer>;

  /** Unknown top-level fields preserved losslessly for round-tripping. */
  vendorExtensions?: Record<string, unknown>;
}
