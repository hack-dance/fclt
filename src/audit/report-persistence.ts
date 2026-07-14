import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  open,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { ScanResult } from "../scan";

export type AuditReportMode = "agent" | "static";

export interface AuditEvaluation<TReport> {
  auditedRoots: string[];
  report: TReport;
}

const PATH_SEGMENT_SPLIT_RE = /[\\/]+/;

interface PathSemantics {
  relative(from: string, to: string): string;
  sep: string;
}

export function auditPathsOverlap(
  a: string,
  b: string,
  semantics: PathSemantics = { relative, sep }
): boolean {
  const aToB = semantics.relative(a, b);
  const bToA = semantics.relative(b, a);
  const contains = (value: string) =>
    value === "" || (!value.startsWith(`..${semantics.sep}`) && value !== "..");
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

export function auditedRootsFromScan(scan: ScanResult): string[] {
  return Array.from(
    new Set(
      scan.sources
        .flatMap((source) => source.roots)
        .map((root) => resolve(root))
    )
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

export async function persistAuditReport(args: {
  auditedRoots: string[];
  mode: AuditReportMode;
  report: unknown;
  reportRoot: string;
}): Promise<string> {
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

  const metadata = await stat(requestedRoot).catch(() => null);
  if (!metadata?.isDirectory()) {
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
  const auditedRoots = await Promise.all(
    args.auditedRoots.map((root) => canonicalExistingPath(root, "Audited root"))
  );
  const overlap = auditedRoots.find((root) =>
    auditPathsOverlap(root, reportRoot)
  );
  if (overlap) {
    throw new Error(
      `Audit report root overlaps audited source: ${reportRoot} <-> ${overlap}`
    );
  }

  const outputPath = join(reportRoot, `${args.mode}-latest.json`);
  const temporaryPath = join(
    reportRoot,
    `.${args.mode}-latest.${process.pid}.${randomUUID()}.tmp`
  );
  const contents = `${JSON.stringify(args.report, null, 2)}\n`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    const rootBeforeCommit = await canonicalExistingPath(
      requestedRoot,
      "Audit report root"
    );
    const metadataBeforeCommit = await stat(requestedRoot).catch(() => null);
    if (
      rootBeforeCommit !== reportRoot ||
      !metadataBeforeCommit?.isDirectory() ||
      metadataBeforeCommit.dev !== metadata.dev ||
      metadataBeforeCommit.ino !== metadata.ino
    ) {
      throw new Error(
        "Audit report root changed while the report was being written"
      );
    }
    await rename(temporaryPath, outputPath);
    return outputPath;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
