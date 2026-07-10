#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FCLT_BIN = process.env.FCLT_BIN || "fclt";
const DEFAULT_TIMEOUT_MS = Number(process.env.FCLT_MCP_TIMEOUT_MS || 60_000);
const CONTENT_LENGTH_RE = /Content-Length:\s*(\d+)/i;
const PLUGIN_ROOT = path.resolve(__dirname, "..");

const tools = [
  {
    name: "fclt_setup",
    description:
      "Bootstrap or repair the complete fclt writeback/evolution loop and return readiness JSON.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        globalOnly: { type: "boolean" },
        dryRun: { type: "boolean" },
        installCodexPlugin: { type: "boolean" },
      },
    },
  },
  {
    name: "fclt_status",
    description:
      "Return fclt status for the current, global, or project scope.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["auto", "global", "project"] },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "fclt_doctor",
    description: "Run read-only fclt doctor checks and return JSON output.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["auto", "global", "project"] },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "fclt_paths",
    description: "Return canonical, generated, review, and runtime fclt paths.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["auto", "global", "project"] },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "fclt_init_operating_model",
    description: "Install or update the built-in operating-model pack.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["global", "project"] },
        cwd: { type: "string" },
        update: { type: "boolean" },
        dryRun: { type: "boolean" },
        force: { type: "boolean" },
      },
      required: ["scope"],
    },
  },
  {
    name: "fclt_writeback_add",
    description: "Record a durable fclt writeback with evidence.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["auto", "global", "project"] },
        cwd: { type: "string" },
        kind: { type: "string" },
        summary: { type: "string" },
        asset: { type: "string" },
        evidence: { type: "string" },
        confidence: {
          type: "string",
          enum: ["low", "medium", "high"],
        },
      },
      required: ["kind", "summary"],
    },
  },
  {
    name: "fclt_writeback_review",
    description: "List, group, or summarize current fclt writebacks.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["auto", "global", "project"] },
        cwd: { type: "string" },
        mode: { type: "string", enum: ["list", "group", "summarize"] },
        by: { type: "string" },
      },
    },
  },
  {
    name: "fclt_evolve",
    description:
      "Assess, list, propose, draft, or review fclt evolution proposals.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["auto", "global", "project"] },
        cwd: { type: "string" },
        action: {
          type: "string",
          enum: ["assess", "list", "propose", "draft", "review", "show"],
        },
        id: { type: "string" },
        asset: { type: "string" },
      },
    },
  },
];

function scopeArgs(scope) {
  if (scope === "global") {
    return ["--global"];
  }
  if (scope === "project") {
    return ["--project"];
  }
  return [];
}

function boolFlag(name, value) {
  return value ? [name] : [];
}

function stringFlag(name, value) {
  return typeof value === "string" && value.trim() ? [name, value] : [];
}

function isSubpath(child, parent) {
  const relative = path.relative(parent, child);
  return (
    relative === "" || !(relative.startsWith("..") || path.isAbsolute(relative))
  );
}

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function resolveWorkspaceCwd({ allowHomeFallback = true } = {}) {
  const candidates = [
    process.env.FCLT_MCP_WORKSPACE_CWD,
    process.env.INIT_CWD,
    process.env.PWD,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) {
      continue;
    }
    const resolved = path.resolve(candidate);
    const isHome = resolved === path.resolve(os.homedir());
    if (
      (allowHomeFallback || !isHome) &&
      !isSubpath(resolved, PLUGIN_ROOT) &&
      isDirectory(resolved)
    ) {
      return resolved;
    }
  }
  if (allowHomeFallback && isDirectory(os.homedir())) {
    return os.homedir();
  }
  return undefined;
}

function resolveToolCwd(name, args = {}) {
  if (typeof args.cwd === "string" && args.cwd.trim()) {
    return args.cwd;
  }
  const inferred = resolveWorkspaceCwd({
    allowHomeFallback: args.scope !== "project",
  });
  if (inferred) {
    return inferred;
  }
  if (args.scope === "project") {
    throw new Error(
      `${name} with project scope requires a cwd for the target workspace`
    );
  }
  return process.cwd();
}

function commandForTool(name, args = {}) {
  switch (name) {
    case "fclt_setup":
      return [
        "setup",
        "--json",
        ...boolFlag("--global-only", args.globalOnly),
        ...boolFlag("--dry-run", args.dryRun),
        ...(args.installCodexPlugin === false ? ["--no-codex-plugin"] : []),
      ];
    case "fclt_status":
      return ["status", ...scopeArgs(args.scope), "--json"];
    case "fclt_doctor":
      return ["doctor", ...scopeArgs(args.scope), "--json"];
    case "fclt_paths":
      return ["paths", ...scopeArgs(args.scope), "--json"];
    case "fclt_init_operating_model":
      return [
        "templates",
        "init",
        "operating-model",
        ...scopeArgs(args.scope),
        ...boolFlag("--update", args.update),
        ...boolFlag("--dry-run", args.dryRun),
        ...boolFlag("--force", args.force),
        "--json",
      ];
    case "fclt_writeback_add":
      return [
        "ai",
        "writeback",
        ...scopeArgs(args.scope),
        "add",
        "--kind",
        args.kind,
        "--summary",
        args.summary,
        ...stringFlag("--asset", args.asset),
        ...stringFlag("--evidence", args.evidence),
        ...stringFlag("--confidence", args.confidence),
      ];
    case "fclt_writeback_review": {
      const mode = args.mode || "list";
      return [
        "ai",
        "writeback",
        ...scopeArgs(args.scope),
        mode,
        ...stringFlag("--by", args.by),
      ];
    }
    case "fclt_evolve": {
      const action = args.action || "list";
      return [
        "ai",
        "evolve",
        ...scopeArgs(args.scope),
        action,
        ...(action === "assess" || action === "propose"
          ? stringFlag("--asset", args.asset)
          : []),
        ...(args.id ? [args.id] : []),
        ...(action === "assess" ? ["--json"] : []),
      ];
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function runFclt(args, cwd) {
  return new Promise((resolve) => {
    const commandText = `$ ${FCLT_BIN} ${args.join(" ")}`;
    let child;
    try {
      child = spawn(FCLT_BIN, args, {
        cwd: cwd || process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        code: 1,
        text: [commandText, `stderr:\n${error.message}`].join("\n\n"),
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, DEFAULT_TIMEOUT_MS);
    const finish = (code, extraError) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const stderrText = [stderr.trim(), extraError].filter(Boolean).join("\n");
      resolve({
        code,
        text: [
          commandText,
          stdout.trim(),
          stderrText ? `stderr:\n${stderrText}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish(1, error.message);
    });
    child.on("close", (code) => {
      finish(code);
    });
  });
}

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
}

async function handle(message) {
  if (!message || message.id == null) {
    return;
  }

  try {
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fclt", version: "0.1.0" },
        },
      });
      return;
    }
    if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools } });
      return;
    }
    if (message.method === "tools/call") {
      const { name, arguments: args = {} } = message.params || {};
      const command = commandForTool(name, args);
      const result = await runFclt(command, resolveToolCwd(name, args));
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          isError: result.code !== 0,
          content: [{ type: "text", text: result.text }],
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32_601, message: `Method not found: ${message.method}` },
    });
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32_000,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = CONTENT_LENGTH_RE.exec(header);
    if (!match) {
      buffer = Buffer.alloc(0);
      return;
    }
    const length = Number(match[1]);
    const frameEnd = headerEnd + 4 + length;
    if (buffer.length < frameEnd) {
      return;
    }
    const body = buffer.slice(headerEnd + 4, frameEnd).toString("utf8");
    buffer = buffer.slice(frameEnd);
    handle(JSON.parse(body)).catch((error) => {
      send({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32_000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
  }
});

if (process.argv.includes("--self-test")) {
  console.log(
    JSON.stringify({ tools: tools.map((tool) => tool.name) }, null, 2)
  );
  process.exit(0);
}
