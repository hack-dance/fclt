import { homedir } from "node:os";
import { join } from "node:path";
import type { FacultIndex } from "./index-builder";
import { facultRootDir } from "./paths";

type TrustMode = "trust" | "untrust";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function ensureIndexStructure(index: FacultIndex): FacultIndex {
  return {
    version: index.version ?? 1,
    updatedAt: index.updatedAt ?? new Date().toISOString(),
    skills: index.skills ?? {},
    mcp: index.mcp ?? { servers: {} },
    agents: index.agents ?? {},
    snippets: index.snippets ?? {},
  };
}

function parseEntryName(raw: string): { kind: "skill" | "mcp"; name: string } {
  if (raw.startsWith("mcp:")) {
    return { kind: "mcp", name: raw.slice("mcp:".length) };
  }
  return { kind: "skill", name: raw };
}

async function loadIndex(rootDir: string): Promise<FacultIndex> {
  const indexPath = join(rootDir, "index.json");
  const file = Bun.file(indexPath);
  if (!(await file.exists())) {
    throw new Error(`Index not found at ${indexPath}. Run "facult index".`);
  }
  const raw = await file.text();
  return JSON.parse(raw) as FacultIndex;
}

async function writeIndex(rootDir: string, index: FacultIndex) {
  const indexPath = join(rootDir, "index.json");
  await Bun.write(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

function setTrustFields(
  entry: Record<string, unknown>,
  mode: TrustMode,
  nowIso: string
) {
  if (mode === "trust") {
    entry.trusted = true;
    entry.trustedAt = nowIso;
    entry.trustedBy = "user";
  } else {
    entry.trusted = false;
    entry.trustedAt = undefined;
    entry.trustedBy = undefined;
  }

  // Ensure auditStatus exists for downstream filtering.
  const rawStatus = entry.auditStatus;
  if (typeof rawStatus !== "string" || rawStatus.trim() === "") {
    entry.auditStatus = "pending";
  }
}

export async function applyTrust({
  names,
  mode,
  homeDir,
  rootDir,
}: {
  names: string[];
  mode: TrustMode;
  homeDir?: string;
  rootDir?: string;
}) {
  if (!names.length) {
    throw new Error("At least one name is required.");
  }
  const home = homeDir ?? homedir();
  const root = rootDir ?? facultRootDir(home);

  const index = ensureIndexStructure(await loadIndex(root));
  const now = new Date().toISOString();

  const missing: string[] = [];
  for (const raw of names) {
    const { kind, name } = parseEntryName(raw);
    if (kind === "skill") {
      const entry = index.skills[name] as unknown;
      if (!(entry && isPlainObject(entry))) {
        missing.push(raw);
        continue;
      }
      setTrustFields(entry, mode, now);
    } else {
      const entry = index.mcp?.servers?.[name] as unknown;
      if (!(entry && isPlainObject(entry))) {
        missing.push(raw);
        continue;
      }
      setTrustFields(entry, mode, now);
    }
  }

  if (missing.length) {
    throw new Error(`Entries not found: ${missing.join(", ")}`);
  }

  index.updatedAt = new Date().toISOString();
  await writeIndex(root, index);
}

function parseNamesFromArgv(argv: string[]): string[] {
  const names: string[] = [];
  for (const arg of argv) {
    if (!arg) {
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    names.push(arg);
  }
  return names;
}

export async function trustCommand(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(`facult trust — mark skills or MCP servers as trusted (annotation only)

Usage:
  facult trust <name> [moreNames...]
  facult trust mcp:<name> [moreNames...]
`);
    return;
  }
  try {
    const names = parseNamesFromArgv(argv);
    await applyTrust({ names, mode: "trust" });
    console.log(`Marked as trusted: ${names.join(", ")}`);
    console.log(
      'Note: Trust is an annotation. Run "facult audit" for security review.'
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function untrustCommand(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(`facult untrust — remove trusted annotation

Usage:
  facult untrust <name> [moreNames...]
  facult untrust mcp:<name> [moreNames...]
`);
    return;
  }
  try {
    const names = parseNamesFromArgv(argv);
    await applyTrust({ names, mode: "untrust" });
    console.log(`Marked as untrusted: ${names.join(", ")}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
