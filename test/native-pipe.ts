interface NativePipeResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Node uses OS pipes here; Bun's subprocess sockets do not reproduce stdout backpressure. */
export function captureNativePipe({
  command,
}: {
  command: string[];
}): NativePipeResult {
  const reader = Bun.spawnSync([
    "node",
    "-e",
    'const {spawnSync} = require("node:child_process"); const result = spawnSync(process.argv[1], process.argv.slice(2), {encoding: "utf8", maxBuffer: 4 * 1024 * 1024}); process.stdout.write(JSON.stringify({status: result.status, stdout: result.stdout, stderr: result.stderr}));',
    ...command,
  ]);
  if (reader.exitCode !== 0) {
    throw new Error(`Native pipe reader failed: ${reader.stderr.toString()}`);
  }
  return JSON.parse(reader.stdout.toString()) as NativePipeResult;
}
