import { createHash } from "node:crypto";
import {
  type FileHandle,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WritebackDisposition } from "./ai";
import {
  facultAiReconciliationReviewDir,
  facultAiReconciliationStatePath,
  projectRootFromAiRoot,
} from "./paths";
import { reconciliationAdapterFor } from "./reconciliation-adapters";
import { loadReconciliationConfig } from "./reconciliation-config";
import type {
  AdapterScanResult,
  CorrelatedSignal,
  ExtractionDecision,
  ReconciledEvidence,
  ReconciliationConfig,
  ReconciliationReview,
  ReconciliationState,
  ReconciliationWindow,
  SignalClassification,
  SourceCoverage,
  SourceRecord,
} from "./reconciliation-types";

const CAPABILITY_PATH_RE =
  /(?:^|[\s,])(?:\.ai\/|AGENTS\.md|instructions\/|skills\/|agents\/|automations\/|snippets\/|mcp\/)/i;
const OUTCOME_RE =
  /\b(?:verified|proof|passed|released|published|deployed|fixed|completed|green)\b/i;
const CAPABILITY_RE =
  /\b(?:capability|writeback|evolution|instruction|skill|agent|runbook|reconciliation|feedback loop|verification)\b/i;
const NOISE_RE =
  /\b(?:chore|format|typo|timestamp|heartbeat unchanged|no-op)\b/i;
const RECONCILIATION_ENGINE_VERSION = 5;
const STOP_WORD_RE =
  /\b(?:the|and|for|with|from|this|that|into|was|were|are|has|have)\b/g;
const NON_ALPHANUMERIC_RE = /[^a-z0-9]+/g;
const WHITESPACE_RE = /\s+/g;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function emptyState(): ReconciliationState {
  return { version: 1, sources: {}, evidence: {}, decisions: {}, reviews: {} };
}

function parseState(value: unknown): ReconciliationState {
  if (!isPlainObject(value) || value.version !== 1) {
    throw new Error("Unsupported reconciliation state schema");
  }
  if (
    !(
      isPlainObject(value.sources) &&
      isPlainObject(value.evidence) &&
      isPlainObject(value.decisions) &&
      isPlainObject(value.reviews)
    )
  ) {
    throw new Error("Malformed reconciliation state schema");
  }
  return {
    version: 1,
    sources: value.sources as ReconciliationState["sources"],
    evidence: value.evidence as ReconciliationState["evidence"],
    decisions: value.decisions as ReconciliationState["decisions"],
    reviews: value.reviews as ReconciliationState["reviews"],
  };
}

async function loadState(path: string): Promise<ReconciliationState> {
  if (!(await Bun.file(path).exists())) {
    return emptyState();
  }
  try {
    return parseState(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    throw new Error(
      `Invalid reconciliation state at ${path}; the file was preserved: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function atomicWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await Bun.write(temporaryPath, value);
  await rename(temporaryPath, path);
}

async function withStateLock<T>(
  statePath: string,
  fn: () => Promise<T>
): Promise<T> {
  const lockPath = `${statePath}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx");
  } catch {
    throw new Error(`Another reconciliation is already updating ${statePath}`);
  }
  try {
    return await fn();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

function configDigest(config: ReconciliationConfig): string {
  return sha256(
    JSON.stringify({
      engineVersion: RECONCILIATION_ENGINE_VERSION,
      config,
      adapters: config.sources.map((source) => ({
        type: source.type,
        version: reconciliationAdapterFor(source.type).version,
      })),
    })
  );
}

function sourceStateDigest(
  source: ReconciliationConfig["sources"][number]
): string {
  return sha256(
    JSON.stringify({
      engineVersion: RECONCILIATION_ENGINE_VERSION,
      adapterVersion: reconciliationAdapterFor(source.type).version,
      source,
    })
  );
}

function createWindow(args: {
  config: ReconciliationConfig;
  rootDir: string;
  homeDir: string;
  since: string;
  until: string;
  mode: "window" | "incremental";
}): ReconciliationWindow {
  const since = new Date(args.since).toISOString();
  const until = DATE_ONLY_RE.test(args.until)
    ? new Date(`${args.until}T23:59:59.999Z`).toISOString()
    : new Date(args.until).toISOString();
  if (Date.parse(since) > Date.parse(until)) {
    throw new Error("Reconciliation --since must be before --until");
  }
  const digest = configDigest(args.config);
  const projectRoot = projectRootFromAiRoot(args.rootDir, args.homeDir);
  const scope = projectRoot ? "project" : "global";
  const id = `RV-${sha256(`${scope}\n${args.rootDir}\n${args.mode}\n${since}\n${until}\n${digest}`).slice(0, 16)}`;
  return {
    id,
    mode: args.mode,
    since,
    until,
    scope,
    rootDir: args.rootDir,
    projectRoot: projectRoot ?? undefined,
    configDigest: digest,
  };
}

function incrementalSince(requestedSince: string, watermark?: string): string {
  if (!watermark) {
    return requestedSince;
  }
  const requested = Date.parse(requestedSince);
  const previous = Date.parse(watermark);
  if (!Number.isFinite(previous) || previous <= requested) {
    return requestedSince;
  }
  return new Date(previous - 1).toISOString();
}

function boundedIncrementalSince(
  requestedSince: string,
  watermark: string | undefined,
  until: string
): string {
  const since = incrementalSince(requestedSince, watermark);
  return Date.parse(since) > Date.parse(until) ? until : since;
}

function classify(record: SourceRecord): SignalClassification {
  if (record.classification) {
    return record.classification;
  }
  const text = `${record.title}\n${record.body}`;
  const paths = Array.isArray(record.provenance.files)
    ? record.provenance.files.join(" ")
    : String(record.provenance.path ?? "");
  if (CAPABILITY_PATH_RE.test(paths) || CAPABILITY_RE.test(text)) {
    return OUTCOME_RE.test(text)
      ? "capability-implementation"
      : "capability-source";
  }
  if (OUTCOME_RE.test(text)) {
    return "outcome-proof";
  }
  if (record.issueRefs.length > 0) {
    return "implementation-only";
  }
  return NOISE_RE.test(text) ? "noise" : "noise";
}

function semanticKey(record: SourceRecord): string {
  const normalized = `${record.title} ${record.body}`
    .toLowerCase()
    .replace(STOP_WORD_RE, " ")
    .replace(NON_ALPHANUMERIC_RE, " ")
    .replace(WHITESPACE_RE, " ")
    .trim()
    .slice(0, 500);
  return `semantic:${sha256(normalized)}`;
}

function correlationKeys(record: SourceRecord): string[] {
  const referenceCount =
    record.assetRefs.length +
    record.issueRefs.length +
    (record.sourceType === "writebacks" ? 0 : record.writebackRefs.length);
  const boundedReferenceKeys =
    referenceCount <= 2
      ? [
          ...record.assetRefs.map((entry) => `asset:${entry.toLowerCase()}`),
          ...record.issueRefs.map((entry) => `issue:${entry}`),
          ...(record.sourceType === "writebacks"
            ? [record.dedupeKey]
            : record.writebackRefs.map((entry) => `writeback:${entry}`)),
        ]
      : [];
  const semanticKeys = referenceCount === 0 ? [semanticKey(record)] : [];
  return unique([...boundedReferenceKeys, ...semanticKeys]);
}

function extractionDecision(record: SourceRecord): ExtractionDecision {
  const classification = classify(record);
  const included = classification !== "noise";
  return {
    id: `XD-${sha256(`${record.sourceId}:${record.recordId}:${record.dedupeKey}`).slice(0, 16)}`,
    sourceId: record.sourceId,
    sourceRecordId: record.recordId,
    dedupeKey: record.dedupeKey,
    included,
    classification,
    reason: included
      ? `Included as ${classification} evidence`
      : "Excluded as noise: no capability, linked-work, or outcome signal was found",
    correlationKeys: correlationKeys(record),
  };
}

function explicitDisposition(
  record: SourceRecord
): WritebackDisposition | undefined {
  const value = record.provenance.disposition;
  return value === "propose" ||
    value === "apply-local" ||
    value === "task" ||
    value === "resolve-watch" ||
    value === "defer"
    ? value
    : undefined;
}

function dispositionFor(args: {
  records: SourceRecord[];
  classifications: SignalClassification[];
  assetRefs: string[];
  issueRefs: string[];
}): { disposition: WritebackDisposition; target?: string; rationale: string } {
  const requested = args.records.map(explicitDisposition).find(Boolean);
  const explicitTarget = args.records
    .map((record) => record.provenance.dispositionTarget)
    .find(
      (value): value is string => typeof value === "string" && Boolean(value)
    );
  if (requested) {
    return {
      disposition: requested,
      target: explicitTarget ?? args.issueRefs[0] ?? args.assetRefs[0],
      rationale:
        "Preserved the explicit disposition from the latest writeback state",
    };
  }
  if (args.classifications.includes("capability-implementation")) {
    return OUTCOME_RE.test(args.records.map((record) => record.body).join(" "))
      ? {
          disposition: "resolve-watch",
          target: args.issueRefs[0] ?? args.assetRefs[0],
          rationale:
            "Capability implementation has outcome evidence and should be watched for effectiveness",
        }
      : {
          disposition: "task",
          target: args.issueRefs[0] ?? args.assetRefs[0],
          rationale:
            "Capability implementation belongs in linked delivery work, not a duplicate proposal",
        };
  }
  if (args.classifications.includes("outcome-proof")) {
    return {
      disposition: "resolve-watch",
      target: args.issueRefs[0] ?? args.assetRefs[0],
      rationale:
        "Outcome evidence closes or monitors existing work rather than creating a proposal",
    };
  }
  if (args.classifications.includes("implementation-only")) {
    return {
      disposition: "task",
      target: args.issueRefs[0],
      rationale:
        "Implementation evidence remains linked work and is not promoted into capability evolution",
    };
  }
  const sourceCount = unique(
    args.records.map((record) => record.sourceId)
  ).length;
  if (args.assetRefs.some((asset) => asset.startsWith("@project/"))) {
    const projectTarget = args.assetRefs.find((asset) =>
      asset.startsWith("@project/")
    );
    return {
      disposition: "apply-local",
      target: projectTarget,
      rationale:
        "Project-local capability evidence has a concrete local target",
    };
  }
  if (sourceCount >= 2) {
    return {
      disposition: "propose",
      target: args.assetRefs[0],
      rationale:
        "Repeated capability signal is corroborated by multiple configured sources",
    };
  }
  return {
    disposition: "defer",
    target: args.assetRefs[0],
    rationale:
      "Capability signal is currently a singleton and needs recurrence or a clearer target",
  };
}

class DisjointSet {
  readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    const parent = this.parent[index] ?? index;
    if (parent === index) {
      return index;
    }
    const root = this.find(parent);
    this.parent[index] = root;
    return root;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) {
      this.parent[rightRoot] = leftRoot;
    }
  }
}

function correlate(args: {
  records: SourceRecord[];
  decisions: ExtractionDecision[];
  state: ReconciliationState;
}): { evidence: ReconciledEvidence[]; signals: CorrelatedSignal[] } {
  const included = args.records
    .map((record, index) => ({ record, decision: args.decisions[index] }))
    .filter(
      (
        entry
      ): entry is { record: SourceRecord; decision: ExtractionDecision } =>
        Boolean(entry.decision?.included)
    );
  const byDedupe = new Map<string, typeof included>();
  for (const entry of included) {
    const current = byDedupe.get(entry.record.dedupeKey) ?? [];
    current.push(entry);
    byDedupe.set(entry.record.dedupeKey, current);
  }
  const evidence: ReconciledEvidence[] = [...byDedupe.entries()].map(
    ([dedupeKey, entries]) => {
      const records = entries.map((entry) => entry.record);
      const newest = [...records].sort((a, b) =>
        b.observedAt.localeCompare(a.observedAt)
      )[0]!;
      const classification = entries
        .map((entry) => entry.decision.classification)
        .find((value) => value !== "noise") as Exclude<
        SignalClassification,
        "noise"
      >;
      return {
        dedupeKey,
        sourceIds: unique(records.map((record) => record.sourceId)),
        sourceRecordIds: unique(records.map((record) => record.recordId)),
        observedAt: newest.observedAt,
        title: newest.title,
        body: newest.body,
        classification,
        assetRefs: unique(records.flatMap((record) => record.assetRefs)),
        issueRefs: unique(records.flatMap((record) => record.issueRefs)),
        writebackRefs: unique(
          records.flatMap((record) => record.writebackRefs)
        ),
        correlationKeys: unique(
          entries.flatMap((entry) => entry.decision.correlationKeys)
        ),
        disposition: "defer",
        isNew: !args.state.evidence[dedupeKey],
        provenance: records.map((record) => record.provenance),
      };
    }
  );

  const writebackSourcesByRef = new Map<string, ReconciledEvidence[]>();
  for (const item of evidence) {
    if (!item.dedupeKey.startsWith("writeback:")) {
      continue;
    }
    for (const ref of item.writebackRefs) {
      const sources = writebackSourcesByRef.get(ref) ?? [];
      sources.push(item);
      writebackSourcesByRef.set(ref, sources);
    }
  }
  for (const [ref, sources] of writebackSourcesByRef) {
    if (sources.length === 1) {
      const source = sources[0]!;
      source.correlationKeys = unique([
        ...source.correlationKeys,
        `writeback:${ref}`,
      ]);
    }
  }

  const set = new DisjointSet(evidence.length);
  const keyOwner = new Map<string, number>();
  for (const [index, item] of evidence.entries()) {
    for (const key of item.correlationKeys) {
      const owner = keyOwner.get(key);
      if (owner === undefined) {
        keyOwner.set(key, index);
      } else {
        set.union(owner, index);
      }
    }
  }
  const groups = new Map<number, ReconciledEvidence[]>();
  for (const [index, item] of evidence.entries()) {
    const root = set.find(index);
    groups.set(root, [...(groups.get(root) ?? []), item]);
  }
  const signals = [...groups.values()].map((items): CorrelatedSignal => {
    const records = included
      .filter((entry) =>
        items.some((item) => item.dedupeKey === entry.record.dedupeKey)
      )
      .map((entry) => entry.record);
    const assetRefs = unique(items.flatMap((item) => item.assetRefs));
    const issueRefs = unique(items.flatMap((item) => item.issueRefs));
    const writebackRefs = unique(items.flatMap((item) => item.writebackRefs));
    const classifications = unique(items.map((item) => item.classification));
    const disposition = dispositionFor({
      records,
      classifications,
      assetRefs,
      issueRefs,
    });
    const id = `SG-${sha256(
      items
        .map((item) => item.dedupeKey)
        .sort()
        .join("\n")
    ).slice(0, 16)}`;
    for (const item of items) {
      item.disposition = disposition.disposition;
    }
    return {
      id,
      title: items[0]?.title ?? id,
      evidenceKeys: items.map((item) => item.dedupeKey).sort(),
      sourceIds: unique(items.flatMap((item) => item.sourceIds)),
      classifications,
      assetRefs,
      issueRefs,
      writebackRefs,
      disposition: disposition.disposition,
      dispositionTarget: disposition.target,
      rationale: disposition.rationale,
      unresolved:
        disposition.disposition === "propose" ||
        disposition.disposition === "apply-local" ||
        disposition.disposition === "task" ||
        disposition.disposition === "defer",
    };
  });
  return { evidence, signals };
}

function dispositionCounts(
  signals: CorrelatedSignal[]
): Record<WritebackDisposition, number> {
  const counts: Record<WritebackDisposition, number> = {
    propose: 0,
    "apply-local": 0,
    task: 0,
    "resolve-watch": 0,
    defer: 0,
  };
  for (const signal of signals) {
    counts[signal.disposition] += 1;
  }
  return counts;
}

function renderReview(review: ReconciliationReview): string {
  const coverage = review.coverage.map(
    (entry) =>
      `| ${entry.sourceId} | ${entry.sourceType} | ${entry.state} | ${entry.recordsScanned} | ${entry.signalsDiscovered} | ${entry.unavailableReason ?? entry.staleReason ?? ""} |`
  );
  const signals = review.signals.flatMap((signal) => [
    `### ${signal.id} — ${signal.title}`,
    "",
    `- Disposition: **${signal.disposition}**${signal.dispositionTarget ? ` → ${signal.dispositionTarget}` : ""}`,
    `- Sources: ${signal.sourceIds.join(", ")}`,
    `- Classification: ${signal.classifications.join(", ")}`,
    `- Linked work: ${signal.issueRefs.join(", ") || "none"}`,
    `- Evidence: ${signal.evidenceKeys.join(", ")}`,
    `- Rationale: ${signal.rationale}`,
    "",
  ]);
  const exclusions = review.decisions
    .filter((decision) => !decision.included)
    .map(
      (decision) =>
        `- ${decision.sourceId}:${decision.sourceRecordId} — ${decision.reason}`
    );
  return [
    "---",
    'artifact: "reconciliation-review"',
    `reviewId: "${review.reviewId}"`,
    `scope: "${review.window.scope}"`,
    `rootDir: ${JSON.stringify(review.window.rootDir)}`,
    ...(review.window.projectRoot
      ? [`projectRoot: ${JSON.stringify(review.window.projectRoot)}`]
      : []),
    `since: "${review.window.since}"`,
    `until: "${review.window.until}"`,
    `coverageComplete: ${review.coverageComplete}`,
    `degraded: ${review.degraded}`,
    "---",
    "",
    `# Reconciliation review ${review.reviewId}`,
    "",
    review.emptyReason ??
      `${review.signals.length} correlated signal(s) were discovered.`,
    "",
    "## Source coverage",
    "",
    "| Source | Type | State | Records | Signals | Detail |",
    "| --- | --- | --- | ---: | ---: | --- |",
    ...coverage,
    "",
    "## Signals and dispositions",
    "",
    ...(signals.length > 0 ? signals : ["No correlated signals.", ""]),
    "## Excluded records",
    "",
    ...(exclusions.length > 0 ? exclusions : ["No records were excluded."]),
    "",
  ].join("\n");
}

function updateState(args: {
  state: ReconciliationState;
  review: ReconciliationReview;
  adapterResults: Map<string, AdapterScanResult>;
  config: ReconciliationConfig;
}): ReconciliationState {
  const next = structuredClone(args.state);
  for (const coverage of args.review.coverage) {
    const result = args.adapterResults.get(coverage.sourceId);
    const prior = next.sources[coverage.sourceId];
    const source = args.config.sources.find(
      (entry) => entry.id === coverage.sourceId
    );
    if (!source) {
      continue;
    }
    const advances = coverage.state !== "unavailable";
    const resultWatermark = result?.watermark;
    const keepsPriorWatermark = Boolean(
      advances &&
        prior?.watermark &&
        resultWatermark &&
        Date.parse(prior.watermark) > Date.parse(resultWatermark)
    );
    const keepsPriorCoverage = Boolean(
      prior?.coverageUntil &&
        Date.parse(prior.coverageUntil) > Date.parse(args.review.window.until)
    );
    next.sources[coverage.sourceId] = {
      watermark:
        advances && !keepsPriorWatermark
          ? (resultWatermark ?? prior?.watermark)
          : prior?.watermark,
      cursor:
        advances && !keepsPriorWatermark
          ? (result?.cursor ?? prior?.cursor)
          : prior?.cursor,
      configDigest: sourceStateDigest(source),
      adapterVersion: reconciliationAdapterFor(source.type).version,
      lastCheckedAt: keepsPriorCoverage
        ? (prior?.lastCheckedAt ?? coverage.checkedAt)
        : coverage.checkedAt,
      coverageUntil: keepsPriorCoverage
        ? prior?.coverageUntil
        : args.review.window.until,
      coverageState: keepsPriorCoverage
        ? (prior?.coverageState ?? coverage.state)
        : coverage.state,
    };
  }
  for (const item of args.review.evidence) {
    const prior = next.evidence[item.dedupeKey];
    next.evidence[item.dedupeKey] = {
      firstSeenAt: prior?.firstSeenAt ?? args.review.generatedAt,
      lastSeenAt: args.review.generatedAt,
      sourceIds: unique([...(prior?.sourceIds ?? []), ...item.sourceIds]),
      reviewIds: unique([...(prior?.reviewIds ?? []), args.review.reviewId]),
    };
  }
  for (const decision of args.review.decisions) {
    next.decisions[decision.id] = {
      included: decision.included,
      classification: decision.classification,
      reason: decision.reason,
      disposition: decision.disposition,
      lastReviewedAt: args.review.generatedAt,
      reviewId: args.review.reviewId,
    };
  }
  next.reviews[args.review.reviewId] = {
    since: args.review.window.since,
    until: args.review.window.until,
    generatedAt: args.review.generatedAt,
    artifactPath: args.review.artifactPath,
    coverageComplete: args.review.coverageComplete,
    evidenceKeys: args.review.evidence.map((item) => item.dedupeKey),
    signalIds: args.review.signals.map((signal) => signal.id),
  };
  return next;
}

function latestReviewId(state: ReconciliationState): string | undefined {
  return Object.entries(state.reviews).sort(
    ([, left], [, right]) =>
      right.until.localeCompare(left.until) ||
      right.since.localeCompare(left.since) ||
      right.generatedAt.localeCompare(left.generatedAt)
  )[0]?.[0];
}

export async function reconcileSources(args: {
  homeDir: string;
  rootDir: string;
  since: string;
  until?: string;
  configPath?: string;
  sourceIds?: string[];
  incremental?: boolean;
}): Promise<ReconciliationReview> {
  const { config } = await loadReconciliationConfig(args);
  const enabledSources = config.sources.filter(
    (source) => source.enabled !== false
  );
  const unknownSourceIds = (args.sourceIds ?? []).filter(
    (sourceId) => !enabledSources.some((source) => source.id === sourceId)
  );
  if (unknownSourceIds.length > 0) {
    throw new Error(
      `Unknown or disabled reconciliation source ids: ${unknownSourceIds.join(", ")}`
    );
  }
  const selectedConfig: ReconciliationConfig = {
    version: 1,
    sources: enabledSources.filter(
      (source) => !args.sourceIds?.length || args.sourceIds.includes(source.id)
    ),
  };
  const filteredCoverage =
    selectedConfig.sources.length < enabledSources.length;
  if (selectedConfig.sources.length === 0) {
    throw new Error("No enabled reconciliation sources matched the request");
  }
  const requestedWindow = createWindow({
    config: selectedConfig,
    rootDir: args.rootDir,
    homeDir: args.homeDir,
    since: args.since,
    until: args.until ?? new Date().toISOString(),
    mode: args.incremental ? "incremental" : "window",
  });
  const statePath = facultAiReconciliationStatePath(args.homeDir, args.rootDir);
  return await withStateLock(statePath, async () => {
    const state = await loadState(statePath);
    const effectiveStarts = selectedConfig.sources.map((source) => {
      const priorState = state.sources[source.id];
      const adapter = reconciliationAdapterFor(source.type);
      const prior =
        priorState?.configDigest === sourceStateDigest(source) &&
        priorState.adapterVersion === adapter.version
          ? priorState
          : undefined;
      return boundedIncrementalSince(
        requestedWindow.since,
        prior?.watermark,
        requestedWindow.until
      );
    });
    const window = args.incremental
      ? createWindow({
          config: selectedConfig,
          rootDir: args.rootDir,
          homeDir: args.homeDir,
          since: effectiveStarts.sort().at(0) ?? requestedWindow.since,
          until: requestedWindow.until,
          mode: "incremental",
        })
      : requestedWindow;
    const windowPath = join(dirname(statePath), "windows", `${window.id}.json`);
    const projectRoot = projectRootFromAiRoot(args.rootDir, args.homeDir);
    const checkedAt = new Date().toISOString();
    const coverage: SourceCoverage[] = [];
    const records: SourceRecord[] = [];
    const adapterResults = new Map<string, AdapterScanResult>();
    for (const source of selectedConfig.sources) {
      const priorState = state.sources[source.id];
      const adapter = reconciliationAdapterFor(source.type);
      const sourceDigest = sourceStateDigest(source);
      const prior =
        priorState?.configDigest === sourceDigest &&
        priorState.adapterVersion === adapter.version
          ? priorState
          : undefined;
      const sourceWindow = {
        ...window,
        since: args.incremental
          ? boundedIncrementalSince(
              requestedWindow.since,
              prior?.watermark,
              requestedWindow.until
            )
          : window.since,
      };
      const result = await adapter.scan({
        config: source,
        homeDir: args.homeDir,
        rootDir: args.rootDir,
        projectRoot,
        window: sourceWindow,
        previousWatermark: prior?.watermark,
        previousCursor: prior?.cursor,
      });
      if (result.watermark && !result.cursor) {
        const lastRecordId = result.records
          .filter((record) => record.observedAt === result.watermark)
          .map((record) => record.recordId)
          .sort()
          .at(-1);
        result.cursor = lastRecordId
          ? `${result.watermark}|${lastRecordId}`
          : result.watermark;
      }
      adapterResults.set(source.id, result);
      const reviewRecords = args.incremental
        ? result.records.filter(
            (record) =>
              !(
                prior?.watermark &&
                Date.parse(record.observedAt) <= Date.parse(prior.watermark) &&
                state.evidence[record.dedupeKey]?.sourceIds.includes(source.id)
              )
          )
        : result.records;
      records.push(...reviewRecords);
      coverage.push({
        sourceId: source.id,
        sourceType: source.type,
        state: result.state,
        checkedAt,
        watermarkBefore: prior?.watermark,
        watermarkAfter: result.watermark ?? prior?.watermark,
        cursorBefore: prior?.cursor,
        cursorAfter: result.cursor ?? prior?.cursor,
        recordsScanned: result.records.length,
        signalsDiscovered: 0,
        unavailableReason: result.unavailableReason,
        staleReason: result.staleReason,
      });
    }
    const decisions = records.map(extractionDecision);
    const correlated = correlate({ records, decisions, state });
    for (const decision of decisions) {
      const evidence = correlated.evidence.find(
        (item) => item.dedupeKey === decision.dedupeKey
      );
      decision.disposition = evidence?.disposition;
      const coverageEntry = coverage.find(
        (entry) => entry.sourceId === decision.sourceId
      );
      if (decision.included && coverageEntry) {
        coverageEntry.signalsDiscovered += 1;
      }
    }
    const coverageComplete =
      !filteredCoverage &&
      coverage.every(
        (entry) => entry.state === "checked" || entry.state === "changed"
      );
    const degraded =
      filteredCoverage ||
      coverage.some(
        (entry) => entry.state === "unavailable" || entry.state === "stale"
      );
    const reviewDir = facultAiReconciliationReviewDir(
      args.homeDir,
      args.rootDir
    );
    const artifactPath = join(reviewDir, `${window.id}.md`);
    const emptyReason =
      correlated.signals.length > 0
        ? undefined
        : filteredCoverage
          ? "No signals are reported, but the run checked only a filtered source subset; this is not a proven empty review."
          : coverageComplete
            ? "Zero signals discovered after every configured source was checked for this review window."
            : "No signals are reported, but configured coverage is degraded; this is not a proven empty review.";
    const review: ReconciliationReview = {
      version: 1,
      reviewId: window.id,
      generatedAt: checkedAt,
      window,
      coverageComplete,
      degraded,
      emptyReason,
      coverage,
      decisions,
      evidence: correlated.evidence,
      signals: correlated.signals,
      unresolvedSignals: correlated.signals
        .filter((signal) => signal.unresolved)
        .map((signal) => signal.id),
      linkedWork: unique(
        correlated.signals.flatMap((signal) => signal.issueRefs)
      ),
      dispositionCounts: dispositionCounts(correlated.signals),
      artifactPath,
    };
    await mkdir(reviewDir, { recursive: true });
    const markdown = `${renderReview(review)}\n`;
    await atomicWrite(artifactPath, markdown);
    await atomicWrite(windowPath, `${JSON.stringify(review, null, 2)}\n`);
    const nextState = updateState({
      state,
      review,
      adapterResults,
      config: selectedConfig,
    });
    if (latestReviewId(nextState) === review.reviewId) {
      await atomicWrite(join(reviewDir, "latest.md"), markdown);
    }
    await atomicWrite(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
    return review;
  });
}

export async function reconciliationStatus(args: {
  homeDir: string;
  rootDir: string;
}): Promise<{
  configured: boolean;
  configurationState: "ready" | "not_configured" | "invalid";
  configurationError?: string;
  stateError?: string;
  configPath: string;
  statePath: string;
  sourceCount: number;
  lastReviewId?: string;
  coverageState?: "complete" | "degraded";
}> {
  const statePath = facultAiReconciliationStatePath(args.homeDir, args.rootDir);
  const configPath = join(args.rootDir, "reconciliation.json");
  if (!(await Bun.file(configPath).exists())) {
    return {
      configured: false,
      configurationState: "not_configured",
      configPath,
      statePath,
      sourceCount: 0,
    };
  }
  let loaded: Awaited<ReturnType<typeof loadReconciliationConfig>>;
  try {
    loaded = await loadReconciliationConfig(args);
  } catch (error) {
    return {
      configured: false,
      configurationState: "invalid",
      configurationError:
        error instanceof Error ? error.message : String(error),
      configPath,
      statePath,
      sourceCount: 0,
    };
  }
  const { config, path } = loaded;
  try {
    const state = await loadState(statePath);
    const lastReview = Object.entries(state.reviews).sort(
      ([, left], [, right]) =>
        right.until.localeCompare(left.until) ||
        right.since.localeCompare(left.since) ||
        right.generatedAt.localeCompare(left.generatedAt)
    )[0];
    const enabledSources = config.sources.filter(
      (source) => source.enabled !== false
    );
    const degraded =
      enabledSources.length === 0 ||
      enabledSources.some((source) => {
        const persisted = state.sources[source.id];
        const adapter = reconciliationAdapterFor(source.type);
        return (
          !persisted ||
          persisted.configDigest !== sourceStateDigest(source) ||
          persisted.adapterVersion !== adapter.version ||
          persisted.coverageState === "unavailable" ||
          persisted.coverageState === "stale"
        );
      });
    return {
      configured: true,
      configurationState: "ready",
      configPath: path,
      statePath,
      sourceCount: enabledSources.length,
      lastReviewId: lastReview?.[0],
      coverageState:
        degraded || lastReview?.[1].coverageComplete !== true
          ? "degraded"
          : lastReview
            ? "complete"
            : undefined,
    };
  } catch (error) {
    return {
      configured: true,
      configurationState: "ready",
      stateError: error instanceof Error ? error.message : String(error),
      configPath: path,
      statePath,
      sourceCount: config.sources.filter((source) => source.enabled !== false)
        .length,
      coverageState: "degraded",
    };
  }
}

export async function latestReconciliationReview(args: {
  homeDir: string;
  rootDir: string;
}): Promise<ReconciliationReview | null> {
  const statePath = facultAiReconciliationStatePath(args.homeDir, args.rootDir);
  const state = await loadState(statePath);
  const latestId = latestReviewId(state);
  if (!latestId) {
    return null;
  }
  const windowPath = join(dirname(statePath), "windows", `${latestId}.json`);
  try {
    return JSON.parse(
      await readFile(windowPath, "utf8")
    ) as ReconciliationReview;
  } catch {
    return null;
  }
}
