import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupIsolatedTestRoot } from "./isolation-root";

function requiredVariable(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing test wrapper creation receipt: ${name}`);
  }
  return value;
}

const receipt = {
  testRoot: requiredVariable("FCLT_TEST_SHELL_ROOT"),
  device: requiredVariable("FCLT_TEST_ROOT_DEVICE"),
  inode: requiredVariable("FCLT_TEST_ROOT_INODE"),
  realHome: requiredVariable("FCLT_TEST_REAL_HOME"),
  realState: requiredVariable("FCLT_TEST_REAL_STATE_ROOT"),
};
const executable = requiredVariable("FCLT_TEST_BUN_EXECUTABLE");
const keepScratch = process.env.FCLT_TEST_KEEP_TMP === "1";
const signalCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;
let runner: Bun.Subprocess | undefined;
let runnerWasSignaled = false;
let signalExit: number | undefined;
const handlers = Object.entries(signalCodes).map(([signal, code]) => {
  const handler = () => {
    signalExit ??= code;
    // Use the live owned handle, never a PID that may already have been reaped.
    if (runner?.exitCode === null) {
      runner.kill("SIGTERM");
    }
  };
  process.on(signal, handler);
  return { signal, handler };
});

let exitCode = 1;
try {
  // Setup belongs to the same cleanup owner as execution. Await each write
  // before removing the root on failure so no pending mkdir can recreate it.
  for (const directory of ["home", "state", "config", "data", "cache", "tmp"]) {
    if (signalExit !== undefined) {
      break;
    }
    await mkdir(join(receipt.testRoot, directory), { recursive: true });
  }
  if (signalExit === undefined) {
    runner = Bun.spawn([executable, "test", ...process.argv.slice(2)], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    exitCode = await runner.exited;
    runnerWasSignaled = Boolean(runner.signalCode);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  runner = undefined;
  if (keepScratch || signalExit !== undefined || runnerWasSignaled) {
    // Interrupted descendants may still be using these fixtures.
    console.error(`Preserved test scratch: ${receipt.testRoot}`);
  } else {
    try {
      cleanupIsolatedTestRoot(receipt);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      console.error(
        `Could not clean test scratch; preserved: ${receipt.testRoot}`
      );
      if (exitCode === 0) {
        exitCode = 1;
      }
    }
  }
  for (const { signal, handler } of handlers) {
    process.off(signal, handler);
  }
}
process.exitCode = signalExit ?? exitCode;
