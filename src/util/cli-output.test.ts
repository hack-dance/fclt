import { describe, expect, it } from "bun:test";

describe("writeCliOutput", () => {
  it("flushes output larger than Bun's buffered stdout window", async () => {
    const expectedBytes = 200_001;
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        'import { writeCliOutput } from "./src/util/cli-output"; await writeCliOutput("x".repeat(200_000));',
      ],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.byteLength).toBe(expectedBytes);
  });
});
