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

function compatibleStubScript(): string {
  return [
    `#!${process.execPath}`,
    "if (process.argv[2] === 'protocol') {",
    "  console.log(JSON.stringify({schemaVersion:1,packageVersion:'9.9.9',protocol:{version:1,minimumPluginVersion:1,maximumPluginVersion:1},runtime:{platform:process.platform,architecture:process.arch,executable:process.argv[1]}}));",
    "} else {",
    "  console.log(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));",
    "}",
    "",
  ].join("\n");
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

function toolPayload(response: unknown): {
  operation: { preview: boolean; risk: string };
  recovery: {
    changedPaths?: string[];
    rollbackAvailable?: boolean;
    verification?: string;
  } | null;
  result: {
    exitCode: number;
    stdout: { argv: string[]; cwd: string } | string;
    stderr: string;
  };
} {
  const typed = response as {
    result?: { content?: { text?: string }[] };
  };
  const text = typed.result?.content?.[0]?.text;
  if (!text) {
    throw new Error("MCP response did not include a text payload");
  }
  return JSON.parse(text) as {
    operation: { preview: boolean; risk: string };
    recovery: {
      changedPaths?: string[];
      rollbackAvailable?: boolean;
      verification?: string;
    } | null;
    result: {
      exitCode: number;
      stdout: { argv: string[]; cwd: string } | string;
      stderr: string;
    };
  };
}

describe("bundled fclt MCP plugin", () => {
  it("wraps the released setup contract with preview, scope, and approval gates", async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-mcp-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "facult-mcp-workspace-"));
    const stub = join(home, "fclt-stub.cjs");
    await Bun.write(stub, compatibleStubScript());
    await chmod(stub, 0o755);

    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawn(
      process.execPath,
      [join(pluginRoot, "scripts", "fclt-mcp.cjs")],
      {
        cwd: pluginRoot,
        env: { ...process.env, FCLT_BIN: stub, HOME: home, PWD: workspace },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    try {
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "fclt_setup",
            arguments: { scope: "global" },
          },
        })
      );
      const defaultResponse = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      expect(defaultResponse.result?.isError).toBe(false);
      expect(toolPayload(defaultResponse).result.stdout).toEqual({
        cwd: await realpath(workspace),
        argv: ["setup", "--json", "--global-only", "--dry-run"],
      });

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "fclt_setup",
            arguments: {
              scope: "global_and_project",
              cwd: workspace,
              dryRun: false,
              installCodexPlugin: false,
              approve: true,
            },
          },
        })
      );
      const disabledResponse = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      expect(disabledResponse.result?.isError).toBe(false);
      expect(toolPayload(disabledResponse).result.stdout).toEqual({
        cwd: await realpath(workspace),
        argv: ["setup", "--json", "--no-codex-plugin"],
      });
      expect(toolPayload(disabledResponse).operation).toMatchObject({
        preview: false,
        risk: "reversible_mutation",
      });
      expect(toolPayload(disabledResponse).recovery).toMatchObject({
        rollbackAvailable: false,
        changedPaths: [],
      });

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "fclt_setup",
            arguments: { scope: "global", dryRun: false },
          },
        })
      );
      const unapproved = (await readFrame(child.stdout)) as {
        error?: { message?: string };
      };
      expect(unapproved.error?.message).toContain("requires approve=true");

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "fclt_init_operating_model",
            arguments: {
              scope: "project",
              dryRun: false,
              approve: true,
            },
          },
        })
      );
      const applyResponse = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      const apply = toolPayload(applyResponse);
      expect(apply.operation).toMatchObject({
        preview: false,
        risk: "high_risk_destructive",
      });
      expect(apply.recovery).toMatchObject({
        rollbackAvailable: false,
        changedPaths: [],
      });

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "fclt_setup",
            arguments: { scope: "global_and_project" },
          },
        })
      );
      const missingTarget = (await readFrame(child.stdout)) as {
        error?: { message?: string };
      };
      expect(missingTarget.error?.message).toContain("explicit cwd");
    } finally {
      child.kill();
    }
  });

  it("publishes typed full-service routers with closed argument schemas", async () => {
    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawn(
      process.execPath,
      [join(pluginRoot, "scripts", "fclt-mcp.cjs")],
      {
        cwd: pluginRoot,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    try {
      child.stdin.write(
        frame({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      );
      const response = (await readFrame(child.stdout)) as {
        result?: {
          tools?: {
            inputSchema?: { additionalProperties?: boolean };
            name?: string;
          }[];
        };
      };
      const published = response.result?.tools ?? [];
      const names = published.map((tool) => tool.name);

      expect(names).toContain("fclt_runtime");
      expect(names).toContain("fclt_capability");
      expect(names).toContain("fclt_workflow");
      expect(names).toContain("fclt_sync");
      expect(names).toContain("fclt_registry");
      expect(names).toContain("fclt_audit");
      expect(names).toContain("fclt_automation");
      expect(
        published.every(
          (tool) => tool.inputSchema?.additionalProperties === false
        )
      ).toBe(true);
      const workflow = published.find(
        (tool) => tool.name === "fclt_workflow"
      ) as
        | {
            inputSchema?: {
              properties?: { action?: { enum?: string[] } };
            };
          }
        | undefined;
      expect(workflow?.inputSchema?.properties?.action?.enum).not.toContain(
        "evolve_apply"
      );
      expect(workflow?.inputSchema?.properties?.action?.enum).not.toContain(
        "evolve_accept"
      );
    } finally {
      child.kill();
    }
  });

  it("routes typed capability and workflow operations without shell passthrough", async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-mcp-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "facult-mcp-workspace-"));
    const stub = join(home, "fclt-stub.cjs");
    await Bun.write(stub, compatibleStubScript());
    await chmod(stub, 0o755);
    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawn(
      process.execPath,
      [join(pluginRoot, "scripts", "fclt-mcp.cjs")],
      {
        cwd: pluginRoot,
        env: { ...process.env, FCLT_BIN: stub, HOME: home, PWD: workspace },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    try {
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "fclt_capability",
            arguments: {
              action: "graph",
              graphMode: "deps",
              selector: "skill:review",
            },
          },
        })
      );
      const capabilityResponse = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      const capability = toolPayload(capabilityResponse);
      expect(capability.result.stdout).toEqual({
        cwd: await realpath(workspace),
        argv: ["graph", "deps", "skill:review", "--json"],
      });

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "fclt_workflow",
            arguments: {
              action: "writeback_add",
              approve: true,
              scope: "project",
              kind: "capability_gap",
              summary: "Missing review context",
              evidence: ["session:runtime-router"],
            },
          },
        })
      );
      const workflowResponse = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      const workflow = toolPayload(workflowResponse);
      expect(workflow.result.stdout).toEqual({
        cwd: await realpath(workspace),
        argv: [
          "ai",
          "writeback",
          "--project",
          "add",
          "--kind",
          "capability_gap",
          "--summary",
          "Missing review context",
          "--evidence",
          "session:runtime-router",
        ],
      });
    } finally {
      child.kill();
    }
  });

  it("rejects unknown fields and unapproved workflow mutation before spawning fclt", async () => {
    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawn(
      process.execPath,
      [join(pluginRoot, "scripts", "fclt-mcp.cjs")],
      {
        cwd: pluginRoot,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    try {
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "fclt_capability",
            arguments: { action: "inventory", shell: "rm -rf /" },
          },
        })
      );
      const unknown = (await readFrame(child.stdout)) as {
        error?: { message?: string };
      };
      expect(unknown.error?.message).toContain("unknown argument fields");

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "fclt_workflow",
            arguments: {
              action: "writeback_add",
              scope: "project",
              kind: "capability_gap",
              summary: "Missing review context",
              evidence: ["session:unapproved"],
            },
          },
        })
      );
      const unapproved = (await readFrame(child.stdout)) as {
        error?: { message?: string };
      };
      expect(unapproved.error?.message).toContain("requires approve=true");
    } finally {
      child.kill();
    }
  });

  it("keeps legacy mutating tools preview-first and approval-gated", async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-mcp-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "facult-mcp-workspace-"));
    const stub = join(home, "fclt-stub.cjs");
    await Bun.write(stub, compatibleStubScript());
    await chmod(stub, 0o755);
    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawn(
      process.execPath,
      [join(pluginRoot, "scripts", "fclt-mcp.cjs")],
      {
        cwd: pluginRoot,
        env: { ...process.env, FCLT_BIN: stub, HOME: home, PWD: workspace },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    try {
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "fclt_init_operating_model",
            arguments: { scope: "project" },
          },
        })
      );
      const previewResponse = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      const preview = toolPayload(previewResponse);
      expect(preview.result.stdout).toEqual({
        cwd: await realpath(workspace),
        argv: [
          "templates",
          "init",
          "operating-model",
          "--project",
          "--dry-run",
          "--json",
        ],
      });

      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "fclt_init_operating_model",
            arguments: { scope: "project", dryRun: false },
          },
        })
      );
      const unapproved = (await readFrame(child.stdout)) as {
        error?: { message?: string };
      };
      expect(unapproved.error?.message).toContain("requires approve=true");
    } finally {
      child.kill();
    }
  });

  it("uses the caller workspace cwd instead of the plugin cwd when omitted", async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-mcp-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "facult-mcp-workspace-"));
    const stub = join(home, "fclt-stub.cjs");
    await Bun.write(stub, compatibleStubScript());
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
      const payload = toolPayload(response);

      expect(response.result?.isError).toBe(false);
      expect(payload.result.stdout).toEqual({
        cwd: expectedWorkspace,
        argv: ["status", "--json"],
      });
    } finally {
      child.kill();
    }
  });

  it("uses the inferred workspace cwd for project-scoped calls", async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-mcp-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "facult-mcp-workspace-"));
    const stub = join(home, "fclt-stub.cjs");
    await Bun.write(stub, compatibleStubScript());
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
            arguments: { scope: "project" },
          },
        })
      );
      const response = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      const expectedWorkspace = await realpath(workspace);
      const payload = toolPayload(response);

      expect(response.result?.isError).toBe(false);
      expect(payload.result.stdout).toEqual({
        cwd: expectedWorkspace,
        argv: ["status", "--project", "--json"],
      });
    } finally {
      child.kill();
    }
  });

  it("skips invalid inferred cwd values before choosing a workspace", async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-mcp-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "facult-mcp-workspace-"));
    const stub = join(home, "fclt-stub.cjs");
    await Bun.write(stub, compatibleStubScript());
    await chmod(stub, 0o755);

    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawn("node", [join(pluginRoot, "scripts", "fclt-mcp.cjs")], {
      cwd: pluginRoot,
      env: {
        ...process.env,
        FCLT_BIN: stub,
        HOME: home,
        FCLT_MCP_WORKSPACE_CWD: join(home, "deleted-workspace"),
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
      const payload = toolPayload(response);

      expect(response.result?.isError).toBe(false);
      expect(payload.result.stdout).toEqual({
        cwd: expectedWorkspace,
        argv: ["status", "--json"],
      });
    } finally {
      child.kill();
    }
  });

  it("rejects project-scoped calls without a usable workspace cwd", async () => {
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

  it("rejects home as an inferred project workspace cwd", async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-mcp-home-"));
    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawn("node", [join(pluginRoot, "scripts", "fclt-mcp.cjs")], {
      cwd: pluginRoot,
      env: {
        ...process.env,
        FCLT_BIN: "fclt",
        HOME: home,
        PWD: home,
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

  it("returns an MCP tool error when an explicit cwd cannot be spawned", async () => {
    const home = await mkdtemp(join(tmpdir(), "facult-mcp-home-"));
    const stub = join(home, "fclt-stub.cjs");
    await Bun.write(stub, compatibleStubScript());
    await chmod(stub, 0o755);

    const pluginRoot = facultBuiltinCodexPluginRoot();
    const child = spawn("node", [join(pluginRoot, "scripts", "fclt-mcp.cjs")], {
      cwd: pluginRoot,
      env: {
        ...process.env,
        FCLT_BIN: stub,
        HOME: home,
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
            arguments: { cwd: join(home, "missing-workspace") },
          },
        })
      );
      const response = (await readFrame(child.stdout)) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
      };
      const payload = toolPayload(response);

      expect(response.result?.isError).toBe(true);
      expect(payload.result.stderr).toContain("ENOENT");
    } finally {
      child.kill();
    }
  });
});

describe("Codex plugin capability matrix", () => {
  it("tracks the released setup contract and preserves the HACK-793 extension boundary", async () => {
    const repoRoot = join(import.meta.dir, "..");
    const packageJson = (await Bun.file(
      join(repoRoot, "package.json")
    ).json()) as {
      version: string;
    };
    const matrix = (await Bun.file(
      join(repoRoot, "docs", "codex-plugin-capability-matrix.json")
    ).json()) as {
      generatedFrom: { packageVersion: string };
      capabilities: {
        id: string;
        mcp: {
          disposition: string;
          plannedRouter?: string;
          tool?: string;
        };
        risk: string;
      }[];
    };
    const ids = matrix.capabilities.map((capability) => capability.id);
    const setup = matrix.capabilities.find(
      (capability) => capability.id === "setup.readiness"
    );
    const reconciliation = matrix.capabilities.find(
      (capability) => capability.id === "reconciliation.review"
    );

    expect(new Set(ids).size).toBe(ids.length);
    expect(matrix.generatedFrom.packageVersion).toBe(packageJson.version);
    expect(setup?.mcp).toMatchObject({
      disposition: "exposed",
      tool: "fclt_setup",
    });
    expect(reconciliation?.risk).toBe("review_producing");
    expect(reconciliation?.mcp).toMatchObject({
      disposition: "blocked_safer_api",
      plannedRouter: "fclt_registry",
    });
  });
});
