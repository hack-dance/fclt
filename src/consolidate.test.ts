import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consolidateCommand } from "./consolidate";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CWD = process.cwd();

let tempDir: string | null = null;

async function makeTempEnv(): Promise<{
  home: string;
  rootDir: string;
  workspace: string;
  fromRoot: string;
}> {
  const base = await mkdtemp(join(tmpdir(), "facult-consolidate-"));
  tempDir = base;

  const home = join(base, "home");
  const rootDir = join(home, "agents", ".facult");
  const workspace = join(base, "workspace");
  const fromRoot = join(base, "from");

  await mkdir(rootDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(fromRoot, { recursive: true });

  process.env.HOME = home;
  process.chdir(workspace);

  return { home, rootDir, workspace, fromRoot };
}

async function withMutedConsole(fn: () => Promise<void>) {
  const prevLog = console.log;
  const prevError = console.error;
  console.log = () => {
    // mute logs during command tests
  };
  console.error = () => {
    // mute errors during command tests
  };
  try {
    await fn();
  } finally {
    console.log = prevLog;
    console.error = prevError;
  }
}

afterEach(async () => {
  process.chdir(ORIGINAL_CWD);
  process.env.HOME = ORIGINAL_HOME;
  process.exitCode = undefined;
  if (!tempDir) {
    return;
  }
  await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("consolidate command", () => {
  it("respects --from roots in auto mode and consolidates skills non-interactively", async () => {
    const { rootDir, fromRoot } = await makeTempEnv();
    const skillDir = join(fromRoot, "my-skill");
    await mkdir(skillDir, { recursive: true });
    await Bun.write(
      join(skillDir, "SKILL.md"),
      "# my-skill\n\n## When To Use\nUse me.\n"
    );

    await withMutedConsole(async () => {
      await consolidateCommand(
        ["--auto", "keep-incoming", "--no-config-from", "--from", fromRoot],
        {
          homeDir: process.env.HOME,
          rootDir,
          cwd: process.cwd(),
        }
      );
    });

    const consolidated = await readFile(
      join(rootDir, "skills", "my-skill", "SKILL.md"),
      "utf8"
    );
    expect(consolidated).toContain("# my-skill");
  });

  it("copies standalone MCP config files in --auto mode without interactive confirmation", async () => {
    const { rootDir, fromRoot } = await makeTempEnv();
    await Bun.write(
      join(fromRoot, ".claude.json"),
      JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }, null, 2)
    );

    await withMutedConsole(async () => {
      await consolidateCommand(
        ["--auto", "keep-current", "--no-config-from", "--from", fromRoot],
        {
          homeDir: process.env.HOME,
          rootDir,
          cwd: process.cwd(),
        }
      );
    });

    const copied = JSON.parse(
      await readFile(join(rootDir, "mcp", ".claude.json"), "utf8")
    ) as { permissions?: { allow?: string[] } };
    expect(copied.permissions?.allow).toEqual(["Bash(ls)"]);
  });

  it("keeps current skill content on conflict with --auto keep-current", async () => {
    const { fromRoot, workspace } = await makeTempEnv();
    const rootDir = join(workspace, ".facult-root");
    await mkdir(rootDir, { recursive: true });
    const incomingDir = join(fromRoot, "my-skill");
    await mkdir(incomingDir, { recursive: true });
    await Bun.write(join(incomingDir, "SKILL.md"), "# incoming\n");

    const existingDir = join(rootDir, "skills", "my-skill");
    await mkdir(existingDir, { recursive: true });
    await Bun.write(join(existingDir, "SKILL.md"), "# current\n");

    await withMutedConsole(async () => {
      await consolidateCommand(
        ["--auto", "keep-current", "--no-config-from", "--from", fromRoot],
        {
          homeDir: process.env.HOME,
          rootDir,
          cwd: process.cwd(),
        }
      );
    });

    const finalSkill = await readFile(join(existingDir, "SKILL.md"), "utf8");
    expect(finalSkill).toContain("# current");
  });

  it("archives and replaces skill content on conflict with --auto keep-incoming", async () => {
    const { fromRoot, workspace } = await makeTempEnv();
    const rootDir = join(workspace, ".facult-root");
    await mkdir(rootDir, { recursive: true });
    const incomingDir = join(fromRoot, "my-skill");
    await mkdir(incomingDir, { recursive: true });
    await Bun.write(join(incomingDir, "SKILL.md"), "# incoming\n");

    const existingDir = join(rootDir, "skills", "my-skill");
    await mkdir(existingDir, { recursive: true });
    await Bun.write(join(existingDir, "SKILL.md"), "# current\n");

    await withMutedConsole(async () => {
      await consolidateCommand(
        ["--auto", "keep-incoming", "--no-config-from", "--from", fromRoot],
        {
          homeDir: process.env.HOME,
          rootDir,
          cwd: process.cwd(),
        }
      );
    });

    const finalSkill = await readFile(join(existingDir, "SKILL.md"), "utf8");
    expect(finalSkill).toContain("# incoming");
    const backups = (await readdir(join(rootDir, "skills"))).filter((name) =>
      name.startsWith("my-skill.bak.")
    );
    expect(backups.length > 0).toBe(true);
  });

  it("prefers newer incoming MCP server definitions with --auto keep-newest", async () => {
    const { fromRoot, workspace } = await makeTempEnv();
    const rootDir = join(workspace, ".facult-root");
    await mkdir(rootDir, { recursive: true });
    const canonicalMcpPath = join(rootDir, "mcp", "mcp.json");
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await Bun.write(
      canonicalMcpPath,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: new Date(0).toISOString(),
          mcpServers: {
            github: {
              name: "github",
              transport: "stdio",
              command: "old-cmd",
            },
          },
        },
        null,
        2
      )}\n`
    );

    const incomingMcpPath = join(fromRoot, ".claude.json");
    await Bun.write(
      incomingMcpPath,
      `${JSON.stringify(
        {
          mcpServers: {
            github: {
              command: "incoming-cmd",
              args: ["serve"],
            },
          },
        },
        null,
        2
      )}\n`
    );

    const oldTime = new Date("2023-01-01T00:00:00.000Z");
    const newTime = new Date("2026-01-01T00:00:00.000Z");
    await utimes(canonicalMcpPath, oldTime, oldTime);
    await utimes(incomingMcpPath, newTime, newTime);

    await withMutedConsole(async () => {
      await consolidateCommand(
        ["--auto", "keep-newest", "--no-config-from", "--from", fromRoot],
        {
          homeDir: process.env.HOME,
          rootDir,
          cwd: process.cwd(),
        }
      );
    });

    const merged = JSON.parse(await readFile(canonicalMcpPath, "utf8")) as {
      mcpServers?: Record<string, { command?: string }>;
    };
    expect(merged.mcpServers?.github?.command).toBe("incoming-cmd");
  });

  it("archives and replaces standalone MCP config conflicts with --auto keep-incoming", async () => {
    const { fromRoot, workspace } = await makeTempEnv();
    const rootDir = join(workspace, ".facult-root");
    await mkdir(rootDir, { recursive: true });
    const existingConfig = join(rootDir, "mcp", ".claude.json");
    await mkdir(join(rootDir, "mcp"), { recursive: true });
    await Bun.write(
      existingConfig,
      `${JSON.stringify({ permissions: { allow: ["Bash(old)"] } }, null, 2)}\n`
    );

    const incomingConfig = join(fromRoot, ".claude.json");
    await Bun.write(
      incomingConfig,
      `${JSON.stringify({ permissions: { allow: ["Bash(new)"] } }, null, 2)}\n`
    );

    await withMutedConsole(async () => {
      await consolidateCommand(
        ["--auto", "keep-incoming", "--no-config-from", "--from", fromRoot],
        {
          homeDir: process.env.HOME,
          rootDir,
          cwd: process.cwd(),
        }
      );
    });

    const finalConfig = JSON.parse(await readFile(existingConfig, "utf8")) as {
      permissions?: { allow?: string[] };
    };
    expect(finalConfig.permissions?.allow).toEqual(["Bash(new)"]);

    const backups = (await readdir(join(rootDir, "mcp"))).filter((name) =>
      name.startsWith(".claude.json.bak.")
    );
    expect(backups.length > 0).toBe(true);
  });
});
