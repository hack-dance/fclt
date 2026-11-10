/** Explicit no-write mode also disables optional machine-local cache writes. */
export function noWriteRequested(): boolean {
  return process.env.FCLT_NO_WRITE === "1";
}

/** Fail closed for commands whose handlers may mutate state. */
export function commandAllowsNoWrite(command: string, args: string[]): boolean {
  if (args.includes("--help") || args.includes("-h") || command === "help") {
    return true;
  }
  if (
    [
      "inventory",
      "status",
      "list",
      "show",
      "find",
      "graph",
      "paths",
      "adapters",
      "version",
      "--version",
      "-v",
    ].includes(command)
  ) {
    return true;
  }
  return command === "doctor" && !args.includes("--repair");
}
