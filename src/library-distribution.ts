import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import { applyCapability } from "./capability-apply";
import {
  capabilityRoot,
  optionalStat,
  pathsOverlap,
  safeCapabilityPath,
  snapshotCapability,
} from "./capability-files";
import { buildCapabilityPlan, type CapabilityContext } from "./capability-plan";
import {
  capabilityRelativePath,
  hashCapability,
  parseCapabilityRegistry,
  selectCapability,
} from "./capability-registry";
import type { LibraryContext } from "./library-editor";
import { withLibraryMutationLock } from "./library-lock";
import { atomicLibraryWrite } from "./library-storage";
import { normalizeRepositoryRemote } from "./repository-identity";
import { gitEnvironmentForRepository } from "./util/git-environment";

const MAX_RECEIPT_BYTES = 262_144;
const MAX_PIN_UPDATES = 4096;
const OID = /^[a-f0-9]{40,64}$/u;
const ID = /^[a-f0-9-]{36}$/u;
const REMOTE = /^[a-z0-9][a-z0-9._-]*$/iu;
const MARKDOWN = /\.md$/iu;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
export type LibraryPublicationPreflightReason =
  | "publication-not-configured"
  | "publication-conflict"
  | "publication-unavailable";
export class LibraryPublicationPreflightError extends Error {
  readonly reason: LibraryPublicationPreflightReason;
  constructor(reason: LibraryPublicationPreflightReason) {
    super(`Library publication: ${reason}`);
    this.reason = reason;
  }
}
export interface LibraryPublication {
  id: string;
  path: string;
  sourceSaved: boolean;
  repository: string;
  commit: string | null;
  state: "published" | "pending";
  reason?: "publication-failed";
}
interface Receipt {
  schemaVersion: 1;
  id: string;
  repository: string;
  remote: string;
  ref: string;
  branch: string;
  base: string;
  files: Record<string, string>;
  asset: { path: string; blob: string; sha256: string };
  commit: string | null;
  unchanged?: boolean;
  pins?: { baseBlob: string; updates: PinUpdate[] };
}
function gitEnvironment(root: string) {
  const env = gitEnvironmentForRepository({ repoDir: root });
  // Preserve caller-supplied transport policy, without inheriting repository-location variables.
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      (name === "GIT_CONFIG_COUNT" ||
        name === "GIT_CONFIG_PARAMETERS" ||
        name.startsWith("GIT_CONFIG_KEY_") ||
        name.startsWith("GIT_CONFIG_VALUE_"))
    ) {
      env[name] = value;
    }
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}
async function git(
  root: string,
  args: string[],
  allowFailure = false,
  input?: string
) {
  const process = Bun.spawn({
    cmd: ["git", "--literal-pathspecs", ...args],
    cwd: root,
    env: gitEnvironment(root),
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "ignore",
    timeout: 30_000,
  });
  const [code, output] = await Promise.all([
    process.exited,
    (async () => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of process.stdout) {
        size += chunk.byteLength;
        if (size > 4 * 1024 * 1024) {
          process.kill();
          throw new Error("Library Git output exceeded its bound");
        }
        chunks.push(chunk);
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks)
      );
    })(),
  ]);
  if ((!allowFailure && code !== 0) || output.length > 4 * 1024 * 1024) {
    throw new Error("Library Git operation unavailable");
  }
  return { code, output: output.trimEnd() };
}
const output = async (root: string, args: string[]) =>
  (await git(root, args)).output;
async function hashContent(root: string, path: string, content: string) {
  return (
    await git(
      root,
      ["hash-object", "--stdin", `--path=${path}`],
      false,
      content
    )
  ).output;
}
async function repositoryOutput(root: string, args: string[]) {
  const result = await git(root, args, true);
  if (result.code !== 0) {
    throw new LibraryPublicationPreflightError("publication-not-configured");
  }
  return result.output;
}
async function repository(ctx: LibraryContext) {
  const root = await capabilityRoot(ctx.sourceRoot);
  if (
    (await capabilityRoot(
      await repositoryOutput(root, ["rev-parse", "--show-toplevel"])
    )) !== root
  ) {
    throw new LibraryPublicationPreflightError("publication-not-configured");
  }
  const branch = await repositoryOutput(root, [
    "symbolic-ref",
    "--short",
    "HEAD",
  ]);
  const remote = await repositoryOutput(root, [
    "config",
    "--get",
    `branch.${branch}.remote`,
  ]);
  const ref = await repositoryOutput(root, [
    "config",
    "--get",
    `branch.${branch}.merge`,
  ]);
  if (
    !(REMOTE.test(remote) && ref.startsWith("refs/heads/")) ||
    (await git(root, ["check-ref-format", ref], true)).code !== 0
  ) {
    throw new LibraryPublicationPreflightError("publication-not-configured");
  }
  const fetchUrls = (
    await repositoryOutput(root, ["remote", "get-url", "--all", remote])
  ).split("\n");
  const pushUrls = (
    await repositoryOutput(root, [
      "remote",
      "get-url",
      "--push",
      "--all",
      remote,
    ])
  ).split("\n");
  if (
    fetchUrls.length !== 1 ||
    pushUrls.length !== 1 ||
    fetchUrls[0] !== pushUrls[0]
  ) {
    throw new LibraryPublicationPreflightError("publication-not-configured");
  }
  const identity =
    normalizeRepositoryRemote(fetchUrls[0]!) ??
    (await capabilityRoot(resolve(root, fetchUrls[0]!)));
  return {
    root,
    branch,
    remote,
    ref,
    repository: hashCapability(`${identity}\n${ref}`),
  };
}
async function fetchUpstream(repo: Awaited<ReturnType<typeof repository>>) {
  try {
    await git(repo.root, [
      "fetch",
      "--no-tags",
      "--recurse-submodules=no",
      "--",
      repo.remote,
      repo.ref,
    ]);
    const commit = await output(repo.root, [
      "rev-parse",
      "FETCH_HEAD^{commit}",
    ]);
    if (!OID.test(commit)) {
      throw new Error("Library upstream is unavailable");
    }
    return commit;
  } catch {
    throw new LibraryPublicationPreflightError("publication-unavailable");
  }
}
async function cleanSelected(root: string, paths: string[]) {
  for (const path of paths) {
    await safeCapabilityPath(join(root, path));
    if (
      (await output(root, ["ls-files", "-v", "-z", "--", path])) !==
        `H ${path}\u0000` ||
      (await git(root, ["diff", "--quiet", "HEAD", "--", path], true)).code !==
        0 ||
      (
        await git(
          root,
          ["diff", "--cached", "--quiet", "HEAD", "--", path],
          true
        )
      ).code !== 0
    ) {
      throw new LibraryPublicationPreflightError("publication-conflict");
    }
  }
}
interface PinUpdate {
  path: (string | number)[];
  sourcePath: string;
}
async function preparePins(
  ctx: LibraryContext,
  path: string,
  updatePins: boolean
) {
  if (!updatePins) {
    return null;
  }
  const file = join(ctx.sourceRoot, "capabilities.json");
  await safeCapabilityPath(file);
  const metadata = await optionalStat(file);
  if (!metadata) {
    return null;
  }
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.size > 1024 * 1024
  ) {
    throw new Error("Library manifest is unsafe");
  }
  const content = await readFile(file, "utf8");
  const registry = parseCapabilityRegistry(JSON.parse(content));
  const updates: PinUpdate[] = [];
  const digests = new Map<string, string | undefined>();
  for (const [index, entry] of registry.entries.entries()) {
    if (entry.owner !== "fclt") {
      continue;
    }
    const sources = [
      {
        source: entry.source,
        path: ["entries", index, "source"] as (string | number)[],
      },
      ...entry.overrides.map((override, overrideIndex) => ({
        source: override.source,
        path: ["entries", index, "overrides", overrideIndex, "source"],
      })),
    ];
    for (const candidate of sources) {
      const sourcePath = candidate.source?.path;
      if (
        !(
          sourcePath &&
          (path === sourcePath || path.startsWith(`${sourcePath}/`))
        )
      ) {
        continue;
      }
      if (
        digests.has(sourcePath) &&
        digests.get(sourcePath) !== candidate.source?.sha256
      ) {
        throw new Error("Library source pins disagree");
      }
      digests.set(sourcePath, candidate.source?.sha256);
      updates.push({ path: candidate.path, sourcePath });
      if (updates.length > MAX_PIN_UPDATES) {
        throw new Error("Library pin recovery exceeds its limit");
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(updates)) > MAX_RECEIPT_BYTES) {
    throw new Error("Library pin recovery exceeds its limit");
  }
  for (const [sourcePath, digest] of digests) {
    const snapshot = await snapshotCapability(join(ctx.sourceRoot, sourcePath));
    if (!snapshot || snapshot.hash !== digest) {
      throw new Error("Library source pin has drifted");
    }
  }
  return updates.length
    ? { file, content, mode: metadata.mode, updates }
    : null;
}
async function changedManifest(
  ctx: LibraryContext,
  content: string,
  updates: PinUpdate[],
  id: string,
  edit?: { path: string; content: string }
) {
  let result = content;
  for (const entry of updates) {
    const sourcePath = join(ctx.sourceRoot, entry.sourcePath);
    const snapshot = await snapshotCapability(sourcePath);
    if (!snapshot) {
      throw new Error("Library source is missing");
    }
    const nodes = snapshot.nodes.map((node) =>
      edit &&
      node.path ===
        relative(sourcePath, join(ctx.sourceRoot, edit.path))
          .replaceAll("\\", "/")
          .normalize("NFC")
        ? { ...node, content: Buffer.from(edit.content) }
        : node
    );
    const digest = hashCapability(
      JSON.stringify(
        nodes.map((node) => ({
          path: node.path,
          kind: node.kind,
          executable: node.executable,
          ...(node.content ? { sha256: hashCapability(node.content) } : {}),
        }))
      )
    );
    const current = JSON.parse(content) as { entries: unknown[] };
    let source: unknown = current;
    for (const part of entry.path) {
      source = (source as Record<string, unknown>)[part];
    }
    if ((source as { sha256: string }).sha256 === digest) {
      continue;
    }
    for (const [key, value] of [
      ["sha256", digest],
      ["revision", `library:${id}`],
    ] as const) {
      result = applyEdits(
        result,
        modify(result, [...entry.path, key], value, {})
      );
    }
  }
  return result;
}
async function completePins(ctx: LibraryContext, receipt: Receipt) {
  if (!(receipt.pins && receipt.files["capabilities.json"])) {
    return;
  }
  const root = ctx.sourceRoot;
  const file = join(root, "capabilities.json");
  await safeCapabilityPath(file);
  const currentBlob = await output(root, [
    "hash-object",
    "--",
    "capabilities.json",
  ]);
  if (currentBlob === receipt.files["capabilities.json"]) {
    return;
  }
  if (currentBlob !== receipt.pins.baseBlob) {
    throw new Error("Library manifest changed");
  }
  for (const [path, blob] of Object.entries(receipt.files).filter(
    ([path]) => path !== "capabilities.json"
  )) {
    if ((await output(root, ["hash-object", "--", path])) !== blob) {
      throw new Error("Saved library content changed");
    }
  }
  const content = await changedManifest(
    ctx,
    await readFile(file, "utf8"),
    receipt.pins.updates,
    receipt.id
  );
  if (
    (await hashContent(root, "capabilities.json", content)) !==
    receipt.files["capabilities.json"]
  ) {
    throw new Error("Library source changed before pin update");
  }
  await atomicLibraryWrite(file, content, (await stat(file)).mode);
}
function libraryPath(path: string) {
  capabilityRelativePath(path);
  return (
    !path.split("/").some((part) => part.startsWith(".")) &&
    (path === "mcp/servers.json" ||
      path === "mcp/mcp.json" ||
      (MARKDOWN.test(path) &&
        (path.split("/").length === 1 ||
          ["skills", "instructions", "snippets", "agents"].includes(
            path.split("/")[0]!
          ))))
  );
}
function receiptPath(ctx: LibraryContext, id: string) {
  if (!ID.test(id)) {
    throw new Error("Invalid library publication");
  }
  return join(ctx.localRoot, "library", "publications", `${id}.json`);
}
async function writeReceipt(ctx: LibraryContext, receipt: Receipt) {
  if (receipt.pins && receipt.pins.updates.length > MAX_PIN_UPDATES) {
    throw new Error("Library pin recovery exceeds its limit");
  }
  // Reserve a full object ID before source mutation; the commit is initially unknown.
  const maximum = `${JSON.stringify({ ...receipt, commit: "0".repeat(64) })}\n`;
  if (Buffer.byteLength(maximum) > MAX_RECEIPT_BYTES) {
    throw new Error("Library publication receipt exceeds its limit");
  }
  await atomicLibraryWrite(
    receiptPath(ctx, receipt.id),
    `${JSON.stringify(receipt)}\n`
  );
}
function publication(
  receipt: Receipt,
  state: LibraryPublication["state"],
  sourceSaved = state === "published" || receipt.commit !== null
): LibraryPublication {
  return {
    id: receipt.id,
    path: receipt.asset.path,
    sourceSaved,
    repository: receipt.repository,
    commit: receipt.commit,
    state,
    ...(state === "pending" ? { reason: "publication-failed" as const } : {}),
  };
}
async function savedAsset(ctx: LibraryContext, receipt: Receipt) {
  try {
    const snapshot = await snapshotCapability(
      join(ctx.sourceRoot, receipt.asset.path)
    );
    const content = snapshot?.nodes[0]?.content;
    return (
      content !== undefined && hashCapability(content) === receipt.asset.sha256
    );
  } catch {
    return false;
  }
}
async function pendingPublication(ctx: LibraryContext, receipt: Receipt) {
  return publication(
    receipt,
    "pending",
    (receipt.commit !== null && !receipt.unchanged) ||
      (await savedAsset(ctx, receipt))
  );
}
async function verifyCommit(root: string, receipt: Receipt, commit: string) {
  if (!OID.test(commit)) {
    throw new Error("Invalid library commit");
  }
  if (!receipt.unchanged) {
    if (
      (await output(root, ["show", "-s", "--format=%P", commit])) !==
        receipt.base ||
      (await output(root, [
        "show",
        "-s",
        "--format=%(trailers:key=Fclt-Library-Publication,valueonly)",
        commit,
      ])) !== receipt.id
    ) {
      throw new Error("Commit is not the owned library edit");
    }
    const changed = (
      await output(root, [
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-z",
        commit,
      ])
    )
      .split("\u0000")
      .filter(Boolean)
      .sort();
    if (
      JSON.stringify(changed) !==
      JSON.stringify(Object.keys(receipt.files).sort())
    ) {
      throw new Error("Library commit contains other changes");
    }
  }
  for (const [path, blob] of Object.entries(receipt.files)) {
    if ((await output(root, ["rev-parse", `${commit}:${path}`])) !== blob) {
      throw new Error("Library committed content changed");
    }
  }
  if (
    (await output(root, ["rev-parse", `${commit}:${receipt.asset.path}`])) !==
    receipt.asset.blob
  ) {
    throw new Error("Library committed asset identity changed");
  }
}
async function commitAndPush(ctx: LibraryContext, receipt: Receipt) {
  const repo = await repository(ctx);
  if (
    repo.repository !== receipt.repository ||
    repo.remote !== receipt.remote ||
    repo.ref !== receipt.ref ||
    repo.branch !== receipt.branch
  ) {
    throw new Error("Library upstream changed");
  }
  if (receipt.unchanged && !(await savedAsset(ctx, receipt))) {
    throw new Error("Unchanged library asset was not saved");
  }
  if (!receipt.commit) {
    const head = await output(repo.root, ["rev-parse", "HEAD"]);
    if (head === receipt.base) {
      if (!(await savedAsset(ctx, receipt))) {
        throw new Error("Saved library asset changed");
      }
      await completePins(ctx, receipt);
      for (const [path, blob] of Object.entries(receipt.files)) {
        if ((await output(repo.root, ["hash-object", "--", path])) !== blob) {
          throw new Error("Saved library content changed");
        }
      }
      for (const path of Object.keys(receipt.files)) {
        if (
          (await output(repo.root, ["rev-parse", `:${path}`])) !==
          (await output(repo.root, ["rev-parse", `${receipt.base}:${path}`]))
        ) {
          throw new Error("Selected library index changed");
        }
      }
      await git(repo.root, [
        "commit",
        "--only",
        "-m",
        `feat(library): update shared source\n\nFclt-Library-Publication: ${receipt.id}`,
        "--",
        ...Object.keys(receipt.files),
      ]);
    }
    const candidates = (
      await output(repo.root, [
        "log",
        "--format=%H",
        "--fixed-strings",
        `--grep=Fclt-Library-Publication: ${receipt.id}`,
        `${receipt.base}..HEAD`,
      ])
    )
      .split("\n")
      .filter(Boolean);
    if (candidates.length !== 1) {
      throw new Error("Owned library commit could not be identified");
    }
    await verifyCommit(repo.root, receipt, candidates[0]!);
    receipt.commit = candidates[0]!;
    await writeReceipt(ctx, receipt);
  }
  await verifyCommit(repo.root, receipt, receipt.commit);
  const upstream = await fetchUpstream(repo);
  if (
    (
      await git(
        repo.root,
        ["merge-base", "--is-ancestor", receipt.commit, upstream],
        true
      )
    ).code === 0
  ) {
    return publication(receipt, "published");
  }
  if (receipt.unchanged || upstream !== receipt.base) {
    return publication(receipt, "pending");
  }
  await git(repo.root, [
    "push",
    "--porcelain",
    "--no-follow-tags",
    "--recurse-submodules=no",
    "--",
    repo.remote,
    `${receipt.commit}:${repo.ref}`,
  ]);
  const observed = await fetchUpstream(repo);
  return publication(
    receipt,
    (
      await git(
        repo.root,
        ["merge-base", "--is-ancestor", receipt.commit, observed],
        true
      )
    ).code === 0
      ? "published"
      : "pending"
  );
}
/** Caller holds the library mutation lock across source validation, mutation, pin update and commit. */
export async function publishLibraryChange(
  ctx: LibraryContext,
  args: {
    path: string;
    content: string;
    updatePins: boolean;
    mutate: () => Promise<void>;
  }
) {
  const path = capabilityRelativePath(args.path);
  if (!libraryPath(path)) {
    throw new Error("Unsupported library publication path");
  }
  const repo = await repository(ctx);
  const localRoot = await capabilityRoot(ctx.localRoot);
  if (pathsOverlap(localRoot, repo.root)) {
    throw new Error("Library publication state overlaps source");
  }
  const pins = await preparePins(ctx, path, args.updatePins);
  const paths = [path, ...(pins ? ["capabilities.json"] : [])];
  await cleanSelected(repo.root, paths);
  const base = await output(repo.root, ["rev-parse", "HEAD"]);
  if (base !== (await fetchUpstream(repo))) {
    throw new LibraryPublicationPreflightError("publication-conflict");
  }
  const id = randomUUID();
  const desired: Record<string, string> = {
    [path]: await hashContent(repo.root, path, args.content),
  };
  if (pins) {
    desired["capabilities.json"] = await hashContent(
      repo.root,
      "capabilities.json",
      await changedManifest(ctx, pins.content, pins.updates, id, {
        path,
        content: args.content,
      })
    );
  }
  const files: Record<string, string> = {};
  for (const [path, blob] of Object.entries(desired)) {
    if (blob !== (await output(repo.root, ["rev-parse", `${base}:${path}`]))) {
      files[path] = blob;
    }
  }
  const receipt: Receipt = {
    schemaVersion: 1,
    id,
    repository: repo.repository,
    remote: repo.remote,
    ref: repo.ref,
    branch: repo.branch,
    base,
    files,
    asset: { path, blob: desired[path]!, sha256: hashCapability(args.content) },
    commit: null,
    ...(pins
      ? {
          pins: {
            baseBlob: await output(repo.root, [
              "hash-object",
              "--",
              "capabilities.json",
            ]),
            updates: pins.updates,
          },
        }
      : {}),
  };
  if (Object.keys(files).length === 0) {
    receipt.files[path] = desired[path]!;
    receipt.commit = base;
    receipt.unchanged = true;
  }
  await writeReceipt(ctx, receipt);
  try {
    await args.mutate();
    if (!(await savedAsset(ctx, receipt))) {
      throw new Error("Library source was not saved");
    }
    await completePins(ctx, receipt);
    if (
      base !== (await output(repo.root, ["rev-parse", "HEAD"])) ||
      repo.branch !==
        (await output(repo.root, ["symbolic-ref", "--short", "HEAD"]))
    ) {
      throw new Error("Library branch changed");
    }
    return await commitAndPush(ctx, receipt);
  } catch {
    return await pendingPublication(ctx, receipt);
  }
}
export async function retryLibraryPublication(
  input: LibraryContext,
  id: string
): Promise<LibraryPublication> {
  const root = await capabilityRoot(input.sourceRoot);
  const ctx = {
    ...input,
    sourceRoot: root,
    localRoot: await capabilityRoot(input.localRoot),
  };
  if (pathsOverlap(root, ctx.localRoot)) {
    throw new Error("Library publication state overlaps source");
  }
  return withLibraryMutationLock(root, async () => {
    const path = receiptPath(ctx, id);
    await safeCapabilityPath(path);
    const metadata = await stat(path);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size > MAX_RECEIPT_BYTES
    ) {
      throw new Error("Invalid library publication receipt");
    }
    const receipt = JSON.parse(await readFile(path, "utf8")) as Receipt;
    if (
      receipt.schemaVersion !== 1 ||
      receipt.id !== id ||
      !DIGEST.test(receipt.repository) ||
      !OID.test(receipt.base) ||
      !(receipt.commit === null || typeof receipt.commit === "string") ||
      !receipt.asset ||
      typeof receipt.asset.path !== "string" ||
      !libraryPath(receipt.asset.path) ||
      typeof receipt.asset.blob !== "string" ||
      !OID.test(receipt.asset.blob) ||
      typeof receipt.asset.sha256 !== "string" ||
      !DIGEST.test(receipt.asset.sha256) ||
      !receipt.files ||
      typeof receipt.files !== "object" ||
      Object.keys(receipt.files).length === 0 ||
      Object.entries(receipt.files).some(
        ([path, blob]) =>
          capabilityRelativePath(path) !== path ||
          typeof blob !== "string" ||
          !OID.test(blob)
      )
    ) {
      throw new Error("Invalid library publication receipt");
    }
    if (
      Object.keys(receipt.files).length > 2 ||
      (receipt.files[receipt.asset.path] !== undefined &&
        receipt.files[receipt.asset.path] !== receipt.asset.blob) ||
      Object.keys(receipt.files).some(
        (path) => path !== receipt.asset.path && path !== "capabilities.json"
      ) ||
      typeof receipt.branch !== "string" ||
      typeof receipt.remote !== "string" ||
      typeof receipt.ref !== "string" ||
      (receipt.unchanged !== undefined && receipt.unchanged !== true)
    ) {
      throw new Error("Invalid library publication receipt");
    }
    if (
      receipt.pins &&
      (!(
        OID.test(receipt.pins.baseBlob) && Array.isArray(receipt.pins.updates)
      ) ||
        receipt.pins.updates.length > MAX_PIN_UPDATES ||
        receipt.pins.updates.some(
          (update) =>
            typeof update.sourcePath !== "string" ||
            capabilityRelativePath(update.sourcePath) !== update.sourcePath ||
            !Array.isArray(update.path) ||
            !(
              (update.path.length === 3 || update.path.length === 5) &&
              update.path[0] === "entries" &&
              typeof update.path[1] === "number" &&
              Number.isSafeInteger(update.path[1]) &&
              update.path[1] >= 0 &&
              update.path.at(-1) === "source" &&
              (update.path.length === 3 ||
                (update.path[2] === "overrides" &&
                  typeof update.path[3] === "number" &&
                  Number.isSafeInteger(update.path[3]) &&
                  update.path[3] >= 0))
            )
        ))
    ) {
      throw new Error("Invalid library pin recovery");
    }
    try {
      return await commitAndPush(ctx, receipt);
    } catch {
      return await pendingPublication(ctx, receipt);
    }
  });
}
export async function pullLibraryPublication(
  ctx: LibraryContext,
  expected: LibraryPublication
) {
  try {
    const root = await capabilityRoot(ctx.sourceRoot);
    return await withLibraryMutationLock(root, async () => {
      const repo = await repository(ctx);
      if (
        !(expected.commit && OID.test(expected.commit)) ||
        expected.state !== "published" ||
        !expected.sourceSaved ||
        expected.repository !== repo.repository
      ) {
        throw new Error("Library publication does not match upstream");
      }
      const remote = await fetchUpstream(repo);
      if (
        (
          await git(
            root,
            ["merge-base", "--is-ancestor", expected.commit, remote],
            true
          )
        ).code !== 0
      ) {
        throw new Error("Library commit is not published");
      }
      if (
        (
          await git(
            root,
            ["merge-base", "--is-ancestor", "HEAD", expected.commit],
            true
          )
        ).code !== 0
      ) {
        throw new Error("Library peer has diverged");
      }
      await git(root, [
        "merge",
        "--ff-only",
        "--no-autostash",
        expected.commit,
      ]);
      if ((await output(root, ["rev-parse", "HEAD"])) !== expected.commit) {
        throw new Error("Library pull did not reach expected commit");
      }
      return { state: "pulled" as const, commit: expected.commit };
    });
  } catch {
    return { state: "pending" as const, reason: "pull-failed" as const };
  }
}
export async function deployLibraryPublication(
  ctx: LibraryContext,
  expected: LibraryPublication,
  options: CapabilityContext
) {
  try {
    const root = await capabilityRoot(ctx.sourceRoot);
    return await withLibraryMutationLock(root, async () => {
      const repo = await repository(ctx);
      if (
        !(expected.commit && libraryPath(expected.path)) ||
        expected.repository !== repo.repository ||
        expected.state !== "published" ||
        !expected.sourceSaved ||
        (await output(root, ["rev-parse", "HEAD"])) !== expected.commit ||
        (await capabilityRoot(options.sourceRoot)) !== root ||
        (await capabilityRoot(options.manifest)) !==
          join(root, "capabilities.json") ||
        options.host !== ctx.machine ||
        (await capabilityRoot(options.libraryStateRoot ?? "")) !==
          (await capabilityRoot(ctx.localRoot))
      ) {
        throw new Error(
          "Library deployment context does not match publication"
        );
      }
      const upstream = await fetchUpstream(repo);
      if (
        (
          await git(
            root,
            ["merge-base", "--is-ancestor", expected.commit!, upstream],
            true
          )
        ).code !== 0
      ) {
        throw new Error("Library deployment source is not published");
      }
      const verify = () => verifyPublishedSources(root, expected, options);
      await verify();
      const result = await deployAsset(ctx, expected.path, options, verify);
      return {
        ...result,
        ...(result.state === "applied" ? { commit: expected.commit } : {}),
      };
    });
  } catch {
    return { state: "pending" as const, reason: "deployment-failed" as const };
  }
}

async function readRegistry(manifest: string) {
  await safeCapabilityPath(manifest);
  const metadata = await stat(manifest);
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.size > 1024 * 1024
  ) {
    throw new Error("Invalid library manifest");
  }
  return parseCapabilityRegistry(JSON.parse(await readFile(manifest, "utf8")));
}
function matchingEntries(
  registry: ReturnType<typeof parseCapabilityRegistry>,
  path: string,
  machine: string,
  platform: string
) {
  return registry.entries
    .map((entry) => selectCapability(entry, machine, platform))
    .filter(
      (entry) =>
        entry.owner === "fclt" &&
        entry.enabled &&
        entry.source.path &&
        (path === entry.source.path ||
          path.startsWith(`${entry.source.path}/`)) &&
        ["skill", "mcp"].includes(entry.kind)
    );
}
async function verifyPublishedSources(
  root: string,
  expected: LibraryPublication,
  options: CapabilityContext
) {
  await cleanSelected(root, ["capabilities.json", expected.path]);
  const committed = parseCapabilityRegistry(
    JSON.parse(
      await output(root, ["show", `${expected.commit}:capabilities.json`])
    )
  );
  if (
    JSON.stringify(committed) !==
    JSON.stringify(await readRegistry(join(root, "capabilities.json")))
  ) {
    throw new Error("Library manifest does not match the publication");
  }
  const paths = [
    ...new Set(
      matchingEntries(
        committed,
        expected.path,
        options.host,
        options.platform
      ).map((entry) => entry.source.path!)
    ),
  ];
  if (
    paths.length &&
    ((
      await git(
        root,
        ["diff", "--quiet", expected.commit!, "--", ...paths],
        true
      )
    ).code !== 0 ||
      (
        await git(
          root,
          ["diff", "--cached", "--quiet", expected.commit!, "--", ...paths],
          true
        )
      ).code !== 0)
  ) {
    throw new Error("Canonical source does not match the publication");
  }
}
async function deployAsset(
  ctx: LibraryContext,
  path: string,
  options: CapabilityContext,
  beforeApply?: () => Promise<void>
) {
  const root = await capabilityRoot(ctx.sourceRoot);
  if (
    !libraryPath(path) ||
    (await capabilityRoot(options.sourceRoot)) !== root ||
    (await capabilityRoot(options.manifest)) !==
      join(root, "capabilities.json") ||
    options.host !== ctx.machine ||
    (await capabilityRoot(options.libraryStateRoot ?? "")) !==
      (await capabilityRoot(ctx.localRoot))
  ) {
    throw new Error("Library deployment context is unsupported");
  }
  const resolved = {
    ...options,
    sourceRoot: root,
    manifest: await capabilityRoot(options.manifest),
    targetRoot: await capabilityRoot(options.targetRoot),
    stateRoot: await capabilityRoot(options.stateRoot),
    libraryStateRoot: await capabilityRoot(ctx.localRoot),
  };
  const ids = matchingEntries(
    await readRegistry(resolved.manifest),
    path,
    ctx.machine,
    resolved.platform
  ).map((entry) => entry.id);
  if (ids.length === 0) {
    return {
      state: "pending" as const,
      reason: "deployment-not-configured" as const,
    };
  }
  const applied: string[] = [];
  const changedEntries: string[] = [];
  let failedEntry: string | undefined;
  try {
    for (const id of ids) {
      failedEntry = id;
      const plan = await buildCapabilityPlan(resolved, id);
      if (plan.status === "disabled") {
        continue;
      }
      if (
        !["create", "restore", "adopt", "update", "current"].includes(
          plan.status
        )
      ) {
        throw new Error("Library target requires attention");
      }
      await beforeApply?.();
      const result = await applyCapability(resolved, id, plan.planId);
      if (result.applied) {
        changedEntries.push(id);
      }
      const after = await buildCapabilityPlan(resolved, id);
      if (
        after.status !== "current" ||
        after.hashes.manifest !== plan.hashes.manifest ||
        after.hashes.source !== plan.hashes.source ||
        after.hashes.library !== plan.hashes.library
      ) {
        throw new Error("Library target output was not verified");
      }
      applied.push(id);
    }
  } catch {
    return {
      state: "pending" as const,
      reason: "deployment-failed" as const,
      entries: applied,
      changedEntries,
      ...(failedEntry ? { failedEntry } : {}),
    };
  }
  return applied.length
    ? {
        state: "applied" as const,
        entries: applied,
        changedEntries,
      }
    : {
        state: "pending" as const,
        reason: "deployment-not-configured" as const,
      };
}
export async function deployLocalLibraryAsset(
  ctx: LibraryContext,
  asset: { path: string; name?: string; revision: string },
  options: CapabilityContext
) {
  try {
    return await withLibraryMutationLock(
      await capabilityRoot(ctx.sourceRoot),
      async () => {
        const { readLibraryAsset } = await import("./library-editor");
        if ((await readLibraryAsset(ctx, asset)).revision !== asset.revision) {
          throw new Error("Library asset changed before deployment");
        }
        const result = await deployAsset(ctx, asset.path, options);
        return {
          ...result,
          ...(result.state === "applied" ? { revision: asset.revision } : {}),
        };
      }
    );
  } catch {
    return { state: "pending" as const, reason: "deployment-failed" as const };
  }
}
