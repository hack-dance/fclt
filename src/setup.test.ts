import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bootstrapFclt } from "./setup";

const cleanupPaths: string[] = [];
const cliEntry = join(import.meta.dir, "index.ts");

afterEach(async () => {
  for (const pathValue of cleanupPaths.splice(0)) {
    await rm(pathValue, { recursive: true, force: true });
  }
});

async function tempHome(prefix: string): Promise<string> {
  const pathValue = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(pathValue);
  return await realpath(pathValue);
}

async function initRepo(home: string): Promise<string> {
  const repo = join(home, "repo");
  await mkdir(repo, { recursive: true });
  const proc = Bun.spawn(["git", "init", "--quiet", repo], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(stderr);
  }
  return repo;
}

async function runCli(args: {
  home: string;
  cwd: string;
  argv: string[];
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", cliEntry, ...args.argv], {
    cwd: args.cwd,
    env: {
      ...process.env,
      HOME: args.home,
      FACULT_LOCAL_STATE_DIR: join(args.home, ".local-state"),
    },
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

describe("zero-config setup", () => {
  it("dry-runs a fresh isolated home without writing or failing", async () => {
    const home = await tempHome("fclt-setup-dry-");
    const repo = await initRepo(home);
    const result = await runCli({
      home,
      cwd: repo,
      argv: ["setup", "--dry-run", "--json", "--no-codex-plugin"],
    });
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { dryRun: boolean }).dryRun).toBe(
      true
    );
    expect(await Bun.file(join(home, ".ai")).exists()).toBe(false);
    expect(await Bun.file(join(repo, ".ai")).exists()).toBe(false);
  });

  it("bootstraps an isolated CLI-only home and project idempotently", async () => {
    const home = await tempHome("fclt-setup-cli-");
    const repo = await initRepo(home);

    const first = await runCli({
      home,
      cwd: repo,
      argv: ["setup", "--json", "--no-codex-plugin"],
    });
    expect(first.code).toBe(0);
    expect(first.stderr).toBe("");
    const result = JSON.parse(first.stdout) as {
      health: string;
      projectRoot: string;
      readiness: {
        global: {
          loop: { state: string; capabilities: Record<string, boolean> };
        };
        project: {
          loop: { state: string; capabilities: Record<string, boolean> };
        };
      };
    };
    expect(result.health).toBe("ready");
    expect(result.projectRoot).toBe(join(repo, ".ai"));
    expect(result.readiness.global.loop.state).toBe("ready");
    expect(result.readiness.project.loop.state).toBe("ready");
    expect(result.readiness.global.loop.capabilities.writebackSkill).toBe(true);
    expect(result.readiness.global.loop.capabilities.evolutionSkill).toBe(true);

    const add = await runCli({
      home,
      cwd: repo,
      argv: [
        "ai",
        "writeback",
        "add",
        "--kind",
        "reusable_pattern",
        "--summary",
        "Preserve this history across setup reruns.",
        "--asset",
        "skill:capability-evolution",
        "--evidence",
        "test:idempotent-setup",
        "--project",
      ],
    });
    expect(add.code).toBe(0);

    const second = await runCli({
      home,
      cwd: repo,
      argv: ["setup", "--json", "--no-codex-plugin"],
    });
    expect(second.code).toBe(0);
    expect((JSON.parse(second.stdout) as { health: string }).health).toBe(
      "ready"
    );
    const list = await runCli({
      home,
      cwd: repo,
      argv: ["ai", "writeback", "list", "--project", "--json"],
    });
    expect(list.stdout).toContain("Preserve this history");
  }, 20_000);

  it("does not bootstrap a nested project inside a git-backed global root", async () => {
    const home = await tempHome("fclt-setup-global-root-");
    const globalRoot = join(home, ".ai");
    await mkdir(globalRoot, { recursive: true });
    const proc = Bun.spawn(["git", "init", "--quiet", globalRoot], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");

    const result = await bootstrapFclt({
      homeDir: home,
      cwd: globalRoot,
      installCodexPlugin: false,
    });

    expect(result.projectRoot).toBeNull();
    expect(await Bun.file(join(globalRoot, ".ai")).exists()).toBe(false);
    expect(result.readiness.project).toBeNull();
  }, 20_000);

  it("records and assesses project writeback using only the documented bootstrap", async () => {
    const home = await tempHome("fclt-setup-loop-");
    const repo = await initRepo(home);
    expect(
      (
        await runCli({
          home,
          cwd: repo,
          argv: ["setup", "--json", "--no-codex-plugin"],
        })
      ).code
    ).toBe(0);

    const add = await runCli({
      home,
      cwd: repo,
      argv: [
        "ai",
        "writeback",
        "add",
        "--kind",
        "weak_verification",
        "--summary",
        "Bootstrap smoke found a reusable verification gap.",
        "--asset",
        "skill:capability-evolution",
        "--evidence",
        "test:isolated-home",
        "--project",
      ],
    });
    expect(add.code).toBe(0);
    expect(add.stdout).toContain("WB-00001");

    const assess = await runCli({
      home,
      cwd: repo,
      argv: [
        "ai",
        "evolve",
        "assess",
        "--asset",
        "skill:capability-evolution",
        "--project",
        "--json",
      ],
    });
    expect(assess.code).toBe(0);
    expect(
      (JSON.parse(assess.stdout) as { recommendation: string }).recommendation
    ).toBe("record_more_writeback");

    const reviewRoot = join(home, ".ai", "writebacks", "projects");
    const projectDirs = await readdir(reviewRoot);
    expect(projectDirs).toHaveLength(1);
    expect(
      await Bun.file(
        join(reviewRoot, projectDirs[0] ?? "", "WB-00001.md")
      ).exists()
    ).toBe(true);
  }, 20_000);

  it("uses the isolated HOME for Codex registration and reports fresh-session proof honestly", async () => {
    const home = await tempHome("fclt-setup-codex-");
    const repo = await initRepo(home);
    const codexBin = join(home, "bin", "codex");
    await mkdir(dirname(codexBin), { recursive: true });
    await Bun.write(
      codexBin,
      `#!/bin/sh
set -eu
mkdir -p "$HOME/.codex"
printf '[plugins."fclt@hack-local"]\nenabled = true\n' > "$HOME/.codex/config.toml"
printf '{"ok":true}\n'
`
    );
    await chmod(codexBin, 0o755);

    const result = await bootstrapFclt({
      homeDir: home,
      cwd: repo,
      codexBin,
    });
    expect(result.health).toBe("degraded");
    expect(result.codexPlugin?.codexInstall.status).toBe("succeeded");
    expect(result.readiness.global.loop.integrations.codex.state).toBe(
      "registered_unverified"
    );
    expect(
      result.readiness.global.loop.integrations.codex.freshSessionDiscovery
    ).toBe("requires_fresh_session");
    expect(await Bun.file(join(home, ".codex", "config.toml")).exists()).toBe(
      true
    );
  }, 20_000);

  it("prepares the Codex plugin without a Codex binary when installation is disabled", async () => {
    const home = await tempHome("fclt-setup-codex-payload-");
    const repo = await initRepo(home);

    const result = await bootstrapFclt({
      homeDir: home,
      cwd: repo,
      codexBin: null,
      installInCodex: false,
    });

    expect(result.codexPlugin?.codexInstall).toEqual({
      status: "skipped",
      reason: "codex plugin install disabled by --no-codex-install",
    });
    expect(
      await Bun.file(
        join(
          result.codexPlugin?.pluginDir ?? "",
          ".codex-plugin",
          "plugin.json"
        )
      ).exists()
    ).toBe(true);
    expect(
      await Bun.file(result.codexPlugin?.marketplacePath ?? "").exists()
    ).toBe(true);
  }, 20_000);
});
