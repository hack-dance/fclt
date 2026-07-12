import { createHash, randomUUID } from "node:crypto";
import { watch as fsWatch } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  parseCliContextArgs,
  resolveCliContextRoot,
  resolveCliContextScope,
} from "./cli-context";
import {
  assertLegacyManagedMutationAllowed,
  LEGACY_MANAGED_MUTATION_FLAG,
  legacyManagedMutationApproved,
} from "./legacy-mutation-policy";
import { syncManagedTools } from "./manage";
import {
  facultInstallStatePath,
  facultMachineStateDir,
  facultRootDir,
  facultStateDir,
  legacyFacultStateDirForRoot,
  machineStateProjectKey,
  projectRootFromAiRoot,
  withFacultRootScope,
} from "./paths";
import { gitEnvironmentForRepository } from "./util/git-environment";

const AUTOSYNC_VERSION = 1 as const;
const DEFAULT_DEBOUNCE_MS = 1500;
const DEFAULT_GIT_INTERVAL_MINUTES = 60;
const LINE_SPLIT_RE = /\r?\n/;
const WHITESPACE_RE = /\s+/;
const LAUNCHCTL_WORKING_DIRECTORY_RE = /^\s*working directory\s*=\s*(.+?)\s*$/i;
const PLIST_COMMENT_RE = /<!--[\s\S]*?-->/g;
const PLIST_LABEL_RE = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/;
const PLIST_PROGRAM_ARGUMENTS_RE =
  /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/;
const PLIST_STRING_RE = /<string>([^<]*)<\/string>/g;
const PLIST_WORKING_DIRECTORY_RE =
  /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/;
const XML_ENTITY_RE = /&(?:amp|lt|gt|quot|apos);/g;
const UNKNOWN_XML_ENTITY_RE = /&[^;\s]*;/;
const RECOVERY_PLAN_ID_RE = /^[a-f0-9]{24}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const UUID_V4_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

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
  serviceName: string;
  config: AutosyncServiceConfig | null;
  state: AutosyncRuntimeState | null;
  plistPath: string;
  plistExists: boolean;
  loaded: boolean;
  ownershipMismatch: boolean;
  launchctlSummary?: string;
}

export type RecoveryInspectionCoverage =
  | "checked"
  | "not_applicable"
  | "unavailable";

export interface AutosyncRecoveryConfigInspection {
  service: string;
  tool: string | null;
  path: string;
  location: "machine" | "canonical_legacy" | "external_legacy";
  state: "valid" | "invalid" | "foreign_root";
  unknownFieldCount: number;
  planId?: string;
}

export interface AutosyncRecoveryInspection {
  coverage: {
    configs: RecoveryInspectionCoverage;
    launchAgents: RecoveryInspectionCoverage;
    launchd: RecoveryInspectionCoverage;
  };
  configured: AutosyncRecoveryConfigInspection[];
  ownedPlists: Array<{
    label: string;
    path: string;
    generation: "current" | "legacy";
  }>;
  ownedLoadedLabels: string[];
  foreignLoadedLabels: string[];
  orphanedLabels: string[];
  reasonCodes: string[];
  configFingerprints: Record<string, string>;
  plistSnapshots: Array<{
    label: string;
    path: string;
    hash: string;
  }>;
}

export interface AutosyncRecoveryCleanupResult {
  version: 1;
  rootDir: string;
  service: string;
  planId: string;
  changed: boolean;
  alreadyApplied: boolean;
  receiptPath: string;
  appliedAt: string;
  dispositions: Array<"launch_agent_unloaded" | "owned_plist_removed">;
  preserves: Array<
    | "canonical_capability"
    | "live_tool_state"
    | "managed_state"
    | "autosync_config"
    | "backups"
  >;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RunnerOptions {
  homeDir?: string;
  once?: boolean;
  expectedRootDir?: string;
  allowLegacyManagedMutation?: boolean;
  env?: NodeJS.ProcessEnv;
}

interface GitSyncOutcome {
  changed: boolean;
  blocked: boolean;
  message?: string;
}

let launchctlRunnerForTests:
  | ((args: string[]) => Promise<CommandResult>)
  | null = null;
let launchctlSupportedForTests: boolean | null = null;
let autosyncMutationLockHookForTests:
  | ((event: {
      phase:
        | "claim_published"
        | "before_claim_load"
        | "before_dead_claim_remove"
        | "before_critical_section";
      claimPath: string;
    }) => Promise<void>)
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
  return machineStateProjectKey(rootDir, home);
}

function legacyServiceSuffix(
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

function legacyAutosyncServiceName(
  tool?: string,
  rootDir?: string,
  home: string = homedir()
): string {
  const base = tool?.trim() ? tool.trim() : "all";
  const suffix = legacyServiceSuffix(rootDir, home);
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

function serviceNameFromAutosyncLabel(label: string): string | null {
  if (label === "com.fclt.autosync" || label === "com.facult.autosync") {
    return "all";
  }
  for (const prefix of ["com.fclt.autosync.", "com.facult.autosync."]) {
    if (label.startsWith(prefix) && label.length > prefix.length) {
      return label.slice(prefix.length);
    }
  }
  return null;
}

function decodePlistString(value: string): string | null {
  const withoutKnownEntities = value.replace(XML_ENTITY_RE, "");
  if (UNKNOWN_XML_ENTITY_RE.test(withoutKnownEntities)) {
    return null;
  }
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function singlePlistCapture(contents: string, pattern: RegExp): string | null {
  const match = contents.match(pattern);
  if (!match?.[1]) {
    return null;
  }
  if (contents.replace(pattern, "").match(pattern)) {
    return null;
  }
  return match[1];
}

function plistContainsOwnedAutosyncProgram(
  contents: string,
  rootDir: string,
  serviceName: string,
  pathLabel: string
): boolean {
  const normalized = contents.replace(PLIST_COMMENT_RE, "");
  const labelRaw = singlePlistCapture(normalized, PLIST_LABEL_RE);
  const workingDirectoryRaw = singlePlistCapture(
    normalized,
    PLIST_WORKING_DIRECTORY_RE
  );
  const argumentsRaw = singlePlistCapture(
    normalized,
    PLIST_PROGRAM_ARGUMENTS_RE
  );
  if (!(labelRaw && workingDirectoryRaw && argumentsRaw)) {
    return false;
  }
  const label = decodePlistString(labelRaw);
  const workingDirectory = decodePlistString(workingDirectoryRaw);
  const argumentMatches = [...argumentsRaw.matchAll(PLIST_STRING_RE)];
  const unparsedArguments = argumentsRaw.replace(PLIST_STRING_RE, "").trim();
  const programArguments = argumentMatches.map((match) =>
    decodePlistString(match[1] ?? "")
  );
  if (
    unparsedArguments ||
    programArguments.some((argument) => argument === null)
  ) {
    return false;
  }
  const argv = programArguments.filter(
    (argument): argument is string => argument !== null
  );
  const autosyncIndex = argv.indexOf("autosync");
  const expectedTail = [
    "autosync",
    "run",
    ...(serviceName === "all" ? [] : [serviceName]),
    "--service",
    serviceName,
  ];
  return (
    label === pathLabel &&
    autosyncLabelCandidates(serviceName).includes(label) &&
    workingDirectory !== null &&
    resolve(workingDirectory) === resolve(rootDir) &&
    autosyncIndex > 0 &&
    isDeepStrictEqual(argv.slice(autosyncIndex), expectedTail)
  );
}

function plistWorkingDirectoryValue(contents: string): string | null {
  const raw = singlePlistCapture(
    contents.replace(PLIST_COMMENT_RE, ""),
    PLIST_WORKING_DIRECTORY_RE
  );
  return raw ? decodePlistString(raw) : null;
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

function autosyncConfigCandidates(
  homeDir: string,
  serviceName: string,
  rootDir?: string
): string[] {
  return [
    autosyncConfigPath(homeDir, serviceName, rootDir),
    join(
      canonicalAutosyncDir(homeDir, rootDir),
      "services",
      `${serviceName}.json`
    ),
    legacyAutosyncConfigPath(homeDir, serviceName, rootDir),
  ].filter((candidate, index, candidates) => {
    const resolved = resolve(candidate);
    return (
      candidates.findIndex((entry) => resolve(entry) === resolved) === index
    );
  });
}

function isAutosyncServiceConfig(
  value: unknown
): value is AutosyncServiceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const config = value as Record<string, unknown>;
  if (
    config.version !== AUTOSYNC_VERSION ||
    typeof config.name !== "string" ||
    !config.name.trim() ||
    (config.tool !== undefined && typeof config.tool !== "string") ||
    typeof config.rootDir !== "string" ||
    !config.rootDir.trim() ||
    typeof config.debounceMs !== "number" ||
    !Number.isFinite(config.debounceMs) ||
    !config.git ||
    typeof config.git !== "object" ||
    Array.isArray(config.git)
  ) {
    return false;
  }
  const git = config.git as Record<string, unknown>;
  return (
    typeof git.enabled === "boolean" &&
    typeof git.remote === "string" &&
    typeof git.branch === "string" &&
    typeof git.intervalMinutes === "number" &&
    Number.isFinite(git.intervalMinutes) &&
    typeof git.autoCommit === "boolean" &&
    typeof git.commitPrefix === "string" &&
    typeof git.source === "string"
  );
}

interface AutosyncConfigFile {
  config: AutosyncServiceConfig | null;
  exists: boolean;
}

async function readAutosyncConfigFile(
  pathValue: string
): Promise<AutosyncConfigFile> {
  try {
    const parsed = JSON.parse(await readFile(pathValue, "utf8")) as unknown;
    return {
      config: isAutosyncServiceConfig(parsed) ? parsed : null,
      exists: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: null, exists: false };
    }
    return { config: null, exists: true };
  }
}

async function autosyncConfigArtifactsExist(
  serviceName: string,
  homeDir: string,
  rootDir?: string
): Promise<boolean> {
  const results = await Promise.all(
    autosyncConfigCandidates(homeDir, serviceName, rootDir).map((candidate) =>
      pathExists(candidate)
    )
  );
  return results.some(Boolean);
}

function autosyncConfigMatchesRoot(
  config: AutosyncServiceConfig,
  rootDir: string
): boolean {
  return resolve(config.rootDir) === resolve(rootDir);
}

function assertAutosyncConfigRoot(
  config: AutosyncServiceConfig,
  rootDir: string,
  serviceName: string
): void {
  if (!autosyncConfigMatchesRoot(config, rootDir)) {
    throw new Error(
      `Refusing autosync config without matching root ownership: ${serviceName} belongs to ${config.rootDir}, not ${rootDir}`
    );
  }
}

async function writeJsonFile(pathValue: string, data: unknown): Promise<void> {
  await mkdir(dirname(pathValue), { recursive: true });
  await writeFile(pathValue, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

interface StagedJsonFile {
  commit: () => Promise<void>;
  discard: () => Promise<void>;
}

async function stageJsonFile(
  pathValue: string,
  data: unknown
): Promise<StagedJsonFile> {
  const parentDir = dirname(pathValue);
  let stagingDir = parentDir;
  while (!(await pathExists(stagingDir))) {
    const parent = dirname(stagingDir);
    if (parent === stagingDir) {
      throw new Error(`No writable ancestor for autosync config: ${pathValue}`);
    }
    stagingDir = parent;
  }
  const tempPath = join(
    stagingDir,
    `.${basename(pathValue)}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    JSON.parse(await readFile(tempPath, "utf8"));
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => null);
    throw error;
  }
  return {
    commit: async () => {
      await mkdir(parentDir, { recursive: true });
      await rename(tempPath, pathValue);
    },
    discard: async () => {
      await rm(tempPath, { force: true });
    },
  };
}

export async function loadAutosyncConfig(
  serviceName: string,
  homeDir: string = homedir(),
  rootDir?: string
): Promise<AutosyncServiceConfig | null> {
  for (const candidate of autosyncConfigCandidates(
    homeDir,
    serviceName,
    rootDir
  )) {
    const result = await readAutosyncConfigFile(candidate);
    if (!result.exists) {
      continue;
    }
    return result.config;
  }
  return null;
}

async function configuredAutosyncServiceName(args: {
  homeDir: string;
  rootDir: string;
  tool?: string;
}): Promise<string> {
  const currentName = autosyncServiceName(
    args.tool,
    args.rootDir,
    args.homeDir
  );
  if (
    await autosyncConfigArtifactsExist(currentName, args.homeDir, args.rootDir)
  ) {
    return currentName;
  }
  const legacyName = legacyAutosyncServiceName(
    args.tool,
    args.rootDir,
    args.homeDir
  );
  if (
    legacyName !== currentName &&
    (await autosyncConfigArtifactsExist(legacyName, args.homeDir, args.rootDir))
  ) {
    return legacyName;
  }
  return currentName;
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
  const commandEnv =
    argv[0] === "git" && opts?.cwd
      ? gitEnvironmentForRepository({ repoDir: opts.cwd })
      : process.env;
  const proc = Bun.spawn({
    cmd: argv,
    cwd: opts?.cwd,
    env: commandEnv,
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

export function setLaunchctlSupportedForTests(supported: boolean | null) {
  launchctlSupportedForTests = supported;
}

export function setAutosyncMutationLockHookForTests(
  hook:
    | ((event: {
        phase:
          | "claim_published"
          | "before_claim_load"
          | "before_dead_claim_remove"
          | "before_critical_section";
        claimPath: string;
      }) => Promise<void>)
    | null
) {
  autosyncMutationLockHookForTests = hook;
}

function launchctlLifecycleSupported(): boolean {
  return (
    launchctlSupportedForTests ??
    (process.platform === "darwin" || launchctlRunnerForTests !== null)
  );
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

interface AutosyncPlistOwnership {
  ownedPaths: Set<string>;
  ownedHashes: Map<string, string>;
  foreignPaths: string[];
}

interface RootOwnedAutosyncPlist {
  label: string;
  path: string;
}

function launchctlServiceNotFound(result: CommandResult): boolean {
  const detail = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    result.exitCode === 113 ||
    detail.includes("could not find service") ||
    detail.includes("service not found")
  );
}

function launchctlWorkingDirectory(result: CommandResult): string | null {
  for (const line of `${result.stdout}\n${result.stderr}`.split(
    LINE_SPLIT_RE
  )) {
    const match = line.match(LAUNCHCTL_WORKING_DIRECTORY_RE);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function launchctlServiceMatchesRoot(
  result: CommandResult,
  rootDir: string
): boolean {
  const workingDirectory = launchctlWorkingDirectory(result);
  return Boolean(
    workingDirectory && resolve(workingDirectory) === resolve(rootDir)
  );
}

function isAutosyncLabel(label: string): boolean {
  return (
    label === "com.fclt.autosync" ||
    label.startsWith("com.fclt.autosync.") ||
    label === "com.facult.autosync" ||
    label.startsWith("com.facult.autosync.")
  );
}

function autosyncLabelFromPlistName(entry: string): string | null {
  if (!entry.endsWith(".plist")) {
    return null;
  }
  const label = entry.slice(0, -".plist".length);
  return isAutosyncLabel(label) ? label : null;
}

async function rootOwnedAutosyncPlists(args: {
  homeDir: string;
  rootDir: string;
}): Promise<RootOwnedAutosyncPlist[]> {
  const launchAgentsDir = join(args.homeDir, "Library", "LaunchAgents");
  let entries: string[];
  try {
    entries = await readdir(launchAgentsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to inspect autosync LaunchAgent directory ${launchAgentsDir}: ${detail}`
    );
  }
  const owned: RootOwnedAutosyncPlist[] = [];
  for (const entry of entries) {
    const label = autosyncLabelFromPlistName(entry);
    if (!label) {
      continue;
    }
    const pathValue = join(launchAgentsDir, entry);
    const metadata = await lstat(pathValue).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Unable to inspect autosync LaunchAgent ${pathValue}: ${detail}`
      );
    });
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(
        `Unable to prove autosync LaunchAgent ownership for non-regular path: ${pathValue}`
      );
    }
    const contents = await readFile(pathValue, "utf8").catch(
      (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Unable to inspect autosync LaunchAgent ${pathValue}: ${detail}`
        );
      }
    );
    const serviceName = serviceNameFromAutosyncLabel(label);
    const workingDirectory = plistWorkingDirectoryValue(contents);
    if (!workingDirectory) {
      throw new Error(
        `Unable to prove autosync LaunchAgent working directory: ${pathValue}`
      );
    }
    if (resolve(workingDirectory) !== resolve(args.rootDir)) {
      continue;
    }
    if (!serviceName) {
      throw new Error(
        `Unable to prove autosync LaunchAgent service identity: ${pathValue}`
      );
    }
    if (
      plistContainsOwnedAutosyncProgram(
        contents,
        args.rootDir,
        serviceName,
        label
      )
    ) {
      owned.push({ label, path: pathValue });
    } else {
      throw new Error(
        `Unable to prove autosync LaunchAgent program ownership: ${pathValue}`
      );
    }
  }
  return owned;
}

function shouldEnumerateLoadedAutosyncServices(): boolean {
  if (launchctlSupportedForTests !== null) {
    return launchctlSupportedForTests;
  }
  return process.platform === "darwin" && launchctlRunnerForTests === null;
}

function listedAutosyncLabels(stdout: string): string[] {
  const labels = new Set<string>();
  for (const line of stdout.split(LINE_SPLIT_RE)) {
    const label = line.trim().split(WHITESPACE_RE).at(-1);
    if (label && isAutosyncLabel(label)) {
      labels.add(label);
    }
  }
  return [...labels];
}

async function rootOwnedLoadedAutosyncLabels(
  rootDir: string
): Promise<string[]> {
  if (!shouldEnumerateLoadedAutosyncServices()) {
    return [];
  }
  const listed = await runLaunchctl(["list"]).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to enumerate loaded autosync services: ${detail}`);
  });
  if (listed.exitCode !== 0) {
    throw new Error(
      `Unable to enumerate loaded autosync services: ${listed.stderr.trim() || listed.stdout.trim() || `exit ${listed.exitCode}`}`
    );
  }
  const domain = launchdDomain();
  const owned: string[] = [];
  for (const label of listedAutosyncLabels(listed.stdout)) {
    const inspected = await runLaunchctl(["print", `${domain}/${label}`]).catch(
      (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Unable to inspect loaded autosync service ${label}: ${detail}`
        );
      }
    );
    if (inspected.exitCode !== 0) {
      if (launchctlServiceNotFound(inspected)) {
        continue;
      }
      throw new Error(
        `Unable to inspect loaded autosync service ${label}: ${inspected.stderr.trim() || inspected.stdout.trim() || `exit ${inspected.exitCode}`}`
      );
    }
    const workingDirectory = launchctlWorkingDirectory(inspected);
    if (!workingDirectory) {
      throw new Error(
        `Unable to prove loaded autosync service root ownership: ${label}`
      );
    }
    if (resolve(workingDirectory) === resolve(rootDir)) {
      owned.push(label);
    }
  }
  return owned;
}

interface LoadedAutosyncRecoveryInspection {
  coverage: RecoveryInspectionCoverage;
  ownedLabels: string[];
  foreignLabels: string[];
  unprovenLabels: string[];
}

async function inspectLoadedAutosyncRecovery(
  rootDir: string
): Promise<LoadedAutosyncRecoveryInspection> {
  if (!shouldEnumerateLoadedAutosyncServices()) {
    return {
      coverage: "not_applicable",
      ownedLabels: [],
      foreignLabels: [],
      unprovenLabels: [],
    };
  }
  let listed: CommandResult;
  try {
    listed = await runLaunchctl(["list"]);
  } catch {
    return {
      coverage: "unavailable",
      ownedLabels: [],
      foreignLabels: [],
      unprovenLabels: [],
    };
  }
  if (listed.exitCode !== 0) {
    return {
      coverage: "unavailable",
      ownedLabels: [],
      foreignLabels: [],
      unprovenLabels: [],
    };
  }
  const domain = launchdDomain();
  const ownedLabels: string[] = [];
  const foreignLabels: string[] = [];
  const unprovenLabels: string[] = [];
  for (const label of listedAutosyncLabels(listed.stdout)) {
    let inspected: CommandResult;
    try {
      inspected = await runLaunchctl(["print", `${domain}/${label}`]);
    } catch {
      return {
        coverage: "unavailable",
        ownedLabels: [],
        foreignLabels: [],
        unprovenLabels: [],
      };
    }
    if (inspected.exitCode !== 0) {
      if (launchctlServiceNotFound(inspected)) {
        continue;
      }
      return {
        coverage: "unavailable",
        ownedLabels: [],
        foreignLabels: [],
        unprovenLabels: [],
      };
    }
    const workingDirectory = launchctlWorkingDirectory(inspected);
    if (!workingDirectory) {
      unprovenLabels.push(label);
    } else if (resolve(workingDirectory) === resolve(rootDir)) {
      ownedLabels.push(label);
    } else {
      foreignLabels.push(label);
    }
  }
  return {
    coverage: "checked",
    ownedLabels: ownedLabels.sort((a, b) => a.localeCompare(b)),
    foreignLabels: foreignLabels.sort((a, b) => a.localeCompare(b)),
    unprovenLabels: unprovenLabels.sort((a, b) => a.localeCompare(b)),
  };
}

async function inspectAutosyncPlistOwnership(args: {
  homeDir: string;
  rootDir: string;
  serviceName: string;
}): Promise<AutosyncPlistOwnership> {
  const candidates = [
    {
      path: autosyncPlistPath(args.homeDir, args.serviceName),
      label: autosyncLabel(args.serviceName),
    },
    {
      path: join(
        args.homeDir,
        "Library",
        "LaunchAgents",
        `${legacyAutosyncLabel(args.serviceName)}.plist`
      ),
      label: legacyAutosyncLabel(args.serviceName),
    },
  ];
  const ownedPaths = new Set<string>();
  const ownedHashes = new Map<string, string>();
  const foreignPaths: string[] = [];
  for (const candidate of candidates) {
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(candidate.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Unable to inspect autosync LaunchAgent ${candidate.path}: ${detail}`
      );
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      foreignPaths.push(candidate.path);
      continue;
    }
    let contents: string;
    try {
      contents = await readFile(candidate.path, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Unable to inspect autosync LaunchAgent ${candidate.path}: ${detail}`
      );
    }
    if (
      plistContainsOwnedAutosyncProgram(
        contents,
        args.rootDir,
        args.serviceName,
        candidate.label
      )
    ) {
      ownedPaths.add(candidate.path);
      ownedHashes.set(
        candidate.path,
        createHash("sha256").update(contents).digest("hex")
      );
    } else {
      foreignPaths.push(candidate.path);
    }
  }
  return { ownedPaths, ownedHashes, foreignPaths };
}

async function unloadAutosyncLaunchAgents(args: {
  homeDir: string;
  rootDir: string;
  serviceName: string;
}): Promise<{
  changed: boolean;
  ownedPaths: Set<string>;
  ownedHashes: Map<string, string>;
}> {
  const ownership = await inspectAutosyncPlistOwnership(args);
  if (ownership.foreignPaths.length > 0) {
    throw new Error(
      `Refusing to remove autosync LaunchAgent without matching root ownership: ${ownership.foreignPaths.join(", ")}`
    );
  }
  if (!launchctlLifecycleSupported()) {
    return {
      changed: false,
      ownedPaths: ownership.ownedPaths,
      ownedHashes: ownership.ownedHashes,
    };
  }
  const domain = launchdDomain();
  let changed = false;
  const candidates = [
    {
      label: autosyncLabel(args.serviceName),
      path: autosyncPlistPath(args.homeDir, args.serviceName),
    },
    {
      label: legacyAutosyncLabel(args.serviceName),
      path: join(
        args.homeDir,
        "Library",
        "LaunchAgents",
        `${legacyAutosyncLabel(args.serviceName)}.plist`
      ),
    },
  ];
  for (const candidate of candidates) {
    const inspected = await runLaunchctl([
      "print",
      `${domain}/${candidate.label}`,
    ]).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Unable to inspect loaded autosync service ${candidate.label}: ${detail}`
      );
    });
    if (inspected.exitCode !== 0) {
      if (!launchctlServiceNotFound(inspected)) {
        throw new Error(
          `Unable to inspect loaded autosync service ${candidate.label}: ${inspected.stderr.trim() || inspected.stdout.trim() || `exit ${inspected.exitCode}`}`
        );
      }
      continue;
    }
    if (!ownership.ownedPaths.has(candidate.path)) {
      throw new Error(
        `Refusing to unload autosync service ${candidate.label} without a root-owned plist.`
      );
    }
    if (!launchctlServiceMatchesRoot(inspected, args.rootDir)) {
      throw new Error(
        `Refusing to unload autosync service ${candidate.label} without matching loaded root ownership.`
      );
    }
    const unloaded = await runLaunchctl([
      "bootout",
      `${domain}/${candidate.label}`,
    ]).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Unable to unload autosync service ${candidate.label}: ${detail}`
      );
    });
    if (unloaded.exitCode !== 0) {
      throw new Error(
        `Unable to unload autosync service ${candidate.label}: ${unloaded.stderr.trim() || unloaded.stdout.trim() || `exit ${unloaded.exitCode}`}`
      );
    }
    changed = true;
  }
  return {
    changed,
    ownedPaths: ownership.ownedPaths,
    ownedHashes: ownership.ownedHashes,
  };
}

async function removeAutosyncLaunchAgentPlists(
  ownedPaths: Set<string>,
  expectedHashes?: Map<string, string>
): Promise<void> {
  for (const pathValue of ownedPaths) {
    const expectedHash = expectedHashes?.get(pathValue);
    if (expectedHash) {
      const currentHash = createHash("sha256")
        .update(await readFile(pathValue))
        .digest("hex");
      if (currentHash !== expectedHash) {
        throw new Error(
          `Refusing to remove autosync LaunchAgent changed after ownership inspection: ${pathValue}`
        );
      }
    }
    await rm(pathValue, { force: true });
  }
}

async function cleanupLegacyAutosyncFiles(args: {
  homeDir: string;
  serviceName: string;
  rootDir: string;
}) {
  const currentPaths = new Set([
    autosyncConfigPath(args.homeDir, args.serviceName, args.rootDir),
    autosyncRuntimeStatePath(args.homeDir, args.serviceName, args.rootDir),
    join(
      autosyncLogsDir(args.homeDir, args.rootDir),
      `${args.serviceName}.log`
    ),
    join(
      autosyncLogsDir(args.homeDir, args.rootDir),
      `${args.serviceName}.err.log`
    ),
  ]);
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
    if (currentPaths.has(candidate)) {
      continue;
    }
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
  homeDir: string,
  allowLegacyManagedMutation?: boolean
): Promise<void> {
  await syncManagedTools({
    homeDir,
    rootDir: config.rootDir,
    tool: config.tool,
    allowLegacyManagedMutation,
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
  if (
    opts.expectedRootDir &&
    resolve(config.rootDir) !== resolve(opts.expectedRootDir)
  ) {
    throw new Error(
      `Autosync config root does not match the selected canonical root: ${config.rootDir}`
    );
  }
  const allowLegacyManagedMutation = legacyManagedMutationApproved({
    explicit: opts.allowLegacyManagedMutation,
    env: opts.env,
  });
  assertLegacyManagedMutationAllowed({
    action: "fclt autosync run",
    approved: allowLegacyManagedMutation,
    safeAlternative: "fclt autosync status",
  });
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
      await runLocalAutosync(config, home, allowLegacyManagedMutation);
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
        await runLocalAutosync(config, home, allowLegacyManagedMutation);
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
  return `fclt autosync — inspect or remove legacy managed-tool autosync

Usage:
  fclt autosync uninstall [tool]
  fclt autosync status [tool]
  fclt autosync cleanup --service <name> --expected-plan <id> [--root <path> | --global | --project] ${LEGACY_MANAGED_MUTATION_FLAG}
  fclt autosync run [tool] [--service <name>] --once ${LEGACY_MANAGED_MUTATION_FLAG}

Options:
  --root <path>                 Select a canonical .ai root explicitly
  --global                      Force the global canonical root
  --project                     Force the nearest repo-local .ai root
  --once                        Run one local+remote sync cycle and exit
  --service <name>              Select the exact diagnosed autosync service
  --expected-plan <id>          Refuse cleanup if owned recovery state changed
  ${LEGACY_MANAGED_MUTATION_FLAG}  Explicitly opt into deprecated broad mutation

Background install, restart, and continuous run are disabled while broad managed mutation is contained.
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
  allowLegacyManagedMutation?: boolean;
}): Promise<AutosyncServiceConfig> {
  const allowLegacyManagedMutation = legacyManagedMutationApproved({
    explicit: args.allowLegacyManagedMutation,
  });
  assertLegacyManagedMutationAllowed({
    action: "fclt autosync install",
    approved: allowLegacyManagedMutation,
    safeAlternative: "fclt autosync status or uninstall",
  });
  if (!launchctlLifecycleSupported()) {
    throw new Error("Background autosync installation requires macOS launchd.");
  }
  const homeDir = args.homeDir ?? homedir();
  const rootDir =
    args.rootDir ?? resolveCliContextRoot({ homeDir, cwd: process.cwd() });
  return await withAutosyncMutationLock({
    homeDir,
    rootDir,
    operation: `install:${args.tool ?? "all"}`,
    fn: async () =>
      await installAutosyncServiceUnlocked({
        ...args,
        homeDir,
        rootDir,
        allowLegacyManagedMutation,
      }),
  });
}

async function installAutosyncServiceUnlocked(args: {
  tool?: string;
  homeDir?: string;
  rootDir?: string;
  gitRemote?: string;
  gitBranch?: string;
  gitIntervalMinutes?: number;
  gitEnabled?: boolean;
  allowLegacyManagedMutation?: boolean;
}): Promise<AutosyncServiceConfig> {
  const allowLegacyManagedMutation = legacyManagedMutationApproved({
    explicit: args.allowLegacyManagedMutation,
  });
  assertLegacyManagedMutationAllowed({
    action: "fclt autosync install",
    approved: allowLegacyManagedMutation,
    safeAlternative: "fclt autosync status or uninstall",
  });
  if (!launchctlLifecycleSupported()) {
    throw new Error("Background autosync installation requires macOS launchd.");
  }
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
  const existingConfigExists = await autosyncConfigArtifactsExist(
    serviceName,
    home,
    rootDir
  );
  const existingConfig = await loadAutosyncConfig(serviceName, home, rootDir);
  if (existingConfigExists && !existingConfig) {
    throw new Error(
      `Autosync service config is invalid; refusing replacement without proven ownership: ${serviceName}`
    );
  }
  if (existingConfig) {
    assertAutosyncConfigRoot(existingConfig, rootDir, serviceName);
  }
  const spec = buildLaunchAgentSpec({
    homeDir: home,
    serviceName,
    rootDir: config.rootDir,
  });
  const plist = buildLaunchAgentPlist(spec);

  await mkdir(dirname(spec.plistPath), { recursive: true });
  await mkdir(autosyncLogsDir(home, rootDir), { recursive: true });
  const stagedConfig = await stageJsonFile(
    autosyncConfigPath(home, serviceName, config.rootDir),
    config
  );
  try {
    const unloaded = await unloadAutosyncLaunchAgents({
      homeDir: home,
      rootDir: config.rootDir,
      serviceName,
    });
    await stagedConfig.commit();
    await cleanupLegacyAutosyncFiles({
      homeDir: home,
      serviceName,
      rootDir: config.rootDir,
    });
    await removeAutosyncLaunchAgentPlists(
      unloaded.ownedPaths,
      unloaded.ownedHashes
    );
    await writeFile(spec.plistPath, plist, "utf8");
  } finally {
    await stagedConfig.discard();
  }

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
  const homeDir = args.homeDir ?? homedir();
  const rootDir =
    args.rootDir ?? resolveCliContextRoot({ homeDir, cwd: process.cwd() });
  return await withAutosyncMutationLock({
    homeDir,
    rootDir,
    operation: `uninstall:${args.tool ?? "all"}`,
    fn: async () =>
      await uninstallAutosyncServiceUnlocked({
        ...args,
        homeDir,
        rootDir,
      }),
  });
}

async function uninstallAutosyncServiceUnlocked(args: {
  tool?: string;
  homeDir?: string;
  rootDir?: string;
}): Promise<void> {
  const home = args.homeDir ?? homedir();
  const rootDir =
    args.rootDir ??
    resolveCliContextRoot({ homeDir: home, cwd: process.cwd() });
  const serviceName = await configuredAutosyncServiceName({
    homeDir: home,
    rootDir,
    tool: args.tool,
  });
  const configExists = await autosyncConfigArtifactsExist(
    serviceName,
    home,
    rootDir
  );
  const config = await loadAutosyncConfig(serviceName, home, rootDir);
  if (configExists && !config) {
    throw new Error(
      `Autosync service config is invalid; refusing cleanup without proven ownership: ${serviceName}`
    );
  }
  if (config) {
    assertAutosyncConfigRoot(config, rootDir, serviceName);
  }

  const unloaded = await unloadAutosyncLaunchAgents({
    homeDir: home,
    rootDir,
    serviceName,
  });
  await removeAutosyncLaunchAgentPlists(
    unloaded.ownedPaths,
    unloaded.ownedHashes
  );
  await cleanupLegacyAutosyncFiles({
    homeDir: home,
    serviceName,
    rootDir,
  });
  await rm(autosyncConfigPath(home, serviceName, rootDir), { force: true });
}

async function autosyncServiceConfigFiles(
  homeDir: string,
  rootDir?: string
): Promise<string[]> {
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
  return files.filter((entry) => entry.endsWith(".json"));
}

interface InternalAutosyncRecoveryConfigInspection {
  service: string;
  tool: string | null;
  path: string;
  location: "machine" | "canonical_legacy" | "external_legacy";
  state: "valid" | "invalid" | "foreign_root";
  unknownFields: string[];
  planId?: string;
  config: AutosyncServiceConfig | null;
  contentHash: string | null;
}

function unknownAutosyncConfigFields(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const topLevel = new Set([
    "version",
    "name",
    "tool",
    "rootDir",
    "debounceMs",
    "git",
  ]);
  const gitFields = new Set([
    "enabled",
    "remote",
    "branch",
    "intervalMinutes",
    "autoCommit",
    "commitPrefix",
    "source",
  ]);
  const unknown = Object.keys(record)
    .filter((key) => !topLevel.has(key))
    .map((key) => `config.${key}`);
  const git = record.git;
  if (git && typeof git === "object" && !Array.isArray(git)) {
    unknown.push(
      ...Object.keys(git as Record<string, unknown>)
        .filter((key) => !gitFields.has(key))
        .map((key) => `config.git.${key}`)
    );
  }
  return unknown.sort((a, b) => a.localeCompare(b));
}

async function inspectAutosyncRecoveryConfigs(args: {
  homeDir: string;
  rootDir: string;
}): Promise<{
  coverage: RecoveryInspectionCoverage;
  records: InternalAutosyncRecoveryConfigInspection[];
  reasonCodes: string[];
}> {
  const candidates = [
    {
      dir: autosyncServicesDir(args.homeDir, args.rootDir),
      location: "machine" as const,
    },
    {
      dir: join(canonicalAutosyncDir(args.homeDir, args.rootDir), "services"),
      location: "canonical_legacy" as const,
    },
    {
      dir: legacyAutosyncServicesDir(args.homeDir, args.rootDir),
      location: "external_legacy" as const,
    },
  ].filter(
    (candidate, index, all) =>
      all.findIndex(
        (entry) => resolve(entry.dir) === resolve(candidate.dir)
      ) === index
  );
  const records: InternalAutosyncRecoveryConfigInspection[] = [];
  const reasonCodes = new Set<string>();
  let coverage: RecoveryInspectionCoverage = "checked";

  for (const candidate of candidates) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(candidate.dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      coverage = "unavailable";
      reasonCodes.add("autosync_config_inspection_unavailable");
      continue;
    }
    for (const entry of entries) {
      if (!entry.name.endsWith(".json")) {
        continue;
      }
      const pathValue = join(candidate.dir, entry.name);
      const service = basename(entry.name, ".json");
      let raw: string;
      try {
        const metadata = await lstat(pathValue);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          records.push({
            service,
            tool: null,
            path: pathValue,
            location: candidate.location,
            state: "invalid",
            unknownFields: [],
            config: null,
            contentHash: null,
          });
          reasonCodes.add("autosync_config_invalid");
          continue;
        }
        raw = await readFile(pathValue, "utf8");
      } catch {
        records.push({
          service,
          tool: null,
          path: pathValue,
          location: candidate.location,
          state: "invalid",
          unknownFields: [],
          config: null,
          contentHash: null,
        });
        coverage = "unavailable";
        reasonCodes.add("autosync_config_inspection_unavailable");
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        parsed = null;
      }
      const unknownFields = unknownAutosyncConfigFields(parsed);
      const config = isAutosyncServiceConfig(parsed) ? parsed : null;
      const expectedNames = config
        ? [
            autosyncServiceName(config.tool, args.rootDir, args.homeDir),
            legacyAutosyncServiceName(config.tool, args.rootDir, args.homeDir),
          ]
        : [];
      const identityValid = Boolean(
        config && config.name === service && expectedNames.includes(service)
      );
      const state =
        !(config && identityValid) || unknownFields.length > 0
          ? "invalid"
          : autosyncConfigMatchesRoot(config, args.rootDir)
            ? "valid"
            : "foreign_root";
      if (state === "invalid") {
        reasonCodes.add("autosync_config_invalid");
      } else if (state === "foreign_root") {
        reasonCodes.add("autosync_config_foreign_root");
      }
      records.push({
        service,
        tool: config?.tool ?? null,
        path: pathValue,
        location: candidate.location,
        state,
        unknownFields,
        config,
        contentHash: createHash("sha256").update(raw).digest("hex"),
      });
    }
  }

  for (const service of new Set(records.map((record) => record.service))) {
    const duplicates = records.filter((record) => record.service === service);
    const validConfigs = duplicates
      .map((record) => record.config)
      .filter((config): config is AutosyncServiceConfig => config !== null);
    if (
      duplicates.length > 1 &&
      validConfigs.some(
        (config) => !isDeepStrictEqual(config, validConfigs[0] ?? config)
      )
    ) {
      for (const record of duplicates) {
        record.state = "invalid";
      }
      reasonCodes.add("autosync_config_conflict");
    }
  }

  return {
    coverage,
    records: records.sort((a, b) => a.path.localeCompare(b.path)),
    reasonCodes: [...reasonCodes].sort((a, b) => a.localeCompare(b)),
  };
}

function autosyncRecoveryPlanId(args: {
  rootDir: string;
  service: string;
  configs: InternalAutosyncRecoveryConfigInspection[];
  plists: Array<{ label: string; path: string; hash: string }>;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        rootDir: resolve(args.rootDir),
        service: args.service,
        configs: args.configs
          .map((record) => ({
            path: resolve(record.path),
            location: record.location,
            state: record.state,
            contentHash: record.contentHash,
          }))
          .sort((a, b) => a.path.localeCompare(b.path)),
        plists: [...args.plists].sort((a, b) => a.path.localeCompare(b.path)),
      })
    )
    .digest("hex")
    .slice(0, 24);
}

function autosyncRecoveryConfigFingerprint(
  records: InternalAutosyncRecoveryConfigInspection[]
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        records
          .map((record) => ({
            path: resolve(record.path),
            location: record.location,
            state: record.state,
            contentHash: record.contentHash,
          }))
          .sort((a, b) => a.path.localeCompare(b.path))
      )
    )
    .digest("hex");
}

export async function inspectAutosyncRecovery(
  args: { homeDir?: string; rootDir?: string } = {}
): Promise<AutosyncRecoveryInspection> {
  const homeDir = args.homeDir ?? homedir();
  const rootDir = args.rootDir ?? facultRootDir(homeDir);
  const configs = await inspectAutosyncRecoveryConfigs({ homeDir, rootDir });
  const reasonCodes = new Set(configs.reasonCodes);
  let launchAgentsCoverage: RecoveryInspectionCoverage = "checked";
  let ownedPlists: RootOwnedAutosyncPlist[] = [];
  try {
    ownedPlists = await rootOwnedAutosyncPlists({ homeDir, rootDir });
  } catch {
    launchAgentsCoverage = "unavailable";
    reasonCodes.add("autosync_launch_agent_inspection_unavailable");
  }

  const uniqueServices = [
    ...new Set(configs.records.map((entry) => entry.service)),
  ];
  for (const serviceName of uniqueServices) {
    try {
      const ownership = await inspectAutosyncPlistOwnership({
        homeDir,
        rootDir,
        serviceName,
      });
      if (ownership.foreignPaths.length > 0) {
        reasonCodes.add("autosync_launch_agent_ownership_mismatch");
      }
    } catch {
      launchAgentsCoverage = "unavailable";
      reasonCodes.add("autosync_launch_agent_inspection_unavailable");
    }
  }

  const loaded = await inspectLoadedAutosyncRecovery(rootDir);
  if (loaded.coverage === "unavailable") {
    reasonCodes.add("autosync_launchd_inspection_unavailable");
  }
  if (loaded.unprovenLabels.length > 0) {
    reasonCodes.add("autosync_loaded_ownership_unproven");
  }

  const configuredLabels = new Set(
    configs.records.flatMap((entry) => autosyncLabelCandidates(entry.service))
  );
  const orphanedLabels = [
    ...ownedPlists
      .map((entry) => entry.label)
      .filter((label) => !configuredLabels.has(label)),
    ...loaded.ownedLabels.filter((label) => !configuredLabels.has(label)),
  ].filter((label, index, all) => all.indexOf(label) === index);
  if (orphanedLabels.length > 0) {
    reasonCodes.add("autosync_orphaned_runtime");
  }
  if (loaded.foreignLabels.some((label) => configuredLabels.has(label))) {
    reasonCodes.add("autosync_loaded_root_mismatch");
  }

  const plistSnapshots = await Promise.all(
    ownedPlists.map(async (entry) => ({
      label: entry.label,
      path: entry.path,
      hash: createHash("sha256")
        .update(await readFile(entry.path))
        .digest("hex"),
    }))
  ).catch(() => {
    launchAgentsCoverage = "unavailable";
    reasonCodes.add("autosync_launch_agent_inspection_unavailable");
    return [];
  });

  for (const record of configs.records) {
    if (
      record.state !== "valid" ||
      configs.coverage !== "checked" ||
      launchAgentsCoverage !== "checked" ||
      loaded.coverage === "unavailable"
    ) {
      continue;
    }
    const labels = new Set(autosyncLabelCandidates(record.service));
    record.planId = autosyncRecoveryPlanId({
      rootDir,
      service: record.service,
      configs: configs.records.filter(
        (candidate) => candidate.service === record.service
      ),
      plists: plistSnapshots.filter((plist) => labels.has(plist.label)),
    });
  }

  const configFingerprints = Object.fromEntries(
    uniqueServices.map((service) => [
      service,
      autosyncRecoveryConfigFingerprint(
        configs.records.filter((record) => record.service === service)
      ),
    ])
  );

  return {
    coverage: {
      configs: configs.coverage,
      launchAgents: launchAgentsCoverage,
      launchd: loaded.coverage,
    },
    configured: configs.records.map(
      ({ config: _config, contentHash: _hash, unknownFields, ...record }) => ({
        ...record,
        unknownFieldCount: unknownFields.length,
      })
    ),
    ownedPlists: ownedPlists.map((entry) => ({
      label: entry.label,
      path: entry.path,
      generation: entry.label.startsWith("com.facult.") ? "legacy" : "current",
    })),
    ownedLoadedLabels: loaded.ownedLabels,
    foreignLoadedLabels: loaded.foreignLabels,
    orphanedLabels: orphanedLabels.sort((a, b) => a.localeCompare(b)),
    reasonCodes: [...reasonCodes].sort((a, b) => a.localeCompare(b)),
    configFingerprints,
    plistSnapshots: plistSnapshots.map((snapshot) => ({
      ...snapshot,
      path: resolve(snapshot.path),
    })),
  };
}

export async function assertAutosyncRepairAllowed(
  homeDir: string = homedir(),
  rootDir?: string,
  allowLegacyManagedMutation?: boolean,
  serviceName?: string
): Promise<void> {
  const activeRoot = rootDir ?? facultRootDir(homeDir);
  const allConfigFiles = await autosyncServiceConfigFiles(homeDir, activeRoot);
  const configFiles = allConfigFiles.filter(
    (entry) =>
      serviceName === undefined || basename(entry, ".json") === serviceName
  );
  const configuredLabels = new Set(
    allConfigFiles.flatMap((entry) =>
      autosyncLabelCandidates(basename(entry, ".json"))
    )
  );
  const orphanedPlists = (
    await rootOwnedAutosyncPlists({ homeDir, rootDir: activeRoot })
  ).filter((plist) => !configuredLabels.has(plist.label));
  if (orphanedPlists.length > 0) {
    throw new Error(
      `Refusing fclt doctor --repair while root-owned orphaned autosync LaunchAgent state remains: ${orphanedPlists.map((plist) => plist.path).join(", ")}. Restore its matching service config or explicitly uninstall the matching tool/root before retrying.`
    );
  }
  const orphanedLoadedServices = (
    await rootOwnedLoadedAutosyncLabels(activeRoot)
  ).filter((label) => !configuredLabels.has(label));
  if (orphanedLoadedServices.length > 0) {
    throw new Error(
      `Refusing fclt doctor --repair while a root-owned orphaned loaded autosync service remains: ${orphanedLoadedServices.join(", ")}. Restore its matching service config or explicitly unload the service before retrying.`
    );
  }
  const domain = launchdDomain();
  for (const entry of configFiles) {
    const serviceName = basename(entry, ".json");
    const currentPlist = autosyncPlistPath(homeDir, serviceName);
    const legacyPlist = join(
      homeDir,
      "Library",
      "LaunchAgents",
      `${legacyAutosyncLabel(serviceName)}.plist`
    );
    const [currentPlistExists, legacyPlistExists, ...loadedChecks] =
      await Promise.all([
        pathExists(currentPlist),
        pathExists(legacyPlist),
        ...autosyncLabelCandidates(serviceName).map((label) =>
          runLaunchctl(["print", `${domain}/${label}`]).catch(() => ({
            exitCode: 1,
            stdout: "",
            stderr: "launchctl unavailable",
          }))
        ),
      ]);
    if (
      !(currentPlistExists || legacyPlistExists) &&
      loadedChecks.every((result) => result.exitCode !== 0)
    ) {
      continue;
    }
    assertLegacyManagedMutationAllowed({
      action: "fclt doctor --repair autosync",
      approved: allowLegacyManagedMutation,
      safeAlternative: "fclt autosync status or uninstall",
    });
    return;
  }
}

export async function repairAutosyncServices(
  homeDir: string = homedir(),
  rootDir?: string,
  opts: {
    allowLegacyManagedMutation?: boolean;
    targetRootDir?: string;
    serviceName?: string;
    lockHeld?: boolean;
  } = {}
): Promise<boolean> {
  const activeRoot = rootDir ?? facultRootDir(homeDir);
  if (!opts.lockHeld) {
    return await withAutosyncMutationLock({
      homeDir,
      rootDir: activeRoot,
      operation: `repair:${opts.serviceName ?? "all"}`,
      fn: async () =>
        await repairAutosyncServices(homeDir, activeRoot, {
          ...opts,
          lockHeld: true,
        }),
    });
  }
  const targetRoot = opts.targetRootDir ?? activeRoot;
  const configFiles = (
    await autosyncServiceConfigFiles(homeDir, activeRoot)
  ).filter(
    (entry) =>
      opts.serviceName === undefined ||
      basename(entry, ".json") === opts.serviceName
  );
  await assertAutosyncRepairAllowed(
    homeDir,
    activeRoot,
    opts.allowLegacyManagedMutation,
    opts.serviceName
  );
  let changed = false;

  for (const entry of configFiles) {
    const serviceName = basename(entry, ".json");
    const config = await loadAutosyncConfig(serviceName, homeDir, activeRoot);
    if (!config) {
      throw new Error(
        `Autosync service config is invalid; refusing cleanup without proven ownership: ${serviceName}`
      );
    }
    if (
      !(
        autosyncConfigMatchesRoot(config, activeRoot) ||
        autosyncConfigMatchesRoot(config, targetRoot)
      )
    ) {
      throw new Error(
        `Refusing autosync config without matching root ownership: ${serviceName} belongs to ${config.rootDir}, not ${activeRoot} or ${targetRoot}`
      );
    }
    const sourceRoot = config.rootDir;
    const desiredRoot = targetRoot;
    const desiredConfig: AutosyncServiceConfig = {
      version: AUTOSYNC_VERSION,
      name: serviceName,
      ...(config.tool ? { tool: config.tool } : {}),
      rootDir: desiredRoot,
      debounceMs: config.debounceMs,
      git: { ...config.git },
    };
    const currentConfigPath = autosyncConfigPath(
      homeDir,
      serviceName,
      desiredRoot
    );
    const activeCurrentConfigPath = autosyncConfigPath(
      homeDir,
      serviceName,
      activeRoot
    );
    const destination = await readAutosyncConfigFile(currentConfigPath);
    const destinationConfig = await loadAutosyncConfig(
      serviceName,
      homeDir,
      desiredRoot
    );
    const destinationArtifactsExist = await autosyncConfigArtifactsExist(
      serviceName,
      homeDir,
      desiredRoot
    );
    const destinationIsSource =
      resolve(currentConfigPath) === resolve(activeCurrentConfigPath);
    if (
      destinationArtifactsExist &&
      !destinationIsSource &&
      !(
        destinationConfig && isDeepStrictEqual(destinationConfig, desiredConfig)
      )
    ) {
      throw new Error(
        `Refusing to overwrite an existing autosync destination config without matching content: ${currentConfigPath}`
      );
    }
    const currentPlistPath = autosyncPlistPath(homeDir, serviceName);
    const legacyPlistPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      `${legacyAutosyncLabel(serviceName)}.plist`
    );
    const [currentPlistExists, legacyPlistExists] = await Promise.all([
      pathExists(currentPlistPath),
      pathExists(legacyPlistPath),
    ]);
    const configNeedsMigration = !(
      destination.config && isDeepStrictEqual(destination.config, desiredConfig)
    );
    const ownership = await inspectAutosyncPlistOwnership({
      homeDir,
      rootDir: sourceRoot,
      serviceName,
    });
    if (ownership.foreignPaths.length > 0) {
      throw new Error(
        `Refusing to remove autosync LaunchAgent without matching root ownership: ${ownership.foreignPaths.join(", ")}`
      );
    }
    const staged = configNeedsMigration
      ? await stageJsonFile(currentConfigPath, desiredConfig)
      : null;
    try {
      const unloaded = await unloadAutosyncLaunchAgents({
        homeDir,
        rootDir: sourceRoot,
        serviceName,
      });
      if (staged) {
        await staged.commit();
      }
      const persistedConfig =
        await readJsonFile<AutosyncServiceConfig>(currentConfigPath);
      if (!isDeepStrictEqual(persistedConfig, desiredConfig)) {
        throw new Error(
          `Autosync config replacement could not be verified: ${currentConfigPath}`
        );
      }
      await removeAutosyncLaunchAgentPlists(
        unloaded.ownedPaths,
        unloaded.ownedHashes
      );
      await cleanupLegacyAutosyncFiles({
        homeDir,
        serviceName,
        rootDir: desiredRoot,
      });
      if (resolve(activeRoot) !== resolve(desiredRoot)) {
        await cleanupLegacyAutosyncFiles({
          homeDir,
          serviceName,
          rootDir: activeRoot,
        });
        const activeConfigPath = autosyncConfigPath(
          homeDir,
          serviceName,
          activeRoot
        );
        if (resolve(activeConfigPath) !== resolve(currentConfigPath)) {
          await rm(activeConfigPath, { force: true });
        }
      }
      changed ||=
        unloaded.changed ||
        configNeedsMigration ||
        currentPlistExists ||
        legacyPlistExists;
    } finally {
      await staged?.discard();
    }
  }

  return changed;
}

function autosyncRecoveryReceiptPath(
  homeDir: string,
  rootDir: string,
  planId: string
): string {
  return join(
    autosyncDir(homeDir, rootDir),
    "recovery",
    "receipts",
    `${planId}.json`
  );
}

function autosyncRecoveryPlanPath(
  homeDir: string,
  rootDir: string,
  planId: string
): string {
  return join(
    autosyncDir(homeDir, rootDir),
    "recovery",
    "plans",
    `${planId}.json`
  );
}

interface AutosyncRecoveryPreparedPlan {
  version: 1;
  rootDir: string;
  service: string;
  planId: string;
  configFingerprint: string;
  plists: Array<{
    label: string;
    path: string;
    hash: string;
  }>;
  preparedAt: string;
}

interface AutosyncMutationClaim {
  version: 1;
  pid: number;
  token: string;
  operation: string;
  rootDir: string;
  startedAt: string;
}

async function loadAutosyncMutationClaim(
  claimPath: string
): Promise<AutosyncMutationClaim> {
  const metadata = await lstat(claimPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(
      `Autosync mutation claim is not a regular owned file: ${claimPath}`
    );
  }
  const parsed = JSON.parse(await readFile(claimPath, "utf8")) as unknown;
  if (!(parsed && typeof parsed === "object" && !Array.isArray(parsed))) {
    throw new Error(`Autosync mutation claim owner is invalid: ${claimPath}`);
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !(Number.isSafeInteger(record.pid) && Number(record.pid) > 0) ||
    typeof record.token !== "string" ||
    !UUID_V4_RE.test(record.token) ||
    basename(claimPath) !== `${record.token}.json` ||
    typeof record.operation !== "string" ||
    typeof record.rootDir !== "string" ||
    typeof record.startedAt !== "string"
  ) {
    throw new Error(`Autosync mutation claim owner is invalid: ${claimPath}`);
  }
  return parsed as AutosyncMutationClaim;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function withAutosyncMutationLock<T>(args: {
  homeDir: string;
  rootDir: string;
  operation: string;
  fn: () => Promise<T>;
}): Promise<T> {
  const recoveryDir = join(
    dirname(facultInstallStatePath(args.homeDir)),
    "autosync",
    "recovery"
  );
  const claimsDir = join(recoveryDir, "lifecycle-locks");
  await mkdir(claimsDir, { recursive: true });
  // A UUID-v4 claim path is published once and never reused. That invariant
  // makes dead-claim removal local to one immutable generation and avoids the
  // stale-owner ABA race of replacing a shared lock filename.
  const token = randomUUID();
  const claimPath = join(claimsDir, `${token}.json`);
  const ownerPayload = `${JSON.stringify({
    version: 1,
    pid: process.pid,
    token,
    operation: args.operation,
    rootDir: resolve(args.rootDir),
    startedAt: new Date().toISOString(),
  })}\n`;
  const stagingPath = join(recoveryDir, `.lifecycle.${token}.tmp`);
  let staged: Awaited<ReturnType<typeof open>> | null = null;
  let published = false;
  try {
    staged = await open(stagingPath, "wx", 0o600);
    await staged.writeFile(ownerPayload);
    await staged.sync();
    await staged.close();
    staged = null;
    await link(stagingPath, claimPath);
    published = true;
    await rm(stagingPath, { force: true });
    await autosyncMutationLockHookForTests?.({
      phase: "claim_published",
      claimPath,
    });

    const liveOwners: AutosyncMutationClaim[] = [];
    const entries = await readdir(claimsDir, { withFileTypes: true });
    for (const entry of entries) {
      const candidatePath = join(claimsDir, entry.name);
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !entry.name.endsWith(".json")
      ) {
        throw new Error(
          `Autosync mutation claim directory contains an unowned entry: ${candidatePath}`
        );
      }
      if (entry.name === `${token}.json`) {
        continue;
      }
      await autosyncMutationLockHookForTests?.({
        phase: "before_claim_load",
        claimPath: candidatePath,
      });
      const owner = await loadAutosyncMutationClaim(candidatePath).catch(
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
          }
          throw error;
        }
      );
      if (!owner) {
        continue;
      }
      if (processIsAlive(owner.pid)) {
        liveOwners.push(owner);
        continue;
      }

      // Claim paths are UUID-scoped and never reused. Revalidate the immutable
      // owner tuple before removing only this abandoned contender.
      const current = await loadAutosyncMutationClaim(candidatePath).catch(
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
          }
          throw error;
        }
      );
      if (
        current &&
        current.pid === owner.pid &&
        current.token === owner.token
      ) {
        await autosyncMutationLockHookForTests?.({
          phase: "before_dead_claim_remove",
          claimPath: candidatePath,
        });
        await rm(candidatePath, { force: true });
      }
    }
    if (liveOwners.length > 0) {
      throw new Error(
        `Another autosync mutation holds the machine lifecycle boundary (pid${liveOwners.length === 1 ? "" : "s"} ${liveOwners.map((owner) => owner.pid).join(", ")}).`
      );
    }
    await autosyncMutationLockHookForTests?.({
      phase: "before_critical_section",
      claimPath,
    });
    return await args.fn();
  } finally {
    await staged?.close().catch(() => null);
    await rm(stagingPath, { force: true }).catch(() => null);
    if (published) {
      const owner = await readFile(claimPath, "utf8").catch(() => "");
      if (owner.includes(`"token":"${token}"`)) {
        await rm(claimPath, { force: true });
      }
    }
  }
}

async function loadAutosyncRecoveryReceipt(
  pathValue: string
): Promise<AutosyncRecoveryCleanupResult | null> {
  try {
    const metadata = await lstat(pathValue);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Invalid autosync recovery receipt path: ${pathValue}`);
    }
    const parsed = JSON.parse(await readFile(pathValue, "utf8")) as unknown;
    const record =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    const dispositions = record?.dispositions;
    const preserves = record?.preserves;
    if (
      record?.version === 1 &&
      typeof record.rootDir === "string" &&
      typeof record.service === "string" &&
      typeof record.planId === "string" &&
      RECOVERY_PLAN_ID_RE.test(record.planId) &&
      typeof record.changed === "boolean" &&
      typeof record.alreadyApplied === "boolean" &&
      typeof record.receiptPath === "string" &&
      typeof record.appliedAt === "string" &&
      Array.isArray(dispositions) &&
      dispositions.every(
        (value) =>
          value === "launch_agent_unloaded" || value === "owned_plist_removed"
      ) &&
      Array.isArray(preserves) &&
      preserves.every((value) =>
        [
          "canonical_capability",
          "live_tool_state",
          "managed_state",
          "autosync_config",
          "backups",
        ].includes(String(value))
      )
    ) {
      return parsed as AutosyncRecoveryCleanupResult;
    }
    throw new Error(`Invalid autosync recovery receipt: ${pathValue}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function loadAutosyncRecoveryPreparedPlan(args: {
  pathValue: string;
  homeDir: string;
  service: string;
}): Promise<AutosyncRecoveryPreparedPlan | null> {
  const { pathValue } = args;
  try {
    const metadata = await lstat(pathValue);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Invalid autosync recovery plan path: ${pathValue}`);
    }
    const parsed = JSON.parse(await readFile(pathValue, "utf8")) as unknown;
    const record =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    const plists = record?.plists;
    const allowedPlistPaths = new Map([
      [
        autosyncLabel(args.service),
        resolve(autosyncPlistPath(args.homeDir, args.service)),
      ],
      [
        legacyAutosyncLabel(args.service),
        resolve(
          join(
            args.homeDir,
            "Library",
            "LaunchAgents",
            `${legacyAutosyncLabel(args.service)}.plist`
          )
        ),
      ],
    ]);
    const seenLabels = new Set<string>();
    const seenPaths = new Set<string>();
    const validPlists =
      Array.isArray(plists) &&
      plists.length > 0 &&
      plists.length <= allowedPlistPaths.size &&
      plists.every((value) => {
        if (!(value && typeof value === "object" && !Array.isArray(value))) {
          return false;
        }
        const plist = value as Record<string, unknown>;
        if (
          typeof plist.label !== "string" ||
          typeof plist.path !== "string" ||
          typeof plist.hash !== "string" ||
          !SHA256_RE.test(plist.hash)
        ) {
          return false;
        }
        const resolvedPath = resolve(plist.path);
        if (
          allowedPlistPaths.get(plist.label) !== resolvedPath ||
          seenLabels.has(plist.label) ||
          seenPaths.has(resolvedPath)
        ) {
          return false;
        }
        seenLabels.add(plist.label);
        seenPaths.add(resolvedPath);
        return true;
      }) &&
      (plists as Array<{ path: string }>).every(
        (plist, index, all) =>
          index === 0 ||
          resolve(all[index - 1]?.path ?? "").localeCompare(
            resolve(plist.path)
          ) < 0
      );
    if (
      record?.version === 1 &&
      typeof record.rootDir === "string" &&
      typeof record.service === "string" &&
      typeof record.planId === "string" &&
      RECOVERY_PLAN_ID_RE.test(
        (record as Record<string, string>).planId ?? ""
      ) &&
      typeof record.configFingerprint === "string" &&
      SHA256_RE.test(
        (record as Record<string, string>).configFingerprint ?? ""
      ) &&
      validPlists &&
      typeof record.preparedAt === "string"
    ) {
      return parsed as AutosyncRecoveryPreparedPlan;
    }
    throw new Error(`Invalid autosync recovery plan: ${pathValue}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function cleanupAutosyncRecovery(args: {
  homeDir?: string;
  rootDir: string;
  service: string;
  expectedPlanId: string;
  approved: boolean;
}): Promise<AutosyncRecoveryCleanupResult> {
  const homeDir = args.homeDir ?? homedir();
  const rootDir = resolve(args.rootDir);
  const service = args.service.trim();
  const expectedPlanId = args.expectedPlanId.trim();
  if (!(service && RECOVERY_PLAN_ID_RE.test(expectedPlanId))) {
    throw new Error(
      "Autosync cleanup requires an explicit service and a 24-character lowercase hex expected plan id."
    );
  }
  if (!args.approved) {
    throw new Error(
      `fclt autosync cleanup requires the explicit ${LEGACY_MANAGED_MUTATION_FLAG} flag from the current doctor action. Ambient environment approval is intentionally ignored.`
    );
  }

  const receiptPath = autosyncRecoveryReceiptPath(
    homeDir,
    rootDir,
    expectedPlanId
  );
  const planPath = autosyncRecoveryPlanPath(homeDir, rootDir, expectedPlanId);
  return await withAutosyncMutationLock({
    homeDir,
    rootDir,
    operation: `cleanup:${service}`,
    fn: async () => {
      const [previous, prepared, before] = await Promise.all([
        loadAutosyncRecoveryReceipt(receiptPath),
        loadAutosyncRecoveryPreparedPlan({
          pathValue: planPath,
          homeDir,
          service,
        }),
        inspectAutosyncRecovery({ homeDir, rootDir }),
      ]);
      for (const record of [previous, prepared]) {
        if (
          record &&
          (resolve(record.rootDir) !== rootDir ||
            record.service !== service ||
            record.planId !== expectedPlanId)
        ) {
          throw new Error(
            `Autosync recovery record does not match the selected root and service: ${record === previous ? receiptPath : planPath}`
          );
        }
      }
      if (previous && resolve(previous.receiptPath) !== resolve(receiptPath)) {
        throw new Error(
          `Autosync recovery receipt path does not match its owned location: ${receiptPath}`
        );
      }
      const labels = new Set(autosyncLabelCandidates(service));
      const currentPlistSnapshots = before.plistSnapshots
        .filter((plist) => labels.has(plist.label))
        .sort((a, b) => a.path.localeCompare(b.path));
      const hasOwnedRuntime =
        before.ownedPlists.some((plist) => labels.has(plist.label)) ||
        before.ownedLoadedLabels.some((label) => labels.has(label));
      const serviceRecords = before.configured.filter(
        (record) => record.service === service
      );
      const selected = serviceRecords.find(
        (record) => record.state === "valid" && record.planId === expectedPlanId
      );
      if (prepared) {
        if (before.configFingerprints[service] !== prepared.configFingerprint) {
          throw new Error(
            "Autosync recovery config changed after the cleanup plan was prepared; refusing to attest the stale plan. Run `fclt doctor --json` again."
          );
        }
        const expectedPlists = new Map(
          prepared.plists.map((plist) => [resolve(plist.path), plist] as const)
        );
        if (
          currentPlistSnapshots.some((plist) => {
            const expected = expectedPlists.get(resolve(plist.path));
            return !(
              expected &&
              expected.label === plist.label &&
              expected.hash === plist.hash
            );
          })
        ) {
          throw new Error(
            "Autosync recovery plist state changed after the cleanup plan was prepared; refusing to continue the stale plan. Run `fclt doctor --json` again."
          );
        }
      }
      const unsafe =
        before.coverage.configs !== "checked" ||
        before.coverage.launchAgents !== "checked" ||
        before.coverage.launchd === "unavailable" ||
        before.orphanedLabels.length > 0 ||
        serviceRecords.length === 0 ||
        serviceRecords.some((record) => record.state !== "valid") ||
        before.ownedLoadedLabels.some(
          (label) =>
            labels.has(label) &&
            !currentPlistSnapshots.some((plist) => plist.label === label)
        ) ||
        before.reasonCodes.some((code) =>
          [
            "autosync_config_invalid",
            "autosync_config_conflict",
            "autosync_config_foreign_root",
            "autosync_launch_agent_ownership_mismatch",
            "autosync_loaded_root_mismatch",
            "autosync_loaded_ownership_unproven",
          ].includes(code)
        );
      if (unsafe) {
        throw new Error(
          "Autosync recovery state is incomplete or ambiguous; refusing cleanup. Review `fclt doctor --json`."
        );
      }
      if (previous && !hasOwnedRuntime) {
        return { ...previous, changed: false, alreadyApplied: true };
      }
      if (!hasOwnedRuntime) {
        if (!prepared) {
          throw new Error(
            "Autosync recovery plan is stale or no cleanup is pending. Run `fclt doctor --json` and use the newly reported action."
          );
        }
        const recoveredReceipt: AutosyncRecoveryCleanupResult = {
          version: 1,
          rootDir,
          service,
          planId: expectedPlanId,
          changed: true,
          alreadyApplied: false,
          receiptPath,
          appliedAt: new Date().toISOString(),
          dispositions: [],
          preserves: [
            "canonical_capability",
            "live_tool_state",
            "managed_state",
            "autosync_config",
            "backups",
          ],
        };
        const staged = await stageJsonFile(receiptPath, recoveredReceipt);
        try {
          await staged.commit();
        } finally {
          await staged.discard();
        }
        return recoveredReceipt;
      }
      if (!(selected || prepared)) {
        throw new Error(
          "Autosync recovery plan is stale or no longer matches owned files. Run `fclt doctor --json` and use the newly reported action."
        );
      }
      let recoveryPlan = prepared;
      if (!recoveryPlan) {
        const configFingerprint = before.configFingerprints[service];
        if (!(configFingerprint && SHA256_RE.test(configFingerprint))) {
          throw new Error(
            "Autosync recovery could not fingerprint the selected service config."
          );
        }
        if (currentPlistSnapshots.length === 0) {
          throw new Error(
            "Autosync recovery could not bind the selected service to an owned LaunchAgent plist."
          );
        }
        recoveryPlan = {
          version: 1,
          rootDir,
          service,
          planId: expectedPlanId,
          configFingerprint,
          plists: currentPlistSnapshots,
          preparedAt: new Date().toISOString(),
        };
        const staged = await stageJsonFile(planPath, recoveryPlan);
        try {
          await staged.commit();
        } finally {
          await staged.discard();
        }
      }

      const unloaded = await unloadAutosyncLaunchAgents({
        homeDir,
        rootDir,
        serviceName: service,
      });
      const expectedPlists = new Map(
        recoveryPlan.plists.map(
          (plist) => [resolve(plist.path), plist] as const
        )
      );
      for (const pathValue of unloaded.ownedPaths) {
        const expected = expectedPlists.get(resolve(pathValue));
        if (
          !expected ||
          unloaded.ownedHashes.get(pathValue) !== expected.hash
        ) {
          throw new Error(
            `Autosync recovery LaunchAgent no longer matches the prepared plan: ${pathValue}`
          );
        }
      }
      await removeAutosyncLaunchAgentPlists(
        unloaded.ownedPaths,
        unloaded.ownedHashes
      );
      const after = await inspectAutosyncRecovery({ homeDir, rootDir });
      if (
        after.coverage.configs !== "checked" ||
        after.coverage.launchAgents !== "checked" ||
        after.coverage.launchd === "unavailable" ||
        after.configFingerprints[service] !== recoveryPlan.configFingerprint ||
        after.configured
          .filter((record) => record.service === service)
          .some((record) => record.state !== "valid") ||
        after.ownedPlists.some((plist) => labels.has(plist.label)) ||
        after.ownedLoadedLabels.some((label) => labels.has(label))
      ) {
        throw new Error(
          "Autosync cleanup postflight could not prove the owned background service was contained."
        );
      }

      const receipt: AutosyncRecoveryCleanupResult = {
        version: 1,
        rootDir,
        service,
        planId: expectedPlanId,
        changed: unloaded.changed || unloaded.ownedPaths.size > 0,
        alreadyApplied: false,
        receiptPath,
        appliedAt: new Date().toISOString(),
        dispositions: [
          ...(unloaded.changed ? (["launch_agent_unloaded"] as const) : []),
          ...(unloaded.ownedPaths.size > 0
            ? (["owned_plist_removed"] as const)
            : []),
        ],
        preserves: [
          "canonical_capability",
          "live_tool_state",
          "managed_state",
          "autosync_config",
          "backups",
        ],
      };
      const staged = await stageJsonFile(receiptPath, receipt);
      try {
        await staged.commit();
      } finally {
        await staged.discard();
      }
      return receipt;
    },
  });
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
  const serviceName = await configuredAutosyncServiceName({
    homeDir: home,
    rootDir,
    tool: args.tool,
  });
  const configExists = await autosyncConfigArtifactsExist(
    serviceName,
    home,
    rootDir
  );
  const config = await loadAutosyncConfig(serviceName, home, rootDir);
  const state = await loadAutosyncRuntimeState(serviceName, home, rootDir);
  const currentPlistPath = autosyncPlistPath(home, serviceName);
  const legacyPlistPath = join(
    home,
    "Library",
    "LaunchAgents",
    `${legacyAutosyncLabel(serviceName)}.plist`
  );
  const ownership = await inspectAutosyncPlistOwnership({
    homeDir: home,
    rootDir,
    serviceName,
  });
  const legacyPlistOwned = ownership.ownedPaths.has(legacyPlistPath);
  const currentPlistOwned = ownership.ownedPaths.has(currentPlistPath);
  const plistPath = legacyPlistOwned
    ? legacyPlistPath
    : currentPlistOwned
      ? currentPlistPath
      : (ownership.foreignPaths[0] ?? currentPlistPath);
  const plistExists = currentPlistOwned || legacyPlistOwned;
  const domain = launchdDomain();
  const launchctlChecks = await Promise.all([
    runLaunchctl(["print", `${domain}/${autosyncLabel(serviceName)}`]).catch(
      () => ({
        exitCode: 1,
        stdout: "",
        stderr: "launchctl unavailable",
      })
    ),
    runLaunchctl([
      "print",
      `${domain}/${legacyAutosyncLabel(serviceName)}`,
    ]).catch(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "launchctl unavailable",
    })),
  ]);
  const ownedLoaded = [
    currentPlistOwned &&
    launchctlServiceMatchesRoot(launchctlChecks[0], rootDir)
      ? launchctlChecks[0]
      : null,
    legacyPlistOwned && launchctlServiceMatchesRoot(launchctlChecks[1], rootDir)
      ? launchctlChecks[1]
      : null,
  ].find((result) => result?.exitCode === 0);
  const unownedLoaded = [
    currentPlistOwned &&
    launchctlServiceMatchesRoot(launchctlChecks[0], rootDir)
      ? null
      : launchctlChecks[0],
    legacyPlistOwned && launchctlServiceMatchesRoot(launchctlChecks[1], rootDir)
      ? null
      : launchctlChecks[1],
  ].some((result) => result?.exitCode === 0);
  const configOwnershipMismatch =
    configExists && !(config && autosyncConfigMatchesRoot(config, rootDir));
  const ownershipMismatch =
    configOwnershipMismatch ||
    ownership.foreignPaths.length > 0 ||
    unownedLoaded;
  const launchctl = ownedLoaded ?? launchctlChecks[0];

  return {
    serviceName,
    config,
    state,
    plistPath,
    plistExists,
    loaded: Boolean(ownedLoaded),
    ownershipMismatch,
    launchctlSummary: ownershipMismatch
      ? "service label or plist does not match the selected canonical root"
      : ownedLoaded
        ? launchctl.stdout.trim()
        : launchctl.stderr.trim() || launchctl.stdout.trim() || undefined,
  };
}

export async function autosyncCommand(argv: string[]) {
  await autosyncCommandWithScope(argv, false);
}

async function autosyncCommandWithScope(
  argv: string[],
  rootScopeActive: boolean
) {
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
    const home = process.env.HOME?.trim() || homedir();
    const rootDir = resolveCliContextRoot({
      homeDir: home,
      rootArg: parsed.rootArg,
      scope: parsed.scope,
      cwd: process.cwd(),
    });
    const scope = resolveCliContextScope({
      homeDir: home,
      rootDir,
      scope: parsed.scope,
    });
    if (!rootScopeActive) {
      await withFacultRootScope({ rootDir, scope }, async () =>
        autosyncCommandWithScope(argv, true)
      );
      return;
    }
    const allowLegacyManagedMutation = legacyManagedMutationApproved({
      argv: parsed.argv,
    });

    if (sub === "install") {
      throw new Error(
        "Background autosync installation is disabled while broad managed mutation is contained. Use autosync status or uninstall; a reviewed one-time migration may use autosync run --once with explicit approval."
      );
    }

    if (sub === "cleanup") {
      if (!parsed.rootArg && parsed.scope === "merged") {
        throw new Error(
          "Autosync cleanup requires an explicit --root, --global, or --project selection."
        );
      }
      const service = parseAutosyncStringFlag(parsed.argv, "--service");
      const expectedPlanId = parseAutosyncStringFlag(
        parsed.argv,
        "--expected-plan"
      );
      if (!(service && expectedPlanId)) {
        throw new Error(
          "Autosync cleanup requires --service and --expected-plan from the current doctor report."
        );
      }
      const result = await cleanupAutosyncRecovery({
        homeDir: home,
        rootDir,
        service,
        expectedPlanId,
        approved: parsed.argv.includes(LEGACY_MANAGED_MUTATION_FLAG),
      });
      if (parsed.argv.includes("--json")) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.alreadyApplied) {
        console.log(`Autosync recovery already applied: ${result.planId}`);
      } else {
        console.log(`Contained autosync service: ${result.service}`);
        console.log(`Recovery receipt: ${result.receiptPath}`);
      }
      return;
    }

    if (sub === "uninstall") {
      const tool = parseAutosyncPositionals(parsed.argv, [])[0];
      const serviceName = await configuredAutosyncServiceName({
        homeDir: home,
        rootDir,
        tool,
      });
      await uninstallAutosyncService({ homeDir: home, tool, rootDir });
      console.log(`Removed autosync service: ${serviceName}`);
      return;
    }

    if (sub === "status") {
      const tool = parseAutosyncPositionals(parsed.argv, [])[0];
      const status = await autosyncStatus({ homeDir: home, tool, rootDir });
      console.log(`Service: ${status.serviceName}`);
      console.log(`Plist: ${status.plistPath}`);
      console.log(`Installed: ${status.plistExists ? "yes" : "no"}`);
      console.log(`Loaded: ${status.loaded ? "yes" : "no"}`);
      if (status.ownershipMismatch) {
        console.log("Ownership: mismatch; no cleanup is safe for this root");
      }
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
      throw new Error(
        "Background autosync restart is disabled while broad managed mutation is contained. Use autosync status or uninstall."
      );
    }

    if (sub === "run") {
      if (!parsed.argv.includes("--once")) {
        throw new Error(
          "Continuous autosync run is disabled while broad managed mutation is contained. A reviewed legacy migration must use --once with explicit approval."
        );
      }
      const service = parseAutosyncStringFlag(parsed.argv, "--service");
      const tool = parseAutosyncPositionals(parsed.argv, ["--service"])[0];
      const serviceName =
        service ??
        (await configuredAutosyncServiceName({
          homeDir: home,
          rootDir,
          tool,
        }));
      const config = await loadAutosyncConfig(serviceName, home, rootDir);
      if (!config) {
        if (await autosyncConfigArtifactsExist(serviceName, home, rootDir)) {
          throw new Error(
            `Autosync service config is invalid; refusing to run without proven ownership: ${serviceName}`
          );
        }
        throw new Error(`Autosync service not configured: ${serviceName}`);
      }
      await runAutosyncService(config, {
        homeDir: home,
        once: parsed.argv.includes("--once"),
        expectedRootDir: rootDir,
        allowLegacyManagedMutation,
      });
      return;
    }

    throw new Error(`Unknown autosync command: ${sub}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
