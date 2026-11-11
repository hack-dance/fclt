import { join } from "node:path";
import {
  canonicalProjectAiRoot,
  facultAiStateDir,
  facultAiWritebackQueuePath,
  legacyFacultAiStateDirs,
  pathsPhysicallyEquivalent,
  projectRootFromAiRoot,
} from "./paths";

export interface WritebackScopeMetadata {
  scope?: unknown;
  sourceRoot?: unknown;
  projectRoot?: unknown;
}

/** Preserve logical-read migration precedence, with the current queue read last. */
export function writebackQueueReadPaths(args: {
  homeDir: string;
  rootDir: string;
}): string[] {
  const scope = projectRootFromAiRoot(args.rootDir, args.homeDir)
    ? "project"
    : "global";
  const current = facultAiWritebackQueuePath(args.homeDir, args.rootDir);
  const legacy = [
    facultAiStateDir(args.homeDir, args.rootDir),
    ...legacyFacultAiStateDirs(args.homeDir, args.rootDir),
  ].map((dir) => join(dir, scope, "writeback", "queue.jsonl"));
  return [...new Set(legacy.filter((path) => path !== current)), current];
}

/** Legacy rows can omit scope; explicit context claims must match the selected queue. */
export function writebackMatchesContext(args: {
  record: WritebackScopeMetadata;
  homeDir: string;
  rootDir: string;
}): boolean {
  const { record, homeDir, rootDir } = args;
  const projectRoot = projectRootFromAiRoot(rootDir, homeDir);
  const scope = projectRoot ? "project" : "global";
  if (record.scope !== undefined && record.scope !== scope) {
    return false;
  }
  try {
    const projectMatches =
      Boolean(record.projectRoot) &&
      typeof record.projectRoot === "string" &&
      projectRoot &&
      pathsPhysicallyEquivalent(record.projectRoot, projectRoot);
    const rootMatches =
      projectMatches ||
      !record.sourceRoot ||
      (typeof record.sourceRoot === "string" &&
        pathsPhysicallyEquivalent(
          canonicalProjectAiRoot(record.sourceRoot, homeDir),
          canonicalProjectAiRoot(rootDir, homeDir)
        ));
    return Boolean(
      rootMatches && (!(record.projectRoot && projectRoot) || projectMatches)
    );
  } catch {
    return false;
  }
}
