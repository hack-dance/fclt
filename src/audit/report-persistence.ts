import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, realpath, stat } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import type { ScanResult } from "../scan";
import {
  auditReportPersistenceSupported,
  writeExclusiveAt,
} from "./safe-openat";
import {
  type AuditSourceSnapshot,
  assertAuditSourceSnapshot,
  validateAuditSourceSnapshot,
} from "./source-provenance";
import type { AuditFinding, AuditItemResult } from "./types";

export type AuditReportMode = "agent" | "static";

export interface AuditEvaluation<TReport> {
  auditedRoots: string[];
  report: TReport;
  sourceSnapshot: AuditSourceSnapshot;
}

export const AUDIT_READ_ONLY_CAPABILITY = "audit-read-only-v1";
export const AUDIT_REPORT_REVISION = 5;
export const AUDIT_REPORT_MAX_AGE_MS = 15 * 60 * 1000;

const PATH_SEGMENT_SPLIT_RE = /[\\/]+/;
const JSON_SUFFIX_RE = /\.json$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

interface PathSemantics {
  parse?(path: string): { root: string };
  relative(from: string, to: string): string;
  sep: string;
}

export interface AuditReportReceipt {
  schemaVersion: 2;
  capability: typeof AUDIT_READ_ONLY_CAPABILITY;
  reportRevision: typeof AUDIT_REPORT_REVISION;
  mode: AuditReportMode;
  persistedAt: string;
  reportTimestamp: string;
  reportSha256: string;
  sourceIdentitySha256: string;
  sourceSnapshot: AuditSourceSnapshot;
  findingIdentities: string[];
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function auditFindingIdentity(args: {
  finding: AuditFinding;
  result: AuditItemResult;
}): string {
  return sha256(
    stableJson({
      evidence: args.finding.evidence ?? null,
      item: args.result.item,
      location: args.finding.location ?? null,
      message: args.finding.message,
      path: args.result.path,
      ruleId: args.finding.ruleId,
      severity: args.finding.severity,
      sourceId: args.result.sourceId ?? null,
      type: args.result.type,
    })
  );
}

function findingIdentities(report: unknown): string[] {
  if (!(report && typeof report === "object")) {
    return [];
  }
  const results = (report as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return [];
  }
  return results
    .flatMap((candidate) => {
      if (!(candidate && typeof candidate === "object")) {
        return [];
      }
      const result = candidate as AuditItemResult;
      if (!Array.isArray(result.findings)) {
        return [];
      }
      return result.findings.map((finding) =>
        auditFindingIdentity({ finding, result })
      );
    })
    .sort();
}

export function auditPathsOverlap(
  a: string,
  b: string,
  semantics: PathSemantics = { parse, relative, sep }
): boolean {
  const aRoot = semantics.parse?.(a).root;
  const bRoot = semantics.parse?.(b).root;
  if (aRoot && bRoot && aRoot.toLowerCase() !== bRoot.toLowerCase()) {
    return false;
  }
  const aToB = semantics.relative(a, b);
  const bToA = semantics.relative(b, a);
  const contains = (value: string) =>
    value === "" ||
    (!(isAbsolute(value) || value.startsWith(`..${semantics.sep}`)) &&
      value !== "..");
  return contains(aToB) || contains(bToA);
}

function hasTraversalSegment(value: string): boolean {
  return value.split(PATH_SEGMENT_SPLIT_RE).includes("..");
}

async function canonicalExistingPath(
  path: string,
  label: string
): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new Error(`${label} could not be resolved safely: ${path}`);
  }
}

function pathsForSource(source: ScanResult["sources"][number]): string[] {
  const directPaths = [
    ...source.roots,
    ...source.evidence,
    ...source.skills.roots,
    ...source.skills.roots.map(dirname),
    ...source.skills.entries,
    ...source.skills.entries.map((entry) => join(entry, "SKILL.md")),
  ];
  const evaluatedFiles = [
    ...source.mcp.configs.map((config) => config.path),
    ...source.assets.files.map((file) => file.path),
  ];
  return [
    ...directPaths,
    ...evaluatedFiles,
    ...evaluatedFiles.map(dirname),
  ].filter((path) => isAbsolute(path));
}

export function auditedRootsFromScan(scan: ScanResult): string[] {
  return Array.from(
    new Set(scan.sources.flatMap(pathsForSource).map((root) => resolve(root)))
  ).sort();
}

export function parseReportRootFlag(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--report-root") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--report-root requires an absolute directory path");
      }
      return value;
    }
    if (arg?.startsWith("--report-root=")) {
      const value = arg.slice("--report-root=".length);
      if (!value) {
        throw new Error("--report-root requires an absolute directory path");
      }
      return value;
    }
  }
  return null;
}

function receiptPath(reportPath: string): string {
  return reportPath.replace(JSON_SUFFIX_RE, ".receipt.json");
}

function readOnlyNoFollowFlags(): number {
  return constants.O_RDONLY + (constants.O_NOFOLLOW ?? 0);
}

export async function persistAuditReport(args: {
  auditedRoots: string[];
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeDescriptorCommit?: () => Promise<void>;
  mode: AuditReportMode;
  report: unknown;
  reportRoot: string;
  sourceSnapshot: AuditSourceSnapshot;
}): Promise<string> {
  if (!auditReportPersistenceSupported()) {
    throw new Error(
      `Audit report persistence is unavailable on ${process.platform}: safe descriptor-relative creation is unsupported`
    );
  }
  if (!isAbsolute(args.reportRoot) || hasTraversalSegment(args.reportRoot)) {
    throw new Error(
      "Audit report root must be an absolute path without traversal segments"
    );
  }

  const requestedRoot = normalize(args.reportRoot);
  const requestedMetadata = await lstat(requestedRoot).catch(() => null);
  if (!requestedMetadata) {
    throw new Error(
      `Audit report root is not fully resolvable: ${args.reportRoot}`
    );
  }
  if (requestedMetadata.isSymbolicLink()) {
    throw new Error(
      `Audit report root must not be a symlink: ${args.reportRoot}`
    );
  }
  if (!requestedMetadata.isDirectory()) {
    throw new Error(
      `Audit report root must be an existing directory: ${args.reportRoot}`
    );
  }
  try {
    await access(requestedRoot, constants.W_OK);
  } catch {
    throw new Error(
      `Audit report root is not unambiguously writable: ${args.reportRoot}`
    );
  }

  const reportRoot = await canonicalExistingPath(
    requestedRoot,
    "Audit report root"
  );
  assertAuditSourceSnapshot(args.sourceSnapshot);
  const canonicalAuditedRoots = await Promise.all(
    args.auditedRoots.map((root) =>
      canonicalExistingPath(root, "Audited source path")
    )
  );
  const protectedRootPaths = new Set(
    args.sourceSnapshot.protectedRoots.map((source) => source.path)
  );
  const unboundRoot = canonicalAuditedRoots.find(
    (root) => !protectedRootPaths.has(root)
  );
  if (unboundRoot) {
    throw new Error(
      `Audit source snapshot does not bind protected root: ${unboundRoot}`
    );
  }
  const overlap = [
    ...args.sourceSnapshot.protectedRoots,
    ...args.sourceSnapshot.evaluatedFiles,
    ...args.sourceSnapshot.evaluatedDirectories,
    ...args.sourceSnapshot.absentPaths,
  ].find((source) => auditPathsOverlap(source.path, reportRoot));
  if (overlap) {
    throw new Error(
      `Audit report root overlaps audited source: ${reportRoot} <-> ${overlap.path}`
    );
  }

  const contents = `${JSON.stringify(args.report, null, 2)}\n`;
  const reportSha256 = sha256(contents);
  const reportFileName = `${args.mode}-${reportSha256}.json`;
  const reportPath = join(reportRoot, reportFileName);
  const reportTimestamp =
    args.report &&
    typeof args.report === "object" &&
    typeof (args.report as { timestamp?: unknown }).timestamp === "string"
      ? (args.report as { timestamp: string }).timestamp
      : "";
  if (!(reportTimestamp && Number.isFinite(Date.parse(reportTimestamp)))) {
    throw new Error(
      "Audit report has no valid timestamp for receipt provenance"
    );
  }

  const receipt: AuditReportReceipt = {
    schemaVersion: 2,
    capability: AUDIT_READ_ONLY_CAPABILITY,
    reportRevision: AUDIT_REPORT_REVISION,
    mode: args.mode,
    persistedAt: reportTimestamp,
    reportTimestamp,
    reportSha256,
    sourceIdentitySha256: sha256(stableJson(args.sourceSnapshot)),
    sourceSnapshot: args.sourceSnapshot,
    findingIdentities: findingIdentities(args.report),
  };
  const receiptContents = `${JSON.stringify(receipt, null, 2)}\n`;

  const directoryHandle = await open(requestedRoot, constants.O_RDONLY);
  try {
    const openedMetadata = await directoryHandle.stat();
    if (
      !openedMetadata.isDirectory() ||
      openedMetadata.dev !== requestedMetadata.dev ||
      openedMetadata.ino !== requestedMetadata.ino
    ) {
      throw new Error(
        "Audit report root changed before it could be safely opened"
      );
    }
    await validateAuditSourceSnapshot(args.sourceSnapshot);
    await args.beforeDescriptorCommit?.();
    await validateAuditSourceSnapshot(args.sourceSnapshot);
    await writeExclusiveAt({
      contents,
      directoryFd: directoryHandle.fd,
      fileName: reportFileName,
    });
    await writeExclusiveAt({
      contents: receiptContents,
      directoryFd: directoryHandle.fd,
      fileName: receiptPath(reportFileName),
    });
    await directoryHandle.sync();
    const finalMetadata = await stat(requestedRoot).catch(() => null);
    const finalCanonical = await realpath(requestedRoot).catch(() => null);
    if (
      !finalMetadata?.isDirectory() ||
      finalMetadata.dev !== openedMetadata.dev ||
      finalMetadata.ino !== openedMetadata.ino ||
      finalCanonical !== reportRoot
    ) {
      throw new Error(
        "Audit report root changed during descriptor-relative commit"
      );
    }
  } finally {
    await directoryHandle.close().catch(() => undefined);
  }
  return reportPath;
}

function assertReceipt(value: unknown): asserts value is AuditReportReceipt {
  const receipt = value as Partial<AuditReportReceipt> | null;
  if (
    !receipt ||
    receipt.schemaVersion !== 2 ||
    receipt.capability !== AUDIT_READ_ONLY_CAPABILITY ||
    receipt.reportRevision !== AUDIT_REPORT_REVISION ||
    (receipt.mode !== "static" && receipt.mode !== "agent") ||
    typeof receipt.persistedAt !== "string" ||
    typeof receipt.reportTimestamp !== "string" ||
    !SHA256_RE.test(receipt.reportSha256 ?? "") ||
    !SHA256_RE.test(receipt.sourceIdentitySha256 ?? "") ||
    !receipt.sourceSnapshot ||
    !Array.isArray(receipt.findingIdentities) ||
    receipt.findingIdentities.some(
      (identity) => typeof identity !== "string" || !SHA256_RE.test(identity)
    )
  ) {
    throw new Error("Audit report receipt schema or revision is unsupported");
  }
  assertAuditSourceSnapshot(receipt.sourceSnapshot);
}

export async function loadVerifiedAuditReport<
  TReport extends {
    mode: AuditReportMode;
    timestamp: string;
    results: AuditItemResult[];
  },
>(args: {
  expectedMode?: AuditReportMode;
  now?: number;
  reportPath: string;
}): Promise<TReport> {
  if (!isAbsolute(args.reportPath) || hasTraversalSegment(args.reportPath)) {
    throw new Error(
      "--report requires an exact absolute path without traversal segments"
    );
  }
  const exactPath = normalize(args.reportPath);
  const exactReceiptPath = receiptPath(exactPath);
  const reportHandle = await open(exactPath, readOnlyNoFollowFlags()).catch(
    () => null
  );
  if (!reportHandle) {
    throw new Error(`Exact audit report is missing or unsafe: ${exactPath}`);
  }
  const receiptHandle = await open(
    exactReceiptPath,
    readOnlyNoFollowFlags()
  ).catch(() => null);
  if (!receiptHandle) {
    await reportHandle.close();
    throw new Error(
      `Exact audit report receipt is missing or unsafe: ${exactReceiptPath}`
    );
  }
  let contents: string;
  let receiptContents: string;
  try {
    const [reportMetadata, receiptMetadata] = await Promise.all([
      reportHandle.stat(),
      receiptHandle.stat(),
    ]);
    if (!(reportMetadata.isFile() && receiptMetadata.isFile())) {
      throw new Error("Exact audit report and receipt must be regular files");
    }
    [contents, receiptContents] = await Promise.all([
      reportHandle.readFile("utf8"),
      receiptHandle.readFile("utf8"),
    ]);
  } finally {
    await Promise.all([reportHandle.close(), receiptHandle.close()]);
  }
  const receiptValue = JSON.parse(receiptContents) as unknown;
  assertReceipt(receiptValue);
  const receipt = receiptValue;
  if (sha256(contents) !== receipt.reportSha256) {
    throw new Error("Audit report content hash does not match its receipt");
  }
  if (args.expectedMode && receipt.mode !== args.expectedMode) {
    throw new Error(
      `Expected a ${args.expectedMode} audit report, received ${receipt.mode}`
    );
  }
  const report = JSON.parse(contents) as TReport;
  if (
    report.mode !== receipt.mode ||
    report.timestamp !== receipt.reportTimestamp ||
    !Array.isArray(report.results)
  ) {
    throw new Error("Audit report provenance does not match its receipt");
  }
  const now = args.now ?? Date.now();
  const reportTime = Date.parse(report.timestamp);
  const persistedTime = Date.parse(receipt.persistedAt);
  if (
    !(Number.isFinite(reportTime) && Number.isFinite(persistedTime)) ||
    reportTime > now + 60_000 ||
    persistedTime > now + 60_000 ||
    now - reportTime > AUDIT_REPORT_MAX_AGE_MS ||
    now - persistedTime > AUDIT_REPORT_MAX_AGE_MS
  ) {
    throw new Error(
      "Audit report receipt is stale or has an invalid timestamp"
    );
  }
  if (
    sha256(stableJson(receipt.sourceSnapshot)) !== receipt.sourceIdentitySha256
  ) {
    throw new Error("Audit report source-root identity hash is invalid");
  }
  await validateAuditSourceSnapshot(receipt.sourceSnapshot);
  if (
    stableJson(findingIdentities(report)) !==
    stableJson(receipt.findingIdentities)
  ) {
    throw new Error("Audit report finding identities do not match its receipt");
  }
  const outputRoot = await canonicalExistingPath(
    dirname(exactPath),
    "Audit report directory"
  );
  if (
    receipt.sourceSnapshot.protectedRoots.some((source) =>
      auditPathsOverlap(source.path, outputRoot)
    ) ||
    receipt.sourceSnapshot.evaluatedFiles.some((source) =>
      auditPathsOverlap(source.path, outputRoot)
    ) ||
    receipt.sourceSnapshot.evaluatedDirectories.some((source) =>
      auditPathsOverlap(source.path, outputRoot)
    ) ||
    receipt.sourceSnapshot.absentPaths.some((proof) =>
      auditPathsOverlap(proof.path, outputRoot)
    )
  ) {
    throw new Error("Audit report directory now overlaps an audited source");
  }
  return report;
}
