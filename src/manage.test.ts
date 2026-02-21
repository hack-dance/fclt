import { describe, expect, it } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  loadManagedState,
  managedStatePath,
  manageTool,
  unmanageTool,
} from "./manage";

async function createTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "facult-manage-"));
}

async function writeJson(p: string, data: unknown) {
  await mkdir(dirname(p), { recursive: true });
  await Bun.write(p, `${JSON.stringify(data, null, 2)}\n`);
}

describe("managed state", () => {
  it("loads default state when missing", async () => {
    const home = await createTempDir();
    const state = await loadManagedState(home);
    expect(state.version).toBe(1);
    expect(state.tools).toEqual({});
  });

  it("writes managed.json after managing", async () => {
    const home = await createTempDir();
    const rootDir = join(home, "agents", ".facult");
    const skillsRoot = join(rootDir, "skills", "alpha");
    await mkdir(skillsRoot, { recursive: true });
    await Bun.write(join(skillsRoot, "SKILL.md"), "# Alpha\n");

    const serversPath = join(rootDir, "mcp", "servers.json");
    await writeJson(serversPath, {
      servers: { test: { command: "node", args: ["server.js"] } },
    });

    await manageTool("cursor", {
      homeDir: home,
      rootDir,
      toolPaths: {
        cursor: {
          tool: "cursor",
          skillsDir: join(home, "tool", "skills"),
          mcpConfig: join(home, "tool", "mcp.json"),
        },
      },
    });

    const managedPath = managedStatePath(home);
    const raw = await readFile(managedPath, "utf8");
    const parsed = JSON.parse(raw) as { tools: Record<string, unknown> };
    expect(parsed.tools.cursor).toBeTruthy();
  });
});

describe("manage/unmanage", () => {
  it("backs up, symlinks, and restores", async () => {
    const home = await createTempDir();
    const rootDir = join(home, "agents", ".facult");
    const skill = join(rootDir, "skills", "alpha");
    await mkdir(skill, { recursive: true });
    await Bun.write(join(skill, "SKILL.md"), "# Alpha\n");

    const indexPath = join(rootDir, "index.json");
    await writeJson(indexPath, {
      skills: {
        alpha: {
          name: "alpha",
          path: skill,
          enabledFor: ["cursor"],
        },
      },
    });

    const serversPath = join(rootDir, "mcp", "servers.json");
    await writeJson(serversPath, {
      servers: {
        alpha: { command: "node", args: ["server.js"], enabledFor: ["cursor"] },
        beta: { command: "node", args: ["skip.js"], enabledFor: ["codex"] },
      },
    });

    const toolRoot = join(home, "tool");
    const toolSkills = join(toolRoot, "skills");
    const toolMcp = join(toolRoot, "mcp.json");
    await mkdir(toolSkills, { recursive: true });
    await Bun.write(join(toolSkills, "legacy.txt"), "old");
    await writeJson(toolMcp, { servers: { legacy: { command: "old" } } });

    await manageTool("cursor", {
      homeDir: home,
      rootDir,
      toolPaths: {
        cursor: {
          tool: "cursor",
          skillsDir: toolSkills,
          mcpConfig: toolMcp,
        },
      },
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    const linkPath = join(toolSkills, "alpha");
    const st = await lstat(linkPath);
    expect(st.isSymbolicLink()).toBe(true);
    const target = await readlink(linkPath);
    expect(target).toBe(skill);

    const newMcp = JSON.parse(await readFile(toolMcp, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(newMcp.mcpServers)).toEqual(["alpha"]);

    await unmanageTool("cursor", {
      homeDir: home,
      toolPaths: {
        cursor: {
          tool: "cursor",
          skillsDir: toolSkills,
          mcpConfig: toolMcp,
        },
      },
    });

    const restored = await readFile(join(toolSkills, "legacy.txt"), "utf8");
    expect(restored).toBe("old");
    const restoredMcp = JSON.parse(await readFile(toolMcp, "utf8")) as {
      servers: Record<string, unknown>;
    };
    expect(Object.keys(restoredMcp.servers)).toEqual(["legacy"]);
  });
});
