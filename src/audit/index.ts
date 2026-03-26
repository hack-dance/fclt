import { agentAuditCommand } from "./agent";
import { auditFixCommand } from "./fix";
import { auditSafeCommand } from "./safe";
import { staticAuditCommand } from "./static";
import { auditTuiCommand } from "./tui";

function printHelp() {
  console.log(`fclt audit — security audit for local agent assets

Usage:
  fclt audit [--from <path>] [--no-config-from]
  fclt audit fix <item> [--path <path>] [--source <static|agent|combined>]
  fclt audit safe <item> [--rule <id>] [--location <text>] [--message <text>]
  fclt audit --non-interactive [name|mcp:<name>] [--severity <level>] [--rules <path>] [--from <path>] [--json]
  fclt audit --non-interactive [name|mcp:<name>] --with <claude|codex> [--from <path>] [--max-items <n|all>] [--json]

Legacy (still supported; prefer --non-interactive):
  fclt audit static ...
  fclt audit agent ...
  fclt audit tui
`);
}

export async function auditCommand(argv: string[]) {
  const firstPositional = argv.find((a) => a && !a.startsWith("-")) ?? null;

  if (
    (argv.includes("--help") || argv.includes("-h")) &&
    firstPositional === "fix"
  ) {
    await auditFixCommand(argv.slice(1));
    return;
  }
  if (
    (argv.includes("--help") || argv.includes("-h")) &&
    firstPositional === "safe"
  ) {
    await auditSafeCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "help" && (argv[1] === "fix" || argv[1] === "safe")) {
    if (argv[1] === "fix") {
      await auditFixCommand(["--help"]);
      return;
    }
    await auditSafeCommand(["--help"]);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printHelp();
    return;
  }

  const nonInteractive = argv.includes("--non-interactive");

  const rest = argv.filter((a) => a !== "--non-interactive");

  if (nonInteractive) {
    // Optional: allow `fclt audit --non-interactive static ...` / `... agent ...`
    const sub = firstPositional;
    const subArgs =
      sub === "static" ||
      sub === "agent" ||
      sub === "tui" ||
      sub === "wizard" ||
      sub === "fix" ||
      sub === "safe"
        ? rest.slice(1)
        : rest;

    if (sub === "fix") {
      await auditFixCommand(subArgs);
      return;
    }
    if (sub === "safe") {
      await auditSafeCommand(subArgs);
      return;
    }

    const hasWith =
      subArgs.includes("--with") ||
      subArgs.some((a) => a.startsWith("--with="));

    if (sub === "agent" || hasWith) {
      await agentAuditCommand(subArgs);
      return;
    }
    await staticAuditCommand(subArgs);
    return;
  }

  // Back-compat: keep subcommands working, but steer usage to the new default.
  if (firstPositional === "static") {
    console.error(
      'Deprecated: use "fclt audit --non-interactive ..." instead of "fclt audit static ...".'
    );
    await staticAuditCommand(argv.slice(1));
    return;
  }
  if (firstPositional === "agent") {
    console.error(
      'Deprecated: use "fclt audit --non-interactive --with claude|codex ..." instead of "fclt audit agent ...".'
    );
    await agentAuditCommand(argv.slice(1));
    return;
  }
  if (firstPositional === "tui" || firstPositional === "wizard") {
    console.error('Tip: "fclt audit" is now interactive by default.');
    await auditTuiCommand(argv.slice(1));
    return;
  }
  if (firstPositional === "safe") {
    await auditSafeCommand(argv.slice(1));
    return;
  }
  if (firstPositional === "fix") {
    await auditFixCommand(argv.slice(1));
    return;
  }

  // Default: interactive wizard.
  await auditTuiCommand(argv);
}
