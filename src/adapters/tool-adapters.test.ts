import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCliAdapter } from "./claude-cli";
import { claudeDesktopAdapter } from "./claude-desktop";
import { clawdbotAdapter } from "./clawdbot";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { factoryAdapter } from "./factory";
import type { ToolAdapter } from "./types";

const SAMPLE_MCP_CONFIG = {
  mcpServers: {
    alpha: {
      command: "node",
      args: ["server.js"],
      env: { KEY: "value" },
      extra: true,
    },
    beta: "legacy",
  },
  theme: "dark",
};

const SAMPLE_MCP_NESTED = {
  mcp: {
    servers: {
      alpha: {
        command: "node",
        args: ["server.js"],
        env: { KEY: "value" },
        extra: true,
      },
      beta: "legacy",
    },
    mode: "strict",
  },
  theme: "dark",
};

const SAMPLE_FACTORY_MCP = {
  mcpServers: {
    alpha: {
      type: "http",
      url: "https://example.com/mcp",
      disabled: false,
      headers: { Authorization: "Bearer token" },
    },
    beta: {
      type: "stdio",
      command: "node",
      args: ["server.js"],
      disabled: true,
    },
  },
};

function roundTrip(adapter: ToolAdapter, input: unknown) {
  const parseMcp = adapter.parseMcp;
  const generateMcp = adapter.generateMcp;
  if (!(parseMcp && generateMcp)) {
    throw new Error(`Adapter ${adapter.id} missing MCP handlers`);
  }
  const parsed = parseMcp(input);
  const generated = generateMcp(parsed);
  const parsedAgain = parseMcp(generated);
  return { parsed, generated, parsedAgain };
}

describe("tool adapters MCP roundtrip", () => {
  it("round-trips cursor", () => {
    const { parsed, generated, parsedAgain } = roundTrip(
      cursorAdapter,
      SAMPLE_MCP_CONFIG
    );
    expect(parsed).toBeTruthy();
    expect(generated).toBeTruthy();
    expect(parsedAgain).toEqual(parsed);
  });

  it("round-trips codex (nested mcp)", () => {
    const { parsed, generated, parsedAgain } = roundTrip(
      codexAdapter,
      SAMPLE_MCP_NESTED
    );
    expect(parsed).toBeTruthy();
    expect(generated).toBeTruthy();
    expect(parsedAgain).toEqual(parsed);
  });

  it("round-trips claude cli", () => {
    const { parsed, generated, parsedAgain } = roundTrip(
      claudeCliAdapter,
      SAMPLE_MCP_CONFIG
    );
    expect(parsed).toBeTruthy();
    expect(generated).toBeTruthy();
    expect(parsedAgain).toEqual(parsed);
  });

  it("round-trips claude desktop", () => {
    const { parsed, generated, parsedAgain } = roundTrip(
      claudeDesktopAdapter,
      SAMPLE_MCP_CONFIG
    );
    expect(parsed).toBeTruthy();
    expect(generated).toBeTruthy();
    expect(parsedAgain).toEqual(parsed);
  });

  it("round-trips clawdbot", () => {
    const { parsed, generated, parsedAgain } = roundTrip(
      clawdbotAdapter,
      SAMPLE_MCP_CONFIG
    );
    expect(parsed).toBeTruthy();
    expect(generated).toBeTruthy();
    expect(parsedAgain).toEqual(parsed);
  });

  it("round-trips factory", () => {
    const { parsed, generated, parsedAgain } = roundTrip(
      factoryAdapter,
      SAMPLE_FACTORY_MCP
    );
    expect(parsed).toBeTruthy();
    expect(generated).toBeTruthy();
    expect(parsedAgain).toEqual(parsed);
  });
});

describe("tool adapters skills parsing", () => {
  it("parses skills directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "facult-skills-"));
    const skillDir = join(root, "alpha");
    await mkdir(skillDir, { recursive: true });
    await Bun.write(join(skillDir, "SKILL.md"), "# Alpha\n");

    const skills = await cursorAdapter.parseSkills?.(root);
    expect(skills?.map((s) => s.name)).toEqual(["alpha"]);
  });
});
