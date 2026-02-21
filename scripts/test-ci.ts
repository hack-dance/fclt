#!/usr/bin/env bun

import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

const proc = Bun.spawn({
  cmd: ["bun", "test"],
  cwd: repoRoot,
  env: {
    ...process.env,
    FACULT_TEST_SKIP_LOCAL: "1",
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await proc.exited);
