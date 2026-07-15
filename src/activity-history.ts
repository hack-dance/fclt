import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ActivityItem } from "./activity";
import { redactPortableActivityText } from "./activity";
import type { EvolutionLoopReport } from "./evolution-loop";
import {
  facultAiActivityHistoryManifestPath,
  facultAiActivityHistorySegmentDir,
  facultAiEvolutionLoopConfigPath,
  facultLocalStateRoot,
  machineStateProjectKey,
  machineStateProjectScopeId,
} from "./paths";
import type { ReconciliationReview } from "./reconciliation-types";

const HISTORY_VERSION = 1;
const DEFAULT_RETENTION_DAYS = 365;
const DEFAULT_RETENTION_EVENTS = 10_000;
const DEFAULT_RETENTION_HEADS = 2000;
const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 200;
const MAX_MANIFEST_BYTES = 8_000_000;
const MAX_SEGMENT_BYTES = 4_000_000;
const MAX_DISCOVERED_PROJECTS = 1000;
const MAX_QUERY_SCOPES = 50;
const MAX_QUERY_SCANNED_EVENTS = 50_000;
const MAX_PORTABLE_TEXT = 1000;
const PORTABLE_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export type ActivityHistoryEventType =
  | "run"
  | "discovery"
  | "observation"
  | "correlation"
  | "disposition"
  | "proposal"
  | "review"
  | "application"
  | "verification"
  | "effectiveness"
  | "regression"
  | "supersession"
  | "resolution";

export type ActivityHistoryAction =
  | "run-recorded"
  | "discovered"
  | "repeated"
  | "metadata-updated"
  | "linked-work-updated"
  | "state-changed"
  | "correlated"
  | "correlation-split"
  | "propose"
  | "apply-local"
  | "task"
  | "watch"
  | "defer"
  | "proposal-proposed"
  | "drafted"
  | "in-review"
  | "accepted"
  | "rejected"
  | "applied"
  | "application-failed"
  | "verification-unscheduled"
  | "verification-pending"
  | "verification-due"
  | "verification-overdue"
  | "verified"
  | "improved"
  | "unchanged"
  | "regressed"
  | "inconclusive"
  | "superseded"
  | "resolved";

const HISTORY_EVENT_TYPES = new Set<ActivityHistoryEventType>([
  "run",
  "discovery",
  "observation",
  "correlation",
  "disposition",
  "proposal",
  "review",
  "application",
  "verification",
  "effectiveness",
  "regression",
  "supersession",
  "resolution",
]);

const HISTORY_ACTIONS = new Set<ActivityHistoryAction>([
  "run-recorded",
  "discovered",
  "repeated",
  "metadata-updated",
  "linked-work-updated",
  "state-changed",
  "correlated",
  "correlation-split",
  "propose",
  "apply-local",
  "task",
  "watch",
  "defer",
  "proposal-proposed",
  "drafted",
  "in-review",
  "accepted",
  "rejected",
  "applied",
  "application-failed",
  "verification-unscheduled",
  "verification-pending",
  "verification-due",
  "verification-overdue",
  "verified",
  "improved",
  "unchanged",
  "regressed",
  "inconclusive",
  "superseded",
  "resolved",
]);

const HISTORY_TRANSITION_FIELDS = new Set<
  NonNullable<ActivityHistoryEvent["transition"]>["field"]
>([
  "state",
  "evidence",
  "correlation",
  "disposition",
  "proposal-status",
  "verification",
  "metadata",
  "linked-work",
]);

export interface ActivityHistoryResourceIdentity {
  id: string;
  kind: ActivityItem["kind"];
  itemId?: string;
  familyId?: string;
  proposalId?: string;
}

export interface ActivityHistoryRun {
  id: string;
  recordedAt: string;
  scopeId: string;
  scope: "global" | "project";
  trigger: EvolutionLoopReport["trigger"];
  status: EvolutionLoopReport["status"];
  revision: number;
  configRevision: number;
  reviewId?: string;
  window?: {
    since: string;
    until: string;
  };
  coverage: {
    complete: boolean;
    checked: number;
    degraded: number;
  };
}

export interface ActivityHistoryEvent {
  version: 1;
  id: string;
  recordedAt: string;
  type: ActivityHistoryEventType;
  action: ActivityHistoryAction;
  scopeId: string;
  runId: string;
  resource?: ActivityHistoryResourceIdentity;
  relatedResourceIds?: string[];
  transition?: {
    field:
      | "state"
      | "evidence"
      | "correlation"
      | "disposition"
      | "proposal-status"
      | "verification"
      | "metadata"
      | "linked-work";
    from?: string;
    to: string;
  };
  context?: {
    title: string;
    evidenceCount: number;
    sourceLabels: string[];
    rationale?: string;
    target?: string;
    linkedWork: string[];
    links: Array<{ label: string; url: string }>;
  };
}

interface ActivityHistoryHead {
  resource: ActivityHistoryResourceIdentity;
  state: string;
  disposition?: string;
  proposalStatus?: string;
  verification?: string;
  evidenceFingerprint: string;
  evidenceCount: number;
  correlated: boolean;
  titleFingerprint: string;
  linkedWorkFingerprint: string;
  firstRecordedAt: string;
  lastRecordedAt: string;
  eventCount: number;
}

interface ActivityHistorySegmentRecord {
  id: string;
  file: string;
  recordedAt: string;
  eventCount: number;
  checksum: string;
}

interface ActivityHistoryManifest {
  version: 1;
  scopeId: string;
  scope: "global" | "project";
  createdAt: string;
  updatedAt: string;
  migration: {
    strategy: "no-backfill";
    snapshotOnlyBefore: string;
  };
  retention: {
    maxAgeDays: number;
    maxEvents: number;
    maxHeads: number;
    prunedEvents: number;
    prunedSegments: number;
    prunedHeads: number;
    prunedBefore?: string;
  };
  segments: ActivityHistorySegmentRecord[];
  heads: Record<string, ActivityHistoryHead>;
}

interface ActivityHistorySegment {
  version: 1;
  run: ActivityHistoryRun;
  events: ActivityHistoryEvent[];
}

export interface ActivityHistoryQuery {
  scope: "all" | "global" | "project";
  homeDir: string;
  rootDir: string;
  since?: string;
  until?: string;
  item?: string;
  scopeId?: string;
  eventTypes?: ActivityHistoryEventType[];
  limit?: number;
  cursor?: string;
}

export interface ActivityHistoryQueryResult {
  version: 1;
  kind: "activity-history";
  mode: "timeline";
  filters: {
    scope: ActivityHistoryQuery["scope"];
    since?: string;
    until?: string;
    item?: string;
    scopeId?: string;
    eventTypes: ActivityHistoryEventType[];
  };
  capabilities: {
    externalMutation: false;
    export: false;
    rawPayloads: false;
  };
  coverage: {
    state: "complete" | "partial" | "unavailable";
    complete: boolean;
    configuredScopes: number;
    reportingScopes: number;
    degradedScopes: number;
    snapshotOnlyScopes: number;
    scopes: Array<{
      id: string;
      scope: "global" | "project";
      state:
        | "available"
        | "snapshot-only"
        | "degraded"
        | "unavailable"
        | "omitted";
      historyStart?: string;
      snapshotOnlyBefore?: string;
      prunedBefore?: string;
      prunedEvents: number;
      prunedHeads: number;
      corruptSegments: number;
      detail?: string;
    }>;
  };
  retention: {
    defaultMaxAgeDays: number;
    defaultMaxEventsPerScope: number;
    defaultMaxLineageHeadsPerScope: number;
    migration: "no-backfill-from-snapshots-or-journals";
  };
  events: ActivityHistoryEvent[];
  runs: ActivityHistoryRun[];
  lineage?: {
    query: string;
    ambiguous: boolean;
    resources: Array<{
      scopeId: string;
      resource: ActivityHistoryResourceIdentity;
      firstRecordedAt: string;
      lastRecordedAt: string;
      eventCount: number;
      current: {
        state: string;
        disposition?: string;
        proposalStatus?: string;
        verification?: string;
      };
    }>;
  };
  page: {
    limit: number;
    nextCursor?: string;
  };
  truncation: {
    truncated: boolean;
    omittedScopes: number;
    scanLimitReached: boolean;
  };
}

interface ScopeDescriptor {
  id: string;
  scope: "global" | "project";
  configured: boolean;
  manifestPath: string;
  segmentDir: string;
  omitted: boolean;
}

interface ScopeRead {
  descriptor: ScopeDescriptor;
  manifest?: ActivityHistoryManifest;
  events: ActivityHistoryEvent[];
  runs: ActivityHistoryRun[];
  state: ActivityHistoryQueryResult["coverage"]["scopes"][number]["state"];
  detail?: string;
  corruptSegments: number;
  scanLimitReached: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function dateValue(value: string): number {
  return Date.parse(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPortableIdentifier(value: unknown): value is string {
  return typeof value === "string" && PORTABLE_IDENTIFIER_RE.test(value);
}

function boundedText(value: string): string {
  return redactPortableActivityText(value).slice(0, MAX_PORTABLE_TEXT);
}

function portableIdentifier(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const redacted = redactPortableActivityText(value);
  return redacted === value && PORTABLE_IDENTIFIER_RE.test(value)
    ? value
    : undefined;
}

function opaqueIdentity(
  kind: "resource" | "family" | "proposal",
  scopeId: string,
  value: string
): string {
  return `${kind}:${sha256(`${scopeId}\n${value}`).slice(0, 24)}`;
}

function safeLink(value: { label: string; url: string }): {
  label: string;
  url: string;
} | null {
  try {
    const parsed = new URL(value.url);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    parsed.search = "";
    parsed.hash = "";
    const url = parsed.toString();
    if (boundedText(url) !== url) {
      return null;
    }
    return { label: boundedText(value.label), url };
  } catch {
    return null;
  }
}

function resourceIdentity(
  scopeId: string,
  item: ActivityItem
): ActivityHistoryResourceIdentity {
  const stableSeed =
    item.technical.familyId ??
    item.technical.proposalId ??
    item.technical.queueId;
  return {
    id: opaqueIdentity("resource", scopeId, `${item.kind}:${stableSeed}`),
    kind: item.kind,
    itemId: portableIdentifier(item.id),
    familyId: item.technical.familyId
      ? opaqueIdentity("family", scopeId, item.technical.familyId)
      : undefined,
    proposalId: item.technical.proposalId
      ? opaqueIdentity("proposal", scopeId, item.technical.proposalId)
      : undefined,
  };
}

function eventContext(item: ActivityItem): ActivityHistoryEvent["context"] {
  return {
    title: boundedText(item.title),
    evidenceCount: item.evidence.count,
    sourceLabels: item.sourceLabels.map(boundedText).slice(0, 10),
    rationale: item.decision.rationale
      ? boundedText(item.decision.rationale)
      : undefined,
    target: item.decision.target
      ? boundedText(item.decision.target)
      : undefined,
    linkedWork: item.linkedWork.map(boundedText).slice(0, 10),
    links: (item.context?.links ?? [])
      .map(safeLink)
      .filter((entry): entry is { label: string; url: string } =>
        Boolean(entry)
      )
      .slice(0, 5),
  };
}

function historyEvent(args: {
  run: ActivityHistoryRun;
  type: ActivityHistoryEventType;
  action: ActivityHistoryAction;
  resource?: ActivityHistoryResourceIdentity;
  relatedResourceIds?: string[];
  transition?: ActivityHistoryEvent["transition"];
  context?: ActivityHistoryEvent["context"];
}): ActivityHistoryEvent {
  const seed = JSON.stringify({
    runId: args.run.id,
    type: args.type,
    action: args.action,
    resourceId: args.resource?.id,
    relatedResourceIds: args.relatedResourceIds,
    transition: args.transition,
  });
  return {
    version: 1,
    id: `event:${sha256(`${args.run.scopeId}\n${seed}`).slice(0, 24)}`,
    recordedAt: args.run.recordedAt,
    type: args.type,
    action: args.action,
    scopeId: args.run.scopeId,
    runId: args.run.id,
    resource: args.resource,
    relatedResourceIds: args.relatedResourceIds,
    transition: args.transition,
    context: args.context,
  };
}

function dispositionAction(value: string): ActivityHistoryAction {
  if (value === "resolve-watch") {
    return "watch";
  }
  if (
    value === "propose" ||
    value === "apply-local" ||
    value === "task" ||
    value === "defer"
  ) {
    return value;
  }
  return "state-changed";
}

function proposalTransition(value: string): {
  type: ActivityHistoryEventType;
  action: ActivityHistoryAction;
} {
  if (value === "proposed") {
    return { type: "proposal", action: "proposal-proposed" };
  }
  if (value === "drafted") {
    return { type: "review", action: "drafted" };
  }
  if (value === "in_review") {
    return { type: "review", action: "in-review" };
  }
  if (value === "accepted") {
    return { type: "review", action: "accepted" };
  }
  if (value === "rejected") {
    return { type: "review", action: "rejected" };
  }
  if (value === "applied") {
    return { type: "application", action: "applied" };
  }
  if (value === "failed") {
    return { type: "application", action: "application-failed" };
  }
  return { type: "supersession", action: "superseded" };
}

function verificationTransition(value: string): {
  type: ActivityHistoryEventType;
  action: ActivityHistoryAction;
} {
  if (value === "pending") {
    return { type: "verification", action: "verification-pending" };
  }
  if (value === "due") {
    return { type: "verification", action: "verification-due" };
  }
  if (value === "overdue") {
    return { type: "verification", action: "verification-overdue" };
  }
  if (value === "improved") {
    return { type: "effectiveness", action: "improved" };
  }
  if (value === "unchanged") {
    return { type: "effectiveness", action: "unchanged" };
  }
  if (value === "regressed") {
    return { type: "regression", action: "regressed" };
  }
  if (value === "inconclusive") {
    return { type: "effectiveness", action: "inconclusive" };
  }
  return { type: "verification", action: "verification-unscheduled" };
}

function stateTransition(value: string): {
  type: ActivityHistoryEventType;
  action: ActivityHistoryAction;
} {
  if (value === "resolved") {
    return { type: "resolution", action: "resolved" };
  }
  if (value === "regressed") {
    return { type: "regression", action: "regressed" };
  }
  if (value === "deferred") {
    return { type: "disposition", action: "defer" };
  }
  return { type: "observation", action: "state-changed" };
}

function eventFingerprints(item: ActivityItem): {
  evidence: string;
  title: string;
  linkedWork: string;
} {
  return {
    evidence: sha256(
      JSON.stringify({
        count: item.evidence.count,
        writebacks: [...item.evidence.writebackIds].sort(),
        sources: [...item.sourceLabels].sort(),
      })
    ),
    title: sha256(boundedText(item.title)),
    linkedWork: sha256(JSON.stringify(item.linkedWork.map(boundedText).sort())),
  };
}

function appendItemEvents(args: {
  run: ActivityHistoryRun;
  item: ActivityItem;
  prior?: ActivityHistoryHead;
}): { events: ActivityHistoryEvent[]; head: ActivityHistoryHead } {
  const resource = resourceIdentity(args.run.scopeId, args.item);
  const context = eventContext(args.item);
  const fingerprints = eventFingerprints(args.item);
  const correlated =
    args.item.kind === "signal" &&
    (args.item.evidence.writebackIds.length > 1 ||
      args.item.sourceLabels.length > 1);
  const mergedResourceId = args.item.linkedWork
    .filter((entry) => entry.startsWith("merged:family:"))
    .map((entry) => entry.slice("merged:family:".length))
    .filter(Boolean)
    .map((familyId) =>
      opaqueIdentity("resource", args.run.scopeId, `signal:${familyId}`)
    )[0];
  const events: ActivityHistoryEvent[] = [];
  const push = (
    type: ActivityHistoryEventType,
    action: ActivityHistoryAction,
    transition?: ActivityHistoryEvent["transition"],
    relatedResourceIds?: string[]
  ) => {
    events.push(
      historyEvent({
        run: args.run,
        type,
        action,
        resource,
        relatedResourceIds,
        transition,
        context,
      })
    );
  };

  if (args.prior) {
    if (args.prior.evidenceFingerprint !== fingerprints.evidence) {
      push("observation", "repeated", {
        field: "evidence",
        from: String(args.prior.evidenceCount),
        to: String(args.item.evidence.count),
      });
    }
    if (args.prior.titleFingerprint !== fingerprints.title) {
      push("observation", "metadata-updated", {
        field: "metadata",
        to: "updated",
      });
    }
    if (args.prior.linkedWorkFingerprint !== fingerprints.linkedWork) {
      push("observation", "linked-work-updated", {
        field: "linked-work",
        to: "updated",
      });
    }
    if (args.prior.state !== args.item.state) {
      const mapped = mergedResourceId
        ? { type: "supersession" as const, action: "superseded" as const }
        : stateTransition(args.item.state);
      push(
        mapped.type,
        mapped.action,
        {
          field: "state",
          from: args.prior.state,
          to: args.item.state,
        },
        mergedResourceId ? [mergedResourceId] : undefined
      );
    }
  } else {
    push("discovery", "discovered", {
      field: "state",
      to: args.item.state,
    });
    if (mergedResourceId) {
      push(
        "supersession",
        "superseded",
        { field: "state", to: args.item.state },
        [mergedResourceId]
      );
    }
  }

  if (args.prior?.correlated !== correlated && (correlated || args.prior)) {
    push("correlation", correlated ? "correlated" : "correlation-split", {
      field: "correlation",
      from: args.prior?.correlated ? "correlated" : "uncorrelated",
      to: correlated ? "correlated" : "uncorrelated",
    });
  }

  const disposition = args.item.decision.disposition;
  if (disposition && args.prior?.disposition !== disposition) {
    push("disposition", dispositionAction(disposition), {
      field: "disposition",
      from: args.prior?.disposition,
      to: disposition,
    });
  }

  const proposalStatus = args.item.decision.proposalStatus;
  if (proposalStatus && args.prior?.proposalStatus !== proposalStatus) {
    const mapped = proposalTransition(proposalStatus);
    push(mapped.type, mapped.action, {
      field: "proposal-status",
      from: args.prior?.proposalStatus,
      to: proposalStatus,
    });
  }

  const verification = args.item.verification?.state;
  if (verification && args.prior?.verification !== verification) {
    const mapped = verificationTransition(verification);
    push(mapped.type, mapped.action, {
      field: "verification",
      from: args.prior?.verification,
      to: verification,
    });
    if (
      ["improved", "unchanged", "regressed", "inconclusive"].includes(
        verification
      )
    ) {
      push("verification", "verified", {
        field: "verification",
        from: args.prior?.verification,
        to: verification,
      });
    }
  }

  const firstRecordedAt = args.prior?.firstRecordedAt ?? args.run.recordedAt;
  return {
    events,
    head: {
      resource,
      state: args.item.state,
      disposition,
      proposalStatus,
      verification,
      evidenceFingerprint: fingerprints.evidence,
      evidenceCount: args.item.evidence.count,
      correlated,
      titleFingerprint: fingerprints.title,
      linkedWorkFingerprint: fingerprints.linkedWork,
      firstRecordedAt,
      lastRecordedAt: args.run.recordedAt,
      eventCount: (args.prior?.eventCount ?? 0) + events.length,
    },
  };
}

function buildRun(args: {
  report: EvolutionLoopReport;
  review?: ReconciliationReview | null;
  configRevision: number;
  scopeId: string;
}): ActivityHistoryRun {
  const degraded = args.report.coverage.filter(
    (entry) => entry.state === "unavailable" || entry.state === "stale"
  ).length;
  return {
    id:
      portableIdentifier(args.report.runId) ??
      `run:${sha256(args.report.runId).slice(0, 24)}`,
    recordedAt: args.report.generatedAt,
    scopeId: args.scopeId,
    scope: args.report.scope,
    trigger: args.report.trigger,
    status: args.report.status,
    revision: args.report.generationAfter,
    configRevision: args.configRevision,
    reviewId: portableIdentifier(args.report.reviewId),
    window: args.review
      ? {
          since: args.review.window.since,
          until: args.review.window.until,
        }
      : undefined,
    coverage: {
      complete: args.report.coverageComplete,
      checked: args.report.coverage.length - degraded,
      degraded,
    },
  };
}

function emptyManifest(args: {
  run: ActivityHistoryRun;
  retentionDays: number;
  retentionEvents: number;
  retentionHeads: number;
}): ActivityHistoryManifest {
  return {
    version: 1,
    scopeId: args.run.scopeId,
    scope: args.run.scope,
    createdAt: args.run.recordedAt,
    updatedAt: args.run.recordedAt,
    migration: {
      strategy: "no-backfill",
      snapshotOnlyBefore: args.run.recordedAt,
    },
    retention: {
      maxAgeDays: args.retentionDays,
      maxEvents: args.retentionEvents,
      maxHeads: args.retentionHeads,
      prunedEvents: 0,
      prunedSegments: 0,
      prunedHeads: 0,
    },
    segments: [],
    heads: {},
  };
}

function parseHead(value: unknown): ActivityHistoryHead | null {
  if (
    !(
      isRecord(value) &&
      isRecord(value.resource) &&
      isPortableIdentifier(value.resource.id) &&
      ["signal", "proposal", "coverage"].includes(String(value.resource.kind))
    ) ||
    typeof value.state !== "string" ||
    (value.resource.itemId !== undefined &&
      !isPortableIdentifier(value.resource.itemId)) ||
    (value.resource.familyId !== undefined &&
      !isPortableIdentifier(value.resource.familyId)) ||
    (value.resource.proposalId !== undefined &&
      !isPortableIdentifier(value.resource.proposalId)) ||
    (value.disposition !== undefined &&
      typeof value.disposition !== "string") ||
    (value.proposalStatus !== undefined &&
      typeof value.proposalStatus !== "string") ||
    (value.verification !== undefined &&
      typeof value.verification !== "string") ||
    typeof value.evidenceFingerprint !== "string" ||
    !isNonNegativeInteger(value.evidenceCount) ||
    typeof value.correlated !== "boolean" ||
    typeof value.titleFingerprint !== "string" ||
    typeof value.linkedWorkFingerprint !== "string" ||
    !isIsoDate(value.firstRecordedAt) ||
    !isIsoDate(value.lastRecordedAt) ||
    !isNonNegativeInteger(value.eventCount)
  ) {
    return null;
  }
  return value as unknown as ActivityHistoryHead;
}

function parseManifest(value: unknown): ActivityHistoryManifest {
  if (
    !isRecord(value) ||
    value.version !== HISTORY_VERSION ||
    typeof value.scopeId !== "string" ||
    (value.scope !== "global" && value.scope !== "project") ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt) ||
    !isRecord(value.migration) ||
    value.migration.strategy !== "no-backfill" ||
    !isIsoDate(value.migration.snapshotOnlyBefore) ||
    !isRecord(value.retention) ||
    !Number.isSafeInteger(value.retention.maxAgeDays) ||
    Number(value.retention.maxAgeDays) < 1 ||
    !Number.isSafeInteger(value.retention.maxEvents) ||
    Number(value.retention.maxEvents) < 1 ||
    !Number.isSafeInteger(value.retention.maxHeads) ||
    Number(value.retention.maxHeads) < 1 ||
    !isNonNegativeInteger(value.retention.prunedEvents) ||
    !isNonNegativeInteger(value.retention.prunedSegments) ||
    !isNonNegativeInteger(value.retention.prunedHeads) ||
    (value.retention.prunedBefore !== undefined &&
      !isIsoDate(value.retention.prunedBefore)) ||
    !Array.isArray(value.segments) ||
    !isRecord(value.heads)
  ) {
    throw new Error("Unsupported or malformed activity history manifest");
  }
  const segments: ActivityHistorySegmentRecord[] = value.segments.map(
    (entry) => {
      if (
        !(isRecord(entry) && isPortableIdentifier(entry.id)) ||
        typeof entry.file !== "string" ||
        basename(entry.file) !== entry.file ||
        !isIsoDate(entry.recordedAt) ||
        !isNonNegativeInteger(entry.eventCount) ||
        typeof entry.checksum !== "string" ||
        !SHA256_RE.test(entry.checksum)
      ) {
        throw new Error("Malformed activity history segment record");
      }
      return entry as unknown as ActivityHistorySegmentRecord;
    }
  );
  const heads: Record<string, ActivityHistoryHead> = {};
  for (const [key, entry] of Object.entries(value.heads)) {
    const parsed = parseHead(entry);
    if (!parsed || parsed.resource.id !== key) {
      throw new Error("Malformed activity history lineage head");
    }
    heads[key] = parsed;
  }
  if (
    new Set(segments.map((entry) => entry.id)).size !== segments.length ||
    new Set(segments.map((entry) => entry.file)).size !== segments.length
  ) {
    throw new Error("Duplicate activity history segment record");
  }
  return {
    ...(value as unknown as ActivityHistoryManifest),
    segments,
    heads,
  };
}

async function readBoundedJson(
  pathValue: string,
  maxBytes: number
): Promise<unknown> {
  return JSON.parse(await readBoundedText(pathValue, maxBytes)) as unknown;
}

async function readBoundedText(
  pathValue: string,
  maxBytes: number
): Promise<string> {
  const info = await lstat(pathValue);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw new Error("Activity history file is not a bounded regular file");
  }
  return await readFile(pathValue, "utf8");
}

async function fileExists(pathValue: string): Promise<boolean> {
  try {
    return (await lstat(pathValue)).isFile();
  } catch {
    return false;
  }
}

async function atomicWrite(pathValue: string, body: string): Promise<void> {
  await mkdir(dirname(pathValue), { recursive: true });
  const temporary = `${pathValue}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, body, "utf8");
  await rename(temporary, pathValue);
}

function retainedManifest(args: {
  manifest: ActivityHistoryManifest;
  now: string;
}): {
  manifest: ActivityHistoryManifest;
  removed: ActivityHistorySegmentRecord[];
} {
  const cutoff =
    Date.parse(args.now) -
    args.manifest.retention.maxAgeDays * 24 * 60 * 60 * 1000;
  const sorted = [...args.manifest.segments].sort(
    (left, right) =>
      dateValue(left.recordedAt) - dateValue(right.recordedAt) ||
      left.id.localeCompare(right.id)
  );
  const retained = sorted.filter(
    (segment, index) =>
      index === sorted.length - 1 || Date.parse(segment.recordedAt) >= cutoff
  );
  while (
    retained.length > 1 &&
    retained.reduce((total, segment) => total + segment.eventCount, 0) >
      args.manifest.retention.maxEvents
  ) {
    retained.shift();
  }
  const retainedIds = new Set(retained.map((segment) => segment.id));
  const removed = sorted.filter((segment) => !retainedIds.has(segment.id));
  const sortedHeads = Object.entries(args.manifest.heads).sort(
    ([leftId, left], [rightId, right]) =>
      dateValue(right.lastRecordedAt) - dateValue(left.lastRecordedAt) ||
      leftId.localeCompare(rightId)
  );
  const retainedHeads = sortedHeads.slice(0, args.manifest.retention.maxHeads);
  const prunedHeads = sortedHeads.length - retainedHeads.length;
  const prunedBefore = removed.reduce<string | undefined>(
    (latest, segment) =>
      !latest || dateValue(segment.recordedAt) > dateValue(latest)
        ? segment.recordedAt
        : latest,
    args.manifest.retention.prunedBefore
  );
  return {
    manifest: {
      ...args.manifest,
      segments: retained,
      heads: Object.fromEntries(retainedHeads),
      retention: {
        ...args.manifest.retention,
        prunedEvents:
          args.manifest.retention.prunedEvents +
          removed.reduce((total, segment) => total + segment.eventCount, 0),
        prunedSegments: args.manifest.retention.prunedSegments + removed.length,
        prunedHeads: args.manifest.retention.prunedHeads + prunedHeads,
        prunedBefore,
      },
    },
    removed,
  };
}

export async function appendActivityHistory(args: {
  homeDir: string;
  rootDir: string;
  report: EvolutionLoopReport;
  review?: ReconciliationReview | null;
  configRevision: number;
  retention?: { maxAgeDays?: number; maxEvents?: number; maxHeads?: number };
}): Promise<{ appended: boolean; eventCount: number; prunedEvents: number }> {
  if (args.report.status === "preview") {
    return { appended: false, eventCount: 0, prunedEvents: 0 };
  }
  const retentionDays = args.retention?.maxAgeDays ?? DEFAULT_RETENTION_DAYS;
  const retentionEvents = args.retention?.maxEvents ?? DEFAULT_RETENTION_EVENTS;
  const retentionHeads = args.retention?.maxHeads ?? DEFAULT_RETENTION_HEADS;
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < 1 ||
    !Number.isSafeInteger(retentionEvents) ||
    retentionEvents < 1 ||
    !Number.isSafeInteger(retentionHeads) ||
    retentionHeads < 1
  ) {
    throw new Error(
      "Activity history retention limits must be positive integers"
    );
  }
  const scopeId =
    args.report.scope === "global"
      ? "global"
      : machineStateProjectScopeId(
          machineStateProjectKey(args.rootDir, args.homeDir)
        );
  const run = buildRun({
    report: args.report,
    review: args.review,
    configRevision: args.configRevision,
    scopeId,
  });
  const manifestPath = facultAiActivityHistoryManifestPath(
    args.homeDir,
    args.rootDir
  );
  const segmentDir = facultAiActivityHistorySegmentDir(
    args.homeDir,
    args.rootDir
  );
  let manifest = (await fileExists(manifestPath))
    ? parseManifest(await readBoundedJson(manifestPath, MAX_MANIFEST_BYTES))
    : emptyManifest({
        run,
        retentionDays,
        retentionEvents,
        retentionHeads,
      });
  if (manifest.scopeId !== scopeId || manifest.scope !== args.report.scope) {
    throw new Error(
      "Activity history manifest scope does not match the current run"
    );
  }
  if (manifest.segments.some((segment) => segment.id === run.id)) {
    return {
      appended: false,
      eventCount: 0,
      prunedEvents: manifest.retention.prunedEvents,
    };
  }

  const events: ActivityHistoryEvent[] = [
    historyEvent({
      run,
      type: "run",
      action: "run-recorded",
    }),
  ];
  const heads = { ...manifest.heads };
  for (const item of args.report.activity?.items ?? []) {
    const identity = resourceIdentity(scopeId, item);
    const result = appendItemEvents({ run, item, prior: heads[identity.id] });
    events.push(...result.events);
    heads[identity.id] = result.head;
  }
  const segment: ActivityHistorySegment = {
    version: 1,
    run,
    events,
  };
  const body = `${JSON.stringify(segment, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_SEGMENT_BYTES) {
    throw new Error(
      "Activity history segment exceeds the bounded segment size"
    );
  }
  const segmentFile = `segment-${sha256(`${scopeId}\n${run.id}`).slice(0, 24)}.json`;
  const segmentPath = join(segmentDir, segmentFile);
  await mkdir(segmentDir, { recursive: true });
  try {
    await writeFile(segmentPath, body, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error) ||
      (error as NodeJS.ErrnoException).code !== "EEXIST"
    ) {
      throw error;
    }
    const existing = await readBoundedText(segmentPath, MAX_SEGMENT_BYTES);
    if (sha256(existing) !== sha256(body)) {
      throw new Error(
        "Activity history run identity conflicts with existing content"
      );
    }
  }
  manifest = {
    ...manifest,
    updatedAt: run.recordedAt,
    retention: {
      ...manifest.retention,
      maxAgeDays: args.retention?.maxAgeDays ?? manifest.retention.maxAgeDays,
      maxEvents: args.retention?.maxEvents ?? manifest.retention.maxEvents,
      maxHeads: args.retention?.maxHeads ?? manifest.retention.maxHeads,
    },
    segments: [
      ...manifest.segments,
      {
        id: run.id,
        file: segmentFile,
        recordedAt: run.recordedAt,
        eventCount: events.length,
        checksum: sha256(body),
      },
    ],
    heads,
  };
  const retained = retainedManifest({ manifest, now: run.recordedAt });
  const manifestBody = `${JSON.stringify(retained.manifest, null, 2)}\n`;
  if (Buffer.byteLength(manifestBody) > MAX_MANIFEST_BYTES) {
    throw new Error("Activity history manifest exceeds its bounded size");
  }
  await atomicWrite(manifestPath, manifestBody);
  await Promise.all(
    retained.removed.map(async (entry) => {
      await rm(join(segmentDir, entry.file), { force: true });
    })
  );
  return {
    appended: true,
    eventCount: events.length,
    prunedEvents: retained.manifest.retention.prunedEvents,
  };
}

function parseResource(
  value: unknown
): ActivityHistoryResourceIdentity | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (
    !(
      isRecord(value) &&
      isPortableIdentifier(value.id) &&
      ["signal", "proposal", "coverage"].includes(String(value.kind))
    ) ||
    (value.itemId !== undefined && !isPortableIdentifier(value.itemId)) ||
    (value.familyId !== undefined && !isPortableIdentifier(value.familyId)) ||
    (value.proposalId !== undefined && !isPortableIdentifier(value.proposalId))
  ) {
    return null;
  }
  return value as unknown as ActivityHistoryResourceIdentity;
}

function parseTransition(
  value: unknown
): ActivityHistoryEvent["transition"] | null {
  if (value === undefined) {
    return undefined;
  }
  if (
    !(
      isRecord(value) &&
      HISTORY_TRANSITION_FIELDS.has(
        value.field as NonNullable<ActivityHistoryEvent["transition"]>["field"]
      )
    ) ||
    (value.from !== undefined && typeof value.from !== "string") ||
    typeof value.to !== "string"
  ) {
    return null;
  }
  return value as unknown as ActivityHistoryEvent["transition"];
}

function parseContext(value: unknown): ActivityHistoryEvent["context"] | null {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.title !== "string" ||
    !isNonNegativeInteger(value.evidenceCount) ||
    !Array.isArray(value.sourceLabels) ||
    value.sourceLabels.length > 10 ||
    value.sourceLabels.some((entry) => typeof entry !== "string") ||
    (value.rationale !== undefined && typeof value.rationale !== "string") ||
    (value.target !== undefined && typeof value.target !== "string") ||
    !Array.isArray(value.linkedWork) ||
    value.linkedWork.length > 10 ||
    value.linkedWork.some((entry) => typeof entry !== "string") ||
    !Array.isArray(value.links) ||
    value.links.length > 5 ||
    value.links.some(
      (entry) =>
        !isRecord(entry) ||
        typeof entry.label !== "string" ||
        typeof entry.url !== "string"
    )
  ) {
    return null;
  }
  return value as unknown as ActivityHistoryEvent["context"];
}

function parseEvent(value: unknown): ActivityHistoryEvent | null {
  if (
    !isRecord(value) ||
    value.version !== HISTORY_VERSION ||
    !isPortableIdentifier(value.id) ||
    !isIsoDate(value.recordedAt) ||
    !HISTORY_EVENT_TYPES.has(value.type as ActivityHistoryEventType) ||
    !HISTORY_ACTIONS.has(value.action as ActivityHistoryAction) ||
    !isPortableIdentifier(value.scopeId) ||
    !isPortableIdentifier(value.runId) ||
    (value.relatedResourceIds !== undefined &&
      (!Array.isArray(value.relatedResourceIds) ||
        value.relatedResourceIds.length > 10 ||
        value.relatedResourceIds.some((entry) => !isPortableIdentifier(entry))))
  ) {
    return null;
  }
  const resource = parseResource(value.resource);
  const transition = parseTransition(value.transition);
  const context = parseContext(value.context);
  if (resource === null || transition === null || context === null) {
    return null;
  }
  return {
    ...(value as unknown as ActivityHistoryEvent),
    resource,
    transition,
    context,
  };
}

function parseRun(value: unknown): ActivityHistoryRun | null {
  if (
    !(
      isRecord(value) &&
      isPortableIdentifier(value.id) &&
      isIsoDate(value.recordedAt) &&
      isPortableIdentifier(value.scopeId)
    ) ||
    (value.scope !== "global" && value.scope !== "project") ||
    (value.trigger !== "manual" && value.trigger !== "scheduled") ||
    !["complete", "degraded", "failed"].includes(String(value.status)) ||
    !isNonNegativeInteger(value.revision) ||
    !isNonNegativeInteger(value.configRevision) ||
    (value.reviewId !== undefined && !isPortableIdentifier(value.reviewId)) ||
    (value.window !== undefined &&
      (!(
        isRecord(value.window) &&
        isIsoDate(value.window.since) &&
        isIsoDate(value.window.until)
      ) ||
        dateValue(value.window.since) > dateValue(value.window.until))) ||
    !isRecord(value.coverage) ||
    typeof value.coverage.complete !== "boolean" ||
    !isNonNegativeInteger(value.coverage.checked) ||
    !isNonNegativeInteger(value.coverage.degraded)
  ) {
    return null;
  }
  return value as unknown as ActivityHistoryRun;
}

function parseSegment(value: unknown): ActivityHistorySegment | null {
  if (
    !isRecord(value) ||
    value.version !== HISTORY_VERSION ||
    !Array.isArray(value.events)
  ) {
    return null;
  }
  const run = parseRun(value.run);
  const events = value.events.map(parseEvent);
  if (!run || events.some((event) => !event)) {
    return null;
  }
  return {
    version: 1,
    run,
    events: events as ActivityHistoryEvent[],
  };
}

function portableEvent(event: ActivityHistoryEvent): ActivityHistoryEvent {
  return {
    ...event,
    context: event.context
      ? {
          ...event.context,
          title: boundedText(event.context.title),
          sourceLabels: event.context.sourceLabels.map(boundedText),
          rationale: event.context.rationale
            ? boundedText(event.context.rationale)
            : undefined,
          target: event.context.target
            ? boundedText(event.context.target)
            : undefined,
          linkedWork: event.context.linkedWork.map(boundedText),
          links: event.context.links
            .map(safeLink)
            .filter((entry): entry is { label: string; url: string } =>
              Boolean(entry)
            ),
        }
      : undefined,
  };
}

function parseCursor(value: string | undefined): {
  recordedAt: string;
  id: string;
} | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      !isIsoDate(parsed.recordedAt) ||
      typeof parsed.id !== "string"
    ) {
      throw new Error("invalid cursor");
    }
    return { recordedAt: parsed.recordedAt, id: parsed.id };
  } catch {
    throw new Error("Invalid activity history cursor");
  }
}

function encodeCursor(event: ActivityHistoryEvent): string {
  return Buffer.from(
    JSON.stringify({ version: 1, recordedAt: event.recordedAt, id: event.id })
  ).toString("base64url");
}

function beforeCursor(
  event: ActivityHistoryEvent,
  cursor: ReturnType<typeof parseCursor>
): boolean {
  if (!cursor) {
    return true;
  }
  return (
    dateValue(event.recordedAt) < dateValue(cursor.recordedAt) ||
    (dateValue(event.recordedAt) === dateValue(cursor.recordedAt) &&
      event.id < cursor.id)
  );
}

function matchesItem(
  event: ActivityHistoryEvent,
  item: string | undefined
): boolean {
  if (!item) {
    return true;
  }
  const resource = event.resource;
  return Boolean(
    resource &&
      [
        resource.id,
        resource.itemId,
        resource.familyId,
        resource.proposalId,
      ].includes(item)
  );
}

function matchesFilters(
  event: ActivityHistoryEvent,
  query: ActivityHistoryQuery,
  cursor: ReturnType<typeof parseCursor>
): boolean {
  return (
    (!query.since || dateValue(event.recordedAt) >= dateValue(query.since)) &&
    (!query.until || dateValue(event.recordedAt) <= dateValue(query.until)) &&
    (!query.scopeId || event.scopeId === query.scopeId) &&
    (!query.eventTypes?.length || query.eventTypes.includes(event.type)) &&
    matchesItem(event, query.item) &&
    beforeCursor(event, cursor)
  );
}

async function readScope(args: {
  descriptor: ScopeDescriptor;
  query: ActivityHistoryQuery;
  cursor: ReturnType<typeof parseCursor>;
  budget: { remaining: number };
}): Promise<ScopeRead> {
  if (args.descriptor.omitted) {
    return {
      descriptor: args.descriptor,
      events: [],
      runs: [],
      state: "omitted",
      corruptSegments: 0,
      scanLimitReached: false,
    };
  }
  if (!(await fileExists(args.descriptor.manifestPath))) {
    return {
      descriptor: args.descriptor,
      events: [],
      runs: [],
      state: args.descriptor.configured ? "snapshot-only" : "unavailable",
      detail: args.descriptor.configured
        ? "history-not-recorded"
        : "loop-not-configured",
      corruptSegments: 0,
      scanLimitReached: false,
    };
  }
  let manifest: ActivityHistoryManifest;
  try {
    manifest = parseManifest(
      await readBoundedJson(args.descriptor.manifestPath, MAX_MANIFEST_BYTES)
    );
  } catch {
    return {
      descriptor: args.descriptor,
      events: [],
      runs: [],
      state: "degraded",
      detail: "history-manifest-invalid",
      corruptSegments: 0,
      scanLimitReached: false,
    };
  }
  if (
    manifest.scopeId !== args.descriptor.id ||
    manifest.scope !== args.descriptor.scope
  ) {
    return {
      descriptor: args.descriptor,
      manifest,
      events: [],
      runs: [],
      state: "degraded",
      detail: "history-scope-mismatch",
      corruptSegments: 0,
      scanLimitReached: false,
    };
  }
  const events: ActivityHistoryEvent[] = [];
  const runs: ActivityHistoryRun[] = [];
  let corruptSegments = 0;
  let scanLimitReached = false;
  const segments = [...manifest.segments].sort(
    (left, right) =>
      dateValue(right.recordedAt) - dateValue(left.recordedAt) ||
      right.id.localeCompare(left.id)
  );
  for (const record of segments) {
    const recordedAt = dateValue(record.recordedAt);
    if (
      (args.query.since && recordedAt < dateValue(args.query.since)) ||
      (args.query.until && recordedAt > dateValue(args.query.until)) ||
      (args.cursor && recordedAt > dateValue(args.cursor.recordedAt))
    ) {
      continue;
    }
    if (args.budget.remaining <= 0) {
      scanLimitReached = true;
      break;
    }
    try {
      const pathValue = join(args.descriptor.segmentDir, record.file);
      const raw = await readBoundedText(pathValue, MAX_SEGMENT_BYTES);
      if (
        Buffer.byteLength(raw) > MAX_SEGMENT_BYTES ||
        sha256(raw) !== record.checksum
      ) {
        throw new Error("invalid segment bounds or checksum");
      }
      const segment = parseSegment(JSON.parse(raw) as unknown);
      if (!segment || segment.run.id !== record.id) {
        throw new Error("invalid segment schema");
      }
      runs.push(segment.run);
      for (const event of segment.events) {
        if (args.budget.remaining <= 0) {
          scanLimitReached = true;
          break;
        }
        args.budget.remaining -= 1;
        if (matchesFilters(event, args.query, args.cursor)) {
          events.push(portableEvent(event));
        }
      }
    } catch {
      corruptSegments += 1;
    }
  }
  return {
    descriptor: args.descriptor,
    manifest,
    events,
    runs,
    state: corruptSegments || scanLimitReached ? "degraded" : "available",
    detail: corruptSegments ? "history-segment-invalid" : undefined,
    corruptSegments,
    scanLimitReached,
  };
}

async function isConfiguredLoop(pathValue: string): Promise<boolean> {
  try {
    const config = await readBoundedJson(pathValue, 100_000);
    return (
      isRecord(config) &&
      (config.scope === "global" || config.scope === "project")
    );
  } catch {
    return false;
  }
}

async function scopeDescriptors(query: ActivityHistoryQuery): Promise<{
  descriptors: ScopeDescriptor[];
  discoveryTruncated: boolean;
}> {
  if (query.scope === "global" || query.scope === "project") {
    const scopeId =
      query.scope === "global"
        ? "global"
        : machineStateProjectScopeId(
            machineStateProjectKey(query.rootDir, query.homeDir)
          );
    return {
      descriptors: [
        {
          id: scopeId,
          scope: query.scope,
          configured: await isConfiguredLoop(
            facultAiEvolutionLoopConfigPath(query.homeDir, query.rootDir)
          ),
          manifestPath: facultAiActivityHistoryManifestPath(
            query.homeDir,
            query.rootDir
          ),
          segmentDir: facultAiActivityHistorySegmentDir(
            query.homeDir,
            query.rootDir
          ),
          omitted: false,
        },
      ],
      discoveryTruncated: false,
    };
  }

  const descriptors: ScopeDescriptor[] = [];
  const globalManifest = facultAiActivityHistoryManifestPath(
    query.homeDir,
    query.rootDir
  );
  const globalConfigured = await isConfiguredLoop(
    facultAiEvolutionLoopConfigPath(query.homeDir, query.rootDir)
  );
  if (globalConfigured || (await fileExists(globalManifest))) {
    descriptors.push({
      id: "global",
      scope: "global",
      configured: globalConfigured,
      manifestPath: globalManifest,
      segmentDir: facultAiActivityHistorySegmentDir(
        query.homeDir,
        query.rootDir
      ),
      omitted: false,
    });
  }
  const projectsDir = join(facultLocalStateRoot(query.homeDir), "projects");
  let entries: Dirent<string>[] = [];
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return { descriptors, discoveryTruncated: false };
  }
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const discoveryTruncated = directories.length > MAX_DISCOVERED_PROJECTS;
  for (const entry of directories.slice(0, MAX_DISCOVERED_PROJECTS)) {
    const loopDir = join(
      projectsDir,
      entry.name,
      "ai",
      "project",
      "evolution",
      "loop"
    );
    const manifestPath = join(loopDir, "history", "manifest.json");
    const configured = await isConfiguredLoop(join(loopDir, "config.json"));
    if (!(configured || (await fileExists(manifestPath)))) {
      continue;
    }
    descriptors.push({
      id: machineStateProjectScopeId(entry.name),
      scope: "project",
      configured,
      manifestPath,
      segmentDir: join(loopDir, "history", "segments"),
      omitted: false,
    });
  }
  return {
    descriptors: descriptors.map((descriptor, index) => ({
      ...descriptor,
      omitted: index >= MAX_QUERY_SCOPES,
    })),
    discoveryTruncated,
  };
}

function validateQuery(query: ActivityHistoryQuery): number {
  for (const [name, value] of [
    ["since", query.since],
    ["until", query.until],
  ] as const) {
    if (value && !isIsoDate(value)) {
      throw new Error(`Activity history --${name} must be an ISO-8601 date`);
    }
  }
  if (
    query.since &&
    query.until &&
    dateValue(query.since) > dateValue(query.until)
  ) {
    throw new Error("Activity history --since must not be after --until");
  }
  const limit = query.limit ?? DEFAULT_QUERY_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
    throw new Error(
      `Activity history --limit must be between 1 and ${MAX_QUERY_LIMIT}`
    );
  }
  return limit;
}

function headMatches(head: ActivityHistoryHead, item: string): boolean {
  return [
    head.resource.id,
    head.resource.itemId,
    head.resource.familyId,
    head.resource.proposalId,
  ].includes(item);
}

export async function queryActivityHistory(
  query: ActivityHistoryQuery
): Promise<ActivityHistoryQueryResult> {
  const limit = validateQuery(query);
  const cursor = parseCursor(query.cursor);
  const discovered = await scopeDescriptors(query);
  const selectedDescriptors = discovered.descriptors
    .filter((descriptor) => !query.scopeId || descriptor.id === query.scopeId)
    .map((descriptor) =>
      query.scopeId ? { ...descriptor, omitted: false } : descriptor
    );
  const readableScopeCount = selectedDescriptors.filter(
    (descriptor) => !descriptor.omitted
  ).length;
  const perScopeBudget = Math.max(
    1,
    Math.floor(MAX_QUERY_SCANNED_EVENTS / Math.max(readableScopeCount, 1))
  );
  const reads: ScopeRead[] = [];
  for (const descriptor of selectedDescriptors) {
    reads.push(
      await readScope({
        descriptor,
        query,
        cursor,
        budget: { remaining: perScopeBudget },
      })
    );
  }
  const sortedEvents = reads
    .flatMap((read) => read.events)
    .sort(
      (left, right) =>
        dateValue(right.recordedAt) - dateValue(left.recordedAt) ||
        right.id.localeCompare(left.id)
    );
  const pageEvents = sortedEvents.slice(0, limit);
  const hasMore = sortedEvents.length > limit;
  const returnedRunKeys = new Set(
    pageEvents.map((event) => `${event.scopeId}\0${event.runId}`)
  );
  const runs = reads
    .flatMap((read) => read.runs)
    .filter((run) => returnedRunKeys.has(`${run.scopeId}\0${run.id}`))
    .filter(
      (run, index, values) =>
        values.findIndex(
          (candidate) =>
            candidate.id === run.id && candidate.scopeId === run.scopeId
        ) === index
    )
    .sort(
      (left, right) => dateValue(right.recordedAt) - dateValue(left.recordedAt)
    );
  const scopes = reads.map((read) => {
    const manifest = read.manifest;
    return {
      id: read.descriptor.id,
      scope: read.descriptor.scope,
      state: read.state,
      historyStart: manifest?.segments[0]?.recordedAt,
      snapshotOnlyBefore: manifest?.migration.snapshotOnlyBefore,
      prunedBefore: manifest?.retention.prunedBefore,
      prunedEvents: manifest?.retention.prunedEvents ?? 0,
      prunedHeads: manifest?.retention.prunedHeads ?? 0,
      corruptSegments: read.corruptSegments,
      detail: read.detail,
    };
  });
  const omittedScopes = selectedDescriptors.filter(
    (entry) => entry.omitted
  ).length;
  const scanLimitReached = reads.some((read) => read.scanLimitReached);
  const requestedWindowIsComplete = reads.every((read) => {
    const manifest = read.manifest;
    if (!manifest || read.state !== "available") {
      return false;
    }
    if (query.item && manifest.retention.prunedHeads > 0) {
      return false;
    }
    const since = query.since;
    if (
      !since ||
      dateValue(since) < dateValue(manifest.migration.snapshotOnlyBefore)
    ) {
      return false;
    }
    return !(
      manifest.retention.prunedBefore &&
      dateValue(since) <= dateValue(manifest.retention.prunedBefore)
    );
  });
  const complete =
    reads.length > 0 &&
    requestedWindowIsComplete &&
    !omittedScopes &&
    !discovered.discoveryTruncated &&
    !scanLimitReached;
  const unavailable =
    reads.length === 0 || reads.every((read) => read.state === "unavailable");
  const lineageResources = query.item
    ? reads.flatMap((read) =>
        Object.values(read.manifest?.heads ?? {})
          .filter((head) => headMatches(head, query.item!))
          .map((head) => ({
            scopeId: read.descriptor.id,
            resource: head.resource,
            firstRecordedAt: head.firstRecordedAt,
            lastRecordedAt: head.lastRecordedAt,
            eventCount: head.eventCount,
            current: {
              state: head.state,
              disposition: head.disposition,
              proposalStatus: head.proposalStatus,
              verification: head.verification,
            },
          }))
      )
    : [];
  return {
    version: 1,
    kind: "activity-history",
    mode: "timeline",
    filters: {
      scope: query.scope,
      since: query.since,
      until: query.until,
      item: query.item,
      scopeId: query.scopeId,
      eventTypes: query.eventTypes ?? [],
    },
    capabilities: {
      externalMutation: false,
      export: false,
      rawPayloads: false,
    },
    coverage: {
      state: unavailable ? "unavailable" : complete ? "complete" : "partial",
      complete,
      configuredScopes: reads.filter((read) => read.descriptor.configured)
        .length,
      reportingScopes: reads.filter((read) => read.state === "available")
        .length,
      degradedScopes: reads.filter((read) => read.state === "degraded").length,
      snapshotOnlyScopes: reads.filter((read) => read.state === "snapshot-only")
        .length,
      scopes,
    },
    retention: {
      defaultMaxAgeDays: DEFAULT_RETENTION_DAYS,
      defaultMaxEventsPerScope: DEFAULT_RETENTION_EVENTS,
      defaultMaxLineageHeadsPerScope: DEFAULT_RETENTION_HEADS,
      migration: "no-backfill-from-snapshots-or-journals",
    },
    events: pageEvents,
    runs,
    lineage: query.item
      ? {
          query: query.item,
          ambiguous: lineageResources.length > 1,
          resources: lineageResources,
        }
      : undefined,
    page: {
      limit,
      nextCursor:
        hasMore && pageEvents.length
          ? encodeCursor(pageEvents.at(-1)!)
          : undefined,
    },
    truncation: {
      truncated:
        Boolean(omittedScopes) ||
        discovered.discoveryTruncated ||
        scanLimitReached,
      omittedScopes,
      scanLimitReached,
    },
  };
}

export function renderActivityHistory(
  result: ActivityHistoryQueryResult
): string {
  const lines = [
    `Activity history · ${result.coverage.state}`,
    `Scopes: ${result.coverage.reportingScopes}/${result.coverage.configuredScopes} reporting`,
    `Events: ${result.events.length}${result.page.nextCursor ? " · more available" : ""}`,
    "",
  ];
  if (!result.events.length) {
    lines.push(
      result.coverage.state === "unavailable"
        ? "No history is available for the selected scope."
        : "No events matched the selected bounded query."
    );
    return lines.join("\n");
  }
  for (const event of result.events) {
    lines.push(
      `- ${event.recordedAt} · ${event.action} · ${event.context?.title ?? event.runId}`
    );
  }
  return lines.join("\n");
}
