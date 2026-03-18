import { watch as fsWatch } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { syncManagedTools } from "./manage";
import { facultRootDir, facultStateDir } from "./paths";

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

function nowIso(): string {
  return new Date().toISOString();
}

function logAutosyncError(context: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`facult autosync: ${context}: ${detail}`);
}

function runDetached(context: string, promise: Promise<void>) {
  promise.catch((error) => {
    logAutosyncError(context, error);
  });
}

function autosyncDir(home: string): string {
  return join(facultStateDir(home), "autosync");
}

function autosyncServicesDir(home: string): string {
  return join(autosyncDir(home), "services");
}

function autosyncStateDir(home: string): string {
  return join(autosyncDir(home), "state");
}

function autosyncLogsDir(home: string): string {
  return join(autosyncDir(home), "logs");
}

function autosyncServiceName(tool?: string): string {
  return tool?.trim() ? tool.trim() : "all";
}

function autosyncLabel(serviceName: string): string {
  return serviceName === "all"
    ? "com.facult.autosync"
    : `com.facult.autosync.${serviceName}`;
}

function autosyncPlistPath(home: string, serviceName: string): string {
  return join(
    home,
    "Library",
    "LaunchAgents",
    `${autosyncLabel(serviceName)}.plist`
  );
}

function autosyncConfigPath(home: string, serviceName: string): string {
  return join(autosyncServicesDir(home), `${serviceName}.json`);
}

function autosyncRuntimeStatePath(home: string, serviceName: string): string {
  return join(autosyncStateDir(home), `${serviceName}.json`);
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

  if (basename(exec).startsWith("facult")) {
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
  const logsDir = autosyncLogsDir(homeDir);

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
  homeDir: string = homedir()
): Promise<AutosyncServiceConfig | null> {
  return await readJsonFile<AutosyncServiceConfig>(
    autosyncConfigPath(homeDir, serviceName)
  );
}

async function saveAutosyncConfig(
  config: AutosyncServiceConfig,
  homeDir: string
): Promise<void> {
  await writeJsonFile(autosyncConfigPath(homeDir, config.name), config);
}

export async function loadAutosyncRuntimeState(
  serviceName: string,
  homeDir: string = homedir()
): Promise<AutosyncRuntimeState | null> {
  return await readJsonFile<AutosyncRuntimeState>(
    autosyncRuntimeStatePath(homeDir, serviceName)
  );
}

async function saveAutosyncRuntimeState(
  state: AutosyncRuntimeState,
  homeDir: string
): Promise<void> {
  await writeJsonFile(autosyncRuntimeStatePath(homeDir, state.service), state);
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
  return await runCommand(["launchctl", ...args]);
}

function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? process.geteuid?.() ?? 0}`;
}

function defaultAutosyncConfig(args: {
  serviceName: string;
  tool?: string;
  homeDir: string;
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
    rootDir: facultRootDir(args.homeDir),
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
      (await loadAutosyncRuntimeState(config.name, home)) ??
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
  return `facult autosync — background autosync for managed tools

Usage:
  facult autosync install [tool] [--git-remote <name>] [--git-branch <name>] [--git-interval-minutes <n>] [--git-disable]
  facult autosync uninstall [tool]
  facult autosync status [tool]
  facult autosync restart [tool]
  facult autosync run [tool] [--service <name>] [--once]

Options:
  --git-remote <name>           Git remote for canonical repo sync (default: origin)
  --git-branch <name>           Git branch for canonical repo sync (default: main)
  --git-interval-minutes <n>    Remote git sync interval in minutes (default: 60)
  --git-disable                 Disable remote git sync for this service
  --once                        Run one local+remote sync cycle and exit
`;
}

export async function installAutosyncService(args: {
  tool?: string;
  homeDir?: string;
  gitRemote?: string;
  gitBranch?: string;
  gitIntervalMinutes?: number;
  gitEnabled?: boolean;
}): Promise<AutosyncServiceConfig> {
  const home = args.homeDir ?? homedir();
  const serviceName = autosyncServiceName(args.tool);
  const config = defaultAutosyncConfig({
    serviceName,
    tool: args.tool,
    homeDir: home,
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
  await mkdir(autosyncLogsDir(home), { recursive: true });
  await saveAutosyncConfig(config, home);
  await writeFile(spec.plistPath, plist, "utf8");

  const domain = launchdDomain();
  await runLaunchctl(["bootout", `${domain}/${spec.label}`]).catch(() => null);
  await runLaunchctl(["bootstrap", domain, spec.plistPath]);
  await runLaunchctl(["kickstart", "-k", `${domain}/${spec.label}`]);
  return config;
}

export async function uninstallAutosyncService(args: {
  tool?: string;
  homeDir?: string;
}): Promise<void> {
  const home = args.homeDir ?? homedir();
  const serviceName = autosyncServiceName(args.tool);
  const label = autosyncLabel(serviceName);
  const domain = launchdDomain();

  await runLaunchctl(["bootout", `${domain}/${label}`]).catch(() => null);
  await rm(autosyncPlistPath(home, serviceName), { force: true });
  await rm(autosyncConfigPath(home, serviceName), { force: true });
}

export async function repairAutosyncServices(
  homeDir: string = homedir()
): Promise<boolean> {
  const servicesDir = autosyncServicesDir(homeDir);
  const files = await readdir(servicesDir).catch(() => [] as string[]);
  let changed = false;

  for (const entry of files) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const serviceName = basename(entry, ".json");
    const config = await loadAutosyncConfig(serviceName, homeDir);
    if (!config) {
      continue;
    }
    const desiredRoot = facultRootDir(homeDir);
    if (config.rootDir !== desiredRoot) {
      config.rootDir = desiredRoot;
      await saveAutosyncConfig(config, homeDir);
      changed = true;
    }

    const spec = buildLaunchAgentSpec({
      homeDir,
      serviceName,
      rootDir: config.rootDir,
    });
    const desired = buildLaunchAgentPlist(spec);
    const currentText = await readFile(spec.plistPath, "utf8").catch(
      () => null
    );
    if (currentText !== desired) {
      await mkdir(dirname(spec.plistPath), { recursive: true });
      await mkdir(autosyncLogsDir(homeDir), { recursive: true });
      await writeFile(spec.plistPath, desired, "utf8");
      const domain = launchdDomain();
      await runLaunchctl(["bootout", `${domain}/${spec.label}`]).catch(
        () => null
      );
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
}): Promise<AutosyncStatus> {
  const home = args.homeDir ?? homedir();
  const serviceName = autosyncServiceName(args.tool);
  const config = await loadAutosyncConfig(serviceName, home);
  const state = await loadAutosyncRuntimeState(serviceName, home);
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
}): Promise<void> {
  const serviceName = autosyncServiceName(args.tool);
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
    if (sub === "install") {
      const tool = parseAutosyncPositionals(rest, [
        "--git-remote",
        "--git-branch",
        "--git-interval-minutes",
      ])[0];
      const gitRemote = parseAutosyncStringFlag(rest, "--git-remote");
      const gitBranch = parseAutosyncStringFlag(rest, "--git-branch");
      const gitIntervalMinutes = parseAutosyncIntFlag(
        rest,
        "--git-interval-minutes"
      );
      const gitEnabled = !rest.includes("--git-disable");
      const config = await installAutosyncService({
        tool,
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
      const tool = parseAutosyncPositionals(rest, [])[0];
      await uninstallAutosyncService({ tool });
      console.log(`Removed autosync service: ${autosyncServiceName(tool)}`);
      return;
    }

    if (sub === "status") {
      const tool = parseAutosyncPositionals(rest, [])[0];
      const status = await autosyncStatus({ tool });
      console.log(`Service: ${autosyncServiceName(tool)}`);
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
      const tool = parseAutosyncPositionals(rest, [])[0];
      await restartAutosyncService({ tool });
      console.log(`Restarted autosync service: ${autosyncServiceName(tool)}`);
      return;
    }

    if (sub === "run") {
      const service = parseAutosyncStringFlag(rest, "--service");
      const tool = parseAutosyncPositionals(rest, ["--service"])[0];
      const serviceName = service ?? autosyncServiceName(tool);
      const config = await loadAutosyncConfig(serviceName);
      if (!config) {
        throw new Error(`Autosync service not configured: ${serviceName}`);
      }
      await runAutosyncService(config, { once: rest.includes("--once") });
      return;
    }

    throw new Error(`Unknown autosync command: ${sub}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
