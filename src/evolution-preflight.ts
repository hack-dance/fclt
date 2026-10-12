import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rmdir } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { loadEvolutionLoopConfig } from "./evolution-loop";
import {
  facultAiActivityHistoryDir,
  facultAiActivityHistorySegmentDir,
  facultAiDraftDir,
  facultAiEvolutionLoopConfigPath,
  facultAiEvolutionLoopLockPath,
  facultAiEvolutionLoopReportDir,
  facultAiEvolutionReviewDir,
  facultAiJournalPath,
  facultAiProposalDir,
  facultAiReconciliationReviewDir,
  facultAiReconciliationStatePath,
  facultAiWritebackQueuePath,
  facultAiWritebackReviewDir,
  projectRootFromAiRoot,
  withFacultRootScope,
} from "./paths";
import {
  loadReconciliationConfig,
  selectReconciliationSources,
} from "./reconciliation-config";
import { withoutLocalGitEnvironment } from "./util/git-environment";

const GIT_TIMEOUT_MS = 5000;
const REVIEW_INIT_HINT_RE = /\s*Run fclt ai review init\.?/;

export interface WorktreeClassification {
  linked: boolean;
  primary: string | null;
  /** Set when Git metadata exists but could not be inspected. */
  unresolved: string | null;
}

function runGitProbe(argv: string[]) {
  return spawnSync("git", argv, {
    encoding: "utf8",
    env: {
      ...withoutLocalGitEnvironment(process.env),
      GIT_OPTIONAL_LOCKS: "0",
    },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: GIT_TIMEOUT_MS,
  });
}

function hasGitMetadataAbove(start: string): boolean {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, ".git"))) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

function submodulePrimary(commonDir: string): string | null {
  const result = runGitProbe([
    `--git-dir=${commonDir}`,
    "config",
    "--get",
    "core.worktree",
  ]);
  const value =
    result.status === 0 && typeof result.stdout === "string"
      ? result.stdout.trim()
      : "";
  return value ? resolve(commonDir, value) : null;
}

/**
 * Classify the repository containing `projectRoot` (which may be a
 * subdirectory). Only a linked worktree has a private Git directory that
 * differs from the shared common directory; submodules and
 * `--separate-git-dir` checkouts are not linked.
 */
export function linkedWorktreePrimaryCheckout(
  projectRoot: string
): WorktreeClassification {
  const result = runGitProbe([
    "-C",
    projectRoot,
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
    "--show-toplevel",
  ]);
  const lines =
    result.status === 0 && typeof result.stdout === "string"
      ? result.stdout.trim().split("\n")
      : [];
  // Git < 2.31 echoes the unknown --path-format option instead of failing;
  // accept only exactly three absolute paths.
  const parsed =
    lines.length === 3 && lines.every((line) => isAbsolute(line)) ? lines : [];
  const [gitDir, commonDir, topLevel] = parsed;
  if (lines.length > 0 && parsed.length === 0) {
    return {
      linked: false,
      primary: null,
      unresolved:
        "git returned unexpected rev-parse output (git 2.31 or newer is required)",
    };
  }
  if (!(gitDir && commonDir && topLevel)) {
    if (!hasGitMetadataAbove(projectRoot)) {
      return { linked: false, primary: null, unresolved: null };
    }
    const error = result.error as NodeJS.ErrnoException | undefined;
    const unresolved =
      error?.code === "ENOENT"
        ? "git is not available on PATH in this execution environment"
        : error?.code === "ETIMEDOUT" || result.signal
          ? `git did not answer within ${GIT_TIMEOUT_MS} ms`
          : "git could not read this repository's metadata";
    return { linked: false, primary: null, unresolved };
  }
  if (resolve(gitDir) === resolve(commonDir)) {
    return { linked: false, primary: null, unresolved: null };
  }
  const common = resolve(commonDir);
  const primary =
    basename(common) === ".git" ? dirname(common) : submodulePrimary(common);
  const self = resolve(topLevel);
  // --show-toplevel is symlink-resolved; compare against the real project path.
  let realProject = resolve(projectRoot);
  try {
    realProject = realpathSync.native(realProject);
  } catch {
    // Keep the lexical path; relative() below then degrades to the root.
  }
  // Map a subdirectory .ai root to the matching subdirectory in the primary.
  const matching = primary ? join(primary, relative(self, realProject)) : null;
  return {
    linked: true,
    primary: primary && resolve(primary) !== self ? matching : null,
    unresolved: null,
  };
}

/** Probe the actual execution environment without reconciling or creating queue state. */
export async function preflightEvolutionLoop(args: {
  homeDir: string;
  rootDir: string;
  scope?: "project" | "global";
}) {
  return await withFacultRootScope(
    {
      rootDir: args.rootDir,
      scope:
        args.scope ??
        (projectRootFromAiRoot(args.rootDir, args.homeDir)
          ? "project"
          : "global"),
    },
    async () => {
      const checks: Array<{ path: string; writable: boolean; error?: string }> =
        [];
      let enabled = false;
      let configError: string | undefined;
      let loopConfigAbsent = false;
      try {
        const config = await loadEvolutionLoopConfig(args);
        loopConfigAbsent = config === null;
        enabled = config?.enabled === true;
        const reconciliation = await loadReconciliationConfig(args);
        selectReconciliationSources(reconciliation.config, config?.sourceIds);
      } catch (error) {
        configError = error instanceof Error ? error.message : String(error);
      }
      const projectRoot = projectRootFromAiRoot(args.rootDir, args.homeDir);
      const worktree: WorktreeClassification = projectRoot
        ? linkedWorktreePrimaryCheckout(projectRoot)
        : { linked: false, primary: null, unresolved: null };
      const reviewConfigAbsent =
        loopConfigAbsent ||
        !existsSync(join(args.rootDir, "reconciliation.json"));
      if ((worktree.linked || worktree.unresolved) && reviewConfigAbsent) {
        // `.ai/` review configuration is machine-local and ignored, so a
        // generated worktree never carries the enrolled loop. Probing writes
        // here would only create orphaned per-worktree state directories.
        const primaryCheckout = worktree.primary;
        const target = primaryCheckout
          ? `the primary checkout ${primaryCheckout}`
          : "the repository's primary checkout (it could not be resolved from here)";
        const recovery = worktree.unresolved
          ? `Review configuration is absent and the checkout type could not be determined: ${worktree.unresolved}. Fix Git access in the task execution environment and run preflight again. Do not run \`fclt ai review init\` or invoke the loop here.`
          : `This is a generated/linked worktree without the enrolled review configuration. Run the scheduled review from ${target} (task execution environment: local, not a generated worktree). Do not run \`fclt ai review init\` or invoke the loop here; that would create orphaned per-worktree state.`;
        return {
          version: 1,
          status: "blocked" as const,
          blocker: worktree.unresolved
            ? "worktree-unresolved"
            : "linked-worktree-without-loop-config",
          queueAvailable: false,
          loopInvoked: false,
          runtime: process.execPath,
          enabled,
          configError: configError
            ? configError.replace(REVIEW_INIT_HINT_RE, "")
            : undefined,
          primaryCheckout,
          checks: [],
          recovery,
        };
      }
      const paths = new Set([
        facultAiActivityHistoryDir(args.homeDir, args.rootDir),
        facultAiActivityHistorySegmentDir(args.homeDir, args.rootDir),
        facultAiDraftDir(args.homeDir, args.rootDir),
        dirname(facultAiJournalPath(args.homeDir, args.rootDir)),
        facultAiProposalDir(args.homeDir, args.rootDir),
        dirname(facultAiReconciliationStatePath(args.homeDir, args.rootDir)),
        dirname(facultAiWritebackQueuePath(args.homeDir, args.rootDir)),

        dirname(facultAiEvolutionLoopConfigPath(args.homeDir, args.rootDir)),
        dirname(facultAiEvolutionLoopLockPath(args.homeDir, args.rootDir)),
        facultAiEvolutionLoopReportDir(args.homeDir, args.rootDir),
        facultAiEvolutionReviewDir(args.homeDir, args.rootDir),
        facultAiReconciliationReviewDir(args.homeDir, args.rootDir),
        facultAiWritebackReviewDir(args.homeDir, args.rootDir),
      ]);
      for (const path of paths) {
        try {
          await mkdir(path, { recursive: true });
          const probe = await mkdtemp(join(path, ".fclt-preflight-"));
          await rmdir(probe);
          checks.push({ path, writable: true });
        } catch (error) {
          checks.push({
            path,
            writable: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const denied = checks.filter((check) => !check.writable);
      return {
        version: 1,
        status:
          enabled && !configError && denied.length === 0 ? "ready" : "blocked",
        blocker:
          denied.length > 0
            ? "state-write-denied"
            : configError
              ? "loop-config-invalid"
              : enabled
                ? null
                : "loop-disabled",
        queueAvailable: false,
        loopInvoked: false,
        runtime: process.execPath,
        enabled,
        configError,
        primaryCheckout: null,
        checks,
        recovery:
          denied.length > 0
            ? `Authorize writes to these fclt state/review directories in the task execution environment: ${denied.map((check) => check.path).join(", ")}. Run preflight again before invoking the loop.`
            : configError
              ? `Repair the review configuration before invoking the loop: ${configError}`
              : enabled
                ? null
                : "Inspect the loop configuration and enable the intended scope before invoking the loop.",
      };
    }
  );
}
