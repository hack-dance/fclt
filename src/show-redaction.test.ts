import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { facultAiIndexPath } from "./paths";

async function writeJson(p: string, data: unknown) {
  await mkdir(dirname(p), { recursive: true });
  await Bun.write(p, `${JSON.stringify(data, null, 2)}\n`);
}

test("show redacts MCP secrets by default (use --show-secrets to bypass)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-show-"));
  const rootDir = join(dir, "root");
  const mcpPath = join(rootDir, "mcp", "mcp.json");

  const secret = "sk-1234567890ABCDEFGHIJK"; // matches redaction regex

  await mkdir(join(rootDir, "mcp"), { recursive: true });

  await writeJson(facultAiIndexPath(dir), {
    version: 1,
    updatedAt: new Date().toISOString(),
    skills: {},
    mcp: {
      servers: {
        alpha: {
          name: "alpha",
          path: mcpPath,
          definition: {
            command: "node",
            args: ["server.js"],
            env: { OPENAI_API_KEY: secret },
          },
        },
      },
    },
    agents: {},
    snippets: {},
    instructions: {},
  });

  await writeJson(mcpPath, {
    mcpServers: {
      alpha: {
        command: "node",
        args: ["server.js"],
        env: { OPENAI_API_KEY: secret },
      },
    },
  });

  const baseEnv = { ...process.env, HOME: dir, FACULT_ROOT_DIR: rootDir };
  const entrypoint = join(import.meta.dir, "index.ts");
  const index = Bun.spawn(["bun", "run", entrypoint, "index"], {
    cwd: dir,
    env: baseEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await index.exited).toBe(0);

  {
    const proc = Bun.spawn(["bun", "run", entrypoint, "show", "mcp:alpha"], {
      cwd: dir,
      env: baseEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(out).not.toContain(secret);
    expect(out).toContain("<redacted>");
  }

  {
    const proc = Bun.spawn(
      ["bun", "run", entrypoint, "show", "mcp:alpha", "--show-secrets"],
      { cwd: dir, env: baseEnv, stdout: "pipe", stderr: "pipe" }
    );
    const [code, out] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    expect(code).toBe(0);
    expect(out).toContain(secret);
  }
});
