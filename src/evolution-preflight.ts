import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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

/**
 * Resolve the primary checkout when a project root is a linked (generated) Git
 * worktree. `linked` is true whenever `.git` is a pointer file; `primary` is
 * null when it cannot be resolved (the worktree is still treated as linked).
 */
export function linkedWorktreePrimaryCheckout(projectRoot: string): {
  linked: boolean;
  primary: string | null;
} {
  const unlinked = { linked: false, primary: null };
  try {
    if (!lstatSync(join(projectRoot, ".git")).isFile()) {
      return unlinked;
    }
  } catch {
    return unlinked;
  }
  // A `.git` pointer file alone also describes submodules and
  // `--separate-git-dir` checkouts. Only a linked worktree has a private Git
  // directory that differs from the shared common directory.
  const result = spawnSync(
    "git",
    [
      "-C",
      projectRoot,
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
    ],
    {
      encoding: "utf8",
      env: {
        ...withoutLocalGitEnvironment(process.env),
        GIT_OPTIONAL_LOCKS: "0",
      },
      stdio: ["ignore", "pipe", "ignore"],
    }
  );
  const [gitDir, commonDir] =
    result.status === 0 && typeof result.stdout === "string"
      ? result.stdout.trim().split("\n")
      : [];
  if (!(gitDir && commonDir)) {
    // Unresolvable pointer: treat as linked so preflight never probes writes.
    return { linked: true, primary: null };
  }
  if (resolve(gitDir) === resolve(commonDir)) {
    return unlinked;
  }
  const common = resolve(commonDir);
  const primary = basename(common) === ".git" ? dirname(common) : null;
  return {
    linked: true,
    primary:
      primary && resolve(primary) !== resolve(projectRoot) ? primary : null,
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
      const worktree = projectRoot
        ? linkedWorktreePrimaryCheckout(projectRoot)
        : { linked: false, primary: null };
      const reviewConfigAbsent =
        loopConfigAbsent ||
        !existsSync(join(args.rootDir, "reconciliation.json"));
      if (worktree.linked && reviewConfigAbsent) {
        const primaryCheckout = worktree.primary;
        const target = primaryCheckout
          ? `the primary checkout ${primaryCheckout}`
          : "the repository's primary checkout (it could not be resolved from this worktree)";
        // `.ai/` review configuration is machine-local and ignored, so a
        // generated worktree never carries the enrolled loop. Probing writes
        // here would only create orphaned per-worktree state directories.
        return {
          version: 1,
          status: "blocked" as const,
          blocker: "linked-worktree-without-loop-config",
          queueAvailable: false,
          loopInvoked: false,
          runtime: process.execPath,
          enabled,
          configError,
          primaryCheckout,
          checks: [],
          recovery: `This is a generated/linked worktree without the enrolled review configuration. Run the scheduled review from ${target} (task execution environment: local, not a generated worktree). Do not invoke the loop here.`,
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
