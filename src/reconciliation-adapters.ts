import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  facultAiStateDir,
  facultAiWritebackQueuePath,
  facultRootDir,
  legacyFacultAiStateDirs,
  projectRootFromAiRoot,
} from "./paths";
import type {
  AdapterScanResult,
  FileSourceConfig,
  GitSourceConfig,
  LinearSourceConfig,
  ReconciliationAdapter,
  ReconciliationAdapterContext,
  ReconciliationSourceType,
  SignalClassification,
  SourceRecord,
  WritebackSourceConfig,
} from "./reconciliation-types";

const ISSUE_REF_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const WRITEBACK_REF_RE = /\bWB-\d{5}\b/g;
const ASSET_REF_RE =
  /(?:@(?:ai|project)\/[^\s)`]+|(?:instructions|skills|agents|automations|snippets|mcp)\/[\w./-]+)/g;
const TRAILING_REF_PUNCTUATION_RE = /[.,;:!?]+$/;
const SECRET_VALUE_RE =
  /(bearer\s+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s"']+/gi;
const JSON_SECRET_VALUE_RE =
  /("[^"]*(?:api[_-]?key|token|secret|password|authorization)[^"]*"\s*:\s*")[^"]*(")/gi;
const SECRET_TOKEN_RE =
  /\b(?:sk[-_]|ghp_|github_pat_|lin_api_)[A-Za-z0-9_-]{12,}\b/g;
const LINE_SPLIT_RE = /\r?\n/;
const PATH_SEGMENT_RE = /[\\/]/;
const MARKDOWN_SECTION_RE = /(?=^#{1,3}\s+)/m;
const MARKDOWN_HEADING_RE = /^#{1,3}\s+(.+)$/m;
const DATE_HEADING_RE = /^(\d{4}-\d{2}-\d{2})\b/;
const LOG_TIMESTAMP_RE =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/;
const UNBORN_GIT_RE =
  /does not have any commits yet|bad default revision 'HEAD'/i;
const LINEAR_CAPABILITY_RE =
  /capabilit|writeback|evolution|instruction|skill|agent|runbook|reconcil/;
const TERMINAL_LINEAR_STATE_RE =
  /^(?:completed|done|closed|canceled|cancelled|released)$/i;
const LINEAR_OUTCOME_RE = /proof|verified|released|deployed|completed/;
const FILE_RELEVANCE_RE =
  /capabilit|writeback|evolution|instruction|skill|runbook|verification|reconcil|outcome|signal/i;
const WHITESPACE_RE = /\s+/g;
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 500;
const MAX_BODY_CHARS = 4000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function redactReconciliationText(value: string): string {
  return value
    .replace(JSON_SECRET_VALUE_RE, "$1<redacted>$2")
    .replace(SECRET_VALUE_RE, "$1<redacted>")
    .replace(SECRET_TOKEN_RE, "<redacted-token>")
    .slice(0, MAX_BODY_CHARS);
}

function references(value: string): {
  assetRefs: string[];
  issueRefs: string[];
  writebackRefs: string[];
} {
  return {
    assetRefs: unique(
      (value.match(ASSET_REF_RE) ?? []).map((entry) =>
        entry.replace(TRAILING_REF_PUNCTUATION_RE, "")
      )
    ),
    issueRefs: unique(
      (value.match(ISSUE_REF_RE) ?? []).filter(
        (entry) => !(entry.startsWith("WB-") || entry.startsWith("EV-"))
      )
    ),
    writebackRefs: unique(value.match(WRITEBACK_REF_RE) ?? []),
  };
}

function inWindow(
  value: string,
  context: ReconciliationAdapterContext
): boolean {
  const observed = Date.parse(value);
  return (
    Number.isFinite(observed) &&
    observed >= Date.parse(context.window.since) &&
    observed <= Date.parse(context.window.until)
  );
}

function latestTimestamp(records: SourceRecord[]): string | undefined {
  return records.reduce<string | undefined>((latest, record) => {
    if (!latest || Date.parse(record.observedAt) > Date.parse(latest)) {
      return record.observedAt;
    }
    return latest;
  }, undefined);
}

function resultFromRecords(
  records: SourceRecord[],
  staleReason?: string
): AdapterScanResult {
  if (records.length > 0) {
    return { state: "changed", records, watermark: latestTimestamp(records) };
  }
  return staleReason
    ? { state: "stale", records, staleReason }
    : { state: "checked", records };
}

function record(args: {
  context: ReconciliationAdapterContext;
  recordId: string;
  dedupeKey: string;
  observedAt: string;
  title: string;
  body: string;
  classification?: SignalClassification;
  provenance: SourceRecord["provenance"];
  extraRefs?: string[];
}): SourceRecord {
  const body = redactReconciliationText(args.body);
  const refs = references(
    `${args.title}\n${body}\n${(args.extraRefs ?? []).join(" ")}`
  );
  return {
    sourceId: args.context.config.id,
    sourceType: args.context.config.type,
    recordId: args.recordId,
    dedupeKey: args.dedupeKey,
    observedAt: args.observedAt,
    title: redactReconciliationText(args.title),
    body,
    classification: args.classification,
    ...refs,
    provenance: args.provenance,
  };
}

interface WritebackQueueRecord {
  id?: string;
  ts?: string;
  updatedAt?: string;
  summary?: string;
  kind?: string;
  assetRef?: string;
  issueLinks?: string[];
  disposition?: string;
  dispositionTarget?: string;
  status?: string;
}

const writebackAdapter: ReconciliationAdapter = {
  type: "writebacks",
  version: 1,
  async scan(context): Promise<AdapterScanResult> {
    const config = context.config as WritebackSourceConfig;
    const sourceRoot =
      config.scope === "global"
        ? facultRootDir(context.homeDir)
        : context.rootDir;
    const scope = projectRootFromAiRoot(sourceRoot, context.homeDir)
      ? "project"
      : "global";
    const paths = [
      ...legacyFacultAiStateDirs(context.homeDir, sourceRoot).map((dir) =>
        join(dir, scope, "writeback", "queue.jsonl")
      ),
      join(
        facultAiStateDir(context.homeDir, sourceRoot),
        scope,
        "writeback",
        "queue.jsonl"
      ),
      facultAiWritebackQueuePath(context.homeDir, sourceRoot),
    ];
    const existingPaths = [
      ...new Set(
        (
          await Promise.all(
            paths.map(async (path) =>
              (await Bun.file(path).exists()) ? path : null
            )
          )
        ).filter((path): path is string => Boolean(path))
      ),
    ];
    if (existingPaths.length === 0) {
      return resultFromRecords([]);
    }
    const entriesById = new Map<string, WritebackQueueRecord[]>();
    const malformed: SourceRecord[] = [];
    for (const path of existingPaths) {
      for (const [index, line] of (await Bun.file(path).text())
        .split(LINE_SPLIT_RE)
        .entries()) {
        if (!line.trim()) {
          continue;
        }
        try {
          const value: unknown = JSON.parse(line);
          if (!isPlainObject(value)) {
            throw new Error("record is not an object");
          }
          const parsed = value as WritebackQueueRecord;
          const timestamp = parsed.updatedAt ?? parsed.ts;
          if (
            typeof parsed.id !== "string" ||
            !parsed.id ||
            typeof timestamp !== "string" ||
            !Number.isFinite(Date.parse(timestamp))
          ) {
            throw new Error("record is missing a valid id or timestamp");
          }
          entriesById.set(parsed.id, [
            ...(entriesById.get(parsed.id) ?? []),
            parsed,
          ]);
        } catch {
          malformed.push(
            record({
              context,
              recordId: `malformed-line-${index + 1}`,
              dedupeKey: `writeback-malformed:${sha256(line)}`,
              observedAt: context.window.since,
              title: `Malformed writeback queue line ${index + 1}`,
              body: line,
              classification: "noise",
              provenance: { path, line: index + 1, parseError: true },
            })
          );
        }
      }
    }
    const records = [...entriesById.values()].flatMap((entries) => {
      const entry = entries
        .filter((candidate) => {
          const timestamp = candidate.updatedAt ?? candidate.ts;
          return (
            timestamp &&
            Date.parse(timestamp) <= Date.parse(context.window.until)
          );
        })
        .sort((left, right) =>
          (right.updatedAt ?? right.ts ?? "").localeCompare(
            left.updatedAt ?? left.ts ?? ""
          )
        )[0];
      const observedAt = entry?.updatedAt ?? entry?.ts;
      if (!(entry?.id && observedAt && inWindow(observedAt, context))) {
        return [];
      }
      if (
        ["resolved", "dismissed", "superseded"].includes(entry.status ?? "")
      ) {
        return [];
      }
      return [
        record({
          context,
          recordId: entry.id,
          dedupeKey: `writeback:${scope}:${entry.id}`,
          observedAt,
          title: entry.summary ?? entry.id,
          body: JSON.stringify({
            kind: entry.kind,
            status: entry.status,
            disposition: entry.disposition,
            dispositionTarget: entry.dispositionTarget,
          }),
          classification: "capability-source",
          provenance: {
            path: existingPaths,
            writebackId: entry.id,
            disposition: entry.disposition ?? null,
            dispositionTarget: entry.dispositionTarget ?? null,
            status: entry.status ?? null,
          },
          extraRefs: [
            entry.id,
            entry.assetRef ?? "",
            ...(entry.issueLinks ?? []),
          ],
        }),
      ];
    });
    records.push(...malformed);
    if (malformed.length > 0) {
      return {
        state: "unavailable",
        records,
        unavailableReason: `${malformed.length} malformed writeback queue line(s) prevented complete coverage`,
      };
    }
    return resultFromRecords(records);
  },
};

function safeGitEnvironment(projectRoot: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("GIT_")) {
      env[name] = value;
    }
  }
  env.GIT_CEILING_DIRECTORIES = dirname(projectRoot);
  env.GIT_DISCOVERY_ACROSS_FILESYSTEM = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: [Bun.which("git") ?? "/usr/bin/git", ...args],
    cwd,
    env: safeGitEnvironment(cwd),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `git ${args[0] ?? "command"} failed`);
  }
  return stdout;
}

function parseGitRecords(args: {
  context: ReconciliationAdapterContext;
  config: GitSourceConfig;
  output: string;
  projectRoot: string;
}): Array<Omit<SourceRecord, "dedupeKey"> & { commit: string }> {
  const entries: Array<Omit<SourceRecord, "dedupeKey"> & { commit: string }> =
    [];
  for (const raw of args.output.split("\u001e")) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const [header = "", changes = ""] = trimmed.split("\0", 2);
    const [commit, observedAt, subject, body = ""] = header.split("\u001f");
    if (!(commit && observedAt && subject)) {
      continue;
    }
    const files = changes
      .split(LINE_SPLIT_RE)
      .map((line) => line.trim().split("\t"))
      .filter((parts) => parts.length >= 2)
      .map((parts) => (parts[0]?.startsWith("R") ? parts.at(-1) : parts[1]))
      .filter((pathValue): pathValue is string => Boolean(pathValue));
    const text = `${subject}\n${body}\n${files.join("\n")}`;
    const refs = references(text);
    entries.push({
      sourceId: args.context.config.id,
      sourceType: "git",
      recordId: commit,
      commit,
      observedAt,
      title: redactReconciliationText(subject),
      body: redactReconciliationText(`${body}\nChanged: ${files.join(", ")}`),
      ...refs,
      provenance: {
        repository: args.projectRoot,
        commit,
        files,
        allBranches: args.config.allBranches === true,
      },
    });
  }
  return entries;
}

const gitAdapter: ReconciliationAdapter = {
  type: "git",
  version: 1,
  async scan(context): Promise<AdapterScanResult> {
    const config = context.config as GitSourceConfig;
    const projectRoot = context.projectRoot;
    if (!projectRoot) {
      return {
        state: "unavailable",
        records: [],
        unavailableReason: "No project repository is available",
      };
    }
    try {
      const isRepo = (
        await runGit(["rev-parse", "--is-inside-work-tree"], projectRoot)
      ).trim();
      if (isRepo !== "true") {
        throw new Error("Configured project is not a Git worktree");
      }
      const pathArgs = config.paths?.length ? ["--", ...config.paths] : [];
      let output: string;
      try {
        output = await runGit(
          [
            "log",
            ...(config.allBranches ? ["--all"] : []),
            `--since=${context.window.since}`,
            `--until=${context.window.until}`,
            "--format=%x1e%H%x1f%cI%x1f%s%x1f%b%x00",
            "--name-status",
            "--find-renames",
            ...pathArgs,
          ],
          projectRoot
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (UNBORN_GIT_RE.test(message)) {
          return resultFromRecords([]);
        }
        throw error;
      }
      const parsed = parseGitRecords({ context, config, output, projectRoot });
      const records: SourceRecord[] = [];
      for (const entry of parsed) {
        const patch = await runGit(
          ["show", "--format=", "--no-ext-diff", entry.commit, ...pathArgs],
          projectRoot
        );
        const { commit: _commit, ...base } = entry;
        records.push({ ...base, dedupeKey: `git-patch:${sha256(patch)}` });
      }
      return resultFromRecords(records);
    } catch (error) {
      return {
        state: "unavailable",
        records: [],
        unavailableReason:
          error instanceof Error ? error.message : String(error),
      };
    }
  },
};

interface LinearCommentExport {
  id?: string;
  body?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface LinearHistoryExport {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  fromState?: { name?: string } | null;
  toState?: { name?: string } | null;
}

interface LinearConnection<T> {
  nodes?: T[];
  pageInfo?: { hasNextPage?: boolean };
}

interface LinearIssueExport {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string;
  updatedAt?: string;
  state?: { name?: string; type?: string } | string;
  labels?: { nodes?: Array<{ name?: string }> } | string[];
  comments?: LinearConnection<LinearCommentExport> | LinearCommentExport[];
  history?: LinearConnection<LinearHistoryExport> | LinearHistoryExport[];
}

function linearNodes<T>(value: LinearConnection<T> | T[] | undefined): T[] {
  return Array.isArray(value) ? value : (value?.nodes ?? []);
}

function parseLinearPayload(value: unknown): {
  issues: LinearIssueExport[];
  truncated: boolean;
} {
  if (Array.isArray(value)) {
    return { issues: value as LinearIssueExport[], truncated: false };
  }
  if (!value || typeof value !== "object") {
    return { issues: [], truncated: false };
  }
  const object = value as Record<string, unknown>;
  const data = (object.data ?? object) as Record<string, unknown>;
  const issues = data.issues as
    | LinearConnection<LinearIssueExport>
    | LinearIssueExport[]
    | undefined;
  const nodes = linearNodes(issues);
  const truncated =
    (!Array.isArray(issues) && issues?.pageInfo?.hasNextPage === true) ||
    nodes.some(
      (issue) =>
        (!Array.isArray(issue.comments) &&
          issue.comments?.pageInfo?.hasNextPage === true) ||
        (!Array.isArray(issue.history) &&
          issue.history?.pageInfo?.hasNextPage === true)
    );
  return { issues: nodes, truncated };
}

async function loadLinearIssues(args: {
  config: LinearSourceConfig;
  context: ReconciliationAdapterContext;
}): Promise<{ issues: LinearIssueExport[]; truncated: boolean }> {
  if (args.config.exportPath) {
    if (
      isAbsolute(args.config.exportPath) ||
      args.config.exportPath.includes("..")
    ) {
      throw new Error("Linear exportPath must be relative to the project root");
    }
    const base = args.context.projectRoot ?? args.context.rootDir;
    const baseReal = await realpath(base).catch(() => resolve(base));
    const exportReal = await realpath(resolve(base, args.config.exportPath));
    const rel = relative(baseReal, exportReal);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("Linear exportPath resolves outside the project root");
    }
    return parseLinearPayload(JSON.parse(await readFile(exportReal, "utf8")));
  }
  const tokenEnv = args.config.tokenEnv;
  const token = tokenEnv ? process.env[tokenEnv] : undefined;
  if (!(tokenEnv && token)) {
    throw new Error(
      `Linear token environment variable is unavailable: ${tokenEnv ?? "not configured"}`
    );
  }
  const endpoint = args.config.endpoint ?? "https://api.linear.app/graphql";
  const query = `query ReconciliationIssues($since: DateTimeOrDuration!, $until: DateTimeOrDuration!, $team: String) {
    issues(first: 250, orderBy: updatedAt, filter: { updatedAt: { gte: $since, lte: $until }, team: { key: { eq: $team } } }) {
      pageInfo { hasNextPage }
      nodes { id identifier title description updatedAt state { name type } labels { nodes { name } }
        comments(first: 100) { pageInfo { hasNextPage } nodes { id body createdAt updatedAt } }
        history(first: 100) { pageInfo { hasNextPage } nodes { id createdAt updatedAt fromState { name } toState { name } } }
      }
    }
  }`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      variables: {
        since: args.context.window.since,
        until: args.context.window.until,
        team: args.config.teamKey ?? null,
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Linear read failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    errors?: Array<{ message?: string }>;
  };
  if (payload.errors?.length) {
    throw new Error(
      payload.errors
        .map((entry) => entry.message ?? "Linear GraphQL error")
        .join("; ")
    );
  }
  return parseLinearPayload(payload);
}

function linearClassification(issue: LinearIssueExport): SignalClassification {
  const text = `${issue.title ?? ""} ${issue.description ?? ""}`.toLowerCase();
  if (LINEAR_CAPABILITY_RE.test(text)) {
    return "capability-implementation";
  }
  if (LINEAR_OUTCOME_RE.test(text)) {
    return "outcome-proof";
  }
  return "implementation-only";
}

const linearAdapter: ReconciliationAdapter = {
  type: "linear",
  version: 1,
  async scan(context): Promise<AdapterScanResult> {
    const config = context.config as LinearSourceConfig;
    try {
      const { issues, truncated } = await loadLinearIssues({ config, context });
      const records: SourceRecord[] = [];
      for (const issue of issues) {
        const issueRef = issue.identifier ?? issue.id;
        if (
          !(issueRef && issue.updatedAt && inWindow(issue.updatedAt, context))
        ) {
          continue;
        }
        const state =
          typeof issue.state === "string" ? issue.state : issue.state?.name;
        records.push(
          record({
            context,
            recordId: `issue:${issueRef}`,
            dedupeKey: `linear:issue:${issueRef}`,
            observedAt: issue.updatedAt,
            title: issue.title ?? issueRef,
            body: `${issue.description ?? ""}\nState: ${state ?? "unknown"}`,
            classification: linearClassification(issue),
            provenance: { issue: issueRef, state: state ?? null },
            extraRefs: [issueRef],
          })
        );
        for (const comment of linearNodes(issue.comments)) {
          const observedAt = comment.updatedAt ?? comment.createdAt;
          if (!(comment.id && observedAt && inWindow(observedAt, context))) {
            continue;
          }
          records.push(
            record({
              context,
              recordId: `comment:${comment.id}`,
              dedupeKey: `linear:comment:${comment.id}`,
              observedAt,
              title: `${issueRef} comment`,
              body: comment.body ?? "",
              classification: linearClassification(issue),
              provenance: { issue: issueRef, commentId: comment.id },
              extraRefs: [issueRef],
            })
          );
        }
        for (const history of linearNodes(issue.history)) {
          const observedAt = history.updatedAt ?? history.createdAt;
          if (!(history.id && observedAt && inWindow(observedAt, context))) {
            continue;
          }
          records.push(
            record({
              context,
              recordId: `status:${history.id}`,
              dedupeKey: `linear:status:${history.id}`,
              observedAt,
              title: `${issueRef} status changed`,
              body: `${history.fromState?.name ?? "unknown"} -> ${history.toState?.name ?? "unknown"}`,
              classification: TERMINAL_LINEAR_STATE_RE.test(
                history.toState?.name ?? ""
              )
                ? "outcome-proof"
                : linearClassification(issue),
              provenance: { issue: issueRef, historyId: history.id },
              extraRefs: [issueRef],
            })
          );
        }
      }
      if (truncated) {
        return {
          state: "unavailable",
          records,
          unavailableReason:
            "Linear result exceeded a bounded page; coverage is incomplete",
        };
      }
      return resultFromRecords(records);
    } catch (error) {
      return {
        state: "unavailable",
        records: [],
        unavailableReason:
          error instanceof Error ? error.message : String(error),
      };
    }
  },
};

function safeFileRoot(
  context: ReconciliationAdapterContext,
  config: FileSourceConfig
): string | null {
  if (config.root === "home") {
    return context.homeDir;
  }
  return context.projectRoot;
}

function validateGlob(pattern: string): void {
  if (
    isAbsolute(pattern) ||
    pattern.split(PATH_SEGMENT_RE).includes("..") ||
    pattern.includes("\0")
  ) {
    throw new Error(`Unsafe reconciliation path pattern: ${pattern}`);
  }
}

function splitTextRecords(
  text: string,
  path: string
): Array<{
  id: string;
  title: string;
  body: string;
  observedAt?: string;
  timestampMissing?: boolean;
}> {
  if (path.endsWith(".jsonl") || path.endsWith(".log")) {
    return text
      .split(LINE_SPLIT_RE)
      .map((body, index) => {
        let observedAt = body.match(LOG_TIMESTAMP_RE)?.[0];
        if (path.endsWith(".jsonl")) {
          try {
            const parsed = JSON.parse(body) as Record<string, unknown>;
            const value = [
              parsed.updatedAt,
              parsed.createdAt,
              parsed.ts,
              parsed.timestamp,
              parsed.startedAt,
              parsed.completedAt,
            ].find(
              (candidate): candidate is string =>
                typeof candidate === "string" &&
                Number.isFinite(Date.parse(candidate))
            );
            observedAt = value ?? observedAt;
          } catch {
            // Malformed JSONL remains an undated extraction decision below.
          }
        }
        return {
          id: `line-${index + 1}`,
          title: `${path}:${index + 1}`,
          body,
          observedAt,
          timestampMissing: !observedAt,
        };
      })
      .filter((entry) => entry.body.trim());
  }
  const sections = text
    .split(MARKDOWN_SECTION_RE)
    .filter((entry) => entry.trim());
  return sections.map((body, index) => {
    const heading = body.match(MARKDOWN_HEADING_RE)?.[1]?.trim();
    const headingDate = heading?.match(DATE_HEADING_RE)?.[1];
    return {
      id: `section-${index + 1}`,
      title: heading ?? `${path} section ${index + 1}`,
      body,
      observedAt: headingDate ? `${headingDate}T12:00:00.000Z` : undefined,
    };
  });
}

function fileAdapter(type: "automation" | "markdown"): ReconciliationAdapter {
  return {
    type,
    version: 1,
    async scan(context): Promise<AdapterScanResult> {
      const config = context.config as FileSourceConfig;
      const root = safeFileRoot(context, config);
      if (!root) {
        return {
          state: "unavailable",
          records: [],
          unavailableReason: `No ${config.root ?? "project"} root is available`,
        };
      }
      try {
        const paths: string[] = [];
        let truncated = false;
        for (const pattern of config.paths) {
          if (paths.length >= MAX_FILES) {
            break;
          }
          validateGlob(pattern);
          const glob = new Bun.Glob(pattern);
          for await (const path of glob.scan({
            cwd: root,
            onlyFiles: true,
            dot: true,
          })) {
            paths.push(path);
            if (paths.length >= MAX_FILES) {
              truncated = true;
              break;
            }
          }
        }
        if (paths.length === 0) {
          return {
            state: "unavailable",
            records: [],
            unavailableReason: "No configured files matched this source",
          };
        }
        const records: SourceRecord[] = [];
        const contentDigests: string[] = [];
        let missingTimestamps = 0;
        let skippedFiles = 0;
        let latestMtime = 0;
        let latestObserved = 0;
        for (const path of unique(paths)) {
          const rootReal = await realpath(root).catch(() => resolve(root));
          const absolutePath = await realpath(resolve(root, path));
          const rel = relative(rootReal, absolutePath);
          if (rel.startsWith("..") || isAbsolute(rel)) {
            skippedFiles += 1;
            continue;
          }
          const info = await stat(absolutePath);
          latestMtime = Math.max(latestMtime, info.mtimeMs);
          if (info.size > MAX_FILE_BYTES) {
            skippedFiles += 1;
            continue;
          }
          const text = await readFile(absolutePath, "utf8");
          contentDigests.push(`${path}:${sha256(text)}`);
          if (text.includes("\0")) {
            skippedFiles += 1;
            continue;
          }
          for (const fragment of splitTextRecords(text, path)) {
            if (type === "automation" && fragment.timestampMissing) {
              missingTimestamps += 1;
              records.push(
                record({
                  context,
                  recordId: `${path}#${fragment.id}`,
                  dedupeKey: `${type}-undated:${sha256(fragment.body)}`,
                  observedAt: context.window.since,
                  title: fragment.title,
                  body: fragment.body,
                  classification: "noise",
                  provenance: {
                    path,
                    root: config.root ?? "project",
                    bytes: info.size,
                    timestampMissing: true,
                  },
                })
              );
              continue;
            }
            const observedAt = fragment.observedAt ?? info.mtime.toISOString();
            if (!inWindow(observedAt, context)) {
              continue;
            }
            latestObserved = Math.max(latestObserved, Date.parse(observedAt));
            const fragmentRefs = references(fragment.body);
            const looksRelevant =
              fragmentRefs.issueRefs.length > 0 ||
              fragmentRefs.writebackRefs.length > 0 ||
              fragmentRefs.assetRefs.length > 0 ||
              FILE_RELEVANCE_RE.test(fragment.body);
            records.push(
              record({
                context,
                recordId: `${path}#${fragment.id}`,
                dedupeKey: `${type}-content:${sha256(fragment.body.replace(WHITESPACE_RE, " ").trim())}`,
                observedAt,
                title: fragment.title,
                body: fragment.body,
                classification: looksRelevant ? "capability-source" : "noise",
                provenance: {
                  path,
                  root: config.root ?? "project",
                  bytes: info.size,
                },
              })
            );
          }
        }
        const staleReason =
          paths.length > 0 &&
          Math.max(latestMtime, latestObserved) <
            Date.parse(context.window.since)
            ? "Configured files exist but none changed in the review window"
            : undefined;
        const cursor = sha256(contentDigests.sort().join("\n"));
        if (missingTimestamps > 0) {
          return {
            state: "unavailable",
            records,
            cursor,
            unavailableReason: `${missingTimestamps} automation record(s) lacked a parseable timestamp`,
          };
        }
        if (truncated) {
          return {
            state: "stale",
            records,
            cursor,
            staleReason: `File scan truncated at the ${MAX_FILES}-file safety cap`,
          };
        }
        if (skippedFiles > 0) {
          return {
            state: "unavailable",
            records,
            cursor,
            unavailableReason: `${skippedFiles} configured file(s) could not be safely extracted`,
          };
        }
        return { ...resultFromRecords(records, staleReason), cursor };
      } catch (error) {
        return {
          state: "unavailable",
          records: [],
          unavailableReason:
            error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

const adapters = new Map<ReconciliationSourceType, ReconciliationAdapter>([
  [writebackAdapter.type, writebackAdapter],
  [gitAdapter.type, gitAdapter],
  [linearAdapter.type, linearAdapter],
  ["automation", fileAdapter("automation")],
  ["markdown", fileAdapter("markdown")],
]);

export function reconciliationAdapterFor(
  type: ReconciliationSourceType
): ReconciliationAdapter {
  const adapter = adapters.get(type);
  if (!adapter) {
    throw new Error(`No reconciliation adapter registered for ${type}`);
  }
  return adapter;
}
