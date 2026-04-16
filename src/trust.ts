import { homedir } from "node:os";
import { ensureAiIndexPath } from "./ai-state";
import type { FacultIndex } from "./index-builder";
import { facultAiIndexPath, facultRootDir } from "./paths";

type TrustMode = "trust" | "untrust";
type TrustTargetKind = "skills" | "mcp";

interface TrustArgs {
  all: boolean;
  kind?: TrustTargetKind;
  names: string[];
}

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
    automations: index.automations ?? {},
    snippets: index.snippets ?? {},
    instructions: index.instructions ?? {},
  };
}

function parseEntryName(raw: string): { kind: "skill" | "mcp"; name: string } {
  if (raw.startsWith("mcp:")) {
    return { kind: "mcp", name: raw.slice("mcp:".length) };
  }
  return { kind: "skill", name: raw };
}

function collectTargetNames(args: {
  index: FacultIndex;
  all: boolean;
  kind?: TrustTargetKind;
  names: string[];
}): string[] {
  if (!args.all) {
    return args.names;
  }

  if (args.kind === "skills") {
    return Object.keys(args.index.skills).sort();
  }

  if (args.kind === "mcp") {
    return Object.keys(args.index.mcp?.servers ?? {})
      .sort()
      .map((name) => `mcp:${name}`);
  }

  return [
    ...Object.keys(args.index.skills).sort(),
    ...Object.keys(args.index.mcp?.servers ?? {})
      .sort()
      .map((name) => `mcp:${name}`),
  ];
}

async function loadIndex(homeDir: string): Promise<FacultIndex> {
  const { path: indexPath } = await ensureAiIndexPath({
    homeDir,
    rootDir: facultRootDir(homeDir),
    repair: true,
  });
  const file = Bun.file(indexPath);
  if (!(await file.exists())) {
    throw new Error(`Index not found at ${indexPath}. Run "fclt index".`);
  }
  const raw = await file.text();
  return JSON.parse(raw) as FacultIndex;
}

async function writeIndex(homeDir: string, index: FacultIndex) {
  const indexPath = facultAiIndexPath(homeDir);
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
  all,
  kind,
  mode,
  homeDir,
}: {
  names: string[];
  all?: boolean;
  kind?: TrustTargetKind;
  mode: TrustMode;
  homeDir?: string;
}) {
  const home = homeDir ?? homedir();

  const index = ensureIndexStructure(await loadIndex(home));
  const targetNames = collectTargetNames({
    index,
    all: all === true,
    kind,
    names,
  });
  if (!targetNames.length) {
    throw new Error("No matching entries found.");
  }
  const now = new Date().toISOString();

  const missing: string[] = [];
  for (const raw of targetNames) {
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
  await writeIndex(home, index);
}

function parseNamesFromArgv(argv: string[]): string[] {
  return parseTrustArgs(argv).names;
}

function parseTrustArgs(argv: string[]): TrustArgs {
  const names: string[] = [];
  let all = false;

  for (const arg of argv) {
    if (!arg) {
      continue;
    }
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    names.push(arg);
  }

  if (all) {
    if (names.length === 0) {
      return { all: true, names: [] };
    }
    if (names.length === 1 && (names[0] === "skills" || names[0] === "mcp")) {
      return { all: true, kind: names[0], names: [] };
    }
    throw new Error(
      'When using --all, optionally pass only "skills" or "mcp".'
    );
  }

  if (!names.length) {
    throw new Error("At least one name is required.");
  }

  return { all: false, names };
}

export async function trustCommand(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(`fclt trust — mark skills or MCP servers as trusted (annotation only)

Usage:
  fclt trust <name> [moreNames...]
  fclt trust mcp:<name> [moreNames...]
  fclt trust --all
  fclt trust skills --all
  fclt trust mcp --all
`);
    return;
  }
  try {
    const parsed = parseTrustArgs(argv);
    await applyTrust({
      names: parsed.names,
      all: parsed.all,
      kind: parsed.kind,
      mode: "trust",
    });
    if (parsed.all) {
      const targetLabel =
        parsed.kind === "skills"
          ? "all skills"
          : parsed.kind === "mcp"
            ? "all MCP servers"
            : "all skills and MCP servers";
      console.log(`Marked as trusted: ${targetLabel}`);
    } else {
      console.log(`Marked as trusted: ${parsed.names.join(", ")}`);
    }
    console.log(
      'Note: Trust is an annotation. Run "fclt audit" for security review.'
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function untrustCommand(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(`fclt untrust — remove trusted annotation

Usage:
  fclt untrust <name> [moreNames...]
  fclt untrust mcp:<name> [moreNames...]
  fclt untrust --all
  fclt untrust skills --all
  fclt untrust mcp --all
`);
    return;
  }
  try {
    const parsed = parseTrustArgs(argv);
    await applyTrust({
      names: parsed.names,
      all: parsed.all,
      kind: parsed.kind,
      mode: "untrust",
    });
    if (parsed.all) {
      const targetLabel =
        parsed.kind === "skills"
          ? "all skills"
          : parsed.kind === "mcp"
            ? "all MCP servers"
            : "all skills and MCP servers";
      console.log(`Marked as untrusted: ${targetLabel}`);
    } else {
      console.log(`Marked as untrusted: ${parsed.names.join(", ")}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
