import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { refreshAiReviewArtifacts } from "./ai";
import { buildDoctorReport, type DoctorReport } from "./doctor";
import { type SetupCodexPluginResult, setupCodexPlugin } from "./manage";
import { facultRootDir } from "./paths";
import {
  findGitRootFromPath,
  scaffoldBuiltinOperatingModelPack,
  scaffoldBuiltinProjectAiPack,
} from "./remote";

export interface BootstrapOptions {
  cwd?: string;
  homeDir?: string;
  dryRun?: boolean;
  includeProject?: boolean;
  installCodexPlugin?: boolean;
  installInCodex?: boolean;
  codexBin?: string | null;
}

export interface BootstrapResult {
  version: 1;
  dryRun: boolean;
  health: "ready" | "degraded" | "blocked";
  cwd: string;
  homeDir: string;
  globalRoot: string;
  projectRoot: string | null;
  changedPaths: string[];
  skippedPaths: string[];
  codexPlugin: SetupCodexPluginResult | null;
  readiness: {
    global: DoctorReport;
    project: DoctorReport | null;
  };
  repairActions: Array<{
    scope: "global" | "project" | "codex";
    command: string;
    reason: string;
  }>;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function reportRepairs(
  report: DoctorReport,
  scope: "global" | "project"
): BootstrapResult["repairActions"] {
  return report.actions.map((action) => ({
    scope,
    command: action.command,
    reason: action.label,
  }));
}

export async function bootstrapFclt(
  opts: BootstrapOptions = {}
): Promise<BootstrapResult> {
  const homeDir = resolve(
    opts.homeDir ?? process.env.HOME?.trim() ?? homedir()
  );
  const cwd = resolve(opts.cwd ?? process.cwd());
  const globalRoot = facultRootDir(homeDir);
  const detectedProject = findGitRootFromPath(cwd);
  const includeProject = opts.includeProject ?? detectedProject !== null;
  const projectRoot = includeProject
    ? join(detectedProject ?? cwd, ".ai")
    : null;
  const changedPaths: string[] = [];
  const skippedPaths: string[] = [];

  const globalInstall = await scaffoldBuiltinOperatingModelPack({
    rootDir: globalRoot,
    homeDir,
    dryRun: opts.dryRun,
    update: true,
  });
  changedPaths.push(...globalInstall.changedPaths);
  skippedPaths.push(...(globalInstall.skippedPaths ?? []));

  if (!opts.dryRun) {
    await refreshAiReviewArtifacts({ homeDir, rootDir: globalRoot });
  }

  if (projectRoot) {
    const projectInstall = await scaffoldBuiltinProjectAiPack({
      cwd: detectedProject ?? cwd,
      rootDir: projectRoot,
      homeDir,
      dryRun: opts.dryRun,
      update: true,
    });
    changedPaths.push(...projectInstall.changedPaths);
    skippedPaths.push(...(projectInstall.skippedPaths ?? []));
    if (!opts.dryRun) {
      await refreshAiReviewArtifacts({ homeDir, rootDir: projectRoot });
    }
  }

  const codexBin =
    opts.codexBin === undefined ? Bun.which("codex") : opts.codexBin;
  const installCodexPlugin = opts.installCodexPlugin ?? codexBin !== null;
  const codexPlugin = installCodexPlugin
    ? await setupCodexPlugin({
        homeDir,
        dryRun: opts.dryRun,
        installInCodex: opts.installInCodex,
        codexBin,
      })
    : null;
  if (codexPlugin) {
    changedPaths.push(...codexPlugin.changedPaths);
  }

  const [globalReadiness, projectReadiness] = await Promise.all([
    buildDoctorReport({ cwd, homeDir, rootArg: globalRoot, scope: "global" }),
    projectRoot
      ? buildDoctorReport({
          cwd,
          homeDir,
          rootArg: projectRoot,
          scope: "project",
        })
      : Promise.resolve(null),
  ]);
  const reports = [globalReadiness, projectReadiness].filter(
    (report): report is DoctorReport => report !== null
  );
  const coreBlocked = reports.some((report) => report.loop.state === "blocked");
  const coreDegraded = reports.some(
    (report) => report.loop.state === "degraded"
  );
  const pluginFailed = codexPlugin?.codexInstall.status === "failed";
  const pluginNeedsFreshSession =
    codexPlugin?.codexInstall.status === "succeeded";
  const repairActions = [
    ...reportRepairs(globalReadiness, "global"),
    ...(projectReadiness ? reportRepairs(projectReadiness, "project") : []),
    ...(pluginFailed
      ? [
          {
            scope: "codex" as const,
            command: "fclt setup codex-plugin",
            reason: "Retry the failed Codex plugin installation.",
          },
        ]
      : []),
    ...(pluginNeedsFreshSession
      ? [
          {
            scope: "codex" as const,
            command: "codex plugin list --json",
            reason:
              "Registration is proven; start a fresh Codex session to prove fclt tool discovery.",
          },
        ]
      : []),
  ];

  return {
    version: 1,
    dryRun: Boolean(opts.dryRun),
    health: coreBlocked
      ? "blocked"
      : coreDegraded || pluginFailed || pluginNeedsFreshSession
        ? "degraded"
        : "ready",
    cwd,
    homeDir,
    globalRoot,
    projectRoot,
    changedPaths: uniqueSorted(changedPaths),
    skippedPaths: uniqueSorted(skippedPaths),
    codexPlugin,
    readiness: {
      global: globalReadiness,
      project: projectReadiness,
    },
    repairActions,
  };
}

function printHelp(): void {
  console.log(`fclt setup — bootstrap a healthy writeback/evolution loop

Usage:
  fclt setup [--json] [--dry-run] [--global-only] [--no-codex-plugin]
  fclt setup codex-plugin [--dry-run] [--json] [--no-codex-install]

The default command initializes or safely updates the global operating model,
initializes the current git repository when present, prepares review state, and
installs the Codex plugin when Codex is available. It is safe to run again.

Options:
  --json                Print machine-readable bootstrap and readiness output
  --dry-run             Report planned writes without changing state
  --global-only         Do not initialize the current repository
  --no-codex-plugin     Keep setup CLI-only even when Codex is available
  --no-codex-install    Prepare plugin files without running codex plugin add
`);
}

export async function setupCommand(argv: string[]): Promise<void> {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    printHelp();
    return;
  }

  if (args[0] === "codex-plugin") {
    const { setupCommand: pluginSetupCommand } = await import("./manage");
    await pluginSetupCommand(args);
    return;
  }

  const unknownTarget = args.find(
    (arg) => !arg.startsWith("-") && arg !== "bootstrap"
  );
  if (unknownTarget) {
    console.error(`Unknown setup target: ${unknownTarget}`);
    process.exitCode = 2;
    return;
  }

  try {
    const result = await bootstrapFclt({
      dryRun: args.includes("--dry-run"),
      includeProject: args.includes("--global-only") ? false : undefined,
      installCodexPlugin: args.includes("--no-codex-plugin")
        ? false
        : undefined,
      installInCodex: !args.includes("--no-codex-install"),
    });
    if (args.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`fclt setup: ${result.health}`);
      console.log(`global: ${result.globalRoot}`);
      console.log(`project: ${result.projectRoot ?? "(none)"}`);
      console.log(`changed: ${result.changedPaths.length}`);
      if (result.repairActions.length > 0) {
        console.log("next actions:");
        for (const action of result.repairActions) {
          console.log(`- ${action.command} — ${action.reason}`);
        }
      }
    }
    if (result.health === "blocked" && !result.dryRun) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
