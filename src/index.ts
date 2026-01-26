#!/usr/bin/env bun

import { scanCommand } from "./scan";

function printHelp() {
  console.log(`tacklebox — inspect local agent configs for skills + MCP servers

Usage:
  tacklebox scan [--json] [--show-duplicates]
  tacklebox --show-duplicates

Commands:
  scan     Scan common config locations (Cursor, Claude, Claude Desktop, etc.)

Options:
  --json              Print full JSON (ScanResult)
  --show-duplicates   Print a deduplicated skills table showing where each skill appears
`);
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    printHelp();
    return;
  }

  // Convenience: allow `tacklebox --show-duplicates` as shorthand for `tacklebox scan --show-duplicates`.
  if (cmd === "--show-duplicates") {
    await scanCommand([cmd, ...rest]);
    return;
  }

  switch (cmd) {
    case "scan":
      await scanCommand(rest);
      return;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exitCode = 1;
      return;
  }
}

await main(process.argv.slice(2));
