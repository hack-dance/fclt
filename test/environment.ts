/** Restore absence explicitly: assigning undefined stores the string "undefined". */
export function restoreEnvironmentVariable(
  name: string,
  value: string | undefined
): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
