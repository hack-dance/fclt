import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scan } from "./scan";

function fixturePath(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "test", "fixtures", rel);
}

test("scan includeConfigFrom reads scanFrom roots from ~/.ai/.facult/config.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-scan-"));
  const home = join(dir, "home");
  const projects = join(home, "projects");
  const repo = join(projects, "repo1");

  await mkdir(join(repo, ".git"), { recursive: true });
  await Bun.write(join(repo, "AGENTS.md"), "Hello\n");
  await Bun.write(join(repo, "CLAUDE.md"), "Claude\n");
  await Bun.write(join(repo, ".cursorrules"), "Rules\n");

  const cfgDir = join(home, ".ai", ".facult");
  await mkdir(cfgDir, { recursive: true });
  await Bun.write(
    join(cfgDir, "config.json"),
    JSON.stringify({ scanFrom: ["~/projects"] }, null, 2)
  );

  const res = await scan([], {
    cwd: dir,
    homeDir: home,
    includeConfigFrom: true,
  });

  const allAssets = res.sources.flatMap((s) => s.assets.files);
  expect(
    allAssets.some(
      (a) =>
        a.kind === "agents-instructions" && a.path === join(repo, "AGENTS.md")
    )
  ).toBe(true);
  expect(
    allAssets.some(
      (a) =>
        a.kind === "claude-instructions" && a.path === join(repo, "CLAUDE.md")
    )
  ).toBe(true);
  expect(
    allAssets.some(
      (a) =>
        a.kind === "cursor-rules-file" && a.path === join(repo, ".cursorrules")
    )
  ).toBe(true);
});

test("scan does not read scanFrom roots when includeConfigFrom is false", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-scan-"));
  const home = join(dir, "home");
  const projects = join(home, "projects");
  const repo = join(projects, "repo1");

  await mkdir(join(repo, ".git"), { recursive: true });
  await Bun.write(join(repo, "AGENTS.md"), "Hello\n");

  const cfgDir = join(home, ".ai", ".facult");
  await mkdir(cfgDir, { recursive: true });
  await Bun.write(
    join(cfgDir, "config.json"),
    JSON.stringify({ scanFrom: ["~/projects"] }, null, 2)
  );

  const res = await scan([], {
    cwd: dir,
    homeDir: home,
    includeConfigFrom: false,
  });

  const allAssets = res.sources.flatMap((s) => s.assets.files);
  expect(allAssets.some((a) => a.path === join(repo, "AGENTS.md"))).toBe(false);
});

test("scan --from detects git hooks when .git is a file (git worktree)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-scan-"));
  const home = join(dir, "home");

  const repo = join(dir, "repo1");
  const gitDir = join(dir, "repo1.gitdir");
  await mkdir(join(gitDir, "hooks"), { recursive: true });
  await Bun.write(join(gitDir, "hooks", "pre-commit"), "#!/bin/sh\necho ok\n");

  await mkdir(repo, { recursive: true });
  // Worktree-style .git file pointing to the actual gitdir.
  await Bun.write(join(repo, ".git"), "gitdir: ../repo1.gitdir\n");

  const res = await scan([], {
    cwd: dir,
    homeDir: home,
    includeConfigFrom: false,
    includeGitHooks: true,
    from: [dir],
  });

  const fromSource = res.sources.find((s) => s.id === "from-1");
  expect(fromSource).toBeTruthy();

  const hooks = fromSource?.assets.files.filter((f) => f.kind === "git-hook");
  expect(
    hooks?.some((h) => h.path === join(gitDir, "hooks", "pre-commit"))
  ).toBe(true);
});

test("scan --from detects instruction files inside known tool dot-dirs (e.g. .codex/AGENTS.md)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-scan-"));
  const home = join(dir, "home");

  const toolDir = join(dir, ".codex");
  await mkdir(toolDir, { recursive: true });
  await Bun.write(join(toolDir, "AGENTS.md"), "hello\n");

  const res = await scan([], {
    cwd: dir,
    homeDir: home,
    includeConfigFrom: false,
    from: [dir],
  });

  const allAssets = res.sources.flatMap((s) => s.assets.files);
  expect(
    allAssets.some(
      (a) =>
        a.kind === "agents-instructions" &&
        a.path === join(toolDir, "AGENTS.md")
    )
  ).toBe(true);
});

test("scan --from detects Factory tool surfaces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-scan-"));
  const home = join(dir, "home");

  const toolDir = join(dir, ".factory");
  await mkdir(join(toolDir, "skills", "alpha"), { recursive: true });
  await Bun.write(join(toolDir, "AGENTS.md"), "factory override\n");
  await Bun.write(
    join(toolDir, "mcp.json"),
    '{"mcpServers":{"alpha":{"url":"https://example.com/mcp","type":"http"}}}\n'
  );
  await Bun.write(join(toolDir, "skills", "alpha", "SKILL.md"), "# Alpha\n");

  const res = await scan([], {
    cwd: dir,
    homeDir: home,
    includeConfigFrom: false,
    from: [dir],
  });

  const allAssets = res.sources.flatMap((s) => s.assets.files);
  expect(
    allAssets.some(
      (a) =>
        a.kind === "agents-instructions" &&
        a.path === join(toolDir, "AGENTS.md")
    )
  ).toBe(true);

  const allSkillPaths = res.sources.flatMap((s) => s.skills.entries ?? []);
  expect(allSkillPaths).toContain(join(toolDir, "skills", "alpha"));

  const allMcpPaths = res.sources.flatMap((s) =>
    s.mcp.configs.map((cfg) => cfg.path)
  );
  expect(allMcpPaths).toContain(join(toolDir, "mcp.json"));
});

test("scan --from discovers per-project .vscode/settings.json MCP servers (JSONC)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-scan-"));
  const home = join(dir, "home");

  const repo = join(dir, "repo1");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(repo, ".vscode"), { recursive: true });
  await Bun.write(
    join(repo, ".vscode", "settings.json"),
    `{\n  // comment\n  "cursor.mcpServers": {\n    "local": { "command": "node", "args": ["server.js"] },\n  }\n}\n`
  );

  const res = await scan([], {
    cwd: dir,
    homeDir: home,
    includeConfigFrom: false,
    from: [dir],
  });

  const fromSource = res.sources.find((s) => s.id === "from-1");
  expect(fromSource).toBeTruthy();

  const cfg = fromSource?.mcp.configs.find(
    (c) => c.path === join(repo, ".vscode", "settings.json")
  );
  expect(cfg).toBeTruthy();
  expect(cfg?.servers).toEqual(["local"]);
});

test("scan summarizes Claude settings hooks + permissions (fixture)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-scan-"));
  const home = join(dir, "home");

  const settingsPath = join(home, ".claude", "settings.json");
  await mkdir(join(home, ".claude"), { recursive: true });
  await Bun.write(
    settingsPath,
    await Bun.file(fixturePath("claude/settings.json")).text()
  );

  const res = await scan([], {
    cwd: dir,
    homeDir: home,
    includeConfigFrom: false,
    from: [],
  });

  const claude = res.sources.find((s) => s.id === "claude");
  expect(claude).toBeTruthy();

  const asset = claude?.assets.files.find(
    (f) => f.kind === "claude-settings" && f.path === settingsPath
  );
  expect(asset).toBeTruthy();
  expect(asset?.summary?.hookEvents).toEqual(["postToolUse", "preToolUse"]);
  expect(
    (asset?.summary?.hookCommands as unknown[]).some((c) =>
      String(c).includes("<redacted>")
    )
  ).toBe(true);
  expect(
    (asset?.summary?.hookCommands as unknown[]).some((c) =>
      String(c).includes("sk-")
    )
  ).toBe(false);
  expect(asset?.summary?.hookTypes).toEqual(["command"]);
  expect(asset?.summary?.permissionsAllowCount).toBe(2);
});

test("scan summarizes Cursor project hooks.json (fixture)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-scan-"));
  const home = join(dir, "home");

  const hooksPath = join(dir, ".cursor", "hooks.json");
  await mkdir(join(dir, ".cursor"), { recursive: true });
  await Bun.write(
    hooksPath,
    await Bun.file(fixturePath("cursor/hooks.json")).text()
  );

  const res = await scan([], {
    cwd: dir,
    homeDir: home,
    includeConfigFrom: false,
    from: [],
  });

  const cursorProject = res.sources.find((s) => s.id === "cursor-project");
  expect(cursorProject).toBeTruthy();

  const asset = cursorProject?.assets.files.find(
    (f) => f.kind === "cursor-hook" && f.path === hooksPath
  );
  expect(asset).toBeTruthy();
  expect(asset?.summary?.hookEvents).toEqual(["postCommit", "preCommit"]);
  expect(
    (asset?.summary?.hookCommands as unknown[]).some((c) =>
      String(c).includes("<redacted>")
    )
  ).toBe(true);
  expect(
    (asset?.summary?.hookCommands as unknown[]).some((c) =>
      String(c).includes("github_pat_")
    )
  ).toBe(false);
});

test("default scan records MCP config parse errors for invalid JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-scan-"));
  const home = join(dir, "home");

  const mcpPath = join(home, ".cursor", "mcp.json");
  await mkdir(join(home, ".cursor"), { recursive: true });
  await Bun.write(
    mcpPath,
    await Bun.file(fixturePath("json/invalid.json")).text()
  );

  const res = await scan([], {
    cwd: dir,
    homeDir: home,
    includeConfigFrom: false,
    from: [],
  });

  const cursor = res.sources.find((s) => s.id === "cursor");
  expect(cursor).toBeTruthy();

  const cfg = cursor?.mcp.configs.find((c) => c.path === mcpPath);
  expect(cfg).toBeTruthy();
  expect(cfg?.error && cfg.error.length > 0).toBe(true);
});

test("scan --from sets truncated + warnings when exceeding maxResults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-scan-"));
  const home = join(dir, "home");

  const root = join(dir, "root");
  for (let i = 0; i < 10; i += 1) {
    const p = join(root, `proj-${i}`);
    await mkdir(p, { recursive: true });
    await Bun.write(join(p, "SKILL.md"), `skill ${i}\n`);
  }

  const res = await scan([], {
    cwd: dir,
    homeDir: home,
    includeConfigFrom: false,
    from: [root],
    fromOptions: {
      ignoreDirNames: [],
      maxVisits: 1000,
      maxResults: 3,
    },
  });

  const fromSource = res.sources.find((s) => s.id === "from-1");
  expect(fromSource).toBeTruthy();
  expect(fromSource?.truncated).toBe(true);
  expect(
    (fromSource?.warnings ?? []).some((w) =>
      w.includes("exceeded maxResults=3")
    )
  ).toBe(true);
});

test("scan --from sets truncated + warnings when exceeding maxVisits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-scan-"));
  const home = join(dir, "home");

  const root = join(dir, "root");
  await mkdir(join(root, "child"), { recursive: true });
  await Bun.write(join(root, "child", "SKILL.md"), "x\n");

  const res = await scan([], {
    cwd: dir,
    homeDir: home,
    includeConfigFrom: false,
    from: [root],
    fromOptions: {
      ignoreDirNames: [],
      maxVisits: 1,
      maxResults: 1000,
    },
  });

  const fromSource = res.sources.find((s) => s.id === "from-1");
  expect(fromSource).toBeTruthy();
  expect(fromSource?.truncated).toBe(true);
  expect(
    (fromSource?.warnings ?? []).some((w) => w.includes("exceeded maxVisits=1"))
  ).toBe(true);
});

test("scan --from respects ignoreDirNames", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-scan-"));
  const home = join(dir, "home");

  const root = join(dir, "root");
  await mkdir(join(root, "vendor"), { recursive: true });
  await Bun.write(join(root, "vendor", "SKILL.md"), "ignored\n");

  await mkdir(join(root, "keep"), { recursive: true });
  await Bun.write(join(root, "keep", "SKILL.md"), "kept\n");

  const res = await scan([], {
    cwd: dir,
    homeDir: home,
    includeConfigFrom: false,
    from: [root],
    fromOptions: {
      ignoreDirNames: ["vendor"],
      maxVisits: 1000,
      maxResults: 1000,
    },
  });

  const fromSource = res.sources.find((s) => s.id === "from-1");
  expect(fromSource).toBeTruthy();

  const entries = fromSource?.skills.entries ?? [];
  expect(entries.some((p) => p.includes(`${join("root", "vendor")}`))).toBe(
    false
  );
  expect(entries.some((p) => p.includes(`${join("root", "keep")}`))).toBe(true);
});

test("scan --from handles unreadable directories gracefully", async () => {
  if (process.platform === "win32") {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), "facult-scan-"));
  const home = join(dir, "home");

  const root = join(dir, "root");
  const ok = join(root, "ok");
  const unreadable = join(root, "unreadable");
  await mkdir(ok, { recursive: true });
  await Bun.write(join(ok, "AGENTS.md"), "hello\n");

  await mkdir(unreadable, { recursive: true });
  await Bun.write(join(unreadable, "SKILL.md"), "nope\n");

  await chmod(unreadable, 0o000);
  try {
    const res = await scan([], {
      cwd: dir,
      homeDir: home,
      includeConfigFrom: false,
      from: [root],
      fromOptions: {
        ignoreDirNames: [],
        maxVisits: 1000,
        maxResults: 1000,
      },
    });

    const allAssets = res.sources.flatMap((s) => s.assets.files);
    expect(allAssets.some((a) => a.path === join(ok, "AGENTS.md"))).toBe(true);
  } finally {
    // Restore permissions so the temp dir can be cleaned up.
    await chmod(unreadable, 0o700).catch(() => undefined);
  }
});

test("scan --from ignores *_node_modules trees (docker volumes) by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-scan-"));
  const home = join(dir, "home");

  const root = join(dir, "root");
  const vol = join(
    root,
    "event-agent_node_modules",
    "react-dropzone",
    ".husky"
  );
  await mkdir(vol, { recursive: true });
  const hook = join(vol, "pre-commit");
  await Bun.write(hook, "#!/bin/sh\necho nope\n");

  const res = await scan([], {
    cwd: dir,
    homeDir: home,
    includeConfigFrom: false,
    from: [root],
  });

  const fromSource = res.sources.find((s) => s.id === "from-1");
  expect(fromSource).toBeTruthy();
  const husky = (fromSource?.assets.files ?? []).filter(
    (f) => f.kind === "husky"
  );
  expect(husky.length).toBe(0);
});

test("default scan discovers Windows-style VS Code settings.json MCP servers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-scan-"));
  const home = join(dir, "home");

  const settingsDir = join(home, "AppData", "Roaming", "Code", "User");
  await mkdir(settingsDir, { recursive: true });
  const settingsPath = join(settingsDir, "settings.json");
  await Bun.write(
    settingsPath,
    `{\n  "mcpServers": {\n    "filesystem": { "command": "node", "args": ["server.js"] }\n  }\n}\n`
  );

  const res = await scan([], {
    cwd: dir,
    homeDir: home,
    includeConfigFrom: false,
    from: [],
  });

  const vscode = res.sources.find((s) => s.id === "vscode");
  expect(vscode).toBeTruthy();

  const cfg = vscode?.mcp.configs.find((c) => c.path === settingsPath);
  expect(cfg).toBeTruthy();
  expect(cfg?.servers).toEqual(["filesystem"]);
});

test("default scan discovers Windows-style Cursor settings.json MCP servers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-scan-"));
  const home = join(dir, "home");

  const settingsDir = join(home, "AppData", "Roaming", "Cursor", "User");
  await mkdir(settingsDir, { recursive: true });
  const settingsPath = join(settingsDir, "settings.json");
  await Bun.write(
    settingsPath,
    `{\n  "cursor.mcpServers": {\n    "local": { "command": "node", "args": ["server.js"] }\n  }\n}\n`
  );

  const res = await scan([], {
    cwd: dir,
    homeDir: home,
    includeConfigFrom: false,
    from: [],
  });

  const cursor = res.sources.find((s) => s.id === "cursor");
  expect(cursor).toBeTruthy();

  const cfg = cursor?.mcp.configs.find((c) => c.path === settingsPath);
  expect(cfg).toBeTruthy();
  expect(cfg?.servers).toEqual(["local"]);
});
