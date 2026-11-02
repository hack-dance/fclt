import { homedir, hostname } from "node:os";
import { resolve } from "node:path";
import type { CapabilityContext } from "./capability-plan";
import { parseCliContextArgs, resolveCliContextRoot } from "./cli-context";
import {
  deployLibraryPublication,
  deployLocalLibraryAsset,
  type LibraryPublication,
  pullLibraryPublication,
  retryLibraryPublication,
} from "./library-distribution";
import {
  type LibraryContext,
  LibraryEditorError,
  type LibraryLayer,
  readLibraryAsset,
  resetLibraryAsset,
  saveLibraryAsset,
} from "./library-editor";
import { readLibrarySettings, saveLibrarySettings } from "./library-settings";
import { facultMachineStateDir } from "./paths";
import { writeCliOutput } from "./util/cli-output";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LibraryEditorError("unsupported");
  }
  return value as Record<string, unknown>;
}
export async function libraryRpc(
  context: LibraryContext,
  input: unknown,
  deployment?: CapabilityContext
) {
  const request = record(input);
  if (request.schemaVersion !== 1) {
    throw new LibraryEditorError("unsupported");
  }
  if (
    request.operation === "settings.read" ||
    request.operation === "settings.save"
  ) {
    const scope = request.scope;
    if (scope !== "global" && scope !== "project") {
      throw new LibraryEditorError("unsupported");
    }
    const keys =
      request.operation === "settings.read"
        ? ["schemaVersion", "operation", "scope"]
        : ["schemaVersion", "operation", "scope", "revision", "enabled"];
    if (Object.keys(request).some((key) => !keys.includes(key))) {
      throw new LibraryEditorError("unsupported");
    }
    if (request.operation === "settings.read") {
      return await readLibrarySettings(context, scope);
    }
    if (
      typeof request.revision !== "string" ||
      typeof request.enabled !== "boolean"
    ) {
      throw new LibraryEditorError("unsupported");
    }
    return await saveLibrarySettings(
      context,
      scope,
      request.revision,
      request.enabled
    );
  }
  if (request.operation === "retry") {
    if (
      typeof request.id !== "string" ||
      Object.keys(request).some(
        (key) => !["schemaVersion", "operation", "id"].includes(key)
      )
    ) {
      throw new LibraryEditorError("unsupported");
    }
    return await retryLibraryPublication(context, request.id);
  }
  if (request.operation === "pull" || request.operation === "deploy") {
    if (
      Object.keys(request).some(
        (key) => !["schemaVersion", "operation", "publication"].includes(key)
      )
    ) {
      throw new LibraryEditorError("unsupported");
    }
    const value = record(request.publication);
    if (
      typeof value.id !== "string" ||
      typeof value.path !== "string" ||
      value.sourceSaved !== true ||
      typeof value.repository !== "string" ||
      typeof value.commit !== "string" ||
      value.state !== "published" ||
      Object.keys(value).some(
        (key) =>
          ![
            "id",
            "path",
            "sourceSaved",
            "repository",
            "commit",
            "state",
          ].includes(key)
      )
    ) {
      throw new LibraryEditorError("unsupported");
    }
    if (request.operation === "deploy") {
      if (!deployment) {
        return {
          state: "pending" as const,
          reason: "deployment-not-configured" as const,
        };
      }
      return await deployLibraryPublication(
        context,
        value as unknown as LibraryPublication,
        deployment
      );
    }
    return await pullLibraryPublication(
      context,
      value as unknown as LibraryPublication
    );
  }
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
    (request.layer !== undefined && typeof request.layer !== "string")
  ) {
    throw new LibraryEditorError("unsupported");
  }
  if (request.operation === "apply") {
    if (
      Object.keys(request).some(
        (key) =>
          !["schemaVersion", "operation", "asset", "revision"].includes(key)
      )
    ) {
      throw new LibraryEditorError("unsupported");
    }
    return deployment
      ? await deployLocalLibraryAsset(
          context,
          { ...target, revision: request.revision },
          deployment
        )
      : {
          state: "pending" as const,
          reason: "deployment-not-configured" as const,
        };
  }
  if (
    request.operation === "save" ||
    request.operation === "edit" ||
    request.operation === "publish"
  ) {
    const current =
      request.operation === "edit" && request.layer === undefined
        ? await readLibraryAsset(context, target)
        : null;
    const provenance = current ? Object.values(current.provenance) : [];
    const automatic =
      request.operation === "edit" && request.layer === undefined;
    const autoSync =
      !automatic || (await readLibrarySettings(context, "global")).enabled;
    const defaultLayer = provenance.includes("local")
      ? "local"
      : provenance.includes("machine")
        ? "machine"
        : !autoSync && current?.supportsOverrides
          ? "machine"
          : "shared";
    if (
      request.operation === "publish" &&
      request.layer !== undefined &&
      request.layer !== "shared"
    ) {
      throw new LibraryEditorError("unsupported");
    }
    const layer =
      request.operation === "save"
        ? request.layer
        : request.operation === "publish"
          ? "shared"
          : (request.layer ?? defaultLayer);
    if (
      typeof layer !== "string" ||
      !["shared", "machine", "local"].includes(layer) ||
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
    const saved = await saveLibraryAsset(context, {
      ...target,
      revision: request.revision,
      layer: layer as LibraryLayer,
      ...(request.operation !== "save" &&
      layer === "shared" &&
      (!automatic || autoSync)
        ? { publish: true, updatePins: true }
        : {}),
      values: request.values,
    });
    if (request.operation === "save") {
      return saved;
    }
    const deploy = async () => {
      if (!deployment) {
        return {
          state: "pending" as const,
          reason: "deployment-not-configured" as const,
        };
      }
      if (saved.publication) {
        return saved.publication.state === "published"
          ? await deployLibraryPublication(
              context,
              saved.publication,
              deployment
            )
          : {
              state: "pending" as const,
              reason: "publication-failed" as const,
            };
      }
      return await deployLocalLibraryAsset(
        context,
        { ...target, revision: saved.revision },
        deployment
      );
    };
    return { ...saved, deployment: await deploy() };
  }

  if (request.operation === "reset") {
    if (
      !(
        typeof request.layer === "string" &&
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
    const saved = await resetLibraryAsset(context, {
      ...target,
      revision: request.revision,
      layer: request.layer as "machine" | "local",
      fields: request.fields,
    });
    return {
      ...saved,
      deployment: deployment
        ? await deployLocalLibraryAsset(
            context,
            { ...target, revision: saved.revision },
            deployment
          )
        : {
            state: "pending" as const,
            reason: "deployment-not-configured" as const,
          },
    };
  }
  throw new LibraryEditorError("unsupported");
}
export async function libraryCommand(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h")) {
    await writeCliOutput(
      "fclt library rpc --global [--root PATH] [--machine NAME] [--local-root PATH]\n\nRead one schemaVersion:1 JSON request from stdin. Operations: read, save, reset, edit, publish, retry, pull, deploy, apply, settings.read, settings.save.\nPlain save never publishes. Edit uses Auto-sync (default on); publish always selects shared source.\nFor owned runtime deployment pass --target-root PATH --capability-state-root PATH. Without configured targets, deployment stays pending.\nUse --project only for project inheritance settings."
    );
    return;
  }
  try {
    const parsed = parseCliContextArgs(argv.slice(1));
    if (
      argv[0] !== "rpc" ||
      !["global", "project"].includes(parsed.scope ?? "")
    ) {
      throw new LibraryEditorError("unsupported");
    }
    let machine = hostname();
    let localRoot: string | undefined;
    let targetRoot: string | undefined;
    let stateRoot: string | undefined;
    const seen = new Set<string>();
    for (let index = 0; index < parsed.argv.length; index++) {
      const flag = parsed.argv[index]!;
      if (flag === "--json") {
        continue;
      }
      if (
        ![
          "--machine",
          "--local-root",
          "--target-root",
          "--capability-state-root",
        ].includes(flag) ||
        seen.has(flag)
      ) {
        throw new LibraryEditorError("unsupported");
      }
      seen.add(flag);
      const value = parsed.argv[++index];
      if (!value || value.startsWith("--")) {
        throw new LibraryEditorError("unsupported");
      }
      if (flag === "--machine") {
        machine = value;
      } else if (flag === "--target-root") {
        targetRoot = resolve(value);
      } else if (flag === "--capability-state-root") {
        stateRoot = resolve(value);
      } else {
        localRoot = resolve(value);
      }
    }
    const home = homedir();
    const sourceRoot = resolveCliContextRoot({
      homeDir: home,
      cwd: process.cwd(),
      rootArg: parsed.rootArg,
      scope: parsed.scope,
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
    const operation = record(request).operation;
    if (
      parsed.scope === "project" &&
      ((operation !== "settings.read" && operation !== "settings.save") ||
        record(request).scope !== "project")
    ) {
      throw new LibraryEditorError("unsupported");
    }
    if (
      parsed.scope === "global" &&
      (operation === "settings.read" || operation === "settings.save") &&
      record(request).scope !== "global"
    ) {
      throw new LibraryEditorError("unsupported");
    }
    if (
      (targetRoot || stateRoot) &&
      !(
        ["deploy", "edit", "publish", "reset", "apply"].includes(
          String(operation)
        ) &&
        targetRoot &&
        stateRoot
      )
    ) {
      throw new LibraryEditorError("unsupported");
    }
    const deployment =
      targetRoot && stateRoot
        ? {
            manifest: resolve(sourceRoot, "capabilities.json"),
            sourceRoot,
            targetRoot,
            stateRoot,
            host: machine,
            platform: process.platform,
            libraryStateRoot: context.localRoot,
          }
        : undefined;
    await writeCliOutput(
      JSON.stringify({
        ok: true,
        value: await libraryRpc(context, request, deployment),
      })
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
