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
    const tbRoot = join(home, "agents", ".tb");
    const skillsRoot = join(tbRoot, "skills");
    const alphaDir = join(skillsRoot, "alpha");
    await mkdir(alphaDir, { recursive: true });
    await Bun.write(join(alphaDir, "SKILL.md"), "# Alpha\n");

    const indexPath = join(tbRoot, "index.json");
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
            path: join(tbRoot, "mcp", "servers.json"),
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
    await mkdir(tbRoot, { recursive: true });
    await Bun.write(indexPath, `${JSON.stringify(index, null, 2)}\n`);

    const serversPath = join(tbRoot, "mcp", "servers.json");
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
      tbRoot,
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
      tbRoot,
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
});
