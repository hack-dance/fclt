import { homedir } from "node:os";
import {
  type CapabilityScopeMode,
  parseCliContextArgs,
  resolveCliContextRoot,
} from "./cli-context";
import { renderCode, renderKeyValue, renderPage } from "./cli-ui";
import { loadManagedState } from "./manage";
import {
  facultAiDraftDir,
  facultAiEvolutionReviewDir,
  facultAiGraphPath,
  facultAiIndexPath,
  facultAiJournalPath,
  facultAiProposalDir,
  facultAiReconciliationConfigPath,
  facultAiReconciliationReviewDir,
  facultAiReconciliationStatePath,
  facultAiRuntimeScopeDir,
  facultAiStateDir,
  facultAiWritebackQueuePath,
  facultAiWritebackReviewDir,
  facultConfigPath,
  facultGeneratedStateDir,
  facultInstallStatePath,
  facultLocalCacheRoot,
  facultLocalStateRoot,
  facultMachineStateDir,
  facultRootDir,
  facultRuntimeCacheDir,
  machineStateProjectKey,
  preferredGlobalAiRoot,
  projectRootFromAiRoot,
} from "./paths";

export interface FacultPaths {
  version: 1;
  cwd: string;
  homeDir: string;
  scope: CapabilityScopeMode;
  globalRoot: string;
  contextRoot: string;
  projectRoot: string | null;
  projectKey: string | null;
  canonical: {
    globalRoot: string;
    contextRoot: string;
    configPath: string;
    reconciliationConfigPath: string;
  };
  generated: {
    stateDir: string;
    aiStateDir: string;
    indexPath: string;
    graphPath: string;
  };
  runtime: {
    localStateRoot: string;
    localCacheRoot: string;
    installStatePath: string;
    runtimeCacheDir: string;
    machineStateDir: string;
    aiRuntimeScopeDir: string;
    journalPath: string;
    writebackQueuePath: string;
    proposalDir: string;
    draftDir: string;
    reconciliationStatePath: string;
  };
  review: {
    writebackDir: string;
    evolutionDir: string;
    reconciliationDir: string;
  };
  managedTools: string[];
}

export async function buildPaths(opts?: {
  cwd?: string;
  homeDir?: string;
  rootArg?: string;
  scope?: CapabilityScopeMode;
}): Promise<FacultPaths> {
  const homeDir = opts?.homeDir ?? process.env.HOME?.trim() ?? homedir();
  const cwd = opts?.cwd ?? process.cwd();
  const scope = opts?.scope ?? "merged";
  const globalRoot = facultRootDir(homeDir);
  const contextRoot = resolveCliContextRoot({
    homeDir,
    cwd,
    rootArg: opts?.rootArg,
    scope,
  });
  const projectRoot = projectRootFromAiRoot(contextRoot, homeDir);
  const managed = await loadManagedState(homeDir, contextRoot);

  return {
    version: 1,
    cwd,
    homeDir,
    scope,
    globalRoot,
    contextRoot,
    projectRoot,
    projectKey: projectRoot
      ? machineStateProjectKey(contextRoot, homeDir)
      : null,
    canonical: {
      globalRoot: preferredGlobalAiRoot(homeDir),
      contextRoot,
      configPath: facultConfigPath(homeDir),
      reconciliationConfigPath: facultAiReconciliationConfigPath(
        homeDir,
        contextRoot
      ),
    },
    generated: {
      stateDir: facultGeneratedStateDir({
        home: homeDir,
        rootDir: contextRoot,
      }),
      aiStateDir: facultAiStateDir(homeDir, contextRoot),
      indexPath: facultAiIndexPath(homeDir, contextRoot),
      graphPath: facultAiGraphPath(homeDir, contextRoot),
    },
    runtime: {
      localStateRoot: facultLocalStateRoot(homeDir),
      localCacheRoot: facultLocalCacheRoot(homeDir),
      installStatePath: facultInstallStatePath(homeDir),
      runtimeCacheDir: facultRuntimeCacheDir(homeDir),
      machineStateDir: facultMachineStateDir(homeDir, contextRoot),
      aiRuntimeScopeDir: facultAiRuntimeScopeDir(homeDir, contextRoot),
      journalPath: facultAiJournalPath(homeDir, contextRoot),
      writebackQueuePath: facultAiWritebackQueuePath(homeDir, contextRoot),
      proposalDir: facultAiProposalDir(homeDir, contextRoot),
      draftDir: facultAiDraftDir(homeDir, contextRoot),
      reconciliationStatePath: facultAiReconciliationStatePath(
        homeDir,
        contextRoot
      ),
    },
    review: {
      writebackDir: facultAiWritebackReviewDir(homeDir, contextRoot),
      evolutionDir: facultAiEvolutionReviewDir(homeDir, contextRoot),
      reconciliationDir: facultAiReconciliationReviewDir(homeDir, contextRoot),
    },
    managedTools: Object.keys(managed.tools).sort(),
  };
}

function printHelp() {
  console.log(
    renderPage({
      title: "fclt paths",
      subtitle: "Show canonical, generated, runtime, and review paths.",
      sections: [
        {
          title: "Usage",
          lines: [
            renderCode("fclt paths"),
            renderCode("fclt paths --json"),
            renderCode("fclt paths --project --json"),
          ],
        },
      ],
    })
  );
}

function printPaths(paths: FacultPaths) {
  console.log(
    renderPage({
      title: "fclt paths",
      subtitle: paths.contextRoot,
      sections: [
        {
          title: "Canonical",
          lines: renderKeyValue([
            ["global root", paths.globalRoot],
            ["context root", paths.contextRoot],
            ["project root", paths.projectRoot ?? "(none)"],
            ["config", paths.canonical.configPath],
            ["reconciliation config", paths.canonical.reconciliationConfigPath],
          ]),
        },
        {
          title: "Generated",
          lines: renderKeyValue([
            ["state", paths.generated.stateDir],
            ["index", paths.generated.indexPath],
            ["graph", paths.generated.graphPath],
          ]),
        },
        {
          title: "Runtime",
          lines: renderKeyValue([
            ["machine state", paths.runtime.machineStateDir],
            ["writeback queue", paths.runtime.writebackQueuePath],
            ["proposal dir", paths.runtime.proposalDir],
            ["draft dir", paths.runtime.draftDir],
            ["reconciliation state", paths.runtime.reconciliationStatePath],
          ]),
        },
        {
          title: "Review",
          lines: renderKeyValue([
            ["writebacks", paths.review.writebackDir],
            ["evolution", paths.review.evolutionDir],
            ["reconciliation", paths.review.reconciliationDir],
          ]),
        },
      ],
    })
  );
}

export async function pathsCommand(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printHelp();
    return;
  }

  const json = argv.includes("--json");
  try {
    const parsed = parseCliContextArgs(argv.filter((arg) => arg !== "--json"));
    const paths = await buildPaths({
      cwd: process.cwd(),
      homeDir: process.env.HOME?.trim() || homedir(),
      rootArg: parsed.rootArg,
      scope: parsed.scope,
    });
    if (json) {
      console.log(JSON.stringify(paths, null, 2));
      return;
    }
    printPaths(paths);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
