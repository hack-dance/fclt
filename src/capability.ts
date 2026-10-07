import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { applyCapability } from "./capability-apply";
import { capabilityRoot, snapshotCapability } from "./capability-files";
import {
  buildCapabilityPlan,
  type CapabilityContext,
  type CapabilityPlan,
  loadCapabilityContext,
} from "./capability-plan";

const FLAGS = new Set([
  "--manifest",
  "--source-root",
  "--target-root",
  "--state-root",
  "--host",
  "--platform",
  "--id",
  "--expected-plan",
  "--path",
]);
function parse(argv: string[]) {
  const result = new Map<string, string>();
  const overlays: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === "--json") {
      continue;
    }
    if (flag === "--overlay") {
      const path = argv[++index];
      if (!path || path.startsWith("--")) {
        throw new Error("--overlay requires a file");
      }
      overlays.push(path);
      continue;
    }
    if (!FLAGS.has(flag) || result.has(flag)) {
      throw new Error("Unknown or repeated capability option");
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    result.set(flag, value);
  }
  return { flags: result, overlays };
}
function required(flags: Map<string, string>, key: string): string {
  const value = flags.get(key);
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}
export async function capabilityCommand(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(`fclt capability — versioned ownership and narrow copy deployment

  digest --path <file-or-directory>
  inventory --manifest <registry.json> --source-root <canonical-root> --target-root <home> --state-root <runtime-dir>
  plan <inventory options> --id <entry-id>
  apply <inventory options> --id <entry-id> --expected-plan <planId>

All commands emit JSON. Optional selectors: --host <name> --platform <platform>.
Apply ordered platform/machine/private patches with repeated --overlay <file>.
Source root defaults to the manifest directory; host/platform default to this machine.
Apply handles one fclt-owned entry. Conflicts, disabled entries, unavailable credentials,
and native/external ownership never mutate targets. See docs/capability-registry.md.`);
    return;
  }
  try {
    const command = argv[0];
    const { flags, overlays } = parse(argv.slice(1));
    for (const flag of flags.keys()) {
      if (
        (command === "digest" && flag !== "--path") ||
        (command !== "digest" && flag === "--path") ||
        (command !== "apply" && flag === "--expected-plan") ||
        (command !== "apply" && command !== "plan" && flag === "--id")
      ) {
        throw new Error("Capability option is not valid for this command");
      }
    }
    if (command === "digest" && overlays.length) {
      throw new Error("digest does not accept overlays");
    }
    if (command === "digest") {
      const path = await capabilityRoot(required(flags, "--path"));
      const snapshot = await snapshotCapability(path);
      if (!snapshot) {
        throw new Error("Capability path is missing");
      }
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            path,
            sha256: snapshot.hash,
            nodes: snapshot.nodes.length,
          },
          null,
          2
        )
      );
      return;
    }
    if (command !== "inventory" && command !== "plan" && command !== "apply") {
      throw new Error("Expected capability digest, inventory, plan, or apply");
    }
    const manifest = resolve(required(flags, "--manifest"));
    const options: CapabilityContext = {
      manifest,
      overlays,
      sourceRoot: flags.get("--source-root") ?? dirname(manifest),
      targetRoot: required(flags, "--target-root"),
      stateRoot: required(flags, "--state-root"),
      host: flags.get("--host") ?? hostname(),
      platform: flags.get("--platform") ?? process.platform,
    };
    let result: unknown;
    if (command === "inventory") {
      const context = await loadCapabilityContext(options);
      const entries: CapabilityPlan[] = [];
      for (const entry of context.entries) {
        entries.push(await buildCapabilityPlan(options, entry.id));
      }
      result = {
        schemaVersion: 1,
        host: options.host,
        platform: options.platform,
        entries,
      };
    } else if (command === "plan") {
      result = await buildCapabilityPlan(options, required(flags, "--id"));
    } else {
      result = await applyCapability(
        options,
        required(flags, "--id"),
        required(flags, "--expected-plan")
      );
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    // Do not echo parser input or filesystem errors that could contain credential values.
    console.error(
      error instanceof SyntaxError
        ? "Invalid capability JSON"
        : error instanceof Error
          ? error.message
          : "Capability operation failed"
    );
    process.exitCode = 1;
  }
}
