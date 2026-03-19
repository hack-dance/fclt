import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  stat,
  symlink,
  utimes,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { facultConfigPath, preferredGlobalAiRoot } from "./paths";

function printHelp() {
  console.log(`fclt migrate — migrate a legacy canonical store to the fclt path

Usage:
  fclt migrate [--from <path>] [--dry-run] [--move] [--write-config]

What it does:
  - Auto-detects a legacy store under ~/agents/ (or use --from)
  - Copies it to ~/.ai (default, safe)
  - Or moves it with --move (destructive; removes the legacy directory)

Options:
  --from           Path to a legacy store root directory
  --dry-run        Print what would happen without changing anything
  --move           Rename legacy dir to the new location instead of copying
  --write-config   Write ~/.ai/.facult/config.json to pin rootDir to ~/.ai
`);
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function looksLikeStore(root: string): Promise<boolean> {
  if (!(await dirExists(root))) {
    return false;
  }
  // Heuristic: treat as a store if it contains something we'd create.
  if (await fileExists(join(root, "index.json"))) {
    return true;
  }
  for (const d of ["skills", "mcp", "snippets"]) {
    if (await dirExists(join(root, d))) {
      return true;
    }
  }
  return false;
}

function expandHomePath(p: string, home: string): string {
  if (p === "~") {
    return home;
  }
  if (p.startsWith("~/")) {
    return join(home, p.slice(2));
  }
  return p;
}

function resolvePath(p: string, home: string): string {
  const expanded = expandHomePath(p, home);
  return expanded.startsWith("/") ? expanded : resolve(expanded);
}

function parseFromFlag(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === "--from") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--from requires a path");
      }
      return next;
    }
    if (arg.startsWith("--from=")) {
      const raw = arg.slice("--from=".length);
      if (!raw) {
        throw new Error("--from requires a path");
      }
      return raw;
    }
  }
  return null;
}

async function findLegacyStoreUnderAgents(home: string): Promise<string[]> {
  const agentsDir = join(home, "agents");
  let entries: any[];
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const ent of entries) {
    if (!ent?.isDirectory?.()) {
      continue;
    }
    const name = String(ent.name ?? "");
    if (!name || name === ".facult") {
      continue;
    }
    const abs = join(agentsDir, name);
    if (await looksLikeStore(abs)) {
      out.push(abs);
    }
  }
  return out.sort();
}

async function copyTree(
  src: string,
  dst: string,
  opts: { dryRun: boolean }
): Promise<void> {
  const st = await lstat(src);

  if (st.isSymbolicLink()) {
    const target = await readlink(src);
    if (opts.dryRun) {
      return;
    }
    await mkdir(dirname(dst), { recursive: true });
    // Best-effort: preserve symlinks as symlinks (do not dereference).
    await symlink(target, dst);
    return;
  }

  if (st.isDirectory()) {
    if (!opts.dryRun) {
      await mkdir(dst, { recursive: true });
      // Preserve directory timestamps best-effort after contents are copied.
    }
    const entries = await readdir(src, { withFileTypes: true });
    for (const ent of entries) {
      const name = String(ent.name ?? "");
      if (!name) {
        continue;
      }
      await copyTree(join(src, name), join(dst, name), opts);
    }
    if (!opts.dryRun) {
      const s = await stat(src);
      await utimes(dst, s.atime, s.mtime).catch(() => null);
    }
    return;
  }

  if (st.isFile()) {
    if (opts.dryRun) {
      return;
    }
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    const s = await stat(src);
    await utimes(dst, s.atime, s.mtime).catch(() => null);
  }
}

export async function migrateCommand(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printHelp();
    return;
  }

  const dryRun = argv.includes("--dry-run");
  const move = argv.includes("--move");
  const writeConfig = argv.includes("--write-config");

  const home = homedir();
  const dest = preferredGlobalAiRoot(home);
  const configPath = facultConfigPath(home);

  let legacy: string | null = null;
  try {
    const from = parseFromFlag(argv);
    if (from) {
      legacy = resolvePath(from, home);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
    return;
  }

  if (!legacy) {
    const candidates = await findLegacyStoreUnderAgents(home);
    if (candidates.length === 0) {
      console.error(
        "No legacy store found under ~/agents. Pass --from <path> to migrate from a specific directory."
      );
      process.exitCode = 1;
      return;
    }
    if (candidates.length > 1) {
      const names = candidates.map((p) => basename(p)).join(", ");
      console.error(
        `Multiple legacy stores found under ~/agents: ${names}\nPass --from <path> to choose one.`
      );
      process.exitCode = 1;
      return;
    }
    legacy = candidates[0] ?? null;
  }

  if (!(legacy && (await dirExists(legacy)))) {
    console.error(
      "Legacy store not found. Pass --from <path> to migrate from a specific directory."
    );
    process.exitCode = 1;
    return;
  }

  if (await dirExists(dest)) {
    if (await looksLikeStore(dest)) {
      console.log(`Destination already exists: ${dest}`);
      console.log("Nothing to do.");
      return;
    }
    console.error(
      `Destination exists but does not look like a fclt store: ${dest}`
    );
    process.exitCode = 1;
    return;
  }

  if (move) {
    if (dryRun) {
      console.log(`[dry-run] Would move ${legacy} -> ${dest}`);
    } else {
      await rename(legacy, dest);
      console.log(`Moved ${legacy} -> ${dest}`);
    }
  } else if (dryRun) {
    console.log(`[dry-run] Would copy ${legacy} -> ${dest}`);
  } else {
    await mkdir(dest, { recursive: true });
    await copyTree(legacy, dest, { dryRun: false });
    console.log(`Copied ${legacy} -> ${dest}`);
  }

  if (writeConfig) {
    if (dryRun) {
      console.log(`[dry-run] Would write ${configPath} with rootDir=${dest}`);
    } else {
      await mkdir(dirname(configPath), { recursive: true });
      await Bun.write(configPath, JSON.stringify({ rootDir: dest }, null, 2));
      console.log(`Wrote ${configPath}`);
    }
  }
}
