import { watch as fsWatch } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseCliContextArgs, resolveCliContextRoot } from "./cli-context";
import { syncManagedTools } from "./manage";
import {
  facultMachineStateDir,
  facultRootDir,
  facultStateDir,
  legacyFacultStateDirForRoot,
  projectRootFromAiRoot,
} from "./paths";

const AUTOSYNC_VERSION = 1 as const;
const DEFAULT_DEBOUNCE_MS = 1500;
const DEFAULT_GIT_INTERVAL_MINUTES = 60;

export interface AutosyncGitConfig {
  enabled: boolean;
  remote: string;
  branch: string;
  intervalMinutes: number;
  autoCommit: boolean;
  commitPrefix: string;
  source: string;
}

export interface AutosyncServiceConfig {
  version: 1;
  name: string;
  tool?: string;
  rootDir: string;
  debounceMs: number;
  git: AutosyncGitConfig;
}

export interface AutosyncRuntimeState {
  version: 1;
  service: string;
  label: string;
  tool?: string;
  dirty: boolean;
  rootDir: string;
  lastEventAt?: string;
  lastLocalSyncAt?: string;
  lastGitSyncAt?: string;
  lastError?: string;
  remoteBlocked?: boolean;
  remoteBlockReason?: string;
}

export interface LaunchAgentSpec {
  label: string;
  plistPath: string;
  stdoutPath: string;
  stderrPath: string;
  programArguments: string[];
  workingDirectory?: string;
}

export interface AutosyncStatus {
  config: AutosyncServiceConfig | null;
  state: AutosyncRuntimeState | null;
  plistPath: string;
  plistExists: boolean;
  loaded: boolean;
  launchctlSummary?: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RunnerOptions {
  homeDir?: string;
  once?: boolean;
}

interface GitSyncOutcome {
  changed: boolean;
  blocked: boolean;
  message?: string;
}

let launchctlRunnerForTests:
  | ((args: string[]) => Promise<CommandResult>)
  | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function logAutosyncError(context: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`fclt autosync: ${context}: ${detail}`);
}

function runDetached(context: string, promise: Promise<void>) {
  promise.catch((error) => {
    logAutosyncError(context, error);
  });
}

function autosyncDir(home: string, rootDir?: string): string {
  return join(facultMachineStateDir(home, rootDir), "autosync");
}

function canonicalAutosyncDir(home: string, rootDir?: string): string {
  return join(facultStateDir(home, rootDir), "autosync");
}

function legacyAutosyncDir(home: string, rootDir?: string): string {
  const resolvedRoot = rootDir ?? facultRootDir(home);
  return join(legacyFacultStateDirForRoot(resolvedRoot, home), "autosync");
}

function autosyncServicesDir(home: string, rootDir?: string): string {
  return join(autosyncDir(home, rootDir), "services");
}

function legacyAutosyncServicesDir(home: string, rootDir?: string): string {
  return join(legacyAutosyncDir(home, rootDir), "services");
}

function autosyncStateDir(home: string, rootDir?: string): string {
  return join(autosyncDir(home, rootDir), "state");
}

function legacyAutosyncStateDir(home: string, rootDir?: string): string {
  return join(legacyAutosyncDir(home, rootDir), "state");
}

function autosyncLogsDir(home: string, rootDir?: string): string {
  return join(autosyncDir(home, rootDir), "logs");
}

function serviceSuffix(
  rootDir: string | undefined,
  home: string
): string | null {
  if (!rootDir) {
    return null;
  }
  const projectRoot = projectRootFromAiRoot(rootDir, home);
  if (!projectRoot) {
    return null;
  }
  const base = basename(projectRoot).trim().toLowerCase();
  const slug = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "project";
}

function autosyncServiceName(
  tool?: string,
  rootDir?: string,
  home: string = homedir()
): string {
  const base = tool?.trim() ? tool.trim() : "all";
  const suffix = serviceSuffix(rootDir, home);
  return suffix ? `${base}-${suffix}` : base;
}

function autosyncLabel(serviceName: string): string {
  return serviceName === "all"
    ? "com.fclt.autosync"
    : `com.fclt.autosync.${serviceName}`;
}

function legacyAutosyncLabel(serviceName: string): string {
  return serviceName === "all"
    ? "com.facult.autosync"
    : `com.facult.autosync.${serviceName}`;
}

function autosyncLabelCandidates(serviceName: string): string[] {
  return [autosyncLabel(serviceName), legacyAutosyncLabel(serviceName)];
}

function autosyncPlistPath(home: string, serviceName: string): string {
  return join(
    home,
    "Library",
    "LaunchAgents",
    `${autosyncLabel(serviceName)}.plist`
  );
}

function autosyncConfigPath(
  home: string,
  serviceName: string,
  rootDir?: string
): string {
  return join(autosyncServicesDir(home, rootDir), `${serviceName}.json`);
}

function legacyAutosyncConfigPath(
  home: string,
  serviceName: string,
  rootDir?: string
): string {
  return join(legacyAutosyncServicesDir(home, rootDir), `${serviceName}.json`);
}

function autosyncRuntimeStatePath(
  home: string,
  serviceName: string,
  rootDir?: string
): string {
  return join(autosyncStateDir(home, rootDir), `${serviceName}.json`);
}

function legacyAutosyncRuntimeStatePath(
  home: string,
  serviceName: string,
  rootDir?: string
): string {
  return join(legacyAutosyncStateDir(home, rootDir), `${serviceName}.json`);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function plistArray(values: string[]): string {
  return values
    .map((value) => `    <string>${escapeXml(value)}</string>`)
    .join("\n");
}

export function resolveAutosyncInvocation(
  argv: string[] = process.argv
): string[] {
  const exec = process.execPath;
  const script = argv[1];

  if (script?.endsWith(".ts")) {
    return [exec, "run", script];
  }

  if (
    basename(exec).startsWith("facult") ||
    basename(exec).startsWith("fclt")
  ) {
    return [exec];
  }

  if (script) {
    return [exec, script];
  }

  return [exec];
}

export function buildLaunchAgentSpec(args: {
  homeDir: string;
  serviceName: string;
  rootDir: string;
  invocation?: string[];
}): LaunchAgentSpec {
  const { homeDir, rootDir, serviceName } = args;
  const label = autosyncLabel(serviceName);
  const invocation = args.invocation ?? resolveAutosyncInvocation();
  const logsDir = autosyncLogsDir(homeDir, rootDir);

  return {
    label,
    plistPath: autosyncPlistPath(homeDir, serviceName),
    stdoutPath: join(logsDir, `${serviceName}.log`),
    stderrPath: join(logsDir, `${serviceName}.err.log`),
    programArguments: [
      ...invocation,
      "autosync",
      "run",
      ...(serviceName === "all" ? [] : [serviceName]),
      "--service",
      serviceName,
    ],
    workingDirectory: rootDir,
  };
}

export function buildLaunchAgentPlist(spec: LaunchAgentSpec): string {
  const workingDirectory = spec.workingDirectory
    ? `  <key>WorkingDirectory</key>\n  <string>${escapeXml(spec.workingDirectory)}</string>\n`
    : "";

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(spec.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    plistArray(spec.programArguments),
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    workingDirectory.trimEnd(),
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(spec.stdoutPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(spec.stderrPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await Bun.file(pathValue).stat();
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(pathValue: string): Promise<T | null> {
  try {
    const text = await readFile(pathValue, "utf8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(pathValue: string, data: unknown): Promise<void> {
  await mkdir(dirname(pathValue), { recursive: true });
  await writeFile(pathValue, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function loadAutosyncConfig(
  serviceName: string,
  homeDir: string = homedir(),
  rootDir?: string
): Promise<AutosyncServiceConfig | null> {
  const candidates = [
    autosyncConfigPath(homeDir, serviceName, rootDir),
    join(
      canonicalAutosyncDir(homeDir, rootDir),
      "services",
      `${serviceName}.json`
    ),
    legacyAutosyncConfigPath(homeDir, serviceName, rootDir),
  ];
  for (const candidate of candidates) {
    const config = await readJsonFile<AutosyncServiceConfig>(candidate);
    if (config) {
      return config;
    }
  }
  return null;
}

async function saveAutosyncConfig(
  config: AutosyncServiceConfig,
  homeDir: string
): Promise<void> {
  await writeJsonFile(
    autosyncConfigPath(homeDir, config.name, config.rootDir),
    config
  );
}

export async function loadAutosyncRuntimeState(
  serviceName: string,
  homeDir: string = homedir(),
  rootDir?: string
): Promise<AutosyncRuntimeState | null> {
  const candidates = [
    autosyncRuntimeStatePath(homeDir, serviceName, rootDir),
    join(
      canonicalAutosyncDir(homeDir, rootDir),
      "state",
      `${serviceName}.json`
    ),
    legacyAutosyncRuntimeStatePath(homeDir, serviceName, rootDir),
  ];
  for (const candidate of candidates) {
    const state = await readJsonFile<AutosyncRuntimeState>(candidate);
    if (state) {
      return state;
    }
  }
  return null;
}

async function saveAutosyncRuntimeState(
  state: AutosyncRuntimeState,
  homeDir: string
): Promise<void> {
  await writeJsonFile(
    autosyncRuntimeStatePath(homeDir, state.service, state.rootDir),
    state
  );
}

async function runCommand(
  argv: string[],
  opts?: { cwd?: string }
): Promise<CommandResult> {
  const proc = Bun.spawn({
    cmd: argv,
    cwd: opts?.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function runLaunchctl(args: string[]): Promise<CommandResult> {
  if (launchctlRunnerForTests) {
    return await launchctlRunnerForTests(args);
  }
  return await runCommand(["launchctl", ...args]);
}

export function setLaunchctlRunnerForTests(
  runner: ((args: string[]) => Promise<CommandResult>) | null
) {
  launchctlRunnerForTests = runner;
}

function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? process.geteuid?.() ?? 0}`;
}

function defaultAutosyncConfig(args: {
  serviceName: string;
  tool?: string;
  homeDir: string;
  rootDir?: string;
  remote?: string;
  branch?: string;
  intervalMinutes?: number;
  gitEnabled?: boolean;
}): AutosyncServiceConfig {
  const source = hostname();
  return {
    version: AUTOSYNC_VERSION,
    name: args.serviceName,
    tool: args.tool,
    rootDir: args.rootDir ?? facultRootDir(args.homeDir),
    debounceMs: DEFAULT_DEBOUNCE_MS,
    git: {
      enabled: args.gitEnabled ?? true,
      remote: args.remote ?? "origin",
      branch: args.branch ?? "main",
      intervalMinutes: args.intervalMinutes ?? DEFAULT_GIT_INTERVAL_MINUTES,
      autoCommit: true,
      commitPrefix: "chore(facult-autosync)",
      source,
    },
  };
}

function gitCommitMessage(config: AutosyncServiceConfig): string {
  const source = config.git.source || hostname();
  return `${config.git.commitPrefix}: sync canonical ai changes from ${source} [service:${config.name}]`;
}

async function gitHasWorktreeChanges(repoDir: string): Promise<boolean> {
  const result = await runCommand(["git", "status", "--porcelain"], {
    cwd: repoDir,
  });
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}

async function gitCurrentBranch(repoDir: string): Promise<string | null> {
  const result = await runCommand(
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    { cwd: repoDir }
  );
  if (result.exitCode !== 0) {
    return null;
  }
  const branch = result.stdout.trim();
  return branch || null;
}

async function gitHead(repoDir: string): Promise<string | null> {
  const result = await runCommand(["git", "rev-parse", "HEAD"], {
    cwd: repoDir,
  });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function ensureGitRepo(repoDir: string): Promise<boolean> {
  return await pathExists(join(repoDir, ".git"));
}

async function cleanupAutosyncLaunchAgentArtifacts(args: {
  homeDir: string;
  serviceName: string;
}) {
  const domain = launchdDomain();
  for (const label of autosyncLabelCandidates(args.serviceName)) {
    await runLaunchctl(["bootout", `${domain}/${label}`]).catch(() => null);
  }

  const legacyPlistPath = join(
    args.homeDir,
    "Library",
    "LaunchAgents",
    `${legacyAutosyncLabel(args.serviceName)}.plist`
  );
  if (legacyPlistPath !== autosyncPlistPath(args.homeDir, args.serviceName)) {
    await rm(legacyPlistPath, { force: true });
  }
}

async function cleanupLegacyAutosyncFiles(args: {
  homeDir: string;
  serviceName: string;
  rootDir: string;
}) {
  const legacyPaths = [
    join(
      canonicalAutosyncDir(args.homeDir, args.rootDir),
      "services",
      `${args.serviceName}.json`
    ),
    join(
      canonicalAutosyncDir(args.homeDir, args.rootDir),
      "state",
      `${args.serviceName}.json`
    ),
    join(
      canonicalAutosyncDir(args.homeDir, args.rootDir),
      "logs",
      `${args.serviceName}.log`
    ),
    join(
      canonicalAutosyncDir(args.homeDir, args.rootDir),
      "logs",
      `${args.serviceName}.err.log`
    ),
    legacyAutosyncConfigPath(args.homeDir, args.serviceName, args.rootDir),
    legacyAutosyncRuntimeStatePath(
      args.homeDir,
      args.serviceName,
      args.rootDir
    ),
  ];
  for (const candidate of legacyPaths) {
    await rm(candidate, { force: true }).catch(() => null);
  }
}

const AUTOSYNC_REBUILDABLE_PATHS = [
  ".facult/ai/index.json",
  ".facult/ai/graph.json",
];

const AUTOSYNC_MACHINE_LOCAL_LEGACY_PATHS = [
  ".facult/managed.json",
  ".facult/install.json",
  ".facult/autosync",
  ".facult/runtime",
];

async function gitListTrackedPaths(
  repoDir: string,
  pathValue: string
): Promise<string[]> {
  const result = await runCommand(["git", "ls-files", "-z", "--", pathValue], {
    cwd: repoDir,
  });
  if (result.exitCode !== 0 || !result.stdout) {
    return [];
  }
  return result.stdout
    .split("\0")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function cleanupAutosyncProtectedPaths(repoDir: string): Promise<void> {
  const tracked = new Set<string>();
  for (const pathValue of [
    ...AUTOSYNC_REBUILDABLE_PATHS,
    ...AUTOSYNC_MACHINE_LOCAL_LEGACY_PATHS,
  ]) {
    for (const entry of await gitListTrackedPaths(repoDir, pathValue)) {
      tracked.add(entry);
    }
    await rm(join(repoDir, pathValue), { force: true, recursive: true }).catch(
      () => null
    );
  }

  if (tracked.size > 0) {
    await runCommand(
      [
        "git",
        "restore",
        "--staged",
        "--worktree",
        "--source=HEAD",
        "--",
        ...tracked,
      ],
      { cwd: repoDir }
    );
  }
}

export async function runGitAutosyncOnce(args: {
  config: AutosyncServiceConfig;
}): Promise<GitSyncOutcome> {
  const { config } = args;
  const repoDir = config.rootDir;

  if (!config.git.enabled) {
    return { changed: false, blocked: false };
  }
  if (!(await ensureGitRepo(repoDir))) {
    return {
      changed: false,
      blocked: true,
      message: `Canonical root is not a git repo: ${repoDir}`,
    };
  }

  const branch = await gitCurrentBranch(repoDir);
  if (!branch) {
    return {
      changed: false,
      blocked: true,
      message: "Unable to determine current git branch.",
    };
  }
  if (branch !== config.git.branch) {
    return {
      changed: false,
      blocked: true,
      message: `Autosync expects branch ${config.git.branch} but repo is on ${branch}.`,
    };
  }

  await cleanupAutosyncProtectedPaths(repoDir);

  const fetch = await runCommand(
    ["git", "fetch", config.git.remote, config.git.branch],
    { cwd: repoDir }
  );
  if (fetch.exitCode !== 0) {
    return {
      changed: false,
      blocked: false,
      message: fetch.stderr.trim() || fetch.stdout.trim() || "git fetch failed",
    };
  }

  const beforeHead = await gitHead(repoDir);
  const hadChanges = await gitHasWorktreeChanges(repoDir);

  if (hadChanges && config.git.autoCommit) {
    await runCommand(["git", "add", "-A"], { cwd: repoDir });
    const commit = await runCommand(
      ["git", "commit", "-m", gitCommitMessage(config)],
      { cwd: repoDir }
    );
    if (
      commit.exitCode !== 0 &&
      !commit.stdout.includes("nothing to commit") &&
      !commit.stderr.includes("nothing to commit")
    ) {
      return {
        changed: false,
        blocked: false,
        message:
          commit.stderr.trim() || commit.stdout.trim() || "git commit failed",
      };
    }
  }

  const pull = await runCommand(
    ["git", "pull", "--rebase", config.git.remote, config.git.branch],
    { cwd: repoDir }
  );
  if (pull.exitCode !== 0) {
    await runCommand(["git", "rebase", "--abort"], { cwd: repoDir });
    return {
      changed: false,
      blocked: true,
      message:
        pull.stderr.trim() ||
        pull.stdout.trim() ||
        "git pull --rebase reported conflicts",
    };
  }

  const push = await runCommand(["git", "push", config.git.remote, branch], {
    cwd: repoDir,
  });
  if (push.exitCode !== 0) {
    return {
      changed: false,
      blocked: false,
      message: push.stderr.trim() || push.stdout.trim() || "git push failed",
    };
  }

  const afterHead = await gitHead(repoDir);
  return {
    changed: beforeHead !== afterHead || hadChanges,
    blocked: false,
  };
}

async function runLocalAutosync(
  config: AutosyncServiceConfig,
  homeDir: string
): Promise<void> {
  await syncManagedTools({
    homeDir,
    rootDir: config.rootDir,
    tool: config.tool,
  });
}

function isIgnoredRootEvent(fileName: string | Buffer | null): boolean {
  if (!fileName) {
    return false;
  }
  const text = typeof fileName === "string" ? fileName : fileName.toString();
  return text === ".git" || text.startsWith(".git/");
}

export async function runAutosyncService(
  config: AutosyncServiceConfig,
  opts: RunnerOptions = {}
): Promise<void> {
  const home = opts.homeDir ?? homedir();
  const label = autosyncLabel(config.name);
  let dirty = false;
  let stopped = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let running = Promise.resolve();

  const persistState = async (patch: Partial<AutosyncRuntimeState>) => {
    const current =
      (await loadAutosyncRuntimeState(config.name, home, config.rootDir)) ??
      ({
        version: AUTOSYNC_VERSION,
        service: config.name,
        label,
        tool: config.tool,
        dirty,
        rootDir: config.rootDir,
      } satisfies AutosyncRuntimeState);
    const next: AutosyncRuntimeState = {
      ...current,
      ...patch,
      version: AUTOSYNC_VERSION,
      service: config.name,
      label,
      tool: config.tool,
      dirty: patch.dirty ?? dirty,
      rootDir: config.rootDir,
    };
    await saveAutosyncRuntimeState(next, home);
  };

  const queue = async (fn: () => Promise<void>) => {
    running = running.then(fn, fn);
    await running;
  };

  const syncLocal = async () => {
    await queue(async () => {
      await runLocalAutosync(config, home);
      dirty = false;
      await persistState({
        dirty,
        lastLocalSyncAt: nowIso(),
        lastError: undefined,
      });
    });
  };

  const syncRemote = async () => {
    if (!config.git.enabled) {
      return;
    }
    await queue(async () => {
      const outcome = await runGitAutosyncOnce({ config });
      await persistState({
        lastGitSyncAt: nowIso(),
        remoteBlocked: outcome.blocked,
        remoteBlockReason: outcome.message,
        lastError: outcome.message,
      });
      if (outcome.changed && !outcome.blocked) {
        await runLocalAutosync(config, home);
        dirty = false;
        await persistState({
          dirty,
          lastLocalSyncAt: nowIso(),
          lastError: undefined,
          remoteBlocked: false,
          remoteBlockReason: undefined,
        });
      }
    });
  };

  await persistState({
    dirty,
    remoteBlocked: false,
    remoteBlockReason: undefined,
  });
  await syncLocal();

  if (opts.once) {
    await syncRemote();
    return;
  }

  const watcher = fsWatch(config.rootDir, { recursive: true });
  watcher.on("change", (_eventType, fileName) => {
    if (stopped || isIgnoredRootEvent(fileName)) {
      return;
    }
    dirty = true;
    runDetached(
      "persisting runtime state after file change",
      persistState({ dirty, lastEventAt: nowIso() })
    );
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      runDetached("running local sync", syncLocal());
    }, config.debounceMs);
  });

  const gitInterval = Math.max(1, config.git.intervalMinutes) * 60_000;
  const remoteTimer = setInterval(() => {
    if (dirty || config.git.enabled) {
      runDetached("running remote sync", syncRemote());
    }
  }, gitInterval);

  await new Promise<void>((resolvePromise) => {
    const stop = async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      clearInterval(remoteTimer);
      watcher.close();
      await persistState({ dirty });
      resolvePromise();
    };

    process.once("SIGINT", () => {
      runDetached("stopping after SIGINT", stop());
    });
    process.once("SIGTERM", () => {
      runDetached("stopping after SIGTERM", stop());
    });
  });
}

function parseAutosyncIntFlag(
  argv: string[],
  flag: string
): number | undefined {
  const exact = argv.indexOf(flag);
  if (exact >= 0) {
    const raw = argv[exact + 1];
    if (!raw) {
      throw new Error(`${flag} requires a value.`);
    }
    return Number.parseInt(raw, 10);
  }
  const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
  if (!inline) {
    return undefined;
  }
  return Number.parseInt(inline.slice(flag.length + 1), 10);
}

function parseAutosyncStringFlag(
  argv: string[],
  flag: string
): string | undefined {
  const exact = argv.indexOf(flag);
  if (exact >= 0) {
    const raw = argv[exact + 1];
    if (!raw) {
      throw new Error(`${flag} requires a value.`);
    }
    return raw.trim();
  }
  const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1).trim() : undefined;
}

function parseAutosyncPositionals(
  argv: string[],
  flagsWithValues: string[]
): string[] {
  const valueFlags = new Set(flagsWithValues);
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (valueFlags.has(arg)) {
      i += 1;
      continue;
    }
    if (valueFlags.has(arg.split("=")[0] ?? "")) {
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    positionals.push(arg);
  }

  return positionals;
}

function autosyncHelp(): string {
  return `fclt autosync — background autosync for managed tools

Usage:
  fclt autosync install [tool] [--git-remote <name>] [--git-branch <name>] [--git-interval-minutes <n>] [--git-disable]
  fclt autosync uninstall [tool]
  fclt autosync status [tool]
  fclt autosync restart [tool]
  fclt autosync run [tool] [--service <name>] [--once]

Options:
  --git-remote <name>           Git remote for canonical repo sync (default: origin)
  --git-branch <name>           Git branch for canonical repo sync (default: main)
  --git-interval-minutes <n>    Remote git sync interval in minutes (default: 60)
  --git-disable                 Disable remote git sync for this service
  --root <path>                 Select a canonical .ai root explicitly
  --global                      Force the global canonical root
  --project                     Force the nearest repo-local .ai root
  --once                        Run one local+remote sync cycle and exit
`;
}

export async function installAutosyncService(args: {
  tool?: string;
  homeDir?: string;
  rootDir?: string;
  gitRemote?: string;
  gitBranch?: string;
  gitIntervalMinutes?: number;
  gitEnabled?: boolean;
}): Promise<AutosyncServiceConfig> {
  const home = args.homeDir ?? homedir();
  const rootDir =
    args.rootDir ??
    resolveCliContextRoot({ homeDir: home, cwd: process.cwd() });
  const serviceName = autosyncServiceName(args.tool, rootDir, home);
  const config = defaultAutosyncConfig({
    serviceName,
    tool: args.tool,
    homeDir: home,
    rootDir,
    remote: args.gitRemote,
    branch: args.gitBranch,
    intervalMinutes: args.gitIntervalMinutes,
    gitEnabled: args.gitEnabled,
  });
  const spec = buildLaunchAgentSpec({
    homeDir: home,
    serviceName,
    rootDir: config.rootDir,
  });
  const plist = buildLaunchAgentPlist(spec);

  await mkdir(dirname(spec.plistPath), { recursive: true });
  await mkdir(autosyncLogsDir(home, rootDir), { recursive: true });
  await saveAutosyncConfig(config, home);
  await cleanupLegacyAutosyncFiles({
    homeDir: home,
    serviceName,
    rootDir: config.rootDir,
  });
  await cleanupAutosyncLaunchAgentArtifacts({
    homeDir: home,
    serviceName,
  });
  await writeFile(spec.plistPath, plist, "utf8");

  const domain = launchdDomain();
  await runLaunchctl(["bootstrap", domain, spec.plistPath]);
  await runLaunchctl(["kickstart", "-k", `${domain}/${spec.label}`]);
  return config;
}

export async function uninstallAutosyncService(args: {
  tool?: string;
  homeDir?: string;
  rootDir?: string;
}): Promise<void> {
  const home = args.homeDir ?? homedir();
  const rootDir =
    args.rootDir ??
    resolveCliContextRoot({ homeDir: home, cwd: process.cwd() });
  const serviceName = autosyncServiceName(args.tool, rootDir, home);

  await cleanupAutosyncLaunchAgentArtifacts({
    homeDir: home,
    serviceName,
  });
  await cleanupLegacyAutosyncFiles({
    homeDir: home,
    serviceName,
    rootDir,
  });
  await rm(autosyncPlistPath(home, serviceName), { force: true });
  await rm(autosyncConfigPath(home, serviceName, rootDir), { force: true });
}

export async function repairAutosyncServices(
  homeDir: string = homedir(),
  rootDir?: string
): Promise<boolean> {
  const activeRoot = rootDir ?? facultRootDir(homeDir);
  const serviceDirs = [
    autosyncServicesDir(homeDir, activeRoot),
    join(canonicalAutosyncDir(homeDir, activeRoot), "services"),
    legacyAutosyncServicesDir(homeDir, activeRoot),
  ];
  const seen = new Set<string>();
  const files: string[] = [];
  for (const dir of serviceDirs) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    for (const entry of entries) {
      if (seen.has(entry)) {
        continue;
      }
      seen.add(entry);
      files.push(entry);
    }
  }
  let changed = false;

  for (const entry of files) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const serviceName = basename(entry, ".json");
    const config = await loadAutosyncConfig(serviceName, homeDir, activeRoot);
    if (!config) {
      continue;
    }
    const desiredRoot = projectRootFromAiRoot(config.rootDir, homeDir)
      ? config.rootDir
      : facultRootDir(homeDir);
    if (config.rootDir !== desiredRoot) {
      config.rootDir = desiredRoot;
      await saveAutosyncConfig(config, homeDir);
      changed = true;
    }
    await cleanupLegacyAutosyncFiles({
      homeDir,
      serviceName,
      rootDir: config.rootDir,
    });

    const spec = buildLaunchAgentSpec({
      homeDir,
      serviceName,
      rootDir: config.rootDir,
    });
    const desired = buildLaunchAgentPlist(spec);
    const legacyPlistPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      `${legacyAutosyncLabel(serviceName)}.plist`
    );
    const currentText = await readFile(spec.plistPath, "utf8").catch(
      () => null
    );
    const legacyExists = await pathExists(legacyPlistPath);
    if (currentText !== desired || legacyExists) {
      await mkdir(dirname(spec.plistPath), { recursive: true });
      await mkdir(autosyncLogsDir(homeDir, config.rootDir), {
        recursive: true,
      });
      await cleanupAutosyncLaunchAgentArtifacts({
        homeDir,
        serviceName,
      });
      await writeFile(spec.plistPath, desired, "utf8");
      const domain = launchdDomain();
      await runLaunchctl(["bootstrap", domain, spec.plistPath]).catch(
        () => null
      );
      await runLaunchctl(["kickstart", "-k", `${domain}/${spec.label}`]).catch(
        () => null
      );
      changed = true;
    }
  }

  return changed;
}

export async function autosyncStatus(args: {
  tool?: string;
  homeDir?: string;
  rootDir?: string;
}): Promise<AutosyncStatus> {
  const home = args.homeDir ?? homedir();
  const rootDir =
    args.rootDir ??
    resolveCliContextRoot({ homeDir: home, cwd: process.cwd() });
  const serviceName = autosyncServiceName(args.tool, rootDir, home);
  const config = await loadAutosyncConfig(serviceName, home, rootDir);
  const state = await loadAutosyncRuntimeState(serviceName, home, rootDir);
  const plistPath = autosyncPlistPath(home, serviceName);
  const plistExists = await pathExists(plistPath);
  const label = autosyncLabel(serviceName);
  const domain = launchdDomain();
  const launchctl = await runLaunchctl(["print", `${domain}/${label}`]);

  return {
    config,
    state,
    plistPath,
    plistExists,
    loaded: launchctl.exitCode === 0,
    launchctlSummary:
      launchctl.exitCode === 0
        ? launchctl.stdout.trim()
        : launchctl.stderr.trim() || launchctl.stdout.trim() || undefined,
  };
}

export async function restartAutosyncService(args: {
  tool?: string;
  rootDir?: string;
}): Promise<void> {
  const home = homedir();
  const rootDir =
    args.rootDir ??
    resolveCliContextRoot({ homeDir: home, cwd: process.cwd() });
  const serviceName = autosyncServiceName(args.tool, rootDir, home);
  const label = autosyncLabel(serviceName);
  await runLaunchctl(["kickstart", "-k", `${launchdDomain()}/${label}`]);
}

export async function autosyncCommand(argv: string[]) {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(autosyncHelp());
    return;
  }

  try {
    const parsed = parseCliContextArgs(rest);
    if (
      parsed.argv.includes("--help") ||
      parsed.argv.includes("-h") ||
      parsed.argv[0] === "help"
    ) {
      console.log(autosyncHelp());
      return;
    }
    const rootDir = resolveCliContextRoot({
      rootArg: parsed.rootArg,
      scope: parsed.scope,
      cwd: process.cwd(),
    });

    if (sub === "install") {
      const tool = parseAutosyncPositionals(parsed.argv, [
        "--git-remote",
        "--git-branch",
        "--git-interval-minutes",
      ])[0];
      const gitRemote = parseAutosyncStringFlag(parsed.argv, "--git-remote");
      const gitBranch = parseAutosyncStringFlag(parsed.argv, "--git-branch");
      const gitIntervalMinutes = parseAutosyncIntFlag(
        parsed.argv,
        "--git-interval-minutes"
      );
      const gitEnabled = !parsed.argv.includes("--git-disable");
      const config = await installAutosyncService({
        tool,
        rootDir,
        gitRemote,
        gitBranch,
        gitIntervalMinutes,
        gitEnabled,
      });
      console.log(`Installed autosync service: ${config.name}`);
      console.log(`Label: ${autosyncLabel(config.name)}`);
      return;
    }

    if (sub === "uninstall") {
      const tool = parseAutosyncPositionals(parsed.argv, [])[0];
      await uninstallAutosyncService({ tool, rootDir });
      console.log(
        `Removed autosync service: ${autosyncServiceName(tool, rootDir)}`
      );
      return;
    }

    if (sub === "status") {
      const tool = parseAutosyncPositionals(parsed.argv, [])[0];
      const status = await autosyncStatus({ tool, rootDir });
      console.log(`Service: ${autosyncServiceName(tool, rootDir)}`);
      console.log(`Plist: ${status.plistPath}`);
      console.log(`Installed: ${status.plistExists ? "yes" : "no"}`);
      console.log(`Loaded: ${status.loaded ? "yes" : "no"}`);
      if (status.config) {
        console.log(`Root: ${status.config.rootDir}`);
        console.log(
          `Remote sync: ${status.config.git.enabled ? "enabled" : "disabled"}`
        );
        if (status.config.git.enabled) {
          console.log(
            `Git remote: ${status.config.git.remote}/${status.config.git.branch}`
          );
          console.log(`Git interval: ${status.config.git.intervalMinutes}m`);
        }
      }
      if (status.state?.lastLocalSyncAt) {
        console.log(`Last local sync: ${status.state.lastLocalSyncAt}`);
      }
      if (status.state?.lastGitSyncAt) {
        console.log(`Last git sync: ${status.state.lastGitSyncAt}`);
      }
      if (status.state?.remoteBlocked) {
        console.log(
          `Remote blocked: ${status.state.remoteBlockReason ?? "yes"}`
        );
      }
      return;
    }

    if (sub === "restart") {
      const tool = parseAutosyncPositionals(parsed.argv, [])[0];
      await restartAutosyncService({ tool, rootDir });
      console.log(
        `Restarted autosync service: ${autosyncServiceName(tool, rootDir)}`
      );
      return;
    }

    if (sub === "run") {
      const service = parseAutosyncStringFlag(parsed.argv, "--service");
      const tool = parseAutosyncPositionals(parsed.argv, ["--service"])[0];
      const serviceName = service ?? autosyncServiceName(tool, rootDir);
      const config = await loadAutosyncConfig(serviceName);
      if (!config) {
        throw new Error(`Autosync service not configured: ${serviceName}`);
      }
      await runAutosyncService(config, {
        once: parsed.argv.includes("--once"),
      });
      return;
    }

    throw new Error(`Unknown autosync command: ${sub}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
