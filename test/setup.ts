import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { withoutLocalGitEnvironment } from "../src/util/git-environment";

process.env.FCLT_ALLOW_LEGACY_MANAGED_MUTATION = "1";

const sanitized = withoutLocalGitEnvironment(process.env);
for (const name of Object.keys(process.env)) {
  if (!(name in sanitized)) {
    delete process.env[name];
  }
}

if (process.platform === "darwin") {
  const launchctlDir = mkdtempSync(join(tmpdir(), "fclt-test-launchctl-"));
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
  process.on("exit", () => {
    rmSync(launchctlDir, { recursive: true, force: true });
  });
}
