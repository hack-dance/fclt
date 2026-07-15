import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  type ActivityFeed,
  type ActivityItem,
  isActivityFeed,
} from "./activity";
import {
  type ActivityActionClass,
  type ActivityActionLocatorCandidate,
  activityActionRootIdentity,
  activityActionScopeBinding,
  createActivityActionLocator,
  parseActivityActionLocator,
} from "./activity-action-contract";
import type { AiProposalRecord } from "./ai";
import type { EvolutionLoopReport, LoopQueueItem } from "./evolution-loop";
import {
  facultAiEvolutionLoopConfigPath,
  facultAiEvolutionLoopReportDir,
  facultAiEvolutionLoopStatePath,
  facultAiProposalDir,
  facultAiStateDir,
  facultLocalStateRoot,
  facultMachineStateDir,
  legacyFacultAiStateDirs,
  machineStateProjectKey,
  preferredGlobalAiRoot,
} from "./paths";

const MAX_ACTIVITY_REPORT_BYTES = 2_000_000;
const MAX_ACTIVITY_STATE_BYTES = 100_000;
const MAX_PROPOSAL_BYTES = 2_000_000;
const MAX_PROJECT_SCOPE_DIRS = 1000;
const PROPOSAL_ID_PATTERN = /^EV-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RUNTIME_ID_PATTERN = /^[0-9a-f-]{36}$/;
const ROOT_IDENTITY_PATTERN = /^[a-f0-9]{64}$/;

export type ActivityActionResolutionErrorCode =
  | "invalid_locator"
  | "incompatible_locator"
  | "locator_not_found"
  | "stale_revision"
  | "duplicate_identity"
  | "locator_not_issued";

export type ActivityActionResolution =
  | {
      version: 1;
      kind: "activity-action-resolution";
      status: "resolved";
      resolvedAt: string;
      target: {
        scopeId: string;
        scope: "global" | "project";
        resource: {
          kind: ActivityActionLocatorCandidate["resourceKind"];
          id: string;
        };
        activity: {
          runId: string;
          revision: number;
        };
        allowedActionClass: ActivityActionClass;
      };
      plan: {
        summary: string;
        steps: string[];
        mutation: {
          available: false;
          performed: false;
          separateCommandRequired: true;
          approvalRequired: boolean;
          staleRevisionCheckRequired: true;
        };
      };
    }
  | {
      version: 1;
      kind: "activity-action-resolution";
      status: "rejected";
      error: {
        code: ActivityActionResolutionErrorCode;
        message: string;
        recoverable: true;
        next: string;
      };
    };

interface ResolvableScope {
  feed: ActivityFeed;
  report: EvolutionLoopReport;
  rootDir: string;
  scopeBinding: NonNullable<ReturnType<typeof activityActionScopeBinding>>;
}

interface MatchingCandidate {
  candidate: ActivityActionLocatorCandidate;
  item: LoopQueueItem;
  issuedItem?: ActivityItem;
  scope: ResolvableScope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedJson(
  pathValue: string,
  maxBytes: number
): Promise<unknown> {
  const info = await lstat(pathValue);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw new Error("Activity state is not a bounded regular file");
  }
  return JSON.parse(await readFile(pathValue, "utf8")) as unknown;
}

function isQueueItem(value: unknown): value is LoopQueueItem {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    (value.kind === "signal" ||
      value.kind === "proposal" ||
      value.kind === "coverage") &&
    typeof value.state === "string" &&
    Number.isInteger(value.revision) &&
    Number(value.revision) > 0 &&
    typeof value.firstSeenAt === "string" &&
    typeof value.lastSeenAt === "string" &&
    typeof value.lastChangedAt === "string" &&
    Array.isArray(value.linkedWork) &&
    value.linkedWork.every((entry) => typeof entry === "string") &&
    typeof value.approvalRequired === "boolean" &&
    Array.isArray(value.sourceIds) &&
    value.sourceIds.every((entry) => typeof entry === "string") &&
    Array.isArray(value.evidenceRefs) &&
    value.evidenceRefs.every((entry) => typeof entry === "string") &&
    (value.proposalId === undefined ||
      (typeof value.proposalId === "string" &&
        PROPOSAL_ID_PATTERN.test(value.proposalId))) &&
    (value.familyId === undefined || typeof value.familyId === "string") &&
    (value.proposalStatus === undefined ||
      typeof value.proposalStatus === "string")
  );
}

function isProposalRecord(
  value: unknown,
  id: string
): value is AiProposalRecord {
  return (
    isRecord(value) &&
    value.id === id &&
    typeof value.ts === "string" &&
    [
      "proposed",
      "drafted",
      "in_review",
      "accepted",
      "rejected",
      "applied",
      "failed",
      "superseded",
    ].includes(String(value.status)) &&
    (value.scope === "global" || value.scope === "project") &&
    typeof value.kind === "string" &&
    Array.isArray(value.targets) &&
    value.targets.every((entry) => typeof entry === "string") &&
    Array.isArray(value.sourceWritebacks) &&
    value.sourceWritebacks.every((entry) => typeof entry === "string") &&
    typeof value.summary === "string" &&
    typeof value.rationale === "string" &&
    (value.confidence === "low" ||
      value.confidence === "medium" ||
      value.confidence === "high") &&
    typeof value.reviewRequired === "boolean" &&
    typeof value.policyClass === "string" &&
    Array.isArray(value.draftRefs) &&
    value.draftRefs.every((entry) => typeof entry === "string")
  );
}

async function currentProposal(args: {
  homeDir: string;
  id: string;
  rootDir: string;
  scope: "global" | "project";
}): Promise<AiProposalRecord | null> {
  if (!PROPOSAL_ID_PATTERN.test(args.id)) {
    return null;
  }
  const dirs = [
    facultAiProposalDir(args.homeDir, args.rootDir),
    join(
      facultAiStateDir(args.homeDir, args.rootDir),
      args.scope,
      "evolution",
      "proposals"
    ),
    ...legacyFacultAiStateDirs(args.homeDir, args.rootDir).map((dir) =>
      join(dir, args.scope, "evolution", "proposals")
    ),
  ];
  for (const dir of new Set(dirs)) {
    try {
      const value = await readBoundedJson(
        join(dir, `${args.id}.json`),
        MAX_PROPOSAL_BYTES
      );
      if (isProposalRecord(value, args.id)) {
        return value;
      }
    } catch (error) {
      if (
        !(
          isRecord(error) &&
          (error.code === "ENOENT" || error.code === "ENOTDIR")
        )
      ) {
        return null;
      }
    }
  }
  return null;
}

async function latestReport(args: {
  configPath: string;
  reportDir: string;
  statePath: string;
  scope: "global" | "project";
}): Promise<{
  report: EvolutionLoopReport;
  rootIdentity: string;
  runtimeId: string;
} | null> {
  try {
    const config = await readBoundedJson(
      args.configPath,
      MAX_ACTIVITY_STATE_BYTES
    );
    if (
      !isRecord(config) ||
      config.version !== 1 ||
      config.scope !== args.scope ||
      !isRecord(config.actionLocator) ||
      config.actionLocator.version !== 1 ||
      typeof config.actionLocator.runtimeId !== "string" ||
      !RUNTIME_ID_PATTERN.test(config.actionLocator.runtimeId) ||
      typeof config.actionLocator.rootIdentity !== "string" ||
      !ROOT_IDENTITY_PATTERN.test(config.actionLocator.rootIdentity)
    ) {
      return null;
    }
    const state = await readBoundedJson(
      args.statePath,
      MAX_ACTIVITY_STATE_BYTES
    );
    if (
      !(
        isRecord(state) &&
        state.version === 1 &&
        typeof state.lastReportPath === "string"
      )
    ) {
      return null;
    }
    const reportName = basename(state.lastReportPath);
    if (!reportName.endsWith(".json")) {
      return null;
    }
    const value = await readBoundedJson(
      join(args.reportDir, reportName),
      MAX_ACTIVITY_REPORT_BYTES
    );
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      value.scope !== args.scope ||
      typeof value.runId !== "string" ||
      !Array.isArray(value.queue) ||
      !value.queue.every(isQueueItem) ||
      !isActivityFeed(value.activity) ||
      value.activity.scope !== args.scope ||
      value.activity.run.id !== value.runId
    ) {
      return null;
    }
    return {
      report: value as unknown as EvolutionLoopReport,
      rootIdentity: config.actionLocator.rootIdentity,
      runtimeId: config.actionLocator.runtimeId,
    };
  } catch {
    return null;
  }
}

async function isVerifiedCanonicalRoot(rootDir: string): Promise<boolean> {
  try {
    const info = await lstat(rootDir);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function globalScope(homeDir: string): Promise<ResolvableScope | null> {
  const rootDir = preferredGlobalAiRoot(homeDir);
  if (!(await isVerifiedCanonicalRoot(rootDir))) {
    return null;
  }
  const report = await latestReport({
    configPath: facultAiEvolutionLoopConfigPath(homeDir, rootDir),
    reportDir: facultAiEvolutionLoopReportDir(homeDir, rootDir),
    statePath: facultAiEvolutionLoopStatePath(homeDir, rootDir),
    scope: "global",
  });
  if (!report?.report.activity) {
    return null;
  }
  if (report.rootIdentity !== activityActionRootIdentity(rootDir)) {
    return null;
  }
  const scopeBinding = activityActionScopeBinding({
    homeDir,
    rootDir,
    runtimeId: report.runtimeId,
    scope: "global",
  });
  if (!scopeBinding) {
    return null;
  }
  return {
    feed: report.report.activity,
    report: report.report,
    rootDir,
    scopeBinding,
  };
}

async function projectScope(args: {
  entry: Dirent<string>;
  homeDir: string;
  projectsDir: string;
}): Promise<ResolvableScope | null> {
  const loopDir = join(
    args.projectsDir,
    args.entry.name,
    "ai",
    "project",
    "evolution",
    "loop"
  );
  const report = await latestReport({
    configPath: join(loopDir, "config.json"),
    reportDir: join(loopDir, "reports"),
    statePath: join(loopDir, "state.json"),
    scope: "project",
  });
  if (
    !(report?.report.activity && typeof report.report.projectRoot === "string")
  ) {
    return null;
  }
  const rootDir = join(report.report.projectRoot, ".ai");
  if (!(await isVerifiedCanonicalRoot(rootDir))) {
    return null;
  }
  if (report.rootIdentity !== activityActionRootIdentity(rootDir)) {
    return null;
  }
  if (machineStateProjectKey(rootDir, args.homeDir) !== args.entry.name) {
    return null;
  }
  if (
    resolve(facultMachineStateDir(args.homeDir, rootDir)) !==
    resolve(join(args.projectsDir, args.entry.name))
  ) {
    return null;
  }
  const scopeBinding = activityActionScopeBinding({
    homeDir: args.homeDir,
    rootDir,
    runtimeId: report.runtimeId,
    scope: "project",
  });
  if (!scopeBinding) {
    return null;
  }
  return {
    feed: report.report.activity,
    report: report.report,
    rootDir,
    scopeBinding,
  };
}

async function resolvableScopes(homeDir: string): Promise<ResolvableScope[]> {
  const scopes: ResolvableScope[] = [];
  const global = await globalScope(homeDir);
  if (global) {
    scopes.push(global);
  }
  const projectsDir = join(facultLocalStateRoot(homeDir), "projects");
  let entries: Dirent<string>[] = [];
  try {
    entries = (await readdir(projectsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return scopes;
  }
  if (entries.length > MAX_PROJECT_SCOPE_DIRS) {
    return scopes;
  }
  for (const entry of entries) {
    const project = await projectScope({ entry, homeDir, projectsDir });
    if (project) {
      scopes.push(project);
    }
  }
  return scopes;
}

function rejected(args: {
  code: ActivityActionResolutionErrorCode;
  message: string;
  next: string;
}): ActivityActionResolution {
  return {
    version: 1,
    kind: "activity-action-resolution",
    status: "rejected",
    error: { ...args, recoverable: true },
  };
}

function planFor(
  actionClass: ActivityActionClass,
  resource: { kind: string; id: string }
) {
  const actionStep: Record<ActivityActionClass, string> = {
    review:
      "Review the current evidence and proposed direction in the verified scope.",
    decide:
      "Review the current proposal, then explicitly accept or reject it through the separate workflow.",
    apply:
      "Preview the accepted proposal against current canonical state before any separately approved apply.",
    verify:
      "Collect fresh outcome evidence, then record verification through the separate workflow.",
    handoff:
      "Hand off the verified scope and resource target; this locator authorizes no mutation.",
  };
  return {
    summary: `${actionStep[actionClass]} Target: ${resource.kind} ${resource.id}.`,
    steps: [
      actionStep[actionClass],
      "Revalidate this locator immediately before any later lifecycle action.",
      "Do not invoke a mutation from this plan; locator-bound mutation is withheld until a separate command can atomically require approval and the expected binding revision.",
    ],
    mutation: {
      available: false as const,
      performed: false as const,
      separateCommandRequired: true as const,
      approvalRequired: actionClass !== "handoff",
      staleRevisionCheckRequired: true as const,
    },
  };
}

export async function resolveActivityActionLocator(args: {
  homeDir: string;
  locator: string;
  now?: () => Date;
}): Promise<ActivityActionResolution> {
  const parsed = parseActivityActionLocator(args.locator);
  if (!parsed.ok) {
    return rejected({
      code: parsed.code,
      message: parsed.message,
      next: "Refresh the aggregate activity set and use a current version 1 locator.",
    });
  }

  const matches: MatchingCandidate[] = [];
  for (const scope of await resolvableScopes(args.homeDir)) {
    for (const item of scope.report.queue) {
      const proposal = item.proposalId
        ? await currentProposal({
            homeDir: args.homeDir,
            id: item.proposalId,
            rootDir: scope.rootDir,
            scope: scope.scopeBinding.scope,
          })
        : null;
      const candidate = createActivityActionLocator({
        item,
        proposal,
        runId: scope.report.runId,
        scope: scope.scopeBinding,
      });
      if (candidate?.identityDigest !== parsed.identityDigest) {
        continue;
      }
      matches.push({
        candidate,
        item,
        issuedItem: scope.feed.items.find(
          (activityItem) =>
            activityItem.actionLocator === args.locator &&
            activityItem.technical.queueId === item.id
        ),
        scope,
      });
    }
  }

  if (matches.length === 0) {
    return rejected({
      code: "locator_not_found",
      message:
        "The locator no longer identifies a verified current scope and resource.",
      next: "Refresh activity. Missing state, moved or renamed roots, cross-project replay, and removed resources are intentionally not guessed.",
    });
  }
  if (matches.length > 1) {
    return rejected({
      code: "duplicate_identity",
      message:
        "More than one verified current target matched the locator identity, so resolution was refused.",
      next: "Refresh project registration and activity state before retrying.",
    });
  }
  const match = matches[0];
  if (!match) {
    throw new Error("Expected one activity action locator match");
  }
  if (match.candidate.bindingDigest !== parsed.bindingDigest) {
    return rejected({
      code: "stale_revision",
      message:
        "The scope, activity run, queue revision, resource lifecycle, or allowed action class changed.",
      next: "Refresh the aggregate activity set and resolve its new locator.",
    });
  }
  if (!match.issuedItem) {
    return rejected({
      code: "locator_not_issued",
      message:
        "The locator matches current state but was not issued by the current aggregate activity snapshot.",
      next: "Refresh the aggregate activity set and use the locator it returns.",
    });
  }

  return {
    version: 1,
    kind: "activity-action-resolution",
    status: "resolved",
    resolvedAt: (args.now?.() ?? new Date()).toISOString(),
    target: {
      scopeId: match.scope.scopeBinding.scopeId,
      scope: match.scope.scopeBinding.scope,
      resource: {
        kind: match.candidate.resourceKind,
        id: match.candidate.resourceId,
      },
      activity: {
        runId: match.scope.report.runId,
        revision: match.candidate.queueRevision,
      },
      allowedActionClass: match.candidate.actionClass,
    },
    plan: planFor(match.candidate.actionClass, {
      kind: match.candidate.resourceKind,
      id: match.candidate.resourceId,
    }),
  };
}

export function renderActivityActionResolution(
  resolution: ActivityActionResolution
): string {
  if (resolution.status === "rejected") {
    return [
      `Action locator rejected: ${resolution.error.message}`,
      `Next: ${resolution.error.next}`,
    ].join("\n");
  }
  return [
    `Resolved ${resolution.target.resource.kind} ${resolution.target.resource.id}`,
    `Scope: ${resolution.target.scopeId}`,
    `Allowed action: ${resolution.target.allowedActionClass}`,
    `Plan: ${resolution.plan.summary}`,
    "No mutation was performed.",
  ].join("\n");
}
