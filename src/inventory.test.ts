import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentInventory, parseInventoryArgs } from "./inventory";

test("inventory consolidates skills, instructions, and MCP auth metadata without leaking secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-inventory-"));
  const home = join(dir, "home");
  const root = join(home, ".ai");

  await mkdir(join(root, "skills", "alpha"), { recursive: true });
  await Bun.write(join(root, "skills", "alpha", "SKILL.md"), "# Alpha\n");
  await mkdir(join(root, "instructions"), { recursive: true });
  await Bun.write(join(root, "instructions", "WORK.md"), "# Work\n");
  await mkdir(join(root, "mcp"), { recursive: true });
  const publicEnvRef = `${String.fromCharCode(36)}{PUBLIC_ENV}`;
  await Bun.write(
    join(root, "mcp", "servers.json"),
    JSON.stringify(
      {
        servers: {
          github: {
            command: "gh",
            args: [
              "mcp",
              "serve",
              'API_KEY="0123456789abcdef0123456789abcdef"',
              "https://example.com/mcp?token=abcdef0123456789",
            ],
            env: {
              GITHUB_TOKEN: "github_pat_1234567890abcdef",
              PUBLIC_ENV: publicEnvRef,
            },
          },
        },
      },
      null,
      2
    )
  );

  const inventory = await buildAgentInventory({
    cwd: dir,
    homeDir: home,
    includeConfigFrom: false,
    from: [],
  });

  expect(inventory.skills.some((skill) => skill.name === "alpha")).toBe(true);
  expect(
    inventory.instructions.some(
      (instruction) =>
        instruction.kind === "canonical-instruction" &&
        instruction.path === join(root, "instructions", "WORK.md")
    )
  ).toBe(true);

  const github = inventory.mcpServers.find(
    (server) => server.name === "github"
  );
  expect(github).toBeTruthy();
  expect(github?.auth.state).toBe("inline-secret");
  expect(github?.auth.inlineSecretKeys).toContain("GITHUB_TOKEN");
  expect(github?.auth.inlineSecretKeys).toContain("args[2]:API_KEY");
  expect(github?.auth.inlineSecretKeys).toContain("args[3]:token");
  expect(github?.auth.envRefs).toEqual(["PUBLIC_ENV"]);
  expect(JSON.stringify(github)).not.toContain("github_pat_1234567890abcdef");
  expect(JSON.stringify(github)).not.toContain(
    "0123456789abcdef0123456789abcdef"
  );
  expect(JSON.stringify(github)).not.toContain("token=abcdef0123456789");
  expect(github?.args?.[2]).toBe('API_KEY="<redacted>"');
  expect(github?.args?.[3]).toBe("https://example.com/mcp?token=<redacted>");
  expect(inventory.mcpCapabilities).toHaveLength(1);
  expect(inventory.mcpCapabilities[0]?.preferred.name).toBe("github");
});

test("inventory reads Codex TOML MCP servers and reports env references", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-inventory-codex-"));
  const home = join(dir, "home");

  await mkdir(join(home, ".codex"), { recursive: true });
  await Bun.write(
    join(home, ".codex", "config.toml"),
    `[mcp_servers."remote-api"]\nurl = "https://example.com/mcp"\n\n[mcp_servers."remote-api".env]\nAPI_KEY = "\${REMOTE_API_KEY}"\n`
  );

  const inventory = await buildAgentInventory({
    cwd: dir,
    homeDir: home,
    includeConfigFrom: false,
    from: [],
  });

  const remote = inventory.mcpServers.find(
    (server) => server.name === "remote-api"
  );
  expect(remote).toBeTruthy();
  expect(remote?.configFormat).toBe("toml");
  expect(remote?.url).toBe("https://example.com/mcp");
  expect(remote?.auth.state).toBe("env");
  expect(remote?.auth.envRefs).toEqual(["REMOTE_API_KEY"]);
});

test("inventory discovers repo-local .ai roots from explicit scan roots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-inventory-project-ai-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  const root = join(repo, ".ai");

  await mkdir(join(root, "mcp"), { recursive: true });
  await Bun.write(
    join(root, "mcp", "servers.json"),
    JSON.stringify({ servers: { local: { command: "bun", args: ["mcp.ts"] } } })
  );
  await mkdir(join(root, "instructions"), { recursive: true });
  await Bun.write(join(root, "instructions", "PROJECT.md"), "# Project\n");

  const inventory = await buildAgentInventory({
    cwd: repo,
    homeDir: home,
    includeConfigFrom: false,
    from: [repo],
  });

  expect(inventory.mcpServers.some((server) => server.name === "local")).toBe(
    true
  );
  expect(
    inventory.instructions.some(
      (instruction) =>
        instruction.kind === "canonical-instruction" &&
        instruction.path === join(root, "instructions", "PROJECT.md")
    )
  ).toBe(true);
});

test("inventory filters machine inventory by project and tool sources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-inventory-filters-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  const globalRoot = join(home, ".ai");
  const projectRoot = join(repo, ".ai");

  await mkdir(join(globalRoot, "mcp"), { recursive: true });
  await Bun.write(
    join(globalRoot, "mcp", "servers.json"),
    JSON.stringify({ servers: { global: { command: "global-mcp" } } })
  );
  await mkdir(join(projectRoot, "mcp"), { recursive: true });
  await Bun.write(
    join(projectRoot, "mcp", "servers.json"),
    JSON.stringify({ servers: { project: { command: "project-mcp" } } })
  );

  const projectInventory = await buildAgentInventory({
    cwd: repo,
    homeDir: home,
    includeConfigFrom: false,
    sourceMode: "project",
    from: [repo],
  });
  expect(projectInventory.mcpCapabilities.map((server) => server.name)).toEqual(
    ["project"]
  );

  const codexInventory = await buildAgentInventory({
    cwd: repo,
    homeDir: home,
    includeConfigFrom: false,
    tool: "codex",
    from: [repo],
  });
  expect(
    codexInventory.sources.every(
      (source) => source.id === "codex" || source.id === "codex-project"
    )
  ).toBe(true);
});

test("parseInventoryArgs supports JSON-first inventory options", () => {
  const parsed = parseInventoryArgs([
    "--json",
    "--from",
    "~/dev",
    "--show-secrets",
    "--include-git-hooks",
    "--no-config-from",
  ]);

  expect(parsed).toEqual({
    json: true,
    showSecrets: true,
    includeGitHooks: true,
    includeConfigFrom: false,
    sourceMode: "machine",
    tool: undefined,
    from: ["~/dev"],
  });
});
