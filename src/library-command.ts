import { homedir, hostname } from "node:os";
import { resolve } from "node:path";
import { parseCliContextArgs, resolveCliContextRoot } from "./cli-context";
import {
  type LibraryContext,
  LibraryEditorError,
  type LibraryLayer,
  readLibraryAsset,
  resetLibraryAsset,
  saveLibraryAsset,
} from "./library-editor";
import { facultMachineStateDir } from "./paths";
import { writeCliOutput } from "./util/cli-output";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LibraryEditorError("unsupported");
  }
  return value as Record<string, unknown>;
}
export async function libraryRpc(context: LibraryContext, input: unknown) {
  const request = record(input);
  const asset = record(request.asset);
  if (
    request.schemaVersion !== 1 ||
    typeof asset.path !== "string" ||
    asset.path.length > 4096 ||
    (asset.name !== undefined && typeof asset.name !== "string") ||
    Object.keys(asset).some((key) => !["path", "name"].includes(key))
  ) {
    throw new LibraryEditorError("unsupported");
  }
  const target = {
    path: asset.path,
    ...(typeof asset.name === "string" ? { name: asset.name } : {}),
  };
  if (request.operation === "read") {
    if (
      Object.keys(request).some(
        (key) => !["schemaVersion", "operation", "asset"].includes(key)
      )
    ) {
      throw new LibraryEditorError("unsupported");
    }
    return await readLibraryAsset(context, target);
  }
  if (
    typeof request.revision !== "string" ||
    typeof request.layer !== "string"
  ) {
    throw new LibraryEditorError("unsupported");
  }
  if (request.operation === "save") {
    if (
      !["shared", "machine", "local"].includes(request.layer) ||
      Object.keys(request).some(
        (key) =>
          ![
            "schemaVersion",
            "operation",
            "asset",
            "revision",
            "layer",
            "values",
          ].includes(key)
      )
    ) {
      throw new LibraryEditorError("unsupported");
    }
    return await saveLibraryAsset(context, {
      ...target,
      revision: request.revision,
      layer: request.layer as LibraryLayer,
      values: request.values,
    });
  }
  if (request.operation === "reset") {
    if (
      !(
        ["machine", "local"].includes(request.layer) &&
        Array.isArray(request.fields) &&
        request.fields.every((field) => typeof field === "string")
      ) ||
      Object.keys(request).some(
        (key) =>
          ![
            "schemaVersion",
            "operation",
            "asset",
            "revision",
            "layer",
            "fields",
          ].includes(key)
      )
    ) {
      throw new LibraryEditorError("unsupported");
    }
    return await resetLibraryAsset(context, {
      ...target,
      revision: request.revision,
      layer: request.layer as "machine" | "local",
      fields: request.fields,
    });
  }
  throw new LibraryEditorError("unsupported");
}
export async function libraryCommand(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h")) {
    await writeCliOutput(
      "fclt library rpc --global [--root PATH] [--machine NAME] [--local-root PATH]\n\nRead one schemaVersion:1 JSON request from stdin. Operations: read, save, reset.\nSaves change canonical source or an overlay; they never publish, sync or deploy.\nUse capability plan/apply --library-state-root PATH to consume overlays for an explicitly owned target."
    );
    return;
  }
  try {
    const parsed = parseCliContextArgs(argv.slice(1));
    if (argv[0] !== "rpc" || parsed.scope !== "global") {
      throw new LibraryEditorError("unsupported");
    }
    let machine = hostname();
    let localRoot: string | undefined;
    const seen = new Set<string>();
    for (let index = 0; index < parsed.argv.length; index++) {
      const flag = parsed.argv[index]!;
      if (flag === "--json") {
        continue;
      }
      if (!["--machine", "--local-root"].includes(flag) || seen.has(flag)) {
        throw new LibraryEditorError("unsupported");
      }
      seen.add(flag);
      const value = parsed.argv[++index];
      if (!value || value.startsWith("--")) {
        throw new LibraryEditorError("unsupported");
      }
      if (flag === "--machine") {
        machine = value;
      } else {
        localRoot = resolve(value);
      }
    }
    const home = homedir();
    const sourceRoot = resolveCliContextRoot({
      homeDir: home,
      cwd: process.cwd(),
      rootArg: parsed.rootArg,
      scope: "global",
    });
    const context = {
      sourceRoot,
      localRoot: localRoot ?? facultMachineStateDir(home, sourceRoot),
      machine,
    };
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of Bun.stdin.stream()) {
      length += chunk.byteLength;
      if (length > 2 * 1024 * 1024) {
        throw new LibraryEditorError("unsupported");
      }
      chunks.push(chunk);
    }
    let request: unknown;
    try {
      request = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
      );
    } catch {
      throw new LibraryEditorError("unsupported");
    }
    await writeCliOutput(
      JSON.stringify({ ok: true, value: await libraryRpc(context, request) })
    );
  } catch (error) {
    await writeCliOutput(
      JSON.stringify({
        ok: false,
        error: {
          reason:
            error instanceof LibraryEditorError ? error.reason : "unavailable",
        },
      })
    );
    process.exitCode = 1;
  }
}
