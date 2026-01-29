#!/usr/bin/env bun

import { consolidateCommand } from "./consolidate";
import { indexCommand } from "./index-builder";
import { scanCommand } from "./scan";

function printHelp() {
  console.log(`facult — inspect local agent configs for skills + MCP servers

Usage:
  facult scan [--json] [--show-duplicates] [--tui]
  facult consolidate [--force]
  facult index [--force]
  facult --show-duplicates

Commands:
  scan         Scan common config locations (Cursor, Claude, Claude Desktop, etc.)
  consolidate  Interactively deduplicate and copy skills + MCP configs
  index        Build a queryable index from ~/agents/.tb/

Options:
  --json              Print full JSON (ScanResult)
  --show-duplicates   Print only duplicate skills as a table (skill, count, sources)
  --tui               Render scan output in an interactive TUI (skills list)
  --force             Re-copy items already consolidated OR rebuild index from scratch
`);
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    printHelp();
    return;
  }

  // Convenience: allow `facult --show-duplicates` as shorthand for `facult scan --show-duplicates`.
  if (cmd === "--show-duplicates") {
    await scanCommand([cmd, ...rest]);
    return;
  }

  switch (cmd) {
    case "scan":
      await scanCommand(rest);
      return;
    case "consolidate":
      await consolidateCommand(rest);
      return;
    case "index":
      await indexCommand(rest);
      return;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exitCode = 1;
      return;
  }
}

await main(process.argv.slice(2));
