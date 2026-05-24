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
            args: ["mcp", "serve"],
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
  expect(github?.auth.inlineSecretKeys).toEqual(["GITHUB_TOKEN"]);
  expect(github?.auth.envRefs).toEqual(["PUBLIC_ENV"]);
  expect(JSON.stringify(github)).not.toContain("github_pat_1234567890abcdef");
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
    from: ["~/dev"],
  });
});
