import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { automationStatus } from "./evolution-loop";
import {
  canonicalProjectAiRoot,
  facultLocalStateRoot,
  machineStateProjectKey,
} from "./paths";
import { registeredProjectLocations } from "./projects";

const STORE_NAME_RE =
  /^(?:worktree_[a-f0-9]{24}|repo_[a-f0-9]{24}|[a-z0-9-]+-[a-f0-9]{12})$/;
const STALE_AFTER_RE = /^([1-9]\d*)d$/;
const DAY_MS = 86_400_000;
const PATH_PART_RE = /[\\/]/;

export interface ProjectLoopStatus {
  projectKey: string;
  repositoryId: string | null;
  locations: string[];
  ephemeral: boolean;
  schedulerStatus: "ACTIVE" | "PAUSED" | "missing" | "unknown";
  lastRunAt: string | null;
  lastSuccessfulScheduledRunAt: string | null;
  stale: boolean;
  error?: string;
}

export function parseLoopStaleAfter(value = "8d"): number {
  const match = STALE_AFTER_RE.exec(value);
  const days = Number(match?.[1]);
  if (!Number.isSafeInteger(days) || days * DAY_MS > Number.MAX_SAFE_INTEGER) {
    throw new Error(
      "--stale-after requires a positive whole number of days, for example 8d"
    );
  }
  return days;
}

/** Reject symlinked state and bound reads; reporting never creates or repairs a store. */
async function readStoreJson(
  root: string,
  path: string
): Promise<Record<string, unknown> | null> {
  let current = resolve(root);
  for (const part of ["", ...relative(root, path).split(PATH_PART_RE)]) {
    current = join(current, part);
    try {
      const metadata = await lstat(current);
      if (
        metadata.isSymbolicLink() ||
        (current !== path && !metadata.isDirectory()) ||
        (current === path &&
          (!metadata.isFile() ||
            metadata.nlink !== 1 ||
            metadata.size > 1024 * 1024))
      ) {
        throw new Error(`Unsafe loop status path: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Malformed loop status data: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function timestamp(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("Invalid loop run timestamp");
  }
  return value;
}

export async function evolutionLoopPortfolioStatus(args: {
  homeDir: string;
  staleAfter?: string;
  now?: Date;
}) {
  const staleAfterDays = parseLoopStaleAfter(args.staleAfter);
  const now = args.now ?? new Date();
  const projectsRoot = join(facultLocalStateRoot(args.homeDir), "projects");
  const rows = new Map<string, ProjectLoopStatus>();
  function row(projectKey: string): ProjectLoopStatus {
    const existing = rows.get(projectKey);
    if (existing) {
      return existing;
    }
    const result: ProjectLoopStatus = {
      projectKey,
      repositoryId: null,
      locations: [],
      ephemeral: projectKey.startsWith("worktree_"),
      schedulerStatus: "missing",
      lastRunAt: null,
      lastSuccessfulScheduledRunAt: null,
      stale: true,
    };
    rows.set(projectKey, result);
    return result;
  }
  // Include enrolled projects even if they have never created loop state.
  for (const project of await registeredProjectLocations(args.homeDir)) {
    if (project.locations.length === 0) {
      row(project.repositoryId).repositoryId = project.repositoryId;
    }
    for (const location of project.locations) {
      let result: ProjectLoopStatus;
      try {
        const root = canonicalProjectAiRoot(
          join(location, ".ai"),
          args.homeDir
        );
        result = row(machineStateProjectKey(root, args.homeDir));
      } catch (error) {
        result = row(project.repositoryId);
        result.error = error instanceof Error ? error.message : String(error);
      }
      result.repositoryId = project.repositoryId;
      if (!result.locations.includes(location)) {
        result.locations.push(location);
      }
    }
  }
  try {
    const metadata = await lstat(projectsRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Unsafe projects directory: ${projectsRoot}`);
    }
    for (const entry of await readdir(projectsRoot, { withFileTypes: true })) {
      if (STORE_NAME_RE.test(entry.name)) {
        row(entry.name);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  for (const result of rows.values()) {
    try {
      const loopDir = join(
        projectsRoot,
        result.projectKey,
        "ai",
        "project",
        "evolution",
        "loop"
      );
      const config = await readStoreJson(
        projectsRoot,
        join(loopDir, "config.json")
      );
      const state = await readStoreJson(
        projectsRoot,
        join(loopDir, "state.json")
      );
      if ((config && config.version !== 1) || (state && state.version !== 1)) {
        throw new Error("Unsupported loop status schema");
      }
      const name =
        config?.automationName ?? `fclt-evolution-${result.projectKey}`;
      if (typeof name !== "string") {
        throw new Error("Invalid loop automation name");
      }
      const scheduler = await automationStatus({ homeDir: args.homeDir, name });
      result.schedulerStatus = scheduler.exists
        ? (scheduler.status ?? "unknown")
        : "missing";
      if (scheduler.error) {
        result.error = scheduler.error;
      }
      result.lastRunAt = timestamp(state?.lastRunAt);
      result.lastSuccessfulScheduledRunAt = timestamp(
        state?.lastSuccessfulScheduledRunAt
      );
      const age = result.lastRunAt
        ? now.getTime() - Date.parse(result.lastRunAt)
        : Number.NaN;
      result.stale =
        !Number.isFinite(age) || age < 0 || age > staleAfterDays * DAY_MS;
    } catch (error) {
      result.schedulerStatus = "unknown";
      result.error = error instanceof Error ? error.message : String(error);
      result.stale = true;
    }
  }
  return {
    version: 1,
    generatedAt: now.toISOString(),
    staleAfterDays,
    projects: [...rows.values()].sort((a, b) =>
      a.projectKey.localeCompare(b.projectKey)
    ),
  };
}
