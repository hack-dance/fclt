/** Explicit no-write mode also disables optional machine-local cache writes. */
export function noWriteRequested(): boolean {
  const value = process.env.FCLT_NO_WRITE?.trim().toLowerCase();
  return Boolean(value && !["0", "false", "no"].includes(value));
}

/** Fail closed for commands whose handlers may mutate state. */
export function commandAllowsNoWrite(command: string, args: string[]): boolean {
  if (
    [
      "help",
      "--help",
      "-h",
      "protocol",
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
