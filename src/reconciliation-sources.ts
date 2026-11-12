import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import { resolveCliContextRoot } from "./cli-context";
import {
  facultAiReconciliationConfigPath,
  projectRootFromAiRoot,
} from "./paths";
import { reconciliationSourceDiagnostics } from "./reconciliation";
import {
  loadReconciliationConfig,
  parseReconciliationConfig,
} from "./reconciliation-config";
import {
  MAX_RECONCILIATION_FILE_BYTES,
  reconciliationFilePaths,
} from "./reconciliation-files";
import type { ReconciliationSourceConfig } from "./reconciliation-types";
import { writebackQueueReadPaths } from "./writeback-read";

const SEGMENT_RE = /[\\/]/;
const GLOB_RE = /[*?[\]{}!]/;

/** Generate a portable entry without writing or replacing configuration. */
export function reconciliationSourceRecipe(args: {
  id: string;
  type: string;
  paths: string[];
  fileRoot?: string;
  defaultBranch?: string;
}): ReconciliationSourceConfig {
  const paths = args.paths.map((path) => path.trim());
  for (const path of paths) {
    const segments = path.split(SEGMENT_RE);
    if (
      !path.trim() ||
      isAbsolute(path) ||
      win32.isAbsolute(path) ||
      path.startsWith(":") ||
      segments.some(
        (segment) => segment === ".." || segment === "." || !segment
      ) ||
      GLOB_RE.test(segments[0] ?? "")
    ) {
      throw new Error(
        "Source recipes require paths beneath an explicit named file or directory; root-wide patterns are not allowed"
      );
    }
  }
  if (args.type !== "git" && args.defaultBranch) {
    throw new Error("--default-branch is only valid for a Git source");
  }
  if (!["markdown", "automation"].includes(args.type) && args.fileRoot) {
    throw new Error(
      "--file-root is only valid for Markdown or automation sources"
    );
  }
  let source: unknown;
  if (args.type === "git") {
    if (paths.some((path) => GLOB_RE.test(path))) {
      throw new Error("Git recipes require literal relative paths");
    }
    source = {
      id: args.id,
      type: args.type,
      repository: "project",
      paths,
      allBranches: false,
      ...(args.defaultBranch ? { defaultBranch: args.defaultBranch } : {}),
    };
  } else if (args.type === "evidence-export") {
    if (paths.length !== 1 || GLOB_RE.test(paths[0] ?? "")) {
      throw new Error(
        "Evidence export recipes require exactly one literal --path"
      );
    }
    source = { id: args.id, type: args.type, path: paths[0] };
  } else if (args.type === "markdown" || args.type === "automation") {
    if (args.fileRoot !== "project" && args.fileRoot !== "home") {
      throw new Error("File source recipes require --file-root project|home");
    }
    source = {
      id: args.id,
      type: args.type,
      root: args.fileRoot,
      paths,
    };
  } else {
    throw new Error(
      "--type must be git, markdown, automation, or evidence-export"
    );
  }
  const entry = parseReconciliationConfig({ version: 1, sources: [source] })
    .sources[0];
  if (!entry) {
    throw new Error("Source recipe is empty");
  }
  return entry;
}

interface PreviewFile {
  path: string;
  state: "available" | "unavailable" | "excluded";
  reason?: string;
}

interface SourcePreview {
  sourceId: string;
  sourceType: ReconciliationSourceConfig["type"];
  state: "disabled" | "not_checked" | "unavailable" | "previewed";
  files: PreviewFile[];
  reason?: string;
  root?: string;
  repository?: string | null;
  paths?: string[];
  revisions?: string;
  defaultBranch?: string;
  reads?: string[];
  patterns?: string[];
  truncated?: boolean;
}

async function previewFile(args: {
  path: string;
  boundary?: string;
  maxBytes?: number;
}): Promise<PreviewFile> {
  try {
    const physicalPath = await realpath(args.path);
    if (args.boundary) {
      const boundary = await realpath(args.boundary);
      const rel = relative(boundary, physicalPath);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        return {
          path: args.path,
          state: "excluded",
          reason: "Resolves outside the configured root",
        };
      }
    }
    const info = await stat(physicalPath);
    if (!info.isFile()) {
      return {
        path: args.path,
        state: "excluded",
        reason: "Not a regular file",
      };
    }
    if (args.maxBytes && info.size > args.maxBytes) {
      return {
        path: args.path,
        state: "excluded",
        reason: "Exceeds the adapter's 1000000-byte file limit",
      };
    }
    return { path: args.path, state: "available" };
  } catch {
    return {
      path: args.path,
      state: "unavailable",
      reason: "Missing or inaccessible file",
    };
  }
}

/** Metadata-only read targets; availability does not prove parseability or coverage. */
export async function previewReconciliationSource(args: {
  homeDir: string;
  rootDir: string;
  source: ReconciliationSourceConfig;
}): Promise<SourcePreview> {
  const { source, homeDir, rootDir } = args;
  const projectRoot = projectRootFromAiRoot(rootDir, homeDir);
  const base = { sourceId: source.id, sourceType: source.type };
  if (source.enabled === false) {
    return { ...base, state: "disabled", files: [] };
  }
  if (source.type === "git") {
    return {
      ...base,
      state: projectRoot ? "not_checked" : "unavailable",
      reason: projectRoot
        ? "Local Git history query target; no source-history query, fetch, or content scan was run"
        : "No project repository is available in global scope",
      repository: projectRoot,
      paths: source.paths ?? [],
      revisions: source.allBranches ? "all" : "default_branch",
      defaultBranch: source.defaultBranch ?? "auto-detected by reconciliation",
      reads: ["local Git refs, commit metadata, changed paths and patches"],
      files: [],
    };
  }
  if (source.type === "writebacks") {
    const sourceRoot =
      source.scope === "global" && projectRoot
        ? resolveCliContextRoot({ homeDir, scope: "global" })
        : rootDir;
    const files = await Promise.all(
      writebackQueueReadPaths({ homeDir, rootDir: sourceRoot }).map((path) =>
        previewFile({ path })
      )
    );
    return { ...base, state: "previewed", root: sourceRoot, files };
  }
  if (source.type === "evidence-export") {
    const root = projectRoot ?? rootDir;
    const file = await previewFile({
      path: resolve(root, source.path),
      boundary: root,
      maxBytes: MAX_RECONCILIATION_FILE_BYTES,
    });
    return {
      ...base,
      state: file.state === "available" ? "previewed" : "unavailable",
      root,
      files: [file],
    };
  }
  const root = source.root === "home" ? homeDir : projectRoot;
  if (!root) {
    return {
      ...base,
      state: "unavailable",
      reason: "No project root is available",
      files: [],
    };
  }
  try {
    const { paths, truncated } = await reconciliationFilePaths({
      root,
      patterns: source.paths,
    });
    const files = await Promise.all(
      paths.map((path) =>
        previewFile({
          path: resolve(root, path),
          boundary: root,
          maxBytes: MAX_RECONCILIATION_FILE_BYTES,
        })
      )
    );
    return {
      ...base,
      state: files.some((file) => file.state === "available")
        ? "previewed"
        : "unavailable",
      root,
      patterns: source.paths,
      truncated,
      reason: truncated
        ? "Selection reached the adapter's 500-file safety cap; preview is incomplete"
        : paths.length === 0
          ? "No configured files matched this source"
          : undefined,
      files,
    };
  } catch {
    return {
      ...base,
      state: "unavailable",
      root,
      reason: "Unable to enumerate configured paths",
      files: [],
    };
  }
}

function parseSourceFlags(
  argv: string[],
  allowed: string[]
): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? "";
    const equals = argument.indexOf("=");
    const flag = equals < 0 ? argument : argument.slice(0, equals);
    if (flag === "--json" && equals < 0) {
      continue;
    }
    if (!allowed.includes(flag)) {
      throw new Error(`Unknown source option: ${argument}`);
    }
    const value = equals < 0 ? argv[++index] : argument.slice(equals + 1);
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    const values = flags.get(flag) ?? [];
    if (values.length && flag !== "--path" && flag !== "--source") {
      throw new Error(`${flag} may only be provided once`);
    }
    flags.set(flag, [...values, value]);
  }
  return flags;
}

export async function reconciliationSourcesCommand(args: {
  argv: string[];
  homeDir: string;
  rootDir: string;
}): Promise<string> {
  const [command, ...rest] = args.argv;
  const json = rest.includes("--json");
  if (command === "init") {
    const flags = parseSourceFlags(rest, [
      "--id",
      "--type",
      "--path",
      "--file-root",
      "--default-branch",
    ]);
    const source = reconciliationSourceRecipe({
      id: flags.get("--id")?.[0] ?? "",
      type: flags.get("--type")?.[0] ?? "",
      paths: flags.get("--path") ?? [],
      fileRoot: flags.get("--file-root")?.[0],
      defaultBranch: flags.get("--default-branch")?.[0],
    });
    const result = {
      version: 1,
      configPath: facultAiReconciliationConfigPath(args.homeDir, args.rootDir),
      source,
      writes: [],
    };
    return json
      ? JSON.stringify(result, null, 2)
      : `Add this entry to the sources array in ${result.configPath}. No files were written.\n${JSON.stringify(source, null, 2)}`;
  }
  if (command !== "preview" && command !== "doctor") {
    throw new Error("Expected review sources init, preview, or doctor");
  }
  const flags = parseSourceFlags(rest, ["--source", "--config"]);
  const { config, path } = await loadReconciliationConfig({
    ...args,
    configPath: flags.get("--config")?.[0],
  });
  const selected = flags.get("--source") ?? [];
  for (const id of selected) {
    if (!config.sources.some((source) => source.id === id)) {
      throw new Error(`Unknown reconciliation source id: ${id}`);
    }
  }
  const sources = config.sources.filter(
    (source) => selected.length === 0 || selected.includes(source.id)
  );
  const inputs = await Promise.all(
    sources.map((source) => previewReconciliationSource({ ...args, source }))
  );
  const diagnostics =
    command === "doctor"
      ? await reconciliationSourceDiagnostics({ ...args, config })
      : undefined;
  const result = {
    version: 1,
    configPath: path,
    contentScanned: false,
    inputs,
    ...(diagnostics
      ? {
          ...diagnostics,
          sources: diagnostics.sources.filter(
            (source) =>
              selected.length === 0 || selected.includes(source.sourceId)
          ),
        }
      : {}),
  };
  if (json) {
    return JSON.stringify(result, null, 2);
  }
  return [
    `config: ${path}`,
    "Metadata preview only; project routing may read local Git metadata. No source-content scan, network call, or state write. Files can change before reconciliation.",
    ...inputs.flatMap((input) => [
      `${input.sourceId}: inputs ${input.state}${input.reason ? ` — ${input.reason}` : ""}`,
      ...("repository" in input && input.repository
        ? [
            `  repository: ${input.repository}; paths: ${input.paths?.join(", ") || "all"}; revisions: ${input.revisions}; default branch: ${input.defaultBranch}`,
          ]
        : []),
      ...input.files.map(
        (file) =>
          `  ${file.path}: ${file.state}${file.reason ? ` — ${file.reason}` : ""}`
      ),
    ]),
    ...(diagnostics?.sources
      .filter(
        (source) => selected.length === 0 || selected.includes(source.sourceId)
      )
      .map(
        (source) =>
          `${source.sourceId}: ${source.status} — ${source.explanation}`
      ) ?? []),
    ...(diagnostics?.removedSources.map(
      (source) => `${source.sourceId}: ${source.status} — ${source.explanation}`
    ) ?? []),
  ].join("\n");
}
