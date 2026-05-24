import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseCliContextArgs, resolveCliContextRoot } from "./cli-context";
import { loadManagedState } from "./manage";
import {
  facultAiGraphPath,
  facultAiIndexPath,
  facultAiProposalDir,
  facultAiWritebackQueuePath,
  facultMachineStateDir,
  facultRootDir,
  projectRootFromAiRoot,
} from "./paths";
import { parseJsonLenient } from "./util/json";

export interface StatusIssue {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
}

export interface FacultStatus {
  version: 1;
  packageVersion: string;
  cwd: string;
  globalRoot: string;
  contextRoot: string;
  projectRoot: string | null;
  machineStateDir: string;
  managedTools: string[];
  generatedOnlyProjectRoot: boolean;
  index: {
    path: string;
    exists: boolean;
  };
  graph: {
    path: string;
    exists: boolean;
  };
  writeback: {
    queuePath: string;
    pendingCount: number;
    proposalDir: string;
    proposalCount: number;
  };
  issues: StatusIssue[];
}

async function fileExists(pathValue: string): Promise<boolean> {
  try {
    return (await Bun.file(pathValue).stat()).isFile();
  } catch {
    return false;
  }
}

async function dirHasVisibleEntries(pathValue: string): Promise<boolean> {
  const entries = await readdir(pathValue).catch(() => [] as string[]);
  return entries.some((entry) => !entry.startsWith("."));
}

async function hasCanonicalSource(rootDir: string): Promise<boolean> {
  for (const relPath of [
    "config.toml",
    "config.local.toml",
    "AGENTS.global.md",
    "AGENTS.override.global.md",
  ]) {
    if (await fileExists(join(rootDir, relPath))) {
      return true;
    }
  }

  for (const relPath of [
    "agents",
    "automations",
    "instructions",
    "mcp",
    "rules",
    "skills",
    "snippets",
    "tools",
  ]) {
    if (await dirHasVisibleEntries(join(rootDir, relPath))) {
      return true;
    }
  }

  return false;
}

async function countPendingWritebacks(
  homeDir: string,
  rootDir: string
): Promise<number> {
  const { listWritebacks } = await import("./ai");
  const rows = await listWritebacks({ homeDir, rootDir }).catch(() => []);
  return rows.filter(
    (row) =>
      row.status !== "dismissed" &&
      row.status !== "promoted" &&
      row.status !== "resolved" &&
      row.status !== "superseded"
  ).length;
}

async function countActiveProposals(
  homeDir: string,
  rootDir: string
): Promise<number> {
  const { listProposals } = await import("./ai");
  const rows = await listProposals({ homeDir, rootDir }).catch(() => []);
  return rows.filter(
    (row) =>
      row.status !== "applied" &&
      row.status !== "failed" &&
      row.status !== "rejected" &&
      row.status !== "superseded"
  ).length;
}

export async function packageVersion(): Promise<string> {
  const packagePath = join(dirname(import.meta.dir), "package.json");
  const parsed = parseJsonLenient(await Bun.file(packagePath).text());
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    typeof (parsed as Record<string, unknown>).version === "string"
  ) {
    const version = (parsed as Record<string, unknown>).version;
    return typeof version === "string" ? version : "unknown";
  }
  return "unknown";
}

export async function buildStatus(opts?: {
  cwd?: string;
  homeDir?: string;
  rootArg?: string;
  scope?: "merged" | "global" | "project";
}): Promise<FacultStatus> {
  const homeDir = opts?.homeDir ?? process.env.HOME ?? "";
  const cwd = opts?.cwd ?? process.cwd();
  const globalRoot = facultRootDir(homeDir);
  const contextRoot = resolveCliContextRoot({
    homeDir,
    cwd,
    rootArg: opts?.rootArg,
    scope: opts?.scope,
  });
  const projectRoot = projectRootFromAiRoot(contextRoot, homeDir);
  const generatedOnlyProjectRoot =
    projectRoot !== null && !(await hasCanonicalSource(contextRoot));
  const indexPath = facultAiIndexPath(homeDir, contextRoot);
  const graphPath = facultAiGraphPath(homeDir, contextRoot);
  const queuePath = facultAiWritebackQueuePath(homeDir, contextRoot);
  const proposalDir = facultAiProposalDir(homeDir, contextRoot);
  const managed = await loadManagedState(homeDir, contextRoot);

  const issues: StatusIssue[] = [];
  if (generatedOnlyProjectRoot) {
    issues.push({
      severity: "warning",
      code: "project-generated-only",
      message:
        "Project .ai contains generated state only; managed project sync should stay paused until canonical source is restored or initialized.",
    });
  }
  if (!(await fileExists(indexPath))) {
    issues.push({
      severity: "info",
      code: "missing-index",
      message:
        'Generated AI index is missing. Run "fclt index" after canonical source changes.',
    });
  }
  if (!(await fileExists(graphPath))) {
    issues.push({
      severity: "info",
      code: "missing-graph",
      message: 'Generated AI graph is missing. Run "fclt index" to rebuild it.',
    });
  }

  return {
    version: 1,
    packageVersion: await packageVersion(),
    cwd,
    globalRoot,
    contextRoot,
    projectRoot,
    machineStateDir: facultMachineStateDir(homeDir, contextRoot),
    managedTools: Object.keys(managed.tools).sort(),
    generatedOnlyProjectRoot,
    index: {
      path: indexPath,
      exists: await fileExists(indexPath),
    },
    graph: {
      path: graphPath,
      exists: await fileExists(graphPath),
    },
    writeback: {
      queuePath,
      pendingCount: await countPendingWritebacks(homeDir, contextRoot),
      proposalDir,
      proposalCount: await countActiveProposals(homeDir, contextRoot),
    },
    issues,
  };
}

function printStatus(status: FacultStatus) {
  console.log(`fclt ${status.packageVersion}`);
  console.log(`cwd: ${status.cwd}`);
  console.log(`global root: ${status.globalRoot}`);
  console.log(`context root: ${status.contextRoot}`);
  console.log(`project root: ${status.projectRoot ?? "(none)"}`);
  console.log(`machine state: ${status.machineStateDir}`);
  console.log(`managed tools: ${status.managedTools.join(", ") || "(none)"}`);
  console.log(
    `index: ${status.index.exists ? "present" : "missing"} (${status.index.path})`
  );
  console.log(
    `graph: ${status.graph.exists ? "present" : "missing"} (${status.graph.path})`
  );
  console.log(
    `writeback: ${status.writeback.pendingCount} queued, ${status.writeback.proposalCount} proposals`
  );
  if (status.issues.length > 0) {
    console.log("issues:");
    for (const issue of status.issues) {
      console.log(`- [${issue.severity}] ${issue.code}: ${issue.message}`);
    }
  }
}

export async function statusCommand(argv: string[]) {
  const parsed = parseCliContextArgs(argv);
  if (
    parsed.argv.includes("--help") ||
    parsed.argv.includes("-h") ||
    parsed.argv[0] === "help"
  ) {
    console.log(`fclt status

Usage:
  fclt status [--json] [--global|--project|--root <path>]

Print the active canonical root, managed-tool state, generated index/graph state,
writeback counts, and high-signal sync risks.
`);
    return;
  }

  const status = await buildStatus({
    rootArg: parsed.rootArg,
    scope: parsed.scope,
    cwd: process.cwd(),
  });

  if (parsed.argv.includes("--json")) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  printStatus(status);
}
