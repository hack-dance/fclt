import { describe, expect, it } from "bun:test";
import {
  contentHash,
  decideAuto,
  hashesMatch,
  mcpServerHash,
  normalizeJson,
  normalizeMcpServer,
  normalizeText,
} from "./conflicts";

describe("conflicts normalization", () => {
  it("normalizes text line endings and trailing whitespace", () => {
    const input = "  hello\r\nworld   \n\n";
    expect(normalizeText(input)).toBe("hello\nworld");
  });

  it("normalizes JSON with stable key ordering", () => {
    const input = '{"b":1,"a":2}';
    expect(normalizeJson(input)).toBe(
      ["{", '  "a": 2,', '  "b": 1', "}"].join("\n")
    );
  });

  it("computes a stable hash for normalized content", async () => {
    const hash = await contentHash(normalizeText("hello\n"));
    expect(hash.length).toBeGreaterThan(0);
  });

  it("normalizes MCP server entries without provenance", () => {
    const normalized = normalizeMcpServer({
      name: "demo",
      command: "node",
      args: ["--version"],
      provenance: {
        sourceId: "cursor",
        sourcePath: "/tmp/mcp.json",
        importedAt: "2024-01-01T00:00:00Z",
      },
    });
    expect(normalized).toContain('"name": "demo"');
    expect(normalized).not.toContain("provenance");
  });

  it("hashes MCP server entries independent of provenance", async () => {
    const base = {
      name: "demo",
      transport: "stdio" as const,
      command: "node",
      args: ["--version"],
    };
    const hashA = await mcpServerHash({
      ...base,
      provenance: {
        sourceId: "cursor",
        sourcePath: "/tmp/mcp.json",
        importedAt: "2024-01-01T00:00:00Z",
      },
    });
    const hashB = await mcpServerHash({
      ...base,
      provenance: {
        sourceId: "claude",
        sourcePath: "/tmp/other.json",
        importedAt: "2024-02-01T00:00:00Z",
      },
    });
    expect(hashA).toBe(hashB);
  });
});

describe("conflict auto decisions", () => {
  it("prefers newest when configured", () => {
    const current = { modified: new Date("2024-01-01T00:00:00Z") };
    const incoming = { modified: new Date("2024-02-01T00:00:00Z") };
    expect(decideAuto("keep-newest", current, incoming)).toBe("keep-incoming");
  });

  it("honors explicit keep-current/keep-incoming", () => {
    const meta = { modified: null };
    expect(decideAuto("keep-current", meta, meta)).toBe("keep-current");
    expect(decideAuto("keep-incoming", meta, meta)).toBe("keep-incoming");
  });

  it("treats matching hashes as auto-merge", () => {
    expect(hashesMatch("abc", "abc")).toBe(true);
    expect(hashesMatch("abc", "def")).toBe(false);
    expect(hashesMatch(null, "abc")).toBe(false);
  });
});
