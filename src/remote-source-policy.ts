import { homedir } from "node:os";
import {
  clearSourceTrustPolicy,
  defaultSourceTrustLevel,
  loadSourceTrustState,
  type SourceTrustLevel,
  type SourceTrustState,
  setSourceTrustPolicy,
  sourceTrustLevelFor,
} from "./source-trust";

const SOURCE_POLICY_ACTIONS = new Set(["trust", "review", "block", "clear"]);

export interface SourceIndexRef {
  name: string;
  url: string;
}

export interface SourcePolicyCommandContext {
  homeDir?: string;
  cwd?: string;
  now?: () => Date;
}

export interface SourcePolicyRow {
  source: string;
  level: SourceTrustLevel;
  explicit: boolean;
  defaultLevel: SourceTrustLevel;
  note?: string;
  updatedAt?: string;
  url?: string;
}

function parseLongFlag(argv: string[], flag: string): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === flag) {
      return argv[i + 1] ?? null;
    }
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }
  return null;
}

function printSourcesHelp(args: { builtinIndexName: string }) {
  console.log(`facult sources — manage source trust policy for remote indices

Usage:
  facult sources list [--json]
  facult sources trust <source> [--note <text>]
  facult sources review <source> [--note <text>]
  facult sources block <source> [--note <text>]
  facult sources clear <source>

Notes:
  - Default policy is "${args.builtinIndexName}=trusted", all other sources=review.
  - Blocked sources are always denied for install/update.
  - Review sources are allowed unless --strict-source-trust is enabled.
`);
}

export function evaluateSourceTrust(args: {
  sourceName: string;
  trustState: SourceTrustState;
}): {
  level: SourceTrustLevel;
  explicit: boolean;
  note?: string;
  updatedAt?: string;
} {
  const trust = sourceTrustLevelFor({
    sourceName: args.sourceName,
    state: args.trustState,
  });
  return {
    level: trust.level,
    explicit: trust.explicit,
    note: trust.policy?.note,
    updatedAt: trust.policy?.updatedAt,
  };
}

export function assertSourceAllowed(args: {
  sourceName: string;
  trustState: SourceTrustState;
  strictSourceTrust: boolean;
}): SourceTrustLevel {
  const trust = evaluateSourceTrust(args);
  if (trust.level === "blocked") {
    throw new Error(
      `Source "${args.sourceName}" is blocked by policy. Use "facult sources clear ${args.sourceName}" to remove the block.`
    );
  }
  if (args.strictSourceTrust && trust.level === "review") {
    throw new Error(
      `Source "${args.sourceName}" requires review (strict mode). Use "facult sources trust ${args.sourceName}" after review.`
    );
  }
  return trust.level;
}

export async function sourcesCommand(args: {
  argv: string[];
  ctx?: SourcePolicyCommandContext;
  readIndexSources: (home: string, cwd: string) => Promise<SourceIndexRef[]>;
  builtinIndexName: string;
}) {
  const [sub = "list", ...rest] = args.argv;
  if (
    sub === "--help" ||
    sub === "-h" ||
    sub === "help" ||
    (sub !== "list" && !SOURCE_POLICY_ACTIONS.has(sub))
  ) {
    printSourcesHelp({ builtinIndexName: args.builtinIndexName });
    return;
  }

  const home = args.ctx?.homeDir ?? homedir();
  const cwd = args.ctx?.cwd ?? process.cwd();
  const json = rest.includes("--json");

  if (sub === "list") {
    try {
      const [sources, trustState] = await Promise.all([
        args.readIndexSources(home, cwd),
        loadSourceTrustState({ homeDir: home }),
      ]);

      const urlsByName = new Map<string, string>();
      for (const source of sources) {
        urlsByName.set(source.name, source.url);
      }

      const names = new Set<string>([
        ...sources.map((source) => source.name),
        ...Object.keys(trustState.sources),
      ]);
      const rows: SourcePolicyRow[] = Array.from(names)
        .sort((a, b) => a.localeCompare(b))
        .map((name) => {
          const assessed = evaluateSourceTrust({
            sourceName: name,
            trustState,
          });
          return {
            source: name,
            level: assessed.level,
            explicit: assessed.explicit,
            defaultLevel: defaultSourceTrustLevel({ sourceName: name }),
            note: assessed.note,
            updatedAt: assessed.updatedAt,
            url: urlsByName.get(name),
          };
        });

      if (json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (!rows.length) {
        console.log("(no sources)");
        return;
      }
      for (const row of rows) {
        const origin = row.explicit ? "explicit" : "default";
        const url = row.url ?? "-";
        const note = row.note ? `\t${row.note}` : "";
        console.log(`${row.source}\t${row.level}\t${origin}\t${url}${note}`);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
    return;
  }

  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg) {
      continue;
    }
    if (arg === "--note") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--note=") || arg.startsWith("-")) {
      continue;
    }
    positional.push(arg);
  }
  const sourceName = positional[0];
  if (!sourceName) {
    console.error(`${sub} requires a source name`);
    process.exitCode = 1;
    return;
  }
  const note = parseLongFlag(rest, "--note") ?? undefined;

  try {
    if (sub === "clear") {
      await clearSourceTrustPolicy({
        sourceName,
        homeDir: home,
        now: args.ctx?.now,
      });
      console.log(`Cleared source trust policy: ${sourceName}`);
      return;
    }

    const level =
      sub === "trust"
        ? ("trusted" as const)
        : sub === "review"
          ? ("review" as const)
          : ("blocked" as const);
    await setSourceTrustPolicy({
      sourceName,
      level,
      note,
      homeDir: home,
      now: args.ctx?.now,
    });
    console.log(`Set source policy: ${sourceName} -> ${level}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
