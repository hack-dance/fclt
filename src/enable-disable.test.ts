import { describe, expect, it } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyEnableDisable } from "./enable-disable";
import type { FacultIndex } from "./index-builder";
import { type ManagedState, saveManagedState } from "./manage";

async function createTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "facult-enable-"));
}

async function writeJson(p: string, data: unknown) {
  await mkdir(dirname(p), { recursive: true });
  await Bun.write(p, `${JSON.stringify(data, null, 2)}\n`);
}

describe("enable/disable", () => {
  it("updates index and syncs managed tools", async () => {
    const home = await createTempDir();
    const rootDir = join(home, "agents", ".facult");
    const skillsRoot = join(rootDir, "skills");
    const alphaDir = join(skillsRoot, "alpha");
    await mkdir(alphaDir, { recursive: true });
    await Bun.write(join(alphaDir, "SKILL.md"), "# Alpha\n");

    const indexPath = join(rootDir, "index.json");
    const index: FacultIndex = {
      version: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        alpha: {
          name: "alpha",
          path: alphaDir,
          description: "",
          tags: [],
          enabledFor: ["codex"],
        } as FacultIndex["skills"][string] & { enabledFor?: string[] },
      },
      mcp: {
        servers: {
          beta: {
            name: "beta",
            path: join(rootDir, "mcp", "servers.json"),
            definition: {
              command: "node",
              args: ["server.js"],
              enabledFor: ["codex"],
            },
            enabledFor: ["codex"],
          } as FacultIndex["mcp"]["servers"][string] & {
            enabledFor?: string[];
          },
        },
      },
      agents: {},
      snippets: {},
    };
    await mkdir(rootDir, { recursive: true });
    await Bun.write(indexPath, `${JSON.stringify(index, null, 2)}\n`);

    const serversPath = join(rootDir, "mcp", "servers.json");
    await writeJson(serversPath, {
      servers: {
        beta: { command: "node", args: ["server.js"], enabledFor: ["codex"] },
      },
    });

    const toolRoot = join(home, "tool");
    const toolSkills = join(toolRoot, "skills");
    const toolMcp = join(toolRoot, "mcp.json");
    await mkdir(toolSkills, { recursive: true });
    await Bun.write(toolMcp, JSON.stringify({ mcpServers: {} }, null, 2));

    const managed: ManagedState = {
      version: 1,
      tools: {
        cursor: {
          tool: "cursor",
          managedAt: new Date().toISOString(),
          skillsDir: toolSkills,
          mcpConfig: toolMcp,
        },
      },
    };
    await saveManagedState(managed, home);

    await applyEnableDisable({
      names: ["alpha", "mcp:beta"],
      mode: "enable",
      tools: ["cursor"],
      homeDir: home,
      rootDir,
    });

    const updated = JSON.parse(
      await readFile(indexPath, "utf8")
    ) as FacultIndex;
    expect(
      (updated.skills.alpha as { enabledFor?: string[] }).enabledFor
    ).toEqual(["codex", "cursor"]);
    expect(
      (updated.mcp.servers.beta as { enabledFor?: string[] }).enabledFor
    ).toEqual(["codex", "cursor"]);

    const linkPath = join(toolSkills, "alpha");
    const st = await lstat(linkPath);
    expect(st.isSymbolicLink()).toBe(true);
    const target = await readlink(linkPath);
    expect(target).toBe(alphaDir);

    const mcpAfterEnable = JSON.parse(await readFile(toolMcp, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(mcpAfterEnable.mcpServers)).toEqual(["beta"]);

    await applyEnableDisable({
      names: ["alpha", "mcp:beta"],
      mode: "disable",
      tools: ["cursor"],
      homeDir: home,
      rootDir,
    });

    const updatedDisable = JSON.parse(
      await readFile(indexPath, "utf8")
    ) as FacultIndex;
    expect(
      (updatedDisable.skills.alpha as { enabledFor?: string[] }).enabledFor
    ).toEqual(["codex"]);
    expect(
      (updatedDisable.mcp.servers.beta as { enabledFor?: string[] }).enabledFor
    ).toEqual(["codex"]);

    const removedLink = await Bun.file(linkPath).exists();
    expect(removedLink).toBe(false);

    const mcpAfterDisable = JSON.parse(await readFile(toolMcp, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(mcpAfterDisable.mcpServers)).toEqual([]);
  });

  it("scopes first-time enable to requested tools when enabledFor is missing", async () => {
    const home = await createTempDir();
    const rootDir = join(home, "agents", ".facult");
    const skillsRoot = join(rootDir, "skills");
    const alphaDir = join(skillsRoot, "alpha");
    await mkdir(alphaDir, { recursive: true });
    await Bun.write(join(alphaDir, "SKILL.md"), "# Alpha\n");

    const indexPath = join(rootDir, "index.json");
    const index: FacultIndex = {
      version: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        alpha: {
          name: "alpha",
          path: alphaDir,
          description: "",
          tags: [],
        } as FacultIndex["skills"][string] & { enabledFor?: string[] },
      },
      mcp: {
        servers: {
          beta: {
            name: "beta",
            path: join(rootDir, "mcp", "servers.json"),
            definition: {
              command: "node",
              args: ["server.js"],
            },
          } as FacultIndex["mcp"]["servers"][string] & {
            enabledFor?: string[];
          },
        },
      },
      agents: {},
      snippets: {},
    };
    await mkdir(rootDir, { recursive: true });
    await Bun.write(indexPath, `${JSON.stringify(index, null, 2)}\n`);

    const serversPath = join(rootDir, "mcp", "servers.json");
    await writeJson(serversPath, {
      servers: {
        beta: { command: "node", args: ["server.js"] },
      },
    });

    const cursorRoot = join(home, "cursor");
    const cursorSkills = join(cursorRoot, "skills");
    const cursorMcp = join(cursorRoot, "mcp.json");
    await mkdir(cursorSkills, { recursive: true });
    await Bun.write(cursorMcp, JSON.stringify({ mcpServers: {} }, null, 2));

    const codexRoot = join(home, "codex");
    const codexSkills = join(codexRoot, "skills");
    const codexMcp = join(codexRoot, "mcp.json");
    await mkdir(codexSkills, { recursive: true });
    await Bun.write(codexMcp, JSON.stringify({ mcpServers: {} }, null, 2));

    const managed: ManagedState = {
      version: 1,
      tools: {
        cursor: {
          tool: "cursor",
          managedAt: new Date().toISOString(),
          skillsDir: cursorSkills,
          mcpConfig: cursorMcp,
        },
        codex: {
          tool: "codex",
          managedAt: new Date().toISOString(),
          skillsDir: codexSkills,
          mcpConfig: codexMcp,
        },
      },
    };
    await saveManagedState(managed, home);

    await applyEnableDisable({
      names: ["alpha", "mcp:beta"],
      mode: "enable",
      tools: ["cursor"],
      homeDir: home,
      rootDir,
    });

    const updated = JSON.parse(
      await readFile(indexPath, "utf8")
    ) as FacultIndex;
    expect(
      (updated.skills.alpha as { enabledFor?: string[] }).enabledFor
    ).toEqual(["cursor"]);
    expect(
      (updated.mcp.servers.beta as { enabledFor?: string[] }).enabledFor
    ).toEqual(["cursor"]);

    const canonicalServers = JSON.parse(
      await readFile(serversPath, "utf8")
    ) as {
      servers: Record<string, { enabledFor?: string[] }>;
    };
    expect(canonicalServers.servers.beta?.enabledFor).toEqual(["cursor"]);

    const cursorLink = await lstat(join(cursorSkills, "alpha"));
    expect(cursorLink.isSymbolicLink()).toBe(true);
    expect(await Bun.file(join(codexSkills, "alpha")).exists()).toBe(false);

    const cursorMcpAfter = JSON.parse(await readFile(cursorMcp, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(cursorMcpAfter.mcpServers)).toEqual(["beta"]);

    const codexMcpAfter = JSON.parse(await readFile(codexMcp, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(codexMcpAfter.mcpServers)).toEqual([]);
  });
});
