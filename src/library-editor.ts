import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  type CapabilitySnapshot,
  capabilityRoot,
  optionalStat,
  pathsOverlap,
  safeCapabilityPath,
  snapshotCapability,
} from "./capability-files";
import { hashCapability } from "./capability-registry";

const PATH_PART_RE = /[\\:]/u;
const MARKDOWN_RE = /\.md$/iu;
const SENSITIVE_MCP_RE =
  /\b(?:token|secret|password|authorization|api[-_]?key|bearer)\b|(?:sk-|ghp_|github_pat_)[a-z0-9_]{10,}|https?:\/\/[^\s/]*@/iu;
const MACHINE_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/iu;
const REFERENCE_RE = /^(?:op:\/\/[^\s]+|\$\{[A-Za-z_][A-Za-z0-9_]*\})$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;

export type LibraryLayer = "shared" | "machine" | "local";
type Field = "content" | "command" | "args";
type Value = string | string[];
type Values = Partial<Record<Field, Value>>;
export interface LibraryContext {
  sourceRoot: string;
  localRoot: string;
  machine: string;
}
export interface LibraryAsset {
  path: string;
  name?: string;
}
interface Overlay {
  schemaVersion: 1;
  path: string;
  name?: string;
  values: Values;
  base: Partial<Record<Field, string>>;
}
type LibraryErrorReason = "unsupported" | "conflict" | "busy" | "unavailable";
export class LibraryEditorError extends Error {
  readonly reason: LibraryErrorReason;
  constructor(reason: LibraryErrorReason) {
    super(`Library editor: ${reason}`);
    this.reason = reason;
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LibraryEditorError("unsupported");
  }
  return value as Record<string, unknown>;
}
function fields(asset: LibraryAsset): Field[] {
  const parts = asset.path.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part.startsWith(".") ||
        PATH_PART_RE.test(part) ||
        part.includes("\u0000")
    )
  ) {
    throw new LibraryEditorError("unsupported");
  }
  if (asset.name !== undefined) {
    if (
      !(
        ["mcp/servers.json", "mcp/mcp.json"].includes(asset.path) && asset.name
      ) ||
      asset.name.length > 256 ||
      asset.name.includes("\u0000")
    ) {
      throw new LibraryEditorError("unsupported");
    }
    return ["command", "args"];
  }
  if (
    !(
      MARKDOWN_RE.test(asset.path) &&
      (parts.length === 1 ||
        ["skills", "instructions", "snippets", "agents"].includes(parts[0]!))
    )
  ) {
    throw new LibraryEditorError("unsupported");
  }
  return ["content"];
}
function values(value: unknown, allowed: readonly Field[]): Values {
  const input = object(value);
  const output: Values = {};
  for (const [key, entry] of Object.entries(input)) {
    if (!allowed.includes(key as Field)) {
      throw new LibraryEditorError("unsupported");
    }
    if (key === "args") {
      if (
        !Array.isArray(entry) ||
        entry.length > 256 ||
        !entry.every(
          (arg) =>
            typeof arg === "string" &&
            arg.length <= 4096 &&
            !arg.includes("\u0000")
        )
      ) {
        throw new LibraryEditorError("unsupported");
      }
      output.args = [...entry];
    } else {
      if (
        typeof entry !== "string" ||
        entry.includes("\u0000") ||
        Buffer.byteLength(entry) > (key === "content" ? 262_144 : 4096)
      ) {
        throw new LibraryEditorError("unsupported");
      }
      output[key as "content" | "command"] = entry;
    }
  }
  const text = [output.command ?? "", ...(output.args ?? [])].join(" ");
  if (
    allowed.includes("command") &&
    ((output.command !== undefined && !String(output.command).trim()) ||
      SENSITIVE_MCP_RE.test(text))
  ) {
    throw new LibraryEditorError("unsupported");
  }
  return output;
}
const fingerprint = (value: Value | undefined) =>
  hashCapability(JSON.stringify(value ?? null));
async function context(input: LibraryContext): Promise<LibraryContext> {
  if (!MACHINE_RE.test(input.machine)) {
    throw new LibraryEditorError("unsupported");
  }
  const sourceRoot = await capabilityRoot(input.sourceRoot);
  const localRoot = await capabilityRoot(input.localRoot);
  if (pathsOverlap(sourceRoot, localRoot)) {
    throw new LibraryEditorError("unsupported");
  }
  return { ...input, sourceRoot, localRoot };
}
async function readRegular(path: string, limit = 262_144) {
  await safeCapabilityPath(path);
  const stat = await optionalStat(path);
  if (!stat) {
    return null;
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) {
    throw new LibraryEditorError("unsupported");
  }
  const snapshot = await snapshotCapability(path);
  const bytes = snapshot?.nodes[0]?.content;
  if (!bytes || bytes.length > limit) {
    throw new LibraryEditorError("unsupported");
  }
  try {
    return {
      content: new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes),
      mode: stat.mode,
    };
  } catch {
    throw new LibraryEditorError("unsupported");
  }
}
function parse(content: string): Record<string, unknown> {
  try {
    return object(JSON.parse(content));
  } catch {
    throw new LibraryEditorError("unsupported");
  }
}
async function source(ctx: LibraryContext, asset: LibraryAsset) {
  const allowed = fields(asset);
  const file = join(ctx.sourceRoot, ...asset.path.split("/"));
  const document = await readRegular(file);
  if (!document) {
    throw new LibraryEditorError("unavailable");
  }
  if (!asset.name) {
    return {
      ...document,
      file,
      allowed,
      value: { content: document.content } as Values,
      json: null,
      key: null,
      servers: null,
      environment: [] as { name: string; reference: string | null }[],
    };
  }
  const json = parse(document.content);
  const key = Object.hasOwn(json, "servers") ? "servers" : "mcpServers";
  const servers = object(json[key]);
  if (!Object.hasOwn(servers, asset.name)) {
    throw new LibraryEditorError("unsupported");
  }
  const definition = object(servers[asset.name]);
  if (
    typeof definition.command !== "string" ||
    (definition.type ?? definition.transport ?? "stdio") !== "stdio"
  ) {
    throw new LibraryEditorError("unsupported");
  }
  const value = values(
    { command: definition.command, args: definition.args ?? [] },
    allowed
  );
  const environment = Object.entries(
    definition.env === undefined ? {} : object(definition.env)
  ).map(([name, entry]) => ({
    name,
    reference:
      typeof entry === "string" && REFERENCE_RE.test(entry) ? entry : null,
  }));
  return { ...document, file, allowed, value, json, key, servers, environment };
}
function overlayPaths(ctx: LibraryContext, asset: LibraryAsset) {
  const id = hashCapability(
    JSON.stringify([asset.path, asset.name ?? null])
  ).slice(7);
  return {
    machine: join(
      ctx.sourceRoot,
      "profiles",
      ctx.machine,
      "library",
      `${id}.json`
    ),
    local: join(ctx.localRoot, "library", ctx.machine, `${id}.json`),
  };
}
async function overlay(path: string, asset: LibraryAsset) {
  const file = await readRegular(path, 2 * 1024 * 1024);
  if (!file) {
    return { content: null, record: null };
  }
  const data = parse(file.content);
  if (
    data.schemaVersion !== 1 ||
    data.path !== asset.path ||
    data.name !== asset.name ||
    Object.keys(data).some(
      (key) =>
        !["schemaVersion", "path", "name", "values", "base"].includes(key)
    )
  ) {
    throw new LibraryEditorError("unsupported");
  }
  const patch = values(data.values, fields(asset));
  const base = object(data.base);
  if (
    Object.keys(base).some((key) => !Object.hasOwn(patch, key)) ||
    Object.keys(patch).some(
      (key) =>
        typeof base[key] !== "string" || !DIGEST_RE.test(String(base[key]))
    )
  ) {
    throw new LibraryEditorError("unsupported");
  }
  return {
    content: file.content,
    record: {
      schemaVersion: 1,
      path: asset.path,
      ...(asset.name ? { name: asset.name } : {}),
      values: patch,
      base,
    } as Overlay,
  };
}
async function load(ctx: LibraryContext, asset: LibraryAsset) {
  const shared = await source(ctx, asset);
  const paths = overlayPaths(ctx, asset);
  const machine = await overlay(paths.machine, asset);
  const { local: localPath } = paths;
  const local = await overlay(localPath, asset);
  const machineValue = { ...shared.value, ...machine.record?.values };
  const effective = { ...machineValue, ...local.record?.values };
  const changed = (record: Overlay | null, lower: Values) =>
    shared.allowed.filter(
      (field) =>
        record?.values[field] !== undefined &&
        record.base[field] !== fingerprint(lower[field])
    );
  const provenance = Object.fromEntries(
    shared.allowed.map((field) => [
      field,
      local.record?.values[field] !== undefined
        ? "local"
        : machine.record?.values[field] !== undefined
          ? "machine"
          : "shared",
    ])
  );
  const view = {
    schemaVersion: 1 as const,
    path: asset.path,
    ...(asset.name ? { name: asset.name } : {}),
    revision: hashCapability(
      JSON.stringify([
        ctx.machine,
        asset.path,
        asset.name ?? null,
        shared.content,
        machine.content,
        local.content,
      ])
    ),
    shared: shared.value,
    machine: machine.record?.values ?? {},
    local: local.record?.values ?? {},
    effective,
    provenance,
    changed: {
      machine: changed(machine.record, shared.value),
      local: changed(local.record, machineValue),
    },
    environment: shared.environment,
  };
  return { ctx, shared, paths, machine, local, machineValue, view };
}
export async function readLibraryAsset(
  input: LibraryContext,
  asset: LibraryAsset
) {
  try {
    return (await load(await context(input), asset)).view;
  } catch (error) {
    if (error instanceof LibraryEditorError) {
      throw error;
    }
    throw new LibraryEditorError("unavailable");
  }
}
async function atomicWrite(path: string, content: string, mode = 0o600) {
  await safeCapabilityPath(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await safeCapabilityPath(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode });
    await chmod(temporary, mode);
    await safeCapabilityPath(path);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function withLock<A>(
  input: LibraryContext,
  operation: (ctx: LibraryContext) => Promise<A>
): Promise<A> {
  const ctx = await context(input);
  const path = join(ctx.sourceRoot, ".library-editor.lock");
  await safeCapabilityPath(path);
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(path, "wx", 0o600);
  } catch {
    throw new LibraryEditorError("busy");
  }
  try {
    return await operation(ctx);
  } catch (error) {
    if (error instanceof LibraryEditorError) {
      throw error;
    }
    throw new LibraryEditorError("unavailable");
  } finally {
    await lock.close();
    await rm(path);
  }
}
async function backup(ctx: LibraryContext, content: string) {
  const path = join(
    ctx.localRoot,
    "library",
    "recovery",
    `${randomUUID()}.json`
  );
  await atomicWrite(path, content);
  return path;
}
export async function saveLibraryAsset(
  input: LibraryContext,
  request: LibraryAsset & {
    revision: string;
    layer: LibraryLayer;
    values: unknown;
  }
) {
  return await withLock(input, async (ctx) => {
    if (!["shared", "machine", "local"].includes(request.layer)) {
      throw new LibraryEditorError("unsupported");
    }
    const current = await load(ctx, request);
    if (current.view.revision !== request.revision) {
      throw new LibraryEditorError("conflict");
    }
    const patch = values(request.values, current.shared.allowed);
    if (request.layer === "shared") {
      const value = { ...current.shared.value, ...patch };
      const content =
        request.name &&
        current.shared.json &&
        current.shared.servers &&
        current.shared.key
          ? `${JSON.stringify({ ...current.shared.json, [current.shared.key]: { ...current.shared.servers, [request.name]: { ...object(current.shared.servers[request.name]), ...value } } }, null, 2)}\n`
          : String(value.content);
      if (Buffer.byteLength(content) > 262_144) {
        throw new LibraryEditorError("unsupported");
      }
      await backup(
        ctx,
        request.name
          ? JSON.stringify({
              path: request.path,
              name: request.name,
              values: current.shared.value,
            })
          : current.shared.content
      );
      if ((await load(ctx, request)).view.revision !== request.revision) {
        throw new LibraryEditorError("conflict");
      }
      await atomicWrite(current.shared.file, content, current.shared.mode);
    } else {
      const previous = current[request.layer].record;
      const lower =
        request.layer === "machine"
          ? current.shared.value
          : current.machineValue;
      const base = { ...previous?.base };
      for (const field of Object.keys(patch) as Field[]) {
        base[field] = fingerprint(lower[field]);
      }
      const record: Overlay = {
        schemaVersion: 1,
        path: request.path,
        ...(request.name ? { name: request.name } : {}),
        values: { ...previous?.values, ...patch },
        base,
      };
      if (current[request.layer].content !== null) {
        await backup(ctx, current[request.layer].content!);
      }
      if ((await load(ctx, request)).view.revision !== request.revision) {
        throw new LibraryEditorError("conflict");
      }
      await atomicWrite(
        current.paths[request.layer],
        `${JSON.stringify(record, null, 2)}\n`
      );
    }
    return (await load(ctx, request)).view;
  });
}
export async function resetLibraryAsset(
  input: LibraryContext,
  request: LibraryAsset & {
    revision: string;
    layer: "machine" | "local";
    fields: readonly string[];
  }
) {
  return await withLock(input, async (ctx) => {
    if (!["machine", "local"].includes(request.layer)) {
      throw new LibraryEditorError("unsupported");
    }
    const current = await load(ctx, request);
    if (current.view.revision !== request.revision) {
      throw new LibraryEditorError("conflict");
    }
    if (
      request.fields.some(
        (field) => !current.shared.allowed.includes(field as Field)
      )
    ) {
      throw new LibraryEditorError("unsupported");
    }
    const previous = current[request.layer];
    if (!previous.record) {
      return current.view;
    }
    const record = {
      ...previous.record,
      values: { ...previous.record.values },
      base: { ...previous.record.base },
    };
    for (const field of request.fields as Field[]) {
      delete record.values[field];
      delete record.base[field];
    }
    await backup(ctx, previous.content!);
    if ((await load(ctx, request)).view.revision !== request.revision) {
      throw new LibraryEditorError("conflict");
    }
    await atomicWrite(
      current.paths[request.layer],
      `${JSON.stringify(record, null, 2)}\n`
    );
    return (await load(ctx, request)).view;
  });
}
export async function snapshotLibraryCapability(
  input: LibraryContext,
  sourcePath: string,
  snapshot: CapabilitySnapshot,
  kind: string
) {
  const ctx = await context(input);
  const revisions: string[] = [];
  const nodes: CapabilitySnapshot["nodes"] = [];
  const directories = new Map<string, string[]>();
  // Snapshot paths use NFC; overlay keys must use the source's exact filenames.
  async function sourceFile(nodePath: string) {
    let current = sourcePath;
    for (const part of nodePath.split("/").filter(Boolean)) {
      let entries = directories.get(current);
      if (!entries) {
        await safeCapabilityPath(current);
        entries = await readdir(current);
        directories.set(current, entries);
      }
      const name = entries.find((entry) => entry.normalize("NFC") === part);
      if (!name) {
        throw new LibraryEditorError("conflict");
      }
      current = join(current, name);
    }
    return current;
  }
  for (const node of snapshot.nodes) {
    let file = node.path ? join(sourcePath, node.path) : sourcePath;
    let path = relative(ctx.sourceRoot, file).replaceAll("\\", "/");
    if (
      node.kind !== "file" ||
      !(
        (kind === "skill" && MARKDOWN_RE.test(path)) ||
        (kind === "mcp" && ["mcp/servers.json", "mcp/mcp.json"].includes(path))
      )
    ) {
      nodes.push(node);
      continue;
    }
    file = await sourceFile(node.path);
    path = relative(ctx.sourceRoot, file).replaceAll("\\", "/");
    if (kind === "skill") {
      const asset = { path };
      const paths = overlayPaths(ctx, asset);
      const machine = await overlay(paths.machine, asset);
      const { local: localPath } = paths;
      const local = await overlay(localPath, asset);
      if (
        !(
          Object.keys(machine.record?.values ?? {}).length ||
          Object.keys(local.record?.values ?? {}).length
        )
      ) {
        revisions.push(
          hashCapability(JSON.stringify([path, machine.content, local.content]))
        );
        nodes.push(node);
        continue;
      }
      const loaded = await load(ctx, asset);
      if (!Buffer.from(loaded.shared.content).equals(node.content!)) {
        throw new LibraryEditorError("conflict");
      }
      const view = loaded.view;
      revisions.push(view.revision);
      nodes.push({
        ...node,
        content: Buffer.from(String(view.effective.content)),
      });
    } else {
      const current = await readRegular(file, node.content!.byteLength);
      if (!(current && Buffer.from(current.content).equals(node.content!))) {
        throw new LibraryEditorError("conflict");
      }
      const json = parse(current.content);
      const key = Object.hasOwn(json, "servers") ? "servers" : "mcpServers";
      const servers = object(json[key]);
      const next = { ...servers };
      let applied = false;
      for (const name of Object.keys(servers)) {
        const paths = overlayPaths(ctx, { path, name });
        const machine = await overlay(paths.machine, { path, name });
        const { local: localPath } = paths;
        const local = await overlay(localPath, { path, name });
        revisions.push(
          hashCapability(
            JSON.stringify([path, name, machine.content, local.content])
          )
        );
        if (
          !(
            Object.keys(machine.record?.values ?? {}).length ||
            Object.keys(local.record?.values ?? {}).length
          )
        ) {
          continue;
        }
        const loaded = await load(ctx, { path, name });
        if (!Buffer.from(loaded.shared.content).equals(node.content!)) {
          throw new LibraryEditorError("conflict");
        }
        next[name] = { ...object(servers[name]), ...loaded.view.effective };
        applied = true;
      }
      if (!applied) {
        nodes.push(node);
        continue;
      }
      nodes.push({
        ...node,
        content: Buffer.from(
          `${JSON.stringify({ ...json, [key]: next }, null, 2)}\n`
        ),
      });
    }
  }
  const hash = hashCapability(
    JSON.stringify(
      nodes.map((node) => ({
        path: node.path,
        kind: node.kind,
        executable: node.executable,
        ...(node.content ? { sha256: hashCapability(node.content) } : {}),
      }))
    )
  );
  return {
    snapshot: { nodes, hash },
    revision: hashCapability(JSON.stringify(revisions)),
  };
}
