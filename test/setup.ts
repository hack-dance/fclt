import { mock } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createIsolatedTestRoot } from "./isolation-root";

// Run before importing any product module, including helpers that may grow new imports.
const { realHome, realState, testRoot } = createIsolatedTestRoot("fclt-test-");
const nodeRuntime = Bun.spawnSync(["node", "--print", "process.execPath"]);
if (nodeRuntime.exitCode !== 0) {
  throw new Error("Cannot resolve the Node test runtime before HOME isolation");
}
const nodeExecutable = nodeRuntime.stdout.toString().trim();
process.env.NODE_ENV = "test";
process.env.FCLT_TEST_REAL_HOME = realHome;
process.env.FCLT_TEST_REAL_STATE_ROOT = realState;
process.env.FCLT_TEST_TEMP_ROOT = testRoot;
for (const [name, subdir] of Object.entries({
  HOME: "home",
  XDG_STATE_HOME: "state",
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_CACHE_HOME: "cache",
  TMPDIR: "tmp",
  TMP: "tmp",
  TEMP: "tmp",
})) {
  const directory = join(testRoot, subdir);
  mkdirSync(directory, { recursive: true });
  process.env[name] = directory;
}
// Home-relative overrides preserve fixtures that supply their own homeDir/HOME.
process.env.FACULT_LOCAL_STATE_DIR =
  process.platform === "darwin"
    ? "~/Library/Application Support/fclt"
    : "~/.local/state/fclt";
process.env.FACULT_CACHE_DIR =
  process.platform === "darwin"
    ? "~/Library/Application Support/fclt/cache"
    : "~/.cache/fclt";
Reflect.deleteProperty(process.env, "FACULT_ROOT_DIR");
Reflect.deleteProperty(process.env, "FACULT_ROOT_SCOPE");
// Child CLIs must not re-enter a version-manager shim after HOME changes.
process.env.PATH = `${dirname(process.execPath)}${delimiter}${dirname(nodeExecutable)}${delimiter}${process.env.PATH ?? ""}`;
// Bun caches os.homedir() at startup; keep direct callers on the fixture HOME.
os.homedir = () => process.env.HOME || join(testRoot, "home");
mock.module("node:os", () => ({ ...os, default: os }));

const { installFixtureRemovalGuard } = await import("./fixture-safety");
installFixtureRemovalGuard(testRoot);

const { withoutLocalGitEnvironment } = await import(
  "../src/util/git-environment"
);

process.env.FCLT_ALLOW_LEGACY_MANAGED_MUTATION = "1";

const sanitized = withoutLocalGitEnvironment(process.env);
for (const name of Object.keys(process.env)) {
  if (!(name in sanitized)) {
    delete process.env[name];
  }
}

if (process.platform === "darwin") {
  const launchctlDir = join(testRoot, "bin");
  mkdirSync(launchctlDir);
  const launchctlPath = join(launchctlDir, "launchctl");
  writeFileSync(
    launchctlPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "list" ]; then exit 0; fi',
      'if [ "$1" = "print" ]; then echo "Could not find service" >&2; exit 113; fi',
      "exit 64",
      "",
    ].join("\n")
  );
  chmodSync(launchctlPath, 0o755);
  process.env.PATH = `${launchctlDir}${delimiter}${process.env.PATH ?? ""}`;
}
