import { afterEach, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = (await import("../package.json")).version as string;
const platform =
  process.platform === "win32"
    ? "windows"
    : process.platform === "darwin"
      ? "darwin"
      : "linux";
const arch = process.arch;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { force: true, recursive: true });
    })
  );
});

it("does not write install metadata when using a cached runtime binary", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "fclt-launcher-"));
  tempDirs.push(homeDir);

  const runtimeDir = join(
    homeDir,
    ".ai",
    ".facult",
    "runtime",
    version,
    `${platform}-${arch}`
  );
  await mkdir(runtimeDir, { recursive: true });

  const binaryName = process.platform === "win32" ? "fclt.exe" : "fclt";
  const binaryPath = join(runtimeDir, binaryName);
  await writeFile(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(binaryPath, 0o755);

  const proc = Bun.spawn({
    cmd: ["node", "bin/fclt.cjs", "help"],
    cwd: "/Users/hack/dev/hack-dance/facult",
    env: {
      ...process.env,
      HOME: homeDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  expect(exitCode).toBe(0);
  expect(stderr).toBe("");

  const installStatePath = join(homeDir, ".ai", ".facult", "install.json");
  await expect(stat(installStatePath)).rejects.toThrow();
});
