import { mkdir, mkdtemp, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
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
      try {
        const config = await loadEvolutionLoopConfig(args);
        enabled = config?.enabled === true;
      } catch (error) {
        configError = error instanceof Error ? error.message : String(error);
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
        status: enabled && denied.length === 0 ? "ready" : "blocked",
        queueAvailable: false,
        loopInvoked: false,
        runtime: process.execPath,
        enabled,
        configError,
        checks,
        recovery:
          denied.length > 0
            ? `Authorize writes to these fclt state/review directories in the task execution environment: ${denied.map((check) => check.path).join(", ")}. Run preflight again before invoking the loop.`
            : enabled
              ? null
              : "Inspect the loop configuration and enable the intended scope before invoking the loop.",
      };
    }
  );
}
