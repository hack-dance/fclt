import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { facultBuiltinCodexPluginRoot } from "./builtin";

const CONTENT_LENGTH_RE = /Content-Length:\s*(\d+)/i;

function frame(message: unknown): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function readFrame(stream: NodeJS.ReadableStream): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const header = buffer.slice(0, headerEnd).toString("utf8");
      const match = CONTENT_LENGTH_RE.exec(header);
      if (!match) {
        cleanup();
        reject(new Error("Missing Content-Length header"));
        return;
      }
      const bodyLength = Number(match[1]);
      const frameEnd = headerEnd + 4 + bodyLength;
      if (buffer.length < frameEnd) {
        return;
      }
      const body = buffer.slice(headerEnd + 4, frameEnd).toString("utf8");
      cleanup();
      resolve(JSON.parse(body));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onError);
    };
    stream.on("data", onData);
    stream.on("error", onError);
  });
}

describe("bundled fclt MCP plugin", () => {
  it("uses the caller workspace cwd instead of the plugin cwd when omitted", async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-mcp-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "facult-mcp-workspace-"));
    const stub = join(home, "fclt-stub.cjs");
    await Bun.write(
      stub,
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));",
        "",
      ].join("\n")
    );
    await chmod(stub, 0o755);
    await mkdir(join(home, ".ai"), { recursive: true });

    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawn("node", [join(pluginRoot, "scripts", "fclt-mcp.cjs")], {
      cwd: pluginRoot,
      env: {
        ...process.env,
        FCLT_BIN: stub,
        HOME: home,
        PWD: workspace,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "fclt_status",
            arguments: {},
          },
        })
      );
      const response = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      const expectedWorkspace = await realpath(workspace);

      expect(response.result?.isError).toBe(false);
      expect(response.result?.content?.[0]?.text).toContain(
        `"cwd":"${expectedWorkspace}"`
      );
      expect(response.result?.content?.[0]?.text).toContain(
        '"argv":["status","--json"]'
      );
    } finally {
      child.kill();
    }
  });

  it("rejects project-scoped calls without an explicit workspace cwd", async () => {
    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawn("node", [join(pluginRoot, "scripts", "fclt-mcp.cjs")], {
      cwd: pluginRoot,
      env: {
        ...process.env,
        FCLT_BIN: "fclt",
        PWD: pluginRoot,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "fclt_status",
            arguments: { scope: "project" },
          },
        })
      );
      const response = (await readFrame(child.stdout)) as {
        error?: { message?: string };
      };

      expect(response.error?.message).toContain("requires a cwd");
    } finally {
      child.kill();
    }
  });
});
