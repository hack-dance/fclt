import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  ensureAiGraphPath,
  ensureAiIndexPath,
  legacyAiIndexPath,
} from "./ai-state";
import { repairAutosyncServices } from "./autosync";
import { parseCliContextArgs, resolveCliContextRoot } from "./cli-context";
import {
  facultAiGraphPath,
  facultAiIndexPath,
  facultConfigPath,
  facultRootDir,
  facultStateDir,
  legacyExternalFacultStateDir,
  legacyFacultStateDirForRoot,
  projectRootFromAiRoot,
} from "./paths";

function legacyDefaultRoot(home: string): string {
  return join(home, "agents", ".facult");
}

async function repairLegacyRootConfig(home: string): Promise<boolean> {
  const configPath = facultConfigPath(home);
  const legacyConfigPath = join(
    legacyExternalFacultStateDir(home),
    "config.json"
  );
  const preferredRoot = join(home, ".ai");
  const legacyRoot = legacyDefaultRoot(home);

  let parsed: Record<string, unknown> | null = null;
  for (const candidate of [configPath, legacyConfigPath]) {
    try {
      const text = await Bun.file(candidate).text();
      const value = JSON.parse(text) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
        break;
      }
    } catch {
      // Ignore missing or malformed legacy config files and keep searching.
    }
  }

  if (!parsed) {
    return false;
  }

  if (parsed?.rootDir !== legacyRoot) {
    return false;
  }

  try {
    const stat = await Bun.file(preferredRoot).stat();
    if (!stat.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  const next = {
    ...parsed,
    rootDir: preferredRoot,
  };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return true;
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(pathValue: string): Promise<string> {
  const data = await readFile(pathValue);
  return createHash("sha256").update(data).digest("hex");
}

async function moveLeafIfPossible(
  src: string,
  dst: string,
  conflicts: string[]
): Promise<boolean> {
  await mkdir(dirname(dst), { recursive: true });
  if (!(await pathExists(dst))) {
    try {
      await rename(src, dst);
    } catch {
      await copyFile(src, dst);
      await rm(src, { force: true });
    }
    return true;
  }
  const [sourceHash, targetHash] = await Promise.all([
    hashFile(src),
    hashFile(dst),
  ]);
  if (sourceHash === targetHash) {
    await rm(src, { force: true });
    return true;
  }
  conflicts.push(src);
  return false;
}

async function moveSymlinkIfPossible(
  src: string,
  dst: string,
  conflicts: string[]
): Promise<boolean> {
  const sourceTarget = await readlink(src);
  await mkdir(dirname(dst), { recursive: true });
  if (!(await pathExists(dst))) {
    await symlink(sourceTarget, dst);
    await rm(src, { force: true });
    return true;
  }
  try {
    const targetLink = await readlink(dst);
    if (targetLink === sourceTarget) {
      await rm(src, { force: true });
      return true;
    }
  } catch {
    // fall through to conflict
  }
  conflicts.push(src);
  return false;
}

async function moveMissingTree(
  src: string,
  dst: string,
  conflicts: string[],
  options?: { skipTopLevelNames?: string[] }
): Promise<boolean> {
  let srcStat: Stats;
  try {
    srcStat = await lstat(src);
  } catch {
    return false;
  }

  if (srcStat.isSymbolicLink()) {
    return await moveSymlinkIfPossible(src, dst, conflicts);
  }

  if (!srcStat.isDirectory()) {
    return await moveLeafIfPossible(src, dst, conflicts);
  }

  await mkdir(dst, { recursive: true });
  let changed = false;
  const entries = await readdir(src, { withFileTypes: true });
  const skip = new Set(options?.skipTopLevelNames ?? []);
  for (const entry of entries) {
    const name = String(entry.name ?? "");
    if (!name || skip.has(name)) {
      continue;
    }
    if (await moveMissingTree(join(src, name), join(dst, name), conflicts)) {
      changed = true;
    }
  }
  const remaining = await readdir(src).catch(() => [] as string[]);
  if (remaining.length === 0) {
    await rm(src, { recursive: true, force: true }).catch(() => null);
  }
  return changed;
}

async function repairLegacyState(args: {
  home: string;
  rootDir: string;
}): Promise<{ changed: boolean; conflicts: string[] }> {
  const { home, rootDir } = args;
  let changed = false;
  const conflicts: string[] = [];

  const globalLegacy = legacyExternalFacultStateDir(home);
  const globalTarget = facultStateDir(home, join(home, ".ai"));
  if (
    await moveMissingTree(globalLegacy, globalTarget, conflicts, {
      // Keep legacy PATH shims stable. New installs use ~/.ai/.facult/bin.
      skipTopLevelNames: ["bin"],
    })
  ) {
    changed = true;
  }

  const scopedLegacy = legacyFacultStateDirForRoot(rootDir, home);
  const scopedTarget = facultStateDir(home, rootDir);
  if (
    (scopedLegacy !== globalLegacy || scopedTarget !== globalTarget) &&
    (await moveMissingTree(scopedLegacy, scopedTarget, conflicts))
  ) {
    changed = true;
  }

  return { changed, conflicts };
}

function normalizeCodexMarketplaceText(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return text.endsWith("\n") ? text : `${text}\n`;
    }
    const plugins = Array.isArray((parsed as { plugins?: unknown[] }).plugins)
      ? ((parsed as { plugins: unknown[] }).plugins ?? [])
      : null;
    if (plugins) {
      (parsed as { plugins: unknown[] }).plugins = plugins.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return entry;
        }
        const source =
          "source" in entry &&
          (entry as { source?: unknown }).source &&
          typeof (entry as { source?: unknown }).source === "object" &&
          !Array.isArray((entry as { source?: unknown }).source)
            ? {
                ...((entry as { source: Record<string, unknown> }).source ??
                  {}),
              }
            : null;
        if (
          source?.source === "local" &&
          typeof source.path === "string" &&
          source.path.startsWith("./.codex/plugins/")
        ) {
          source.path = source.path.replace("./.codex/plugins/", "./plugins/");
        }
        return source
          ? { ...(entry as Record<string, unknown>), source }
          : entry;
      });
    }
    return `${JSON.stringify(parsed, null, 2)}\n`;
  } catch {
    return text.endsWith("\n") ? text : `${text}\n`;
  }
}

async function repairLegacyCodexAuthoringLayout(args: {
  home: string;
  rootDir: string;
}): Promise<{ changed: boolean; conflicts: string[] }> {
  const liveRoot = projectRootFromAiRoot(args.rootDir, args.home) ?? args.home;
  const legacySkillsDir = join(liveRoot, ".codex", "skills");
  const preferredSkillsDir = join(liveRoot, ".agents", "skills");
  const legacyPluginsDir = join(liveRoot, ".codex", "plugins");
  const preferredPluginsDir = join(liveRoot, "plugins");
  const marketplacePath = join(
    liveRoot,
    ".agents",
    "plugins",
    "marketplace.json"
  );
  const conflicts: string[] = [];
  let changed = false;

  if (await moveMissingTree(legacySkillsDir, preferredSkillsDir, conflicts)) {
    changed = true;
  }

  if (await moveMissingTree(legacyPluginsDir, preferredPluginsDir, conflicts)) {
    changed = true;
  }

  try {
    const current = await readFile(marketplacePath, "utf8");
    const normalized = normalizeCodexMarketplaceText(current);
    if (normalized !== current) {
      await mkdir(dirname(marketplacePath), { recursive: true });
      await writeFile(marketplacePath, normalized, "utf8");
      changed = true;
    }
  } catch {
    // Ignore missing or unreadable marketplace files.
  }

  return { changed, conflicts };
}

function printHelp() {
  console.log(`fclt doctor — inspect and repair local fclt state

Usage:
  fclt doctor [--repair] [--root <path> | --global | --project]

Options:
  --repair   Reconcile legacy Facult state, canonical root config, AI index/graph, and autosync service config when needed
`);
}

export async function doctorCommand(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printHelp();
    return;
  }

  const repair = argv.includes("--repair");
  const home = process.env.HOME?.trim() || homedir();

  try {
    const parsed = parseCliContextArgs(argv);
    const rootDir =
      parsed.rootArg || parsed.scope === "project"
        ? resolveCliContextRoot({
            rootArg: parsed.rootArg,
            scope: parsed.scope,
            cwd: process.cwd(),
            homeDir: home,
          })
        : facultRootDir(home);
    let rootConfigRepaired = false;
    let stateRepaired = false;
    let stateConflicts: string[] = [];
    let autosyncRepaired = false;
    let codexAuthoringRepaired = false;
    let codexAuthoringConflicts: string[] = [];
    if (repair) {
      rootConfigRepaired = await repairLegacyRootConfig(home);
    }
    if (repair) {
      const stateRepair = await repairLegacyState({ home, rootDir });
      stateRepaired = stateRepair.changed;
      stateConflicts = stateRepair.conflicts;
      autosyncRepaired = await repairAutosyncServices(home, rootDir);
      const authoringRepair = await repairLegacyCodexAuthoringLayout({
        home,
        rootDir,
      });
      codexAuthoringRepaired = authoringRepair.changed;
      codexAuthoringConflicts = authoringRepair.conflicts;
    }
    const generated = facultAiIndexPath(home, rootDir);
    const generatedGraph = facultAiGraphPath(home, rootDir);
    const legacy = legacyAiIndexPath(rootDir);
    const result = await ensureAiIndexPath({ homeDir: home, rootDir, repair });
    const graphResult = await ensureAiGraphPath({
      homeDir: home,
      rootDir,
      repair,
    });

    console.log(`Canonical root: ${rootDir}`);
    console.log(`Generated AI index: ${generated}`);
    console.log(`Generated AI graph: ${generatedGraph}`);
    console.log(`Facult state dir: ${facultStateDir(home, rootDir)}`);
    console.log(`Legacy root index: ${legacy}`);

    if (rootConfigRepaired) {
      console.log(`Updated fclt root config to ${join(home, ".ai")}`);
    }
    if (stateRepaired) {
      console.log(
        "Migrated legacy Facult state into the canonical .ai state directory."
      );
    }
    if (stateConflicts.length) {
      console.log("Skipped conflicting legacy state paths:");
      for (const conflict of stateConflicts) {
        console.log(`- ${conflict}`);
      }
    }
    if (autosyncRepaired) {
      console.log("Repaired autosync launch agent configuration.");
    }
    if (codexAuthoringRepaired) {
      console.log(
        "Migrated legacy Codex authoring paths to .agents/skills, .agents/plugins/marketplace.json, and plugins/."
      );
    }
    if (codexAuthoringConflicts.length) {
      console.log("Skipped conflicting Codex authoring paths:");
      for (const conflict of codexAuthoringConflicts) {
        console.log(`- ${conflict}`);
      }
    }

    if (result.source === "generated") {
      console.log("AI index is healthy.");
      return;
    }

    if (repair && result.source === "legacy") {
      console.log(
        `Repaired generated AI index from legacy root index: ${generated}`
      );
      return;
    }

    if (repair && result.source === "rebuilt") {
      console.log(
        `Rebuilt generated AI index from canonical source: ${generated}`
      );
    }
    if (repair && graphResult.rebuilt) {
      console.log(`Repaired generated AI graph: ${generatedGraph}`);
    }
    if (repair && result.source === "rebuilt") {
      return;
    }

    if (result.source === "legacy") {
      console.log(
        "Legacy root index detected. Run `fclt doctor --repair` to reconcile it."
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      "Generated AI index is missing. Run `fclt doctor --repair` or `fclt index`."
    );
    process.exitCode = 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
