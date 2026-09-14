import { describe, expect, it } from "bun:test";

describe("writeCliOutput", () => {
  it.each([
    0, 512, 4096, 49_000, 65_536, 200_000,
  ])("flushes %i bytes completely through a pipe", async (bytes) => {
    const expectedBytes = bytes + 1;
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { writeCliOutput } from "./src/util/cli-output"; await writeCliOutput("x".repeat(${bytes}));`,
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
