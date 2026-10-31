import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, sep } from "node:path";
import {
  allocateArtifactId,
  generateArtifactId,
  isLegacySequentialId,
} from "./ai-ids";
import {
  facultAiPendingReviewRoot,
  facultAiReviewPublishStatePath,
  preferredGlobalAiRoot,
} from "./paths";
import { gitEnvironmentForRepository } from "./util/git-environment";

/**
 * Git environment for publish. Repository-location variables are cleared so a
 * caller's hook context cannot redirect the commands, but config injected
 * through GIT_CONFIG_COUNT/KEY/VALUE or GIT_CONFIG_PARAMETERS is kept: callers
 * use it for transport policy such as URL rewrites and credential helpers.
 * Publish runs unattended, so git never prompts for credentials.
 */
function publishGitEnvironment(repoDir: string): Record<string, string> {
  const env = gitEnvironmentForRepository({ repoDir });
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
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/**
 * Land machine-local review mirrors in the shared canonical repository.
 *
 * Pending mirrors (see `facultAiReviewMirrorMode`) are committed in a
 * temporary `git worktree` cut from the remote host branch, or from the remote
 * default branch when the host branch does not exist yet. The user's working
 * tree, index, stash and current branch are never touched, and the push is a
 * plain fast-forward push. Records are marked published only after the push
 * succeeds.
 *
 * `includeLegacy` also migrates dirty legacy writeback mirrors that older
 * releases wrote straight into the canonical tree (untracked files and tracked
 * files modified in place). Each gets a new collision-free id and lands as a
 * new file; tracked files on the default branch are never rewritten or
 * deleted. Local copies are removed only with `removeMigrated`, after the push
 * succeeded and the source still has the captured sha256.
 */

const LEGACY_WRITEBACK_PATH_RE = /^writebacks\/(?:.+\/)?(WB-\d+)\.md$/;
const REVIEW_ARTIFACT_DIRS = ["writebacks", "evolution", "reconciliation"];
const HOST_KEY_RE = /^[0-9a-z]{8}$/;
const SYMREF_HEAD_RE = /^ref: refs\/heads\/(\S+)\s+HEAD$/m;

export type PublishFileAction = "add" | "update" | "skip";

export interface PublishFileEntry {
  path: string;
  action: PublishFileAction;
  reason?:
    | "on-base"
    | "on-branch"
    | "legacy-id"
    | "published"
    | "deleted"
    | "conflict";
  sha256: string;
}

export interface MigrationEntry {
  source: string;
  sourceState: "untracked" | "modified";
  legacyId: string;
  newId?: string;
  target?: string;
  sha256: string;
  action: "migrate" | "skip";
  reason?: "on-base" | "unrecognized";
  /** The migrated record is already on the default or host branch. */
  landed?: boolean;
  removed?: boolean;
  /** Why a local copy was kept despite --remove-migrated. */
  kept?: "changed" | "staged";
}

export interface PublishResult {
  root: string;
  remote: string;
  base: string;
  branch: string;
  dryRun: boolean;
  files: PublishFileEntry[];
  migrations: MigrationEntry[];
  commit?: string;
  pushed: boolean;
  pushOutput?: string;
  pullRequest?: { url: string; created: boolean };
  pullRequestMessage?: string;
  message: string;
}

interface PublishState {
  version: 1;
  hostKey?: string;
  published: Record<
    string,
    {
      sha256: string;
      /** Default-branch copy when this was published; null when absent. */
      baseSha256?: string | null;
      branch: string;
      commit: string;
      publishedAt: string;
    }
  >;
  migrations: Record<
    string,
    {
      legacyId: string;
      newId: string;
      target: string;
      publishedAt?: string;
      commit?: string;
    }
  >;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(
  cmd: string[],
  cwd: string,
  env?: Record<string, string>
): Promise<CommandResult> {
  const proc = Bun.spawn({
    cmd,
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toPosix(pathValue: string): string {
  return pathValue.split(sep).join(posix.sep);
}

function commandFailure(label: string, result: CommandResult): Error {
  return new Error(
    [label, result.stderr.trim() || result.stdout.trim()]
      .filter(Boolean)
      .join(": ")
  );
}

class Git {
  readonly repoDir: string;
  private readonly env: Record<string, string>;
  private readonly binary: string;

  constructor(repoDir: string) {
    this.repoDir = repoDir;
    this.env = publishGitEnvironment(repoDir);
    this.binary = Bun.which("git") ?? "git";
  }

  run(args: string[], cwd = this.repoDir): Promise<CommandResult> {
    return run([this.binary, ...args], cwd, this.env);
  }

  async ok(args: string[], cwd = this.repoDir): Promise<string> {
    const result = await this.run(args, cwd);
    if (result.exitCode !== 0) {
      throw commandFailure(`git ${args[0]} failed`, result);
    }
    return result.stdout;
  }

  /** Raw blob bytes for `<ref>:<path>`, or null when absent. */
  async blob(ref: string, pathValue: string): Promise<Uint8Array | null> {
    const proc = Bun.spawn({
      cmd: [this.binary, "cat-file", "blob", `${ref}:${pathValue}`],
      cwd: this.repoDir,
      env: this.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [bytes, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      proc.exited,
    ]);
    return exitCode === 0 ? new Uint8Array(bytes) : null;
  }
}

function bytesEqual(left: Uint8Array | null, right: Uint8Array): boolean {
  return left !== null && Buffer.from(left).equals(Buffer.from(right));
}

async function loadState(homeDir: string): Promise<PublishState> {
  try {
    const parsed = JSON.parse(
      await readFile(facultAiReviewPublishStatePath(homeDir), "utf8")
    ) as Partial<PublishState>;
    return {
      version: 1,
      hostKey: parsed.hostKey,
      published: parsed.published ?? {},
      migrations: parsed.migrations ?? {},
    };
  } catch {
    return { version: 1, published: {}, migrations: {} };
  }
}

async function saveState(homeDir: string, state: PublishState): Promise<void> {
  const pathValue = facultAiReviewPublishStatePath(homeDir);
  await mkdir(dirname(pathValue), { recursive: true });
  const temporary = `${pathValue}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, pathValue);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One publish per machine at a time, so concurrent first runs cannot mint two
 * host branches or lose ledger entries.
 *
 * The lock file is created complete with `link()`, so it is never observed
 * empty. It holds `<pid> <token>`; release removes it only while it still holds
 * this run's token. A lock left by a process that died is not taken over
 * automatically: without an atomic compare-and-replace, a takeover could remove
 * a lock another publisher has just acquired. It is reported with its path so
 * a person can remove it.
 */
export async function withPublishLock<T>(
  homeDir: string,
  run: () => Promise<T>
): Promise<T> {
  const lockPath = `${facultAiReviewPublishStatePath(homeDir)}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const token = `${process.pid} ${randomBytes(12).toString("hex")}`;
  const staging = `${lockPath}.${randomBytes(6).toString("hex")}.new`;
  await writeFile(staging, `${token}\n`);
  try {
    await link(staging, lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw await lockBusyError(lockPath);
    }
    throw error;
  } finally {
    await rm(staging, { force: true });
  }
  try {
    return await run();
  } finally {
    const held = await readFile(lockPath, "utf8").catch(() => "");
    if (held.trim() === token) {
      await rm(lockPath, { force: true });
    }
  }
}

async function lockBusyError(lockPath: string): Promise<Error> {
  const content = await readFile(lockPath, "utf8").catch(() => "");
  const holder = Number.parseInt(content.split(" ")[0] ?? "", 10);
  if (Number.isInteger(holder) && holder > 0 && processAlive(holder)) {
    return new Error(
      `Another writeback publish is running (pid ${holder}); retry when it finishes`
    );
  }
  return new Error(
    `Writeback publish lock is held by a process that is no longer running: remove ${lockPath} if no publish is running, then retry`
  );
}

/**
 * A random per-machine key for the default branch name. It is not derived
 * from the hostname or anything else that identifies the machine.
 */
function hostKey(state: PublishState): string {
  if (state.hostKey && HOST_KEY_RE.test(state.hostKey)) {
    return state.hostKey;
  }
  state.hostKey = generateArtifactId("WB").slice(-8).toLowerCase();
  return state.hostKey;
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

async function defaultBranch(git: Git, remote: string): Promise<string | null> {
  const result = await git.run(["ls-remote", "--symref", remote, "HEAD"]);
  const match = SYMREF_HEAD_RE.exec(result.stdout);
  return result.exitCode === 0 && match?.[1] ? match[1] : null;
}

const GITHUB_REMOTE_RE =
  /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;

/** `owner/name` for a GitHub remote URL, or null for any other remote. */
export function githubRepository(remoteUrl: string): string | null {
  const match = GITHUB_REMOTE_RE.exec(remoteUrl.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

async function remoteBranchExists(
  git: Git,
  remote: string,
  branch: string
): Promise<boolean> {
  const result = await git.run([
    "ls-remote",
    "--exit-code",
    "--heads",
    remote,
    `refs/heads/${branch}`,
  ]);
  if (result.exitCode === 0) {
    return true;
  }
  if (result.exitCode === 2) {
    return false;
  }
  throw commandFailure(`git ls-remote ${remote} failed`, result);
}

async function fetchBranch(
  git: Git,
  remote: string,
  branch: string
): Promise<string> {
  const trackingRef = `refs/remotes/${remote}/${branch}`;
  await git.ok([
    "fetch",
    "--no-tags",
    remote,
    `+refs/heads/${branch}:${trackingRef}`,
  ]);
  return trackingRef;
}

const FRONTMATTER_RE = /^---(\r?\n)([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace the id lines of a legacy mirror and record `legacyId`. The
 * frontmatter must carry the legacy id (plain, single- or double-quoted);
 * everything else, including line endings, is kept byte for byte.
 */
export function rewriteLegacyWritebackId(
  content: string,
  legacyId: string,
  newId: string
): string | null {
  const frontmatter = FRONTMATTER_RE.exec(content);
  if (!frontmatter) {
    return null;
  }
  const block = frontmatter[2] ?? "";
  const blockStart = 3 + (frontmatter[1]?.length ?? 0);
  const id = escapeRegExp(legacyId);
  const idLine = new RegExp(`^id:[ \\t]*(["']?)${id}\\1[ \\t]*(\\r?)$`, "m");
  if (!idLine.test(block)) {
    return null;
  }
  const rewrittenBlock = block.replace(
    idLine,
    (_line, _quote, cr: string) =>
      `id: ${JSON.stringify(newId)}${cr}\nlegacyId: ${JSON.stringify(legacyId)}${cr}`
  );
  const bodyStart = frontmatter[0].length;
  const body = content
    .slice(bodyStart)
    .replace(new RegExp(`^# ${id}:`, "m"), `# ${newId}:`);
  return (
    content.slice(0, blockStart) +
    rewrittenBlock +
    content.slice(blockStart + block.length, bodyStart) +
    body
  );
}

interface DirtyLegacyFile {
  path: string;
  state: "untracked" | "modified";
  /** The index differs from HEAD for this path. */
  staged: boolean;
  legacyId: string;
}

async function dirtyLegacyWritebacks(git: Git): Promise<DirtyLegacyFile[]> {
  const output = await git.ok([
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    "writebacks",
  ]);
  const files: DirtyLegacyFile[] = [];
  const records = output.split("\0");
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i] ?? "";
    if (record.length < 4) {
      continue;
    }
    const status = record.slice(0, 2);
    const pathValue = record.slice(3);
    if (status[0] === "R" || status[0] === "C") {
      // Rename and copy records carry the source path as the next field.
      i += 1;
    }
    const match = LEGACY_WRITEBACK_PATH_RE.exec(pathValue);
    if (!match?.[1]) {
      continue;
    }
    if (status === "??") {
      files.push({
        path: pathValue,
        state: "untracked",
        staged: false,
        legacyId: match[1],
      });
    } else if (status.includes("M")) {
      files.push({
        path: pathValue,
        state: "modified",
        staged: status[0] !== " ",
        legacyId: match[1],
      });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function findPullRequest(args: {
  root: string;
  repository: string;
  base: string;
  branch: string;
  title: string;
  body: string;
  gitEnv: Record<string, string>;
}): Promise<{ url?: string; created?: boolean; message?: string }> {
  const gh = Bun.which("gh");
  if (!gh) {
    return { message: "gh not found; open a pull request for the branch." };
  }
  const listed = await run(
    [
      gh,
      "pr",
      "list",
      "--repo",
      args.repository,
      "--head",
      args.branch,
      "--state",
      "open",
      "--json",
      "url",
    ],
    args.root,
    args.gitEnv
  );
  if (listed.exitCode === 0) {
    const rows = JSON.parse(listed.stdout || "[]") as { url?: string }[];
    if (rows[0]?.url) {
      return { url: rows[0].url, created: false };
    }
  }
  const created = await run(
    [
      gh,
      "pr",
      "create",
      "--repo",
      args.repository,
      "--base",
      args.base,
      "--head",
      args.branch,
      "--title",
      args.title,
      "--body",
      args.body,
    ],
    args.root,
    args.gitEnv
  );
  if (created.exitCode !== 0) {
    return {
      message: `gh pr create failed: ${created.stderr.trim() || created.stdout.trim()}`,
    };
  }
  return { url: created.stdout.trim().split("\n").at(-1), created: true };
}

export async function publishReviewArtifacts(args: {
  homeDir: string;
  dryRun?: boolean;
  remote?: string;
  base?: string;
  branch?: string;
  includeLegacy?: boolean;
  removeMigrated?: boolean;
  pullRequest?: boolean;
}): Promise<PublishResult> {
  if (args.removeMigrated && !args.includeLegacy) {
    throw new Error("--remove-migrated requires --include-legacy");
  }
  const dryRun = args.dryRun === true;
  const configuredRoot = preferredGlobalAiRoot(args.homeDir);
  if (!existsSync(join(configuredRoot, ".git"))) {
    throw new Error(
      `Canonical root is not a git work tree: ${configuredRoot}. Review mirrors are written in place there; nothing to publish.`
    );
  }
  const root = await realpath(configuredRoot);
  const git = new Git(root);
  const topLevel = (await git.ok(["rev-parse", "--show-toplevel"])).trim();
  if ((await realpath(topLevel)) !== root) {
    throw new Error(`Canonical root is not a git repository root: ${root}`);
  }

  const remote = args.remote ?? "origin";
  await git.ok(["remote", "get-url", remote]);
  return await withPublishLock(args.homeDir, () =>
    publishLocked({ ...args, dryRun, root, git, remote })
  );
}

async function publishLocked(args: {
  homeDir: string;
  dryRun: boolean;
  root: string;
  git: Git;
  remote: string;
  base?: string;
  branch?: string;
  includeLegacy?: boolean;
  removeMigrated?: boolean;
  pullRequest?: boolean;
}): Promise<PublishResult> {
  const { dryRun, git, remote, root } = args;
  // Loaded under the lock so concurrent runs see each other's ledger.
  const state = await loadState(args.homeDir);
  // The remote's own default branch is protected even when --base names
  // another branch for the pull request, so it must be known: publishing
  // without it could push straight to that branch.
  const remoteDefault = await defaultBranch(git, remote);
  if (!remoteDefault) {
    throw new Error(
      `Unable to determine the default branch of ${remote}; refusing to publish`
    );
  }
  const base = args.base ?? remoteDefault;
  const savedHostKey = state.hostKey;
  const branch = args.branch ?? `fclt/review-${hostKey(state)}`;
  if (state.hostKey !== savedHostKey) {
    // Persist a new key even on a dry run so it previews the real branch name.
    await saveState(args.homeDir, state);
  }
  if (branch === base || branch === remoteDefault) {
    throw new Error(
      `Refusing to publish straight to the default branch ${branch}`
    );
  }

  const baseRef = await fetchBranch(git, remote, base);
  const branchExists = await remoteBranchExists(git, remote, branch);
  const startRef = branchExists
    ? await fetchBranch(git, remote, branch)
    : baseRef;
  const branchBlob = (path: string) =>
    branchExists ? git.blob(startRef, path) : Promise.resolve(null);

  const pendingRoot = facultAiPendingReviewRoot(args.homeDir);
  const files: PublishFileEntry[] = [];
  const writes = new Map<string, Uint8Array>();
  const baseShaAtPublish = new Map<string, string | null>();
  for (const artifactDir of REVIEW_ARTIFACT_DIRS) {
    for (const fullPath of await listFiles(join(pendingRoot, artifactDir))) {
      const relPath = toPosix(relative(pendingRoot, fullPath));
      const content = new Uint8Array(await readFile(fullPath));
      const entry: PublishFileEntry = {
        path: relPath,
        action: "skip",
        sha256: sha256(content),
      };
      files.push(entry);
      const id = posix.basename(relPath, ".md");
      if (artifactDir !== "reconciliation" && isLegacySequentialId(id)) {
        // Sequential ids collide across machines; they land only through
        // --include-legacy, which assigns new ids.
        entry.reason = "legacy-id";
        continue;
      }
      const baseContent = await git.blob(baseRef, relPath);
      const branchContent = await branchBlob(relPath);
      if (bytesEqual(baseContent, content)) {
        entry.reason = "on-base";
        continue;
      }
      if (bytesEqual(branchContent, content)) {
        entry.reason = "on-branch";
        continue;
      }
      const record = state.published[relPath];
      const baseSha = baseContent ? sha256(baseContent) : null;
      if (record?.sha256 === entry.sha256) {
        // Unchanged since this machine published it. A landed copy may carry
        // review edits, so never write the stale local copy over it; re-add
        // only when the earlier publish never landed anywhere.
        if (baseContent || branchContent) {
          entry.reason = "published";
          continue;
        }
        // Gone from both branches. If the default branch ever had it, it was
        // removed on purpose after landing; do not bring it back.
        const history = await git.ok([
          "log",
          "-1",
          "--format=%H",
          baseRef,
          "--",
          relPath,
        ]);
        if (history.trim()) {
          entry.reason = "deleted";
          continue;
        }
      } else if (
        // Another writer changed a landed copy since this machine's last
        // publish: the host branch differs from what was pushed, or the
        // default branch differs from both what was pushed and what it held
        // then. Leave it for a person instead of overwriting either side.
        (branchContent && sha256(branchContent) !== record?.sha256) ||
        (baseSha !== null &&
          baseSha !== record?.sha256 &&
          baseSha !== (record?.baseSha256 ?? null))
      ) {
        entry.reason = "conflict";
        continue;
      }
      entry.action = baseContent || branchContent ? "update" : "add";
      baseShaAtPublish.set(relPath, baseSha);
      writes.set(relPath, content);
    }
  }

  const migrations: MigrationEntry[] = [];
  if (args.includeLegacy) {
    const usedIds = new Set<string>();
    for (const dirty of await dirtyLegacyWritebacks(git)) {
      const bytes = new Uint8Array(await readFile(join(root, dirty.path)));
      const entry: MigrationEntry = {
        source: dirty.path,
        sourceState: dirty.state,
        legacyId: dirty.legacyId,
        sha256: sha256(bytes),
        action: "skip",
      };
      migrations.push(entry);
      if (bytesEqual(await git.blob(baseRef, dirty.path), bytes)) {
        entry.reason = "on-base";
        continue;
      }
      const dir = posix.dirname(dirty.path);
      const ledgerKey = `${dirty.path}\0${entry.sha256}`;
      const known = state.migrations[ledgerKey];
      const newId =
        known?.newId ??
        allocateArtifactId(
          "WB",
          (id) =>
            usedIds.has(id) ||
            existsSync(join(root, dir, `${id}.md`)) ||
            existsSync(join(pendingRoot, dir, `${id}.md`))
        );
      const rewritten = rewriteLegacyWritebackId(
        Buffer.from(bytes).toString("utf8"),
        dirty.legacyId,
        newId
      );
      if (rewritten === null) {
        entry.reason = "unrecognized";
        continue;
      }
      const target = `${dir}/${newId}.md`;
      const targetBytes = new TextEncoder().encode(rewritten);
      const onBase = await git.blob(baseRef, target);
      const onBranch = await branchBlob(target);
      // A migration this machine already published may since carry review
      // edits, or have been removed after landing; either way it landed.
      const publishedBefore = Boolean(known?.publishedAt);
      if (
        bytesEqual(onBase, targetBytes) ||
        bytesEqual(onBranch, targetBytes) ||
        (publishedBefore && (onBase || onBranch)) ||
        (publishedBefore &&
          (
            await git.ok(["log", "-1", "--format=%H", baseRef, "--", target])
          ).trim())
      ) {
        entry.landed = true;
      } else if (onBase || onBranch) {
        throw new Error(
          `Migrated id ${newId} already exists with different content`
        );
      } else {
        writes.set(target, targetBytes);
      }
      usedIds.add(newId);
      entry.action = "migrate";
      entry.newId = newId;
      entry.target = target;
      state.migrations[ledgerKey] = {
        ...known,
        legacyId: dirty.legacyId,
        newId,
        target,
      };
    }
  }

  const result: PublishResult = {
    root,
    remote,
    base,
    branch,
    dryRun,
    files,
    migrations,
    pushed: false,
    message: "",
  };

  if (dryRun) {
    result.message =
      writes.size > 0
        ? `Would publish ${writes.size} file(s) to ${remote}/${branch}.`
        : "Nothing to publish.";
    return result;
  }

  if (writes.size > 0) {
    await commitAndPush({ git, remote, branch, startRef, writes, result });
    const publishedAt = new Date().toISOString();
    const commit = result.commit ?? "";
    for (const entry of files) {
      if (entry.action !== "skip") {
        state.published[entry.path] = {
          sha256: entry.sha256,
          baseSha256: baseShaAtPublish.get(entry.path) ?? null,
          branch,
          commit,
          publishedAt,
        };
      }
    }
    for (const entry of migrations) {
      const record = state.migrations[`${entry.source}\0${entry.sha256}`];
      if (entry.action === "migrate" && record) {
        record.publishedAt ??= publishedAt;
        record.commit ??= commit;
      }
    }
  }
  await saveState(args.homeDir, state);

  if (args.removeMigrated) {
    await removeMigratedCopies({ git, root, migrations });
  }

  // A branch with commits the default branch lacks needs a pull request,
  // including one pushed by an earlier run whose PR step failed.
  const branchHasWork =
    result.pushed ||
    (branchExists &&
      Number.parseInt(
        (
          await git.ok(["rev-list", "--count", `${baseRef}..${startRef}`])
        ).trim(),
        10
      ) > 0);
  if (!branchHasWork) {
    result.message = "Nothing to publish.";
    return result;
  }
  await reconcilePullRequest({ ...args, base, branch, result });
  result.message = result.pushed
    ? `Published ${writes.size} file(s) to ${remote}/${branch}.`
    : `Nothing new to publish; ${remote}/${branch} still has unmerged records.`;
  return result;
}

async function assertNoSymlinkOnPath(
  root: string,
  relPath: string
): Promise<void> {
  let current = root;
  for (const segment of relPath.split("/")) {
    current = join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (!info) {
      return;
    }
    if (info.isSymbolicLink()) {
      throw new Error(
        `Refusing to publish ${relPath}: ${relative(root, current)} is a symbolic link on the target branch`
      );
    }
  }
}

async function commitAndPush(args: {
  git: Git;
  remote: string;
  branch: string;
  startRef: string;
  writes: Map<string, Uint8Array>;
  result: PublishResult;
}): Promise<void> {
  const { git, remote, branch, writes, result } = args;
  const tempDir = await mkdtemp(join(tmpdir(), "fclt-review-publish-"));
  const worktree = join(tempDir, "worktree");
  try {
    await git.ok(["worktree", "add", "--detach", worktree, args.startRef]);
    for (const relPath of writes.keys()) {
      // The fetched tree may track a symlink on the way to a destination;
      // refuse before writing anything rather than follow it out of the
      // temporary worktree.
      await assertNoSymlinkOnPath(worktree, relPath);
    }
    for (const [relPath, content] of writes) {
      const target = join(worktree, ...relPath.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await git.ok(["add", "--", ...writes.keys()], worktree);
    await git.ok(
      [
        "commit",
        "-m",
        `chore(review): publish ${writes.size} review record(s)`,
        "-m",
        "Published by fclt ai writeback publish.",
      ],
      worktree
    );
    result.commit = (await git.ok(["rev-parse", "HEAD"], worktree)).trim();
    // Push the commit from the canonical checkout, where the remote's
    // configuration (including relative URLs and push URLs) resolves as usual.
    const push = await git.run([
      "push",
      remote,
      `${result.commit}:refs/heads/${branch}`,
    ]);
    result.pushOutput = `${push.stdout}${push.stderr}`.trim();
    if (push.exitCode !== 0) {
      throw commandFailure(`git push ${remote} ${branch} failed`, push);
    }
    result.pushed = true;
  } finally {
    const removed = await git.run(["worktree", "remove", worktree]);
    if (removed.exitCode !== 0) {
      // Only reached when a failure left our own temporary worktree dirty.
      await git.run(["worktree", "remove", "--force", worktree]);
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Remove local legacy copies whose migrated record is on the remote. A copy
 * is kept when it changed since capture, or when its path has staged changes:
 * the index belongs to the user and only the captured working-tree bytes were
 * published.
 */
async function removeMigratedCopies(args: {
  git: Git;
  root: string;
  migrations: MigrationEntry[];
}): Promise<void> {
  const staged = new Set(
    (await dirtyLegacyWritebacks(args.git))
      .filter((file) => file.staged)
      .map((file) => file.path)
  );
  for (const entry of args.migrations) {
    if (entry.action !== "migrate") {
      continue;
    }
    const fullPath = join(args.root, entry.source);
    const current = await readFile(fullPath).catch(() => null);
    if (!current || sha256(current) !== entry.sha256) {
      entry.kept = "changed";
      continue;
    }
    if (entry.sourceState === "untracked") {
      await rm(fullPath);
    } else if (staged.has(entry.source)) {
      entry.kept = "staged";
      continue;
    } else {
      // The index matches HEAD here; only the working tree is restored.
      await args.git.ok([
        "restore",
        "--source=HEAD",
        "--worktree",
        "--",
        entry.source,
      ]);
    }
    entry.removed = true;
  }
}

async function reconcilePullRequest(args: {
  git: Git;
  root: string;
  remote: string;
  base: string;
  branch: string;
  pullRequest?: boolean;
  result: PublishResult;
}): Promise<void> {
  const { result } = args;
  if (args.pullRequest === false) {
    result.pullRequestMessage = "Pull request step skipped.";
    return;
  }
  const remoteUrl = (
    await args.git.ok(["remote", "get-url", args.remote])
  ).trim();
  // gh runs against the selected remote's repository, not whichever
  // repository it would infer from the checkout.
  const repository = githubRepository(remoteUrl);
  if (!repository) {
    result.pullRequestMessage = `Remote ${args.remote} is not on GitHub; open a pull request for ${args.branch} manually.`;
    return;
  }
  const pr = await findPullRequest({
    root: args.root,
    repository,
    base: args.base,
    branch: args.branch,
    title: "chore(review): publish review records",
    body: "Review records published by `fclt ai writeback publish`. Each record has a collision-free id; merging adds or updates only these review mirrors.",
    gitEnv: publishGitEnvironment(args.root),
  });
  if (pr.url) {
    result.pullRequest = { url: pr.url, created: pr.created === true };
  }
  result.pullRequestMessage = pr.message;
}
