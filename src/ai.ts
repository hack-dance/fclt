import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ensureAiGraphPath } from "./ai-state";
import { parseCliContextArgs, resolveCliContextRoot } from "./cli-context";
import type { AssetScope, GraphNodeKind } from "./graph";
import { loadGraph, resolveGraphNode } from "./graph-query";
import {
  facultAiDraftDir,
  facultAiJournalPath,
  facultAiProposalDir,
  facultAiWritebackQueuePath,
  facultRootDir,
  projectRootFromAiRoot,
  projectSlugFromAiRoot,
} from "./paths";

const NEWLINE_RE = /\r?\n/;
const TRAILING_NEWLINE_RE = /\n$/;
const NUMERIC_SUFFIX_RE = /(\d+)$/;
const SLUG_SPLIT_RE = /[/_-]+/;
const SKILL_MD_SUFFIX_RE = /\/SKILL\.md$/;
const MARKDOWN_SUFFIX_RE = /\.md$/;
const SKILL_SUFFIX_RE = /SKILL$/;

export type WritebackStatus =
  | "suggested"
  | "recorded"
  | "grouped"
  | "promoted"
  | "resolved"
  | "dismissed"
  | "superseded";
export type ProposalStatus =
  | "proposed"
  | "drafted"
  | "in_review"
  | "accepted"
  | "rejected"
  | "applied"
  | "failed"
  | "superseded";
export type ConfidenceLevel = "low" | "medium" | "high";
export type ProposalKind =
  | "update_asset"
  | "create_asset"
  | "create_instruction"
  | "update_instruction"
  | "create_agent"
  | "update_agent"
  | "extract_snippet"
  | "add_skill"
  | "promote_asset";

export interface WritebackEvidence {
  type: string;
  ref: string;
}

export interface AiJournalEvent {
  id: string;
  ts: string;
  kind: string;
  source: string;
  scope: AssetScope;
  projectSlug?: string;
  projectRoot?: string;
  summary: string;
  refs?: string[];
  evidence?: WritebackEvidence[];
  tags?: string[];
}

export interface AiWritebackRecord {
  id: string;
  ts: string;
  updatedAt?: string;
  scope: AssetScope;
  projectSlug?: string;
  projectRoot?: string;
  kind: string;
  summary: string;
  evidence: WritebackEvidence[];
  confidence: ConfidenceLevel;
  source: string;
  assetRef?: string;
  assetId?: string;
  assetType?: string;
  suggestedDestination?: string;
  domain?: string;
  tags: string[];
  status: WritebackStatus;
}

export interface ProposalReviewHistoryEntry {
  ts: string;
  action: string;
  actor: string;
  note?: string;
}

export interface ProposalReviewRecord {
  status?: "in_review" | "accepted" | "rejected" | "superseded";
  reviewer?: string;
  reviewedAt?: string;
  rejectionReason?: string;
  supersededBy?: string;
  history: ProposalReviewHistoryEntry[];
}

export interface ProposalApplyResult {
  status: "applied" | "failed";
  appliedAt: string;
  appliedBy: string;
  changedFiles: string[];
  draftRefs: string[];
  message?: string;
}

export interface ProposalDraftHistoryEntry {
  ts: string;
  action: "generated" | "revised";
  actor: string;
  draftRefs: string[];
  note?: string;
}

export interface AiProposalRecord {
  id: string;
  ts: string;
  status: ProposalStatus;
  scope: AssetScope;
  projectSlug?: string;
  projectRoot?: string;
  kind: ProposalKind;
  targets: string[];
  sourceWritebacks: string[];
  summary: string;
  rationale: string;
  confidence: ConfidenceLevel;
  reviewRequired: boolean;
  policyClass: string;
  draftRefs: string[];
  sourceProposals?: string[];
  draftHistory?: ProposalDraftHistoryEntry[];
  review?: ProposalReviewRecord;
  applyResult?: ProposalApplyResult;
}

export interface AiWritebackGroup {
  by: "asset" | "kind" | "domain";
  key: string;
  count: number;
  writebackIds: string[];
  assetRefs: string[];
  kinds: string[];
  domains: string[];
  tags: string[];
  summary: string;
}

interface ScopeContext {
  scope: AssetScope;
  projectSlug?: string;
  projectRoot?: string;
}

interface AddWritebackArgs {
  homeDir?: string;
  rootDir: string;
  kind: string;
  summary: string;
  asset?: string;
  evidence?: WritebackEvidence[];
  confidence?: ConfidenceLevel;
  source?: string;
  suggestedDestination?: string;
  domain?: string;
  tags?: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function fileExists(pathValue: string): Promise<boolean> {
  try {
    await Bun.file(pathValue).stat();
    return true;
  } catch {
    return false;
  }
}

async function ensureParentDir(pathValue: string) {
  await mkdir(dirname(pathValue), { recursive: true });
}

async function appendJsonLine(pathValue: string, value: unknown) {
  await ensureParentDir(pathValue);
  await appendFile(pathValue, `${JSON.stringify(value)}\n`, "utf8");
}

async function readJsonLines<T>(pathValue: string): Promise<T[]> {
  if (!(await fileExists(pathValue))) {
    return [];
  }
  const text = await readFile(pathValue, "utf8");
  return text
    .split(NEWLINE_RE)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function supportedDraftTarget(pathValue: string): boolean {
  return pathValue.toLowerCase().endsWith(".md");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function slugToTitle(value: string): string {
  return value
    .split(SLUG_SPLIT_RE)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function canonicalRefToPath(args: {
  ref: string;
  homeDir: string;
  rootDir: string;
}): string | null {
  if (args.ref.startsWith("@ai/")) {
    return join(facultRootDir(args.homeDir), args.ref.slice("@ai/".length));
  }
  if (args.ref.startsWith("@project/")) {
    return join(args.rootDir, args.ref.slice("@project/".length));
  }
  return null;
}

function numericSuffix(id: string): number {
  const match = NUMERIC_SUFFIX_RE.exec(id);
  return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
}

function nextId(prefix: string, ids: string[]): string {
  const next = ids.reduce((max, id) => Math.max(max, numericSuffix(id)), 0) + 1;
  return `${prefix}-${String(next).padStart(5, "0")}`;
}

function resolveScopeContext(rootDir: string, homeDir: string): ScopeContext {
  const projectRoot = projectRootFromAiRoot(rootDir, homeDir);
  const projectSlug = projectSlugFromAiRoot(rootDir, homeDir);
  if (projectRoot && projectSlug) {
    return {
      scope: "project",
      projectRoot,
      projectSlug,
    };
  }
  return { scope: "global" };
}

async function latestWritebackMap(args: {
  homeDir: string;
  rootDir: string;
}): Promise<Map<string, AiWritebackRecord>> {
  const entries = await readJsonLines<AiWritebackRecord>(
    facultAiWritebackQueuePath(args.homeDir, args.rootDir)
  );
  const latest = new Map<string, AiWritebackRecord>();
  for (const entry of entries) {
    latest.set(entry.id, entry);
  }
  return latest;
}

async function appendEvent(
  homeDir: string,
  rootDir: string,
  event: AiJournalEvent
): Promise<void> {
  const pathValue = facultAiJournalPath(homeDir, rootDir);
  const existing = await readJsonLines<AiJournalEvent>(pathValue);
  const next = {
    ...event,
    id: nextId(
      "EVT",
      existing.map((entry) => entry.id)
    ),
  };
  await appendJsonLine(pathValue, next);
}

function mapGraphNodeKind(kind: GraphNodeKind): string {
  switch (kind) {
    case "instruction":
    case "snippet":
    case "agent":
    case "skill":
    case "mcp":
    case "doc":
    case "rendered-target":
      return kind;
    default:
      return "asset";
  }
}

async function resolveAssetSelection(args: {
  homeDir: string;
  rootDir: string;
  asset: string;
}): Promise<{
  assetRef?: string;
  assetId?: string;
  assetType?: string;
}> {
  await ensureAiGraphPath({
    homeDir: args.homeDir,
    rootDir: args.rootDir,
    repair: true,
  });
  const graph = await loadGraph({
    homeDir: args.homeDir,
    rootDir: args.rootDir,
  });
  const node = resolveGraphNode(graph, args.asset);
  if (!node) {
    throw new Error(`Asset not found in graph: ${args.asset}`);
  }
  return {
    assetRef: node.canonicalRef ?? node.id,
    assetId: node.id,
    assetType: mapGraphNodeKind(node.kind),
  };
}

export async function addWriteback(
  args: AddWritebackArgs
): Promise<AiWritebackRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const scopeContext = resolveScopeContext(args.rootDir, homeDir);
  const latest = await latestWritebackMap({
    homeDir,
    rootDir: args.rootDir,
  });
  const asset = args.asset
    ? await resolveAssetSelection({
        homeDir,
        rootDir: args.rootDir,
        asset: args.asset,
      })
    : {};
  const record: AiWritebackRecord = {
    id: nextId("WB", [...latest.keys()]),
    ts: nowIso(),
    scope: scopeContext.scope,
    projectSlug: scopeContext.projectSlug,
    projectRoot: scopeContext.projectRoot,
    kind: args.kind.trim(),
    summary: args.summary.trim(),
    evidence: args.evidence ?? [],
    confidence: args.confidence ?? "medium",
    source: args.source ?? "facult:manual",
    assetRef: asset.assetRef,
    assetId: asset.assetId,
    assetType: asset.assetType,
    suggestedDestination: args.suggestedDestination ?? asset.assetRef,
    domain: args.domain,
    tags: [
      ...new Set((args.tags ?? []).map((tag) => tag.trim()).filter(Boolean)),
    ],
    status: "recorded",
  };

  await appendJsonLine(
    facultAiWritebackQueuePath(homeDir, args.rootDir),
    record
  );
  await appendEvent(homeDir, args.rootDir, {
    id: nextId("EVT", []),
    ts: record.ts,
    kind: "writeback_recorded",
    source: record.source,
    scope: record.scope,
    projectSlug: record.projectSlug,
    projectRoot: record.projectRoot,
    summary: record.summary,
    refs: record.assetRef ? [record.assetRef] : undefined,
    evidence: record.evidence,
    tags: record.tags,
  });
  return record;
}

export async function listWritebacks(args?: {
  homeDir?: string;
  rootDir: string;
}): Promise<AiWritebackRecord[]> {
  if (!args) {
    throw new Error("listWritebacks requires a rootDir");
  }
  const homeDir = args?.homeDir ?? process.env.HOME ?? "";
  const latest = await latestWritebackMap({
    homeDir,
    rootDir: args.rootDir,
  });
  return [...latest.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function showWriteback(
  id: string,
  args: { homeDir?: string; rootDir: string }
): Promise<AiWritebackRecord | null> {
  const latest = await latestWritebackMap({
    homeDir: args.homeDir ?? process.env.HOME ?? "",
    rootDir: args.rootDir,
  });
  return latest.get(id) ?? null;
}

async function updateWritebackStatus(
  id: string,
  status: WritebackStatus,
  args: { homeDir?: string; rootDir: string }
): Promise<AiWritebackRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const current = await showWriteback(id, { homeDir, rootDir: args.rootDir });
  if (!current) {
    throw new Error(`Writeback not found: ${id}`);
  }
  const next: AiWritebackRecord = {
    ...current,
    status,
    updatedAt: nowIso(),
  };
  const eventTs = next.updatedAt ?? next.ts;
  await appendJsonLine(facultAiWritebackQueuePath(homeDir, args.rootDir), next);
  await appendEvent(homeDir, args.rootDir, {
    id: nextId("EVT", []),
    ts: eventTs,
    kind: "writeback_status_changed",
    source: "facult:manual",
    scope: next.scope,
    projectSlug: next.projectSlug,
    projectRoot: next.projectRoot,
    summary: `${id} -> ${status}`,
    refs: next.assetRef ? [next.assetRef] : undefined,
    tags: next.tags,
  });
  return next;
}

export function dismissWriteback(
  id: string,
  args: { homeDir?: string; rootDir: string }
): Promise<AiWritebackRecord> {
  return updateWritebackStatus(id, "dismissed", args);
}

export function promoteWriteback(
  id: string,
  args: { homeDir?: string; rootDir: string }
): Promise<AiWritebackRecord> {
  return updateWritebackStatus(id, "promoted", args);
}

function summarizeGroup(
  by: "asset" | "kind" | "domain",
  key: string,
  entries: AiWritebackRecord[]
): string {
  if (by === "asset") {
    return `${key} has ${entries.length} writeback${entries.length === 1 ? "" : "s"} across ${uniqueStrings(entries.map((entry) => entry.kind)).join(", ")}.`;
  }
  if (by === "domain") {
    return `${key} appears in ${entries.length} writeback${entries.length === 1 ? "" : "s"} across ${uniqueStrings(entries.map((entry) => entry.kind)).join(", ")}.`;
  }
  return `${key} appears in ${entries.length} writeback${entries.length === 1 ? "" : "s"} across ${uniqueStrings(entries.map((entry) => entry.assetRef ?? "unscoped")).join(", ")}.`;
}

export async function groupWritebacks(args: {
  homeDir?: string;
  rootDir: string;
  by: "asset" | "kind" | "domain";
}): Promise<AiWritebackGroup[]> {
  const writebacks = await listWritebacks({
    homeDir: args.homeDir,
    rootDir: args.rootDir,
  });
  const groups = new Map<string, AiWritebackRecord[]>();
  for (const entry of writebacks) {
    if (entry.status === "dismissed" || entry.status === "superseded") {
      continue;
    }
    const key =
      args.by === "asset"
        ? (entry.assetRef ?? entry.suggestedDestination ?? "unassigned")
        : args.by === "kind"
          ? entry.kind
          : (entry.domain ?? "unassigned");
    const next = groups.get(key) ?? [];
    next.push(entry);
    groups.set(key, next);
  }

  return [...groups.entries()]
    .map(([key, entries]) => ({
      by: args.by,
      key,
      count: entries.length,
      writebackIds: entries.map((entry) => entry.id).sort(),
      assetRefs: uniqueStrings(entries.map((entry) => entry.assetRef ?? "")),
      kinds: uniqueStrings(entries.map((entry) => entry.kind)),
      domains: uniqueStrings(entries.map((entry) => entry.domain ?? "")),
      tags: uniqueStrings(entries.flatMap((entry) => entry.tags)),
      summary: summarizeGroup(args.by, key, entries),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function summarizeWritebacks(args: {
  homeDir?: string;
  rootDir: string;
  by: "asset" | "kind" | "domain";
}): Promise<AiWritebackGroup[]> {
  return groupWritebacks(args);
}

function inferProposalKind(args: {
  target: string;
  targetPath: string | null;
  targetKind?: GraphNodeKind | null;
}): ProposalKind {
  if (args.target.includes("/skills/") || args.target.endsWith("/SKILL.md")) {
    return "add_skill";
  }
  if (args.target.includes("/snippets/")) {
    return "extract_snippet";
  }
  if (args.targetKind === "agent" || args.target.includes("/agents/")) {
    return args.targetPath ? "update_agent" : "create_agent";
  }
  if (
    args.targetKind === "instruction" ||
    args.target.includes("/instructions/")
  ) {
    return args.targetPath ? "update_instruction" : "create_instruction";
  }
  if (!args.targetPath) {
    return "create_asset";
  }
  return "update_asset";
}

async function nextProposalId(
  homeDir: string,
  rootDir: string
): Promise<string> {
  const dir = facultAiProposalDir(homeDir, rootDir);
  const entries = await readdir(dir).catch(() => [] as string[]);
  const ids = entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => basename(entry, ".json"));
  return nextId("EV", ids);
}

function policyProfileForProposal(
  scope: AssetScope,
  kind: ProposalKind
): { policyClass: string; reviewRequired: boolean } {
  if (scope === "global") {
    return {
      policyClass: "high-risk",
      reviewRequired: true,
    };
  }

  if (
    kind === "create_instruction" ||
    kind === "create_asset" ||
    kind === "extract_snippet" ||
    kind === "add_skill"
  ) {
    return {
      policyClass: "low-risk",
      reviewRequired: false,
    };
  }

  if (kind === "update_instruction" || kind === "update_asset") {
    return {
      policyClass: "medium-risk",
      reviewRequired: true,
    };
  }

  return {
    policyClass: "high-risk",
    reviewRequired: true,
  };
}

function isStandaloneProposalKind(kind: ProposalKind): boolean {
  return (
    kind === "create_asset" ||
    kind === "create_instruction" ||
    kind === "create_agent" ||
    kind === "extract_snippet" ||
    kind === "add_skill" ||
    kind === "promote_asset"
  );
}

function isAppendProposalKind(kind: ProposalKind): boolean {
  return !isStandaloneProposalKind(kind);
}

function isApplySupportedProposalKind(kind: ProposalKind): boolean {
  return isStandaloneProposalKind(kind) || isAppendProposalKind(kind);
}

async function writeProposalFile(
  homeDir: string,
  rootDir: string,
  proposal: AiProposalRecord
) {
  const dir = facultAiProposalDir(homeDir, rootDir);
  await mkdir(dir, { recursive: true });
  await Bun.write(
    join(dir, `${proposal.id}.json`),
    `${JSON.stringify(proposal, null, 2)}\n`
  );
}

export async function proposeEvolution(args: {
  homeDir?: string;
  rootDir: string;
  asset?: string;
}): Promise<AiProposalRecord[]> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const writebacks = await listWritebacks({
    homeDir,
    rootDir: args.rootDir,
  });
  const scopeContext = resolveScopeContext(args.rootDir, homeDir);
  const graph = await loadGraph({
    homeDir,
    rootDir: args.rootDir,
  }).catch(() => null);
  const filterAsset = args.asset
    ? await resolveAssetSelection({
        homeDir,
        rootDir: args.rootDir,
        asset: args.asset,
      })
    : null;

  const candidates = writebacks.filter((entry) => {
    if (entry.status === "dismissed" || entry.status === "superseded") {
      return false;
    }
    if (filterAsset) {
      return (
        entry.assetId === filterAsset.assetId ||
        entry.assetRef === filterAsset.assetRef
      );
    }
    return Boolean(entry.suggestedDestination ?? entry.assetRef);
  });

  const groups = new Map<string, AiWritebackRecord[]>();
  for (const entry of candidates) {
    const target = entry.suggestedDestination ?? entry.assetRef;
    if (!target) {
      continue;
    }
    const next = groups.get(target) ?? [];
    next.push(entry);
    groups.set(target, next);
  }

  const proposals: AiProposalRecord[] = [];
  for (const [target, entries] of groups) {
    if (entries.length === 0) {
      continue;
    }
    const id = await nextProposalId(homeDir, args.rootDir);
    const targetPath = canonicalRefToPath({
      ref: target,
      homeDir,
      rootDir: args.rootDir,
    });
    const targetNode = graph && (resolveGraphNode(graph, target) ?? undefined);
    const kind = inferProposalKind({
      target,
      targetKind: targetNode?.kind,
      targetPath:
        targetNode?.path ??
        ((targetPath && (await fileExists(targetPath)) && targetPath) || null),
    });
    const policy = policyProfileForProposal(scopeContext.scope, kind);
    const proposal: AiProposalRecord = {
      id,
      ts: nowIso(),
      status: "proposed",
      scope: scopeContext.scope,
      projectSlug: scopeContext.projectSlug,
      projectRoot: scopeContext.projectRoot,
      kind,
      targets: [target],
      sourceWritebacks: entries.map((entry) => entry.id),
      summary: `Update ${target} based on ${entries.length} writeback${entries.length === 1 ? "" : "s"}.`,
      rationale: `Generated from ${entries.length} writeback${entries.length === 1 ? "" : "s"}: ${entries
        .map((entry) => entry.kind)
        .join(", ")}.`,
      confidence: entries.length > 1 ? "high" : "medium",
      reviewRequired: policy.reviewRequired,
      policyClass: policy.policyClass,
      draftRefs: [],
    };
    await writeProposalFile(homeDir, args.rootDir, proposal);
    await appendEvent(homeDir, args.rootDir, {
      id: nextId("EVT", []),
      ts: proposal.ts,
      kind: "proposal_generated",
      source: "facult:evolution",
      scope: proposal.scope,
      projectSlug: proposal.projectSlug,
      projectRoot: proposal.projectRoot,
      summary: proposal.summary,
      refs: proposal.targets,
      tags: [],
    });
    proposals.push(proposal);
    for (const entry of entries) {
      if (entry.status !== "promoted") {
        await promoteWriteback(entry.id, { homeDir, rootDir: args.rootDir });
      }
    }
  }

  return proposals.sort((a, b) => a.id.localeCompare(b.id));
}

export async function listProposals(args?: {
  homeDir?: string;
  rootDir: string;
}): Promise<AiProposalRecord[]> {
  if (!args) {
    throw new Error("listProposals requires a rootDir");
  }
  const homeDir = args?.homeDir ?? process.env.HOME ?? "";
  const dir = facultAiProposalDir(homeDir, args?.rootDir);
  const entries = await readdir(dir).catch(() => [] as string[]);
  const out: AiProposalRecord[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const raw = await readFile(join(dir, entry), "utf8");
    const parsed = JSON.parse(raw) as AiProposalRecord;
    out.push(parsed);
  }
  return out;
}

export async function showProposal(
  id: string,
  args: { homeDir?: string; rootDir: string }
): Promise<AiProposalRecord | null> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const pathValue = join(
    facultAiProposalDir(homeDir, args.rootDir),
    `${id}.json`
  );
  if (!(await fileExists(pathValue))) {
    return null;
  }
  const raw = await readFile(pathValue, "utf8");
  return JSON.parse(raw) as AiProposalRecord;
}

function promoteTargetRef(target: string, to: "global"): string {
  if (to !== "global") {
    throw new Error(`Unsupported promotion target: ${to}`);
  }
  if (target.startsWith("@project/")) {
    return `@ai/${target.slice("@project/".length)}`;
  }
  if (target.startsWith("@ai/")) {
    return target;
  }
  throw new Error(`Cannot promote non-canonical target: ${target}`);
}

async function saveProposal(
  proposal: AiProposalRecord,
  args: { homeDir?: string; rootDir: string }
): Promise<void> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  await writeProposalFile(homeDir, args.rootDir, proposal);
}

function proposalActor(): string {
  return "facult:manual";
}

function nextReviewHistory(
  proposal: AiProposalRecord,
  entry: ProposalReviewHistoryEntry
): ProposalReviewRecord {
  const review = proposal.review ?? { history: [] };
  return {
    ...review,
    history: [...(review.history ?? []), entry],
  };
}

async function updateProposal(
  id: string,
  args: { homeDir?: string; rootDir: string },
  mutate: (proposal: AiProposalRecord) => AiProposalRecord
): Promise<AiProposalRecord> {
  const current = await showProposal(id, args);
  if (!current) {
    throw new Error(`Proposal not found: ${id}`);
  }
  const next = mutate(current);
  await saveProposal(next, args);
  return next;
}

function draftRefForProposal(
  homeDir: string,
  rootDir: string,
  id: string
): string {
  return join(facultAiDraftDir(homeDir, rootDir), `${id}.md`);
}

function patchRefForProposal(
  homeDir: string,
  rootDir: string,
  id: string
): string {
  return join(facultAiDraftDir(homeDir, rootDir), `${id}.patch`);
}

function renderDraftBody(
  proposal: AiProposalRecord,
  writebacks: AiWritebackRecord[]
): string {
  if (proposal.kind === "add_skill") {
    const target = proposal.targets[0] ?? "";
    const skillSlug =
      target.split("/skills/")[1]?.replace(SKILL_MD_SUFFIX_RE, "") ??
      "new-skill";
    return [
      "---",
      `name: ${skillSlug}`,
      `description: ${proposal.summary}`,
      "---",
      "",
      `# ${slugToTitle(skillSlug)}`,
      "",
      "## Purpose",
      proposal.rationale,
      "",
      "## When to Use",
      ...writebacks.map((entry) => `- ${entry.summary}`),
      "",
    ].join("\n");
  }

  if (isStandaloneProposalKind(proposal.kind)) {
    const target = proposal.targets[0] ?? "";
    const leaf =
      target
        .split("/")
        .pop()
        ?.replace(MARKDOWN_SUFFIX_RE, "")
        .replace(SKILL_SUFFIX_RE, "") ?? proposal.id;
    return [
      `# ${slugToTitle(leaf)}`,
      "",
      proposal.summary,
      "",
      "## Rationale",
      proposal.rationale,
      "",
      "## Supporting Writebacks",
      ...writebacks.map(
        (entry) => `- ${entry.id} (${entry.kind}): ${entry.summary}`
      ),
      "",
    ].join("\n");
  }

  const additionLines = [
    `## Facult Evolution Applied: ${proposal.id}`,
    "",
    `Summary: ${proposal.summary}`,
    "",
    "Supporting writebacks:",
    ...writebacks.map(
      (entry) => `- ${entry.id} (${entry.kind}): ${entry.summary}`
    ),
  ];

  return [
    `# Generated Draft: ${proposal.id}`,
    "",
    `Target: ${proposal.targets.join(", ")}`,
    `Kind: ${proposal.kind}`,
    "",
    "## Rationale",
    proposal.rationale,
    "",
    "## Proposed Addition",
    `<!-- facult:evolution:${proposal.id}:start -->`,
    ...additionLines,
    `<!-- facult:evolution:${proposal.id}:end -->`,
    "",
  ].join("\n");
}

function renderAppliedContent(
  proposal: AiProposalRecord,
  writebacks: AiWritebackRecord[]
): string {
  if (isStandaloneProposalKind(proposal.kind)) {
    return renderDraftBody(proposal, writebacks).trimEnd();
  }
  return extractDraftAddition(
    proposal.id,
    renderDraftBody(proposal, writebacks)
  );
}

function renderPatchBody(args: {
  targetPath: string;
  currentText: string;
  nextText: string;
}): string {
  const oldLines = args.currentText
    .replace(TRAILING_NEWLINE_RE, "")
    .split("\n");
  const newLines = args.nextText.replace(TRAILING_NEWLINE_RE, "").split("\n");
  return [
    `--- ${args.targetPath}`,
    `+++ ${args.targetPath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function extractDraftAddition(proposalId: string, input: string): string {
  const startMarker = `<!-- facult:evolution:${proposalId}:start -->`;
  const endMarker = `<!-- facult:evolution:${proposalId}:end -->`;
  const start = input.indexOf(startMarker);
  const end = input.indexOf(endMarker);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`Draft for ${proposalId} is missing apply markers`);
  }
  return input.slice(start, end + endMarker.length).trim();
}

async function resolveProposalTargetNode(
  proposal: AiProposalRecord,
  args: { homeDir?: string; rootDir: string }
) {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const target = proposal.targets[0];
  if (!target) {
    throw new Error(`Proposal ${proposal.id} has no targets`);
  }
  const graph = await loadGraph({
    homeDir,
    rootDir: args.rootDir,
  }).catch(() => null);
  const node = graph ? resolveGraphNode(graph, target) : null;
  const fallbackPath = canonicalRefToPath({
    ref: target,
    homeDir,
    rootDir: args.rootDir,
  });
  const pathValue = node?.path ?? fallbackPath;
  if (!pathValue) {
    throw new Error(`Could not resolve target path for ${target}`);
  }
  if (!supportedDraftTarget(pathValue)) {
    throw new Error(
      `Apply currently supports markdown targets only: ${pathValue}`
    );
  }
  return {
    ...node,
    path: pathValue,
    canonicalRef: node?.canonicalRef ?? target,
  };
}

export async function draftProposal(
  id: string,
  args: { homeDir?: string; rootDir: string; append?: string }
): Promise<AiProposalRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const current = await showProposal(id, { homeDir, rootDir: args.rootDir });
  if (!current) {
    throw new Error(`Proposal not found: ${id}`);
  }
  const writebacks = (
    await Promise.all(
      current.sourceWritebacks.map(async (writebackId) => {
        const entry = await showWriteback(writebackId, {
          homeDir,
          rootDir: args.rootDir,
        });
        return entry ?? null;
      })
    )
  ).filter((entry): entry is AiWritebackRecord => Boolean(entry));
  const targetNode = await resolveProposalTargetNode(current, {
    homeDir,
    rootDir: args.rootDir,
  });
  const draftPath = draftRefForProposal(homeDir, args.rootDir, id);
  const patchPath = patchRefForProposal(homeDir, args.rootDir, id);
  await mkdir(dirname(draftPath), { recursive: true });
  const generatedBody = renderDraftBody(current, writebacks);
  const priorDraft =
    args.append && (await fileExists(draftPath))
      ? await readFile(draftPath, "utf8")
      : null;
  const draftBody = args.append
    ? `${(priorDraft ?? generatedBody).trimEnd()}\n\n## Draft Revision\n${args.append.trim()}\n`
    : generatedBody;
  await Bun.write(draftPath, `${draftBody}\n`);
  const currentText = (await fileExists(targetNode.path!))
    ? await readFile(targetNode.path!, "utf8")
    : "";
  const appliedContent = isAppendProposalKind(current.kind)
    ? extractDraftAddition(id, draftBody)
    : draftBody.trimEnd();
  const nextText = currentText.includes(appliedContent)
    ? currentText
    : `${currentText.trimEnd()}\n\n${appliedContent}\n`;
  await Bun.write(
    patchPath,
    `${renderPatchBody({
      targetPath: targetNode.path!,
      currentText,
      nextText,
    })}\n`
  );

  const actor = proposalActor();
  const next = await updateProposal(
    id,
    { homeDir, rootDir: args.rootDir },
    (proposal) => ({
      ...proposal,
      status: "drafted",
      draftRefs: uniqueStrings([draftPath, patchPath, ...proposal.draftRefs]),
      draftHistory: [
        ...(proposal.draftHistory ?? []),
        {
          ts: nowIso(),
          action: args.append ? "revised" : "generated",
          actor,
          draftRefs: uniqueStrings([draftPath, patchPath]),
          note: args.append?.trim(),
        },
      ],
      review: nextReviewHistory(proposal, {
        ts: nowIso(),
        action: args.append ? "draft_revised" : "drafted",
        actor,
        note: targetNode.canonicalRef ?? targetNode.path,
      }),
    })
  );
  await appendEvent(homeDir, args.rootDir, {
    id: "",
    ts: nowIso(),
    kind: "proposal_drafted",
    source: actor,
    scope: next.scope,
    projectSlug: next.projectSlug,
    projectRoot: next.projectRoot,
    summary: `Drafted ${next.id}`,
    refs: [...next.targets, ...next.draftRefs],
    tags: [],
  });
  return next;
}

export function reviewProposal(
  id: string,
  args: { homeDir?: string; rootDir: string }
): Promise<AiProposalRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const actor = proposalActor();
  return updateProposal(id, { homeDir, rootDir: args.rootDir }, (proposal) => {
    const reviewedAt = nowIso();
    return {
      ...proposal,
      status: "in_review",
      review: {
        ...nextReviewHistory(proposal, {
          ts: reviewedAt,
          action: "in_review",
          actor,
        }),
        status: "in_review",
        reviewer: actor,
        reviewedAt,
      },
    };
  });
}

export function acceptProposal(
  id: string,
  args: { homeDir?: string; rootDir: string }
): Promise<AiProposalRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const actor = proposalActor();
  return updateProposal(id, { homeDir, rootDir: args.rootDir }, (proposal) => {
    const reviewedAt = nowIso();
    return {
      ...proposal,
      status: "accepted",
      review: {
        ...nextReviewHistory(proposal, {
          ts: reviewedAt,
          action: "accepted",
          actor,
        }),
        status: "accepted",
        reviewer: actor,
        reviewedAt,
        rejectionReason: undefined,
      },
    };
  });
}

export function rejectProposal(
  id: string,
  args: { homeDir?: string; rootDir: string; reason: string }
): Promise<AiProposalRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const actor = proposalActor();
  return updateProposal(id, { homeDir, rootDir: args.rootDir }, (proposal) => {
    const reviewedAt = nowIso();
    return {
      ...proposal,
      status: "rejected",
      review: {
        ...nextReviewHistory(proposal, {
          ts: reviewedAt,
          action: "rejected",
          actor,
          note: args.reason,
        }),
        status: "rejected",
        reviewer: actor,
        reviewedAt,
        rejectionReason: args.reason,
      },
    };
  });
}

export function supersedeProposal(
  id: string,
  by: string,
  args: { homeDir?: string; rootDir: string }
): Promise<AiProposalRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const actor = proposalActor();
  return updateProposal(id, { homeDir, rootDir: args.rootDir }, (proposal) => {
    const reviewedAt = nowIso();
    return {
      ...proposal,
      status: "superseded",
      review: {
        ...nextReviewHistory(proposal, {
          ts: reviewedAt,
          action: "superseded",
          actor,
          note: by,
        }),
        status: "superseded",
        reviewer: actor,
        reviewedAt,
        supersededBy: by,
      },
    };
  });
}

export async function applyProposal(
  id: string,
  args: { homeDir?: string; rootDir: string }
): Promise<AiProposalRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const current = await showProposal(id, { homeDir, rootDir: args.rootDir });
  if (!current) {
    throw new Error(`Proposal not found: ${id}`);
  }
  if (!isApplySupportedProposalKind(current.kind)) {
    throw new Error(`Unsupported proposal kind for apply: ${current.kind}`);
  }
  const requiresAcceptedReview = current.reviewRequired !== false;
  if (
    (requiresAcceptedReview && current.status !== "accepted") ||
    (!requiresAcceptedReview &&
      current.status !== "accepted" &&
      current.status !== "drafted")
  ) {
    throw new Error(`Proposal must be accepted before apply: ${id}`);
  }
  if (current.draftRefs.length === 0) {
    throw new Error(
      `Proposal ${id} has no draft refs. Run "fclt ai evolve draft ${id}" first.`
    );
  }

  const targetNode = await resolveProposalTargetNode(current, {
    homeDir,
    rootDir: args.rootDir,
  });
  const draftPath = current.draftRefs[0];
  if (!draftPath) {
    throw new Error(`Proposal ${id} has no primary draft ref`);
  }
  const draftText = await readFile(draftPath, "utf8");
  const existingTarget = (await fileExists(targetNode.path!))
    ? await readFile(targetNode.path!, "utf8")
    : "";
  const nextText = isAppendProposalKind(current.kind)
    ? (() => {
        const addition = extractDraftAddition(id, draftText);
        return existingTarget.includes(addition)
          ? existingTarget
          : `${existingTarget.trimEnd()}\n\n${addition}\n`;
      })()
    : `${draftText.trimEnd()}\n`;
  await Bun.write(targetNode.path!, nextText);

  for (const writebackId of current.sourceWritebacks) {
    const writeback = await showWriteback(writebackId, {
      homeDir,
      rootDir: args.rootDir,
    });
    if (!writeback) {
      continue;
    }
    await updateWritebackStatus(writebackId, "resolved", {
      homeDir,
      rootDir: args.rootDir,
    });
  }

  const actor = proposalActor();
  const appliedAt = nowIso();
  const next = await updateProposal(
    id,
    { homeDir, rootDir: args.rootDir },
    (proposal) => ({
      ...proposal,
      status: "applied",
      review: nextReviewHistory(proposal, {
        ts: appliedAt,
        action: "applied",
        actor,
        note: targetNode.path,
      }),
      applyResult: {
        status: "applied",
        appliedAt,
        appliedBy: actor,
        changedFiles: [targetNode.path!],
        draftRefs: proposal.draftRefs,
        message: `Applied ${proposal.id} to ${targetNode.path}`,
      },
    })
  );

  await appendEvent(homeDir, args.rootDir, {
    id: "",
    ts: appliedAt,
    kind: "proposal_applied",
    source: actor,
    scope: next.scope,
    projectSlug: next.projectSlug,
    projectRoot: next.projectRoot,
    summary: `Applied ${next.id}`,
    refs: [targetNode.path!, ...next.targets],
    tags: [],
  });

  return next;
}

export async function promoteProposal(
  id: string,
  args: {
    homeDir?: string;
    rootDir: string;
    to: "global";
  }
): Promise<AiProposalRecord> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  const current = await showProposal(id, { homeDir, rootDir: args.rootDir });
  if (!current) {
    throw new Error(`Proposal not found: ${id}`);
  }
  if (current.scope !== "project") {
    throw new Error(`Only project-scoped proposals can be promoted: ${id}`);
  }
  const sourceWritebacks = (
    await Promise.all(
      current.sourceWritebacks.map(async (writebackId) => {
        return (
          (await showWriteback(writebackId, {
            homeDir,
            rootDir: args.rootDir,
          })) ?? null
        );
      })
    )
  ).filter((entry): entry is AiWritebackRecord => Boolean(entry));
  const targetRoot =
    args.to === "global" ? facultRootDir(homeDir) : args.rootDir;
  const nextIdValue = await nextProposalId(homeDir, targetRoot);
  const promoted: AiProposalRecord = {
    ...current,
    id: nextIdValue,
    ts: nowIso(),
    status: "proposed",
    scope: "global",
    projectSlug: undefined,
    projectRoot: undefined,
    kind: "promote_asset",
    targets: current.targets.map((target) => promoteTargetRef(target, args.to)),
    summary: sourceWritebacks[0]?.summary ?? current.summary,
    rationale: `Promoted from project proposal ${current.id} targeting ${current.targets.join(", ")}. ${current.rationale}`,
    policyClass: "high-risk",
    draftRefs: [],
    sourceProposals: uniqueStrings([
      ...(current.sourceProposals ?? []),
      current.id,
    ]),
    review: {
      history: [
        {
          ts: nowIso(),
          action: "promoted",
          actor: proposalActor(),
          note: `from ${current.scope} to ${args.to}`,
        },
      ],
    },
    applyResult: undefined,
  };
  await writeProposalFile(homeDir, targetRoot, promoted);
  await appendEvent(homeDir, targetRoot, {
    id: "",
    ts: promoted.ts,
    kind: "proposal_promoted",
    source: proposalActor(),
    scope: promoted.scope,
    summary: `Promoted ${current.id} -> ${promoted.id}`,
    refs: [...promoted.targets, current.id],
    tags: [],
  });
  return promoted;
}

function aiHelp(): string {
  return `fclt ai — writeback and evolution workflows

Usage:
  fclt ai writeback <add|list|show|dismiss|promote> [args...]
  fclt ai evolve <propose|list|show|draft|review|accept|reject|supersede|apply> [args...]
`;
}

function writebackHelp(): string {
  return `fclt ai writeback

Usage:
  fclt ai writeback add --kind <kind> --summary <text> [--asset <selector>] [--tag <tag>] [--evidence <type:ref>]
  fclt ai writeback list [--json]
  fclt ai writeback show <id> [--json]
  fclt ai writeback group --by <asset|kind|domain> [--json]
  fclt ai writeback summarize [--by <asset|kind|domain>] [--json]
  fclt ai writeback dismiss <id>
  fclt ai writeback promote <id>
`;
}

function evolveHelp(): string {
  return `fclt ai evolve

Usage:
  fclt ai evolve propose [--asset <selector>] [--json]
  fclt ai evolve list [--json]
  fclt ai evolve show <id> [--json]
  fclt ai evolve draft <id> [--append <text>]
  fclt ai evolve review <id>
  fclt ai evolve accept <id>
  fclt ai evolve reject <id> --reason <text>
  fclt ai evolve supersede <id> --by <proposal-id>
  fclt ai evolve apply <id>
  fclt ai evolve promote <id> --to global
`;
}

function parseStringFlag(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === flag) {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${flag} requires a value`);
      }
      return value;
    }
    if (arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1);
      if (!value) {
        throw new Error(`${flag} requires a value`);
      }
      return value;
    }
  }
  return undefined;
}

function parseRepeatedFlag(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === flag) {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${flag} requires a value`);
      }
      values.push(value);
      i += 1;
      continue;
    }
    if (arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1);
      if (!value) {
        throw new Error(`${flag} requires a value`);
      }
      values.push(value);
    }
  }
  return values;
}

function parseEvidence(argv: string[]): WritebackEvidence[] {
  return parseRepeatedFlag(argv, "--evidence").map((entry) => {
    const [type, ...rest] = entry.split(":");
    const ref = rest.join(":").trim();
    if (!(type?.trim() && ref)) {
      throw new Error(`Invalid evidence reference: ${entry}`);
    }
    return { type: type.trim(), ref };
  });
}

async function writebackCommand(argv: string[]) {
  const [sub, ...rest] = argv;
  const parsed = parseCliContextArgs(rest);

  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(writebackHelp());
    return;
  }

  const rootDir = resolveCliContextRoot({
    rootArg: parsed.rootArg,
    scope: parsed.scope,
    cwd: process.cwd(),
  });

  try {
    if (sub === "add") {
      const kind = parseStringFlag(parsed.argv, "--kind");
      const summary = parseStringFlag(parsed.argv, "--summary");
      if (!(kind && summary)) {
        throw new Error("writeback add requires --kind and --summary");
      }
      const record = await addWriteback({
        rootDir,
        kind,
        summary,
        asset: parseStringFlag(parsed.argv, "--asset"),
        confidence:
          (parseStringFlag(parsed.argv, "--confidence") as
            | ConfidenceLevel
            | undefined) ?? undefined,
        suggestedDestination: parseStringFlag(
          parsed.argv,
          "--suggested-destination"
        ),
        tags: parseRepeatedFlag(parsed.argv, "--tag"),
        evidence: parseEvidence(parsed.argv),
      });
      console.log(`Recorded writeback ${record.id}`);
      console.log(JSON.stringify(record, null, 2));
      return;
    }

    if (sub === "list") {
      const rows = await listWritebacks({ rootDir });
      if (parsed.argv.includes("--json")) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      for (const row of rows) {
        console.log(`${row.id}\t${row.kind}\t[${row.status}]\t${row.summary}`);
      }
      return;
    }

    if (sub === "group" || sub === "summarize") {
      const byValue = parseStringFlag(parsed.argv, "--by") ?? "asset";
      if (byValue !== "asset" && byValue !== "kind" && byValue !== "domain") {
        throw new Error(`Unsupported writeback grouping: ${byValue}`);
      }
      const rows =
        sub === "group"
          ? await groupWritebacks({ rootDir, by: byValue })
          : await summarizeWritebacks({ rootDir, by: byValue });
      if (parsed.argv.includes("--json")) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      for (const row of rows) {
        console.log(
          `${row.key}\tcount=${row.count}\t${sub === "group" ? row.writebackIds.join(",") : row.summary}`
        );
      }
      return;
    }

    if (sub === "show") {
      const id = parsed.argv.find((arg) => !arg.startsWith("-"));
      if (!id) {
        throw new Error("writeback show requires an id");
      }
      const row = await showWriteback(id, { rootDir });
      if (!row) {
        throw new Error(`Writeback not found: ${id}`);
      }
      console.log(JSON.stringify(row, null, 2));
      return;
    }

    if (sub === "dismiss" || sub === "promote") {
      const id = parsed.argv.find((arg) => !arg.startsWith("-"));
      if (!id) {
        throw new Error(`writeback ${sub} requires an id`);
      }
      const row =
        sub === "dismiss"
          ? await dismissWriteback(id, { rootDir })
          : await promoteWriteback(id, { rootDir });
      console.log(`${sub === "dismiss" ? "Dismissed" : "Promoted"} ${row.id}`);
      console.log(JSON.stringify(row, null, 2));
      return;
    }

    throw new Error(`Unknown writeback command: ${sub}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function evolveCommand(argv: string[]) {
  const [sub, ...rest] = argv;
  const parsed = parseCliContextArgs(rest);

  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(evolveHelp());
    return;
  }

  const rootDir = resolveCliContextRoot({
    rootArg: parsed.rootArg,
    scope: parsed.scope,
    cwd: process.cwd(),
  });

  try {
    if (sub === "propose") {
      const proposals = await proposeEvolution({
        rootDir,
        asset: parseStringFlag(parsed.argv, "--asset"),
      });
      if (parsed.argv.includes("--json")) {
        console.log(JSON.stringify(proposals, null, 2));
        return;
      }
      for (const proposal of proposals) {
        console.log(
          `${proposal.id}\t${proposal.targets.join(", ")}\t${proposal.summary}`
        );
      }
      return;
    }

    if (sub === "list") {
      const rows = await listProposals({ rootDir });
      if (parsed.argv.includes("--json")) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      for (const row of rows) {
        console.log(`${row.id}\t[${row.status}]\t${row.targets.join(", ")}`);
      }
      return;
    }

    if (sub === "show") {
      const id = parsed.argv.find((arg) => !arg.startsWith("-"));
      if (!id) {
        throw new Error("evolve show requires an id");
      }
      const row = await showProposal(id, { rootDir });
      if (!row) {
        throw new Error(`Proposal not found: ${id}`);
      }
      console.log(JSON.stringify(row, null, 2));
      return;
    }

    if (
      sub === "draft" ||
      sub === "review" ||
      sub === "accept" ||
      sub === "reject" ||
      sub === "supersede" ||
      sub === "apply" ||
      sub === "promote"
    ) {
      const id = parsed.argv.find((arg) => !arg.startsWith("-"));
      if (!id) {
        throw new Error(`evolve ${sub} requires an id`);
      }
      const row =
        sub === "draft"
          ? await draftProposal(id, {
              rootDir,
              append: parseStringFlag(parsed.argv, "--append"),
            })
          : sub === "review"
            ? await reviewProposal(id, { rootDir })
            : sub === "accept"
              ? await acceptProposal(id, { rootDir })
              : sub === "reject"
                ? await rejectProposal(id, {
                    rootDir,
                    reason:
                      parseStringFlag(parsed.argv, "--reason") ??
                      (() => {
                        throw new Error("evolve reject requires --reason");
                      })(),
                  })
                : sub === "supersede"
                  ? await supersedeProposal(
                      id,
                      parseStringFlag(parsed.argv, "--by") ??
                        (() => {
                          throw new Error("evolve supersede requires --by");
                        })(),
                      { rootDir }
                    )
                  : sub === "promote"
                    ? await promoteProposal(id, {
                        rootDir,
                        to:
                          (parseStringFlag(parsed.argv, "--to") as
                            | "global"
                            | undefined) ??
                          (() => {
                            throw new Error("evolve promote requires --to");
                          })(),
                      })
                    : await applyProposal(id, { rootDir });
      const verb =
        sub === "draft"
          ? "Drafted"
          : sub === "review"
            ? "Reviewed"
            : sub === "accept"
              ? "Accepted"
              : sub === "reject"
                ? "Rejected"
                : sub === "supersede"
                  ? "Superseded"
                  : sub === "promote"
                    ? "Promoted"
                    : "Applied";
      console.log(`${verb} ${row.id}`);
      console.log(JSON.stringify(row, null, 2));
      return;
    }

    throw new Error(`Unknown evolve command: ${sub}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function aiCommand(argv: string[]) {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(aiHelp());
    return;
  }

  if (sub === "writeback") {
    await writebackCommand(rest);
    return;
  }

  if (sub === "evolve") {
    await evolveCommand(rest);
    return;
  }

  console.error(`Unknown ai command: ${sub}`);
  process.exitCode = 1;
}
