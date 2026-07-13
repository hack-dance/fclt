import { basename } from "node:path";
import type {
  AiProposalRecord,
  AiWritebackRecord,
  WritebackCategory,
  WritebackSensitivity,
} from "./ai";
import {
  type EvolutionLoopReport,
  type LoopQueueItem,
  latestEvolutionLoopReport,
} from "./evolution-loop";
import { reconciliationReviewById } from "./reconciliation";
import { redactReconciliationText } from "./reconciliation-adapters";
import type {
  CorrelatedSignal,
  ReconciliationReview,
  SourceCoverage,
} from "./reconciliation-types";

const MAX_OBSERVATIONS_PER_ITEM = 10;
const FILE_URL_PATH_RE = /\bfile:\/\/[^\s)\]}>"'`,;]+/gi;
const WINDOWS_ABSOLUTE_PATH_RE =
  /\b[A-Za-z]:[\\/](?:[^\\/\s)\]}>"'`,;]+[\\/])*[^\\/\s)\]}>"'`,;]*/g;
const UNC_ABSOLUTE_PATH_RE = /\\\\[^\\\s)\]}>"'`,;]+\\[^\s)\]}>"'`,;]+/g;
const HOME_RELATIVE_PATH_RE = /(^|[\s([{:="'`])~[\\/][^\s)\]}>"'`,;]+/g;
const POSIX_ABSOLUTE_PATH_RE = /(^|[\s([{:="'`])\/(?!\/)[^\s)\]}>"'`,;]+/g;
const HTTP_URL_RE = /\bhttps?:\/\/[^\s)\]}>"'`,;]+/gi;

export type ActivityCategory =
  | WritebackCategory
  | "signal"
  | "evolution"
  | "coverage";

export interface ActivityObservation {
  writebackId: string;
  category: WritebackCategory;
  sensitivity: WritebackSensitivity;
  summary: string;
  contextOmitted: boolean;
  details?: string;
  impact?: string;
  attemptedWorkaround?: string;
  desiredOutcome?: string;
}

export interface ActivityItem {
  id: string;
  kind: LoopQueueItem["kind"];
  categories: ActivityCategory[];
  title: string;
  state: LoopQueueItem["state"];
  change: "new" | "changed" | "resolved" | "unchanged";
  firstSeenAt: string;
  lastChangedAt: string;
  sourceLabels: string[];
  evidence: {
    count: number;
    types: string[];
    writebackIds: string[];
  };
  observations: ActivityObservation[];
  omittedObservations: number;
  decision: {
    disposition?: LoopQueueItem["disposition"];
    proposalStatus?: LoopQueueItem["proposalStatus"];
    rationale?: string;
    target?: string;
  };
  linkedWork: string[];
  approvalRequired: boolean;
  verification?: LoopQueueItem["verification"];
  nextAction: string;
  technical: {
    queueId: string;
    familyId?: string;
    proposalId?: string;
  };
}

export interface ActivityFeed {
  version: 1;
  mode: "latest";
  snapshot: "embedded" | "legacy-derived";
  generatedAt: string;
  scope: "global" | "project";
  project?: {
    key: string;
    name: string;
  };
  run: {
    id: string;
    status: EvolutionLoopReport["status"];
    reviewId?: string;
  };
  coverage: {
    complete: boolean;
    checked: number;
    degraded: number;
    sources: Array<{
      id: string;
      label: string;
      state: SourceCoverage["state"];
      detail?: string;
    }>;
  };
  counts: {
    total: number;
    needsAttention: number;
    new: number;
    changed: number;
    resolved: number;
    unchangedSuppressed: number;
  };
  items: ActivityItem[];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function redactActivityPaths(value: string): string {
  return value
    .replace(FILE_URL_PATH_RE, "file:///<redacted-path>")
    .replace(WINDOWS_ABSOLUTE_PATH_RE, "<redacted-path>")
    .replace(UNC_ABSOLUTE_PATH_RE, "<redacted-path>")
    .replace(
      HOME_RELATIVE_PATH_RE,
      (_match, prefix: string) => `${prefix}<redacted-path>`
    )
    .replace(
      POSIX_ABSOLUTE_PATH_RE,
      (_match, prefix: string) => `${prefix}<redacted-path>`
    );
}

export function redactPortableActivityText(value: string): string {
  const redactedSecrets = redactReconciliationText(value);
  let cursor = 0;
  let output = "";
  for (const match of redactedSecrets.matchAll(HTTP_URL_RE)) {
    const index = match.index;
    output += redactActivityPaths(redactedSecrets.slice(cursor, index));
    output += match[0];
    cursor = index + match[0].length;
  }
  return output + redactActivityPaths(redactedSecrets.slice(cursor));
}

function sourceLabel(sourceId: string): string {
  const normalized = sourceId
    .replaceAll(/[-_.]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return normalized
    ? normalized.replace(/\b\w/g, (value) => value.toUpperCase())
    : "Unknown source";
}

function projectKey(projectRoot: string): string {
  return basename(projectRoot)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

function inferredCategory(kind: string): WritebackCategory {
  const normalized = kind.toLowerCase().replaceAll("_", "-");
  if (
    normalized.includes("success") ||
    normalized.includes("pattern") ||
    normalized.includes("proof")
  ) {
    return "reusable-success";
  }
  if (
    normalized.includes("gap") ||
    normalized.includes("opportunity") ||
    normalized.includes("missing") ||
    normalized.includes("stale")
  ) {
    return "opportunity";
  }
  return "friction";
}

function signalForItem(
  item: LoopQueueItem,
  review: ReconciliationReview | null
): CorrelatedSignal | undefined {
  if (!(review && item.kind === "signal" && item.familyId)) {
    return undefined;
  }
  return review.signals.find(
    (signal) =>
      signal.familyId === item.familyId ||
      signal.familyAliases?.includes(item.familyId!) ||
      item.familyAliases?.includes(signal.familyId)
  );
}

function writebackIdsForSignal(
  signal: CorrelatedSignal | undefined,
  review: ReconciliationReview | null,
  writebacks: AiWritebackRecord[]
): string[] {
  if (!(signal && review)) {
    return [];
  }
  const evidenceKeys = new Set(signal.evidenceKeys);
  const familyRefs = new Set(
    [signal.familyId, ...(signal.familyAliases ?? [])].map(
      (familyId) => `signal-family:${familyId}`
    )
  );
  return unique([
    ...signal.writebackRefs,
    ...review.evidence
      .filter((entry) => evidenceKeys.has(entry.dedupeKey))
      .flatMap((entry) => entry.writebackRefs),
    ...writebacks
      .filter((record) =>
        record.evidence.some(
          (entry) =>
            entry.type === "reconciliation" && familyRefs.has(entry.ref)
        )
      )
      .map((record) => record.id),
  ]);
}

function itemChange(
  id: string,
  delta: EvolutionLoopReport["delta"]
): ActivityItem["change"] {
  if (delta.new.includes(id)) {
    return "new";
  }
  if (delta.changed.includes(id)) {
    return "changed";
  }
  if (delta.resolved.includes(id)) {
    return "resolved";
  }
  return "unchanged";
}

function observation(record: AiWritebackRecord): ActivityObservation {
  const capture = record.capture;
  const sensitivity = capture?.sensitivity ?? "internal";
  const contextOmitted = sensitivity === "private";
  return {
    writebackId: record.id,
    category: capture?.category ?? inferredCategory(record.kind),
    sensitivity,
    summary: redactPortableActivityText(record.summary),
    contextOmitted,
    details:
      !contextOmitted && capture?.details
        ? redactPortableActivityText(capture.details)
        : undefined,
    impact:
      !contextOmitted && capture?.impact
        ? redactPortableActivityText(capture.impact)
        : undefined,
    attemptedWorkaround:
      !contextOmitted && capture?.attemptedWorkaround
        ? redactPortableActivityText(capture.attemptedWorkaround)
        : undefined,
    desiredOutcome:
      !contextOmitted && capture?.desiredOutcome
        ? redactPortableActivityText(capture.desiredOutcome)
        : undefined,
  };
}

function nextAction(
  item: LoopQueueItem,
  observations: ActivityObservation[]
): string {
  if (item.kind === "coverage") {
    return "Restore or reconfigure this source, then rerun reconciliation.";
  }
  if (item.requestedExternalAction === "reopen") {
    return "Review the regression evidence before explicitly reopening linked work.";
  }
  if (item.state === "approval_needed") {
    return "Review the proposed capability direction; approve, redirect, or defer it explicitly.";
  }
  if (
    item.state === "verification_due" ||
    item.state === "verification_overdue" ||
    item.state === "verification_pending" ||
    item.state === "regressed"
  ) {
    return "Verify the expected outcome against fresh producing-loop evidence.";
  }
  if (item.state === "resolved") {
    return "No action unless the signal recurs.";
  }
  if (item.state === "deferred") {
    const desiredOutcome = observations.find(
      (entry) => entry.desiredOutcome
    )?.desiredOutcome;
    return desiredOutcome
      ? `Wait for the configured trigger; desired outcome: ${desiredOutcome}`
      : "Wait for the configured recurrence or review trigger.";
  }
  if (item.linkedWork.length > 0) {
    return "Track the linked implementation work and preserve outcome proof.";
  }
  return "Choose a disposition and the smallest durable target.";
}

function proposalForItem(
  item: LoopQueueItem,
  proposals: AiProposalRecord[]
): AiProposalRecord | undefined {
  return item.proposalId
    ? proposals.find((proposal) => proposal.id === item.proposalId)
    : undefined;
}

export function buildActivityFeed(args: {
  report: EvolutionLoopReport;
  review: ReconciliationReview | null;
  writebacks: AiWritebackRecord[];
  proposals: AiProposalRecord[];
  snapshot?: ActivityFeed["snapshot"];
}): ActivityFeed {
  const writebackById = new Map(
    args.writebacks.map((record) => [record.id, record])
  );
  const items = args.report.queue.map((item): ActivityItem => {
    const signal = signalForItem(item, args.review);
    const proposal = proposalForItem(item, args.proposals);
    const writebackIds =
      item.kind === "signal"
        ? writebackIdsForSignal(signal, args.review, args.writebacks)
        : item.kind === "proposal"
          ? (proposal?.sourceWritebacks ?? item.evidenceRefs)
          : [];
    const writebacks = writebackIds
      .map((id) => writebackById.get(id))
      .filter((record): record is AiWritebackRecord => Boolean(record))
      .sort((left, right) => left.id.localeCompare(right.id));
    const allObservations = writebacks.map(observation);
    const observations = allObservations.slice(0, MAX_OBSERVATIONS_PER_ITEM);
    const evidenceTypes = unique(
      writebacks.flatMap((record) =>
        record.evidence.map((evidence) => evidence.type)
      )
    );
    const evidenceCount = unique(
      writebacks.flatMap((record) =>
        record.evidence.map((evidence) => `${evidence.type}:${evidence.ref}`)
      )
    ).length;
    const categories: ActivityCategory[] =
      item.kind === "coverage"
        ? ["coverage"]
        : item.kind === "proposal"
          ? ["evolution"]
          : observations.length
            ? (unique(
                observations.map((entry) => entry.category)
              ) as ActivityCategory[])
            : ["signal"];
    return {
      id: item.id,
      kind: item.kind,
      categories,
      title: redactPortableActivityText(item.title),
      state: item.state,
      change: itemChange(item.id, args.report.delta),
      firstSeenAt: item.firstSeenAt,
      lastChangedAt: item.lastChangedAt,
      sourceLabels: item.sourceIds.map((sourceId) =>
        redactPortableActivityText(sourceLabel(sourceId))
      ),
      evidence: {
        count: evidenceCount || item.evidenceRefs.length,
        types: evidenceTypes.map(redactPortableActivityText),
        writebackIds,
      },
      observations,
      omittedObservations: allObservations.length - observations.length,
      decision: {
        disposition: item.disposition,
        proposalStatus: item.proposalStatus,
        rationale: signal?.rationale
          ? redactPortableActivityText(signal.rationale)
          : proposal?.rationale
            ? redactPortableActivityText(proposal.rationale)
            : undefined,
        target: signal?.dispositionTarget
          ? redactPortableActivityText(signal.dispositionTarget)
          : proposal?.targets.length
            ? proposal.targets.map(redactPortableActivityText).join(", ")
            : undefined,
      },
      linkedWork: item.linkedWork.map(redactPortableActivityText),
      approvalRequired: item.approvalRequired,
      verification: item.verification,
      nextAction: redactPortableActivityText(nextAction(item, observations)),
      technical: {
        queueId: item.id,
        familyId: item.familyId,
        proposalId: item.proposalId,
      },
    };
  });
  const degradedSources = args.report.coverage.filter(
    (entry) => entry.state === "unavailable" || entry.state === "stale"
  );
  return {
    version: 1,
    mode: "latest",
    snapshot: args.snapshot ?? "embedded",
    generatedAt: args.report.generatedAt,
    scope: args.report.scope,
    project: args.report.projectRoot
      ? {
          key: projectKey(args.report.projectRoot),
          name: basename(args.report.projectRoot),
        }
      : undefined,
    run: {
      id: args.report.runId,
      status: args.report.status,
      reviewId: args.report.reviewId,
    },
    coverage: {
      complete: args.report.coverageComplete,
      checked: args.report.coverage.length - degradedSources.length,
      degraded: degradedSources.length,
      sources: args.report.coverage.map((entry) => ({
        id: redactPortableActivityText(entry.sourceId),
        label: redactPortableActivityText(sourceLabel(entry.sourceId)),
        state: entry.state,
        detail: entry.unavailableReason
          ? redactPortableActivityText(entry.unavailableReason)
          : entry.staleReason
            ? redactPortableActivityText(entry.staleReason)
            : undefined,
      })),
    },
    counts: {
      total: items.length,
      needsAttention: items.filter(
        (item) => item.state !== "resolved" && item.state !== "deferred"
      ).length,
      new: args.report.delta.new.length,
      changed: args.report.delta.changed.length,
      resolved: args.report.delta.resolved.length,
      unchangedSuppressed: args.report.delta.unchangedSuppressed,
    },
    items,
  };
}

function itemLines(item: ActivityItem): string[] {
  const decision = item.decision.disposition ?? item.decision.proposalStatus;
  return [
    `- ${item.title}`,
    `  ${item.categories.join(" + ")} · ${item.state}${decision ? ` · ${decision}` : ""}`,
    ...item.observations.flatMap((entry) => [
      `  Captured: ${entry.summary}`,
      ...(entry.contextOmitted
        ? ["  Context: omitted because this observation is marked private"]
        : [
            ...(entry.details ? [`  Context: ${entry.details}`] : []),
            ...(entry.impact ? [`  Impact: ${entry.impact}`] : []),
            ...(entry.attemptedWorkaround
              ? [`  Tried: ${entry.attemptedWorkaround}`]
              : []),
          ]),
    ]),
    ...(item.omittedObservations
      ? [`  ${item.omittedObservations} additional observations omitted`]
      : []),
    ...(item.decision.rationale
      ? [`  Decision: ${item.decision.rationale}`]
      : []),
    `  Evidence: ${item.evidence.count} item${item.evidence.count === 1 ? "" : "s"}${item.sourceLabels.length ? ` from ${item.sourceLabels.join(", ")}` : ""}`,
    ...(item.linkedWork.length
      ? [`  Linked work: ${item.linkedWork.join(", ")}`]
      : []),
    `  Next: ${item.nextAction}`,
  ];
}

export function renderActivityFeed(feed: ActivityFeed): string {
  const label = feed.project?.name ?? "Global capability";
  const attention = feed.items.filter(
    (item) => item.state !== "resolved" && item.state !== "deferred"
  );
  const recentlyResolved = feed.items.filter(
    (item) => item.change === "resolved"
  );
  const degraded = feed.coverage.sources.filter(
    (source) => source.state === "unavailable" || source.state === "stale"
  );
  const trustworthyEmpty =
    feed.run.status !== "failed" && feed.coverage.complete;
  return [
    `Activity — ${label}`,
    `Last review: ${feed.generatedAt} · ${feed.run.status}`,
    `Coverage: ${feed.coverage.checked}/${feed.coverage.sources.length} sources checked${feed.coverage.complete ? "" : " · incomplete"}`,
    `Changes: ${feed.counts.new} new · ${feed.counts.changed} changed · ${feed.counts.resolved} resolved · ${feed.counts.unchangedSuppressed} unchanged suppressed`,
    "",
    ...(degraded.length
      ? [
          "Source problems",
          ...degraded.map(
            (source) =>
              `- ${source.label}: ${source.state}${source.detail ? ` — ${source.detail}` : ""}`
          ),
          "",
        ]
      : []),
    "Needs attention",
    ...(attention.length
      ? attention.flatMap(itemLines)
      : [
          trustworthyEmpty
            ? "- Nothing needs attention; configured coverage was checked."
            : "- No actionable items are shown because the latest run did not prove complete coverage.",
        ]),
    ...(recentlyResolved.length
      ? ["", "Recently resolved", ...recentlyResolved.flatMap(itemLines)]
      : []),
  ].join("\n");
}

export async function latestActivityFeed(args: {
  homeDir: string;
  rootDir: string;
  scope: "global" | "project";
}): Promise<ActivityFeed | null> {
  const report = await latestEvolutionLoopReport(args);
  if (!report) {
    return null;
  }
  if (report.activity) {
    return report.activity;
  }
  const review = report.reviewId
    ? await reconciliationReviewById({
        homeDir: args.homeDir,
        rootDir: args.rootDir,
        reviewId: report.reviewId,
      })
    : null;
  return buildActivityFeed({
    report,
    review,
    writebacks: [],
    proposals: [],
    snapshot: "legacy-derived",
  });
}
