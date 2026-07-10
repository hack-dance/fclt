#!/usr/bin/env bun

import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: {
  command: string[];
  cwd: string;
  env?: Record<string, string>;
}): Promise<CommandResult> {
  const proc = Bun.spawn(args.command, {
    cwd: args.cwd,
    env: { ...process.env, ...args.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function assertSuccess(result: CommandResult, label: string): void {
  if (result.code !== 0) {
    throw new Error(
      `${label} failed (${result.code})\n${result.stdout}\n${result.stderr}`
    );
  }
}

async function main(): Promise<void> {
  const repoRoot = resolve(import.meta.dir, "..");
  const tempRoot = await mkdtemp(join(tmpdir(), "fclt-package-bootstrap-"));
  try {
    const packageDir = join(tempRoot, "package");
    const appDir = join(tempRoot, "app");
    const homeDir = join(tempRoot, "home");
    const sampleRepo = join(homeDir, "sample-repo");
    await Promise.all([
      mkdir(packageDir, { recursive: true }),
      mkdir(appDir, { recursive: true }),
      mkdir(sampleRepo, { recursive: true }),
    ]);

    let packageSpec = process.env.FCLT_PACKAGE_SPEC?.trim();
    if (!packageSpec) {
      const packed = await run({
        command: ["npm", "pack", "--silent", "--pack-destination", packageDir],
        cwd: repoRoot,
        env: { npm_config_cache: join(tempRoot, "npm-cache") },
      });
      assertSuccess(packed, "npm pack");
      const tarballs = (await readdir(packageDir)).filter((name) =>
        name.endsWith(".tgz")
      );
      if (tarballs.length !== 1) {
        throw new Error(
          `Expected one package tarball, found ${tarballs.length}`
        );
      }
      packageSpec = join(packageDir, tarballs[0] ?? "");
    }

    const installed = await run({
      command: ["bun", "add", "--cwd", appDir, packageSpec],
      cwd: repoRoot,
    });
    assertSuccess(installed, "package install");

    const gitInit = await run({
      command: ["git", "init", "--quiet"],
      cwd: sampleRepo,
    });
    assertSuccess(gitInit, "sample repo init");

    const launcher = join(appDir, "node_modules", ".bin", "fclt");
    const sourceEntry = join(
      appDir,
      "node_modules",
      "facult",
      "src",
      "index.ts"
    );
    const fcltCommand = process.env.FCLT_USE_LAUNCHER
      ? [launcher]
      : ["bun", "run", sourceEntry];
    const env = {
      HOME: homeDir,
      FACULT_LOCAL_STATE_DIR: join(homeDir, ".local-state"),
    };
    const setup = await run({
      command: [...fcltCommand, "setup", "--json", "--no-codex-plugin"],
      cwd: sampleRepo,
      env,
    });
    assertSuccess(setup, "isolated setup");
    const setupResult = JSON.parse(setup.stdout) as { health?: string };
    if (setupResult.health !== "ready") {
      throw new Error(`Expected ready setup, received ${setupResult.health}`);
    }

    const writeback = await run({
      command: [
        ...fcltCommand,
        "ai",
        "writeback",
        "add",
        "--kind",
        "weak_verification",
        "--summary",
        "Package bootstrap smoke signal.",
        "--asset",
        "skill:capability-evolution",
        "--evidence",
        "test:package-bootstrap",
        "--project",
      ],
      cwd: sampleRepo,
      env,
    });
    assertSuccess(writeback, "package writeback");

    const assessment = await run({
      command: [
        ...fcltCommand,
        "ai",
        "evolve",
        "assess",
        "--asset",
        "skill:capability-evolution",
        "--project",
        "--json",
      ],
      cwd: sampleRepo,
      env,
    });
    assertSuccess(assessment, "package evolution assessment");

    const pluginSetup = await run({
      command: [
        ...fcltCommand,
        "setup",
        "codex-plugin",
        "--json",
        "--no-codex-install",
      ],
      cwd: sampleRepo,
      env,
    });
    assertSuccess(pluginSetup, "package plugin setup");
    const pluginSelfTest = await run({
      command: [
        "node",
        join(homeDir, "plugins", "fclt", "scripts", "fclt-mcp.cjs"),
        "--self-test",
      ],
      cwd: sampleRepo,
      env: { ...env, FCLT_BIN: launcher },
    });
    assertSuccess(pluginSelfTest, "plugin MCP self-test");
    const tools = JSON.parse(pluginSelfTest.stdout) as { tools?: string[] };
    if (!tools.tools?.includes("fclt_setup")) {
      throw new Error("Plugin MCP self-test did not discover fclt_setup");
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          packageSpec,
          execution: process.env.FCLT_USE_LAUNCHER
            ? "published launcher"
            : "packed source entry",
          setup: setupResult.health,
          writeback: writeback.stdout.trim(),
          assessment: JSON.parse(assessment.stdout).recommendation,
          pluginTools: tools.tools,
          freshSessionDiscovery:
            "not proven by package smoke; requires a newly started Codex session",
        },
        null,
        2
      )
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
