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
const MAX_TARGETS_PER_ITEM = 5;
const MAX_LINKS_PER_ITEM = 5;
const FILE_URL_PATH_RE = /\bfile:\/\/[^\s)\]}>"'`,;]+/gi;
const WINDOWS_ABSOLUTE_PATH_RE =
  /\b[A-Za-z]:[\\/](?:[^\\/\s)\]}>"'`,;]+[\\/])*[^\\/\s)\]}>"'`,;]*/g;
const UNC_ABSOLUTE_PATH_RE = /\\\\[^\\\s)\]}>"'`,;]+\\[^\s)\]}>"'`,;]+/g;
const HOME_RELATIVE_PATH_RE = /(^|[\s([{:="'`])~[\\/][^\s)\]}>"'`,;]+/g;
const POSIX_ABSOLUTE_PATH_RE = /(^|[\s([{:="'`])\/(?!\/)[^\s)\]}>"'`,;]+/g;
const PATH_TOKEN_RE = /[^\s)\]}>"'`,;]+/g;
const PERCENT_ENCODED_BYTE_RE = /%([0-9a-f]{2})/gi;
const FILE_SCHEME_PATH_RE = /^file:\/\//i;
const EMBEDDED_ABSOLUTE_PATH_RE = /(?:^|[=:])(?:\/|[A-Za-z]:\/)/;
const HTTP_URL_RE = /\bhttps?:\/\/[^\s)\]}>"'`,;]+/gi;
const URL_METADATA_SEPARATOR_RE = /[?#]/;
const ENCODED_PATH_SEPARATOR_RE = /%(?:2f|5c)/i;
const LOCAL_URL_PATH_RE =
  /(?:^|\/)(?:(?:Applications|Library|Network|System|Users|Volumes|afs|bin|boot|cdrom|dev|etc|export|home|lib(?:32|64)?|lost\+found|media|mnt|net|nix|opt|private|proc|root|run|sbin|selinux|srv|sys|tmp|usr|var)(?:\/|$)|[A-Za-z]:(?:\/|$)|~(?:\/|$))/i;
const DOUBLE_PATH_SEPARATOR_RE = /\/\//;
const WINDOWS_DRIVE_SELECTOR_RE = /^[A-Za-z]:\//;
const FILE_SELECTOR_RE = /^file:/i;
const HTTP_SELECTOR_RE = /^https?:/i;
const ISSUE_SELECTOR_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const TYPED_TARGET_SELECTOR_RE =
  /^(instruction|snippet|skill|agent|prompt|automation|mcp|tool):(.+)$/i;
const CANONICAL_SCOPE_PREFIX_RE = /^@(ai|project)\//;
const FILE_EXTENSION_RE = /\.[^.]+$/;
const TARGET_LABEL_SEPARATOR_RE = /[-_]+/g;

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

export type ActivityTargetKind =
  | "instruction"
  | "snippet"
  | "skill"
  | "agent"
  | "prompt"
  | "automation"
  | "mcp"
  | "tool"
  | "document"
  | "capability";

export interface ActivityTarget {
  kind: ActivityTargetKind;
  scope: "global" | "project" | "unknown";
  selector: string;
  label: string;
}

export interface ActivityLink {
  label: string;
  url: string;
  source: "evidence" | "linked-work";
}

export interface ActivityContext {
  scope: "global" | "project";
  project?: {
    key: string;
    name: string;
  };
  targets: ActivityTarget[];
  links: ActivityLink[];
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
  context?: ActivityContext;
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

function containsEncodedOrBareLocalPath(value: string): boolean {
  let decoded = value;
  for (let remaining = value.length; remaining > 0; remaining -= 1) {
    const next = decoded.replace(
      PERCENT_ENCODED_BYTE_RE,
      (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))
    );
    if (next === decoded) {
      break;
    }
    decoded = next;
  }
  const normalized = decoded.replaceAll("\\", "/");
  if (!normalized.includes("/")) {
    return false;
  }
  return (
    normalized.startsWith("/") ||
    normalized.startsWith("~/") ||
    FILE_SCHEME_PATH_RE.test(normalized) ||
    EMBEDDED_ABSOLUTE_PATH_RE.test(normalized) ||
    LOCAL_URL_PATH_RE.test(normalized)
  );
}

function redactActivityPaths(value: string): string {
  return value
    .replace(PATH_TOKEN_RE, (token) =>
      !FILE_SCHEME_PATH_RE.test(token) && containsEncodedOrBareLocalPath(token)
        ? "<redacted-path>"
        : token
    )
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

function stripHttpUrlMetadata(value: string): string {
  // Provider-specific signed URL credentials cannot be safely enumerated.
  const metadataIndex = value.search(URL_METADATA_SEPARATOR_RE);
  return metadataIndex >= 0 ? value.slice(0, metadataIndex) : value;
}

function isPortableUrlPath(pathname: string): boolean {
  try {
    let decodedPathname = pathname;
    for (let remaining = pathname.length; remaining > 0; remaining -= 1) {
      // Encoded separators can hide absolute machine paths at any encoding
      // depth. Decode until stable and fail closed before publishing the URL.
      if (ENCODED_PATH_SEPARATOR_RE.test(decodedPathname)) {
        return false;
      }
      const next = decodeURIComponent(decodedPathname);
      if (next === decodedPathname) {
        break;
      }
      decodedPathname = next;
    }
    return !(
      DOUBLE_PATH_SEPARATOR_RE.test(decodedPathname) ||
      LOCAL_URL_PATH_RE.test(decodedPathname)
    );
  } catch {
    return false;
  }
}

function redactPortableHttpUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !(parsed.username || parsed.password) &&
      isPortableUrlPath(parsed.pathname)
    ) {
      return stripHttpUrlMetadata(value);
    }
  } catch {
    // Malformed or partially redacted URLs fail closed below.
  }
  return "<redacted-url>";
}

export function redactPortableActivityText(value: string): string {
  const redactedSecrets = redactReconciliationText(value);
  let cursor = 0;
  let output = "";
  for (const match of redactedSecrets.matchAll(HTTP_URL_RE)) {
    const index = match.index;
    output += redactActivityPaths(redactedSecrets.slice(cursor, index));
    output += redactPortableHttpUrl(match[0]);
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

function activityProject(
  projectRoot: string | undefined
): ActivityContext["project"] {
  return projectRoot
    ? {
        key: projectKey(projectRoot),
        name: basename(projectRoot),
      }
    : undefined;
}

function safeTargetSelector(value: string): string | null {
  const selector = value.trim();
  if (
    !selector ||
    selector.length > 300 ||
    selector.includes("\\") ||
    selector.includes("%") ||
    selector.includes("?") ||
    selector.includes("#") ||
    selector.startsWith("/") ||
    selector.startsWith("~") ||
    WINDOWS_DRIVE_SELECTOR_RE.test(selector) ||
    FILE_SELECTOR_RE.test(selector) ||
    HTTP_SELECTOR_RE.test(selector) ||
    ISSUE_SELECTOR_RE.test(selector)
  ) {
    return null;
  }
  const typed = TYPED_TARGET_SELECTOR_RE.exec(selector);
  const pathValue =
    typed?.[2] ?? selector.replace(CANONICAL_SCOPE_PREFIX_RE, "");
  const segments = pathValue.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  const redacted = redactPortableActivityText(selector);
  return redacted.includes("<redacted") ? null : redacted;
}

function targetKind(selector: string): ActivityTargetKind {
  const typed = TYPED_TARGET_SELECTOR_RE.exec(selector)?.[1]?.toLowerCase();
  if (typed) {
    return typed as Exclude<ActivityTargetKind, "document" | "capability">;
  }
  const normalized = selector.toLowerCase();
  const segmentKinds: [string, ActivityTargetKind][] = [
    ["/instructions/", "instruction"],
    ["/snippets/", "snippet"],
    ["/skills/", "skill"],
    ["/agents/", "agent"],
    ["/prompts/", "prompt"],
    ["/automations/", "automation"],
    ["/mcp/", "mcp"],
    ["/tools/", "tool"],
  ];
  for (const [segment, kind] of segmentKinds) {
    if (`/${normalized}`.includes(segment)) {
      return kind;
    }
  }
  return normalized.endsWith(".md") ? "document" : "capability";
}

function targetScope(
  selector: string,
  defaultScope: ActivityContext["scope"]
): ActivityTarget["scope"] {
  if (selector.startsWith("@project/")) {
    return "project";
  }
  if (selector.startsWith("@ai/")) {
    return "global";
  }
  return defaultScope;
}

function targetLabel(selector: string): string {
  const typed = TYPED_TARGET_SELECTOR_RE.exec(selector)?.[2];
  const parts = (typed ?? selector).split("/").filter(Boolean);
  const last = parts.at(-1) ?? selector;
  const name =
    last.toLowerCase() === "skill.md" && parts.length > 1
      ? (parts.at(-2) ?? last)
      : last.replace(FILE_EXTENSION_RE, "");
  return name.replaceAll(TARGET_LABEL_SEPARATOR_RE, " ").trim() || selector;
}

function activityTargets(args: {
  signal?: CorrelatedSignal;
  proposal?: AiProposalRecord;
  writebacks: AiWritebackRecord[];
  scope: ActivityContext["scope"];
}): ActivityTarget[] {
  const candidates = [
    ...(args.signal?.assetRefs ?? []),
    ...(args.proposal?.targets ?? []),
    ...args.writebacks.flatMap((record) => [
      record.assetRef ?? "",
      record.suggestedDestination ?? "",
    ]),
    args.signal?.dispositionTarget ?? "",
  ];
  const targets = new Map<string, ActivityTarget>();
  for (const candidate of candidates) {
    const selector = safeTargetSelector(candidate);
    if (!(selector && !targets.has(selector))) {
      continue;
    }
    targets.set(selector, {
      kind: targetKind(selector),
      scope: targetScope(selector, args.scope),
      selector,
      label: targetLabel(selector),
    });
    if (targets.size >= MAX_TARGETS_PER_ITEM) {
      break;
    }
  }
  return [...targets.values()];
}

function safeActivityLink(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (!(parsed.protocol === "https:" || parsed.protocol === "http:")) {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    if (!isPortableUrlPath(parsed.pathname)) {
      return null;
    }
    // Query strings are not portable evidence: signed URLs use many
    // provider-specific credential keys, so an allowlist would fail open.
    if (parsed.search) {
      return null;
    }
    parsed.hash = "";
    const redacted = redactPortableActivityText(parsed.toString());
    return redacted.includes("<redacted") ? null : redacted;
  } catch {
    return null;
  }
}

function activityLinks(args: {
  item: LoopQueueItem;
  signal?: CorrelatedSignal;
  review: ReconciliationReview | null;
  writebacks: AiWritebackRecord[];
}): ActivityLink[] {
  const evidenceKeys = new Set(args.signal?.evidenceKeys ?? []);
  const writebackSensitivity = new Map(
    args.writebacks.map((record) => [
      record.id,
      record.capture?.sensitivity ?? "internal",
    ])
  );
  const provenanceLinks =
    args.review?.evidence
      .filter(
        (entry) =>
          evidenceKeys.has(entry.dedupeKey) &&
          entry.writebackRefs.every(
            (id) =>
              writebackSensitivity.has(id) &&
              writebackSensitivity.get(id) !== "private"
          )
      )
      .flatMap((entry) => entry.provenance)
      .flatMap((provenance) => {
        const candidates = [
          provenance.sourceUri,
          provenance.url,
          provenance.htmlUrl,
        ];
        return candidates.filter(
          (candidate): candidate is string => typeof candidate === "string"
        );
      }) ?? [];
  const evidenceLinks = args.writebacks
    .filter((record) => record.capture?.sensitivity !== "private")
    .flatMap((record) => record.evidence.map((entry) => entry.ref));
  const candidates: Array<{
    value: string;
    source: ActivityLink["source"];
  }> = [
    ...provenanceLinks.map((value) => ({ value, source: "evidence" as const })),
    ...evidenceLinks.map((value) => ({ value, source: "evidence" as const })),
    ...args.item.linkedWork.map((value) => ({
      value,
      source: "linked-work" as const,
    })),
  ];
  const links = new Map<string, ActivityLink>();
  for (const candidate of candidates) {
    const url = safeActivityLink(candidate.value);
    if (!(url && !links.has(url))) {
      continue;
    }
    links.set(url, {
      label: new URL(url).hostname,
      url,
      source: candidate.source,
    });
    if (links.size >= MAX_LINKS_PER_ITEM) {
      break;
    }
  }
  return [...links.values()];
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
  const project = activityProject(args.report.projectRoot);
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
    const context: ActivityContext = {
      scope: args.report.scope,
      project,
      targets: activityTargets({
        signal,
        proposal,
        writebacks,
        scope: args.report.scope,
      }),
      links: activityLinks({
        item,
        signal,
        review: args.review,
        writebacks,
      }),
    };
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
      context,
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
    project,
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
  const targetLines = item.context?.targets.map(
    (target) =>
      `  Target: ${target.kind} · ${target.label} (${target.selector})`
  );
  const linkLines = item.context?.links.map(
    (link) => `  Source: ${link.label} · ${link.url}`
  );
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
    ...(item.decision.rationale ? [`  Why: ${item.decision.rationale}`] : []),
    ...(targetLines ?? []),
    ...(linkLines ?? []),
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
