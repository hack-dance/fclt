import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureAiIndexPath, legacyAiIndexPath } from "./ai-state";
import { repairAutosyncServices } from "./autosync";
import { facultAiIndexPath, facultConfigPath, facultRootDir } from "./paths";

function legacyDefaultRoot(home: string): string {
  return join(home, "agents", ".facult");
}

async function repairLegacyRootConfig(home: string): Promise<boolean> {
  const configPath = facultConfigPath(home);
  const preferredRoot = join(home, ".ai");
  const legacyRoot = legacyDefaultRoot(home);

  let parsed: Record<string, unknown> | null = null;
  try {
    const text = await Bun.file(configPath).text();
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
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
  await mkdir(join(home, ".facult"), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return true;
}

function printHelp() {
  console.log(`facult doctor — inspect and repair local facult state

Usage:
  facult doctor [--repair]

Options:
  --repair   Reconcile legacy AI state, canonical root config, and autosync service config when needed
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
    let rootConfigRepaired = false;
    let autosyncRepaired = false;
    if (repair) {
      rootConfigRepaired = await repairLegacyRootConfig(home);
      autosyncRepaired = await repairAutosyncServices(home);
    }
    const rootDir = facultRootDir(home);
    const generated = facultAiIndexPath(home);
    const legacy = legacyAiIndexPath(rootDir);
    const result = await ensureAiIndexPath({ homeDir: home, rootDir, repair });

    console.log(`Canonical root: ${rootDir}`);
    console.log(`Generated AI index: ${generated}`);
    console.log(`Legacy root index: ${legacy}`);

    if (rootConfigRepaired) {
      console.log(`Updated facult root config to ${join(home, ".ai")}`);
    }
    if (autosyncRepaired) {
      console.log("Repaired autosync launch agent configuration.");
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
      return;
    }

    if (result.source === "legacy") {
      console.log(
        "Legacy root index detected. Run `facult doctor --repair` to reconcile it."
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      "Generated AI index is missing. Run `facult doctor --repair` or `facult index`."
    );
    process.exitCode = 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
