import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
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
  reason?: "on-base" | "on-branch" | "legacy-id";
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
  removed?: boolean;
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
    { sha256: string; branch: string; commit: string; publishedAt: string }
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
  await writeFile(pathValue, `${JSON.stringify(state, null, 2)}\n`);
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

async function defaultBranch(git: Git, remote: string): Promise<string> {
  const result = await git.run(["ls-remote", "--symref", remote, "HEAD"]);
  const match = SYMREF_HEAD_RE.exec(result.stdout);
  if (result.exitCode !== 0 || !match?.[1]) {
    throw new Error(
      `Unable to determine the default branch of ${remote}; pass --base <branch>`
    );
  }
  return match[1];
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

/** Replace the id lines of a legacy mirror and record `legacyId`. */
export function rewriteLegacyWritebackId(
  content: string,
  legacyId: string,
  newId: string
): string | null {
  const idLine = new RegExp(`^id: "?${legacyId}"?(\\r?)$`, "m");
  const heading = new RegExp(`^# ${legacyId}:`, "m");
  if (!(idLine.test(content) || heading.test(content))) {
    return null;
  }
  return content
    .replace(
      idLine,
      (_line, cr: string) =>
        `id: ${JSON.stringify(newId)}${cr}\nlegacyId: ${JSON.stringify(legacyId)}${cr}`
    )
    .replace(heading, `# ${newId}:`);
}

interface DirtyLegacyFile {
  path: string;
  state: "untracked" | "modified";
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
      files.push({ path: pathValue, state: "untracked", legacyId: match[1] });
    } else if (status.includes("M")) {
      files.push({ path: pathValue, state: "modified", legacyId: match[1] });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function findPullRequest(args: {
  root: string;
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
  const state = await loadState(args.homeDir);
  const base = args.base ?? (await defaultBranch(git, remote));
  const savedHostKey = state.hostKey;
  const branch = args.branch ?? `fclt/review-${hostKey(state)}`;
  if (state.hostKey !== savedHostKey) {
    // Persist a new key even on a dry run so it previews the real branch name.
    await saveState(args.homeDir, state);
  }
  if (branch === base) {
    throw new Error(
      `Refusing to publish straight to the default branch ${base}`
    );
  }

  const baseRef = await fetchBranch(git, remote, base);
  const branchExists = await remoteBranchExists(git, remote, branch);
  const startRef = branchExists
    ? await fetchBranch(git, remote, branch)
    : baseRef;

  const pendingRoot = facultAiPendingReviewRoot(args.homeDir);
  const files: PublishFileEntry[] = [];
  const writes = new Map<string, Uint8Array>();
  for (const artifactDir of REVIEW_ARTIFACT_DIRS) {
    for (const fullPath of await listFiles(join(pendingRoot, artifactDir))) {
      const relPath = toPosix(relative(pendingRoot, fullPath));
      const content = new Uint8Array(await readFile(fullPath));
      const entry: PublishFileEntry = {
        path: relPath,
        action: "skip",
        sha256: sha256(content),
      };
      const id = posix.basename(relPath, ".md");
      const baseContent = await git.blob(baseRef, relPath);
      if (artifactDir !== "reconciliation" && isLegacySequentialId(id)) {
        // Sequential ids collide across machines; they land only through
        // --include-legacy, which assigns new ids.
        entry.reason = "legacy-id";
      } else if (bytesEqual(baseContent, content)) {
        entry.reason = "on-base";
      } else if (
        branchExists &&
        bytesEqual(await git.blob(startRef, relPath), content)
      ) {
        entry.reason = "on-branch";
      } else {
        entry.action = baseContent ? "update" : "add";
        writes.set(relPath, content);
      }
      files.push(entry);
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
      if (!known) {
        const taken = await git.blob(baseRef, `${dir}/${newId}.md`);
        if (taken) {
          throw new Error(`Allocated id ${newId} already exists on ${base}`);
        }
      }
      usedIds.add(newId);
      entry.action = "migrate";
      entry.newId = newId;
      entry.target = `${dir}/${newId}.md`;
      writes.set(entry.target, new TextEncoder().encode(rewritten));
      state.migrations[ledgerKey] = {
        ...known,
        legacyId: dirty.legacyId,
        newId,
        target: entry.target,
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

  if (writes.size === 0) {
    result.message = "Nothing to publish.";
    if (!dryRun) {
      await saveState(args.homeDir, state);
    }
    return result;
  }
  if (dryRun) {
    result.message = `Would publish ${writes.size} file(s) to ${remote}/${branch}.`;
    return result;
  }

  const tempDir = await mkdtemp(join(tmpdir(), "fclt-review-publish-"));
  const worktree = join(tempDir, "worktree");
  try {
    await git.ok(["worktree", "add", "--detach", worktree, startRef]);
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
    const push = await git.run(
      ["push", remote, `HEAD:refs/heads/${branch}`],
      worktree
    );
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

  const publishedAt = new Date().toISOString();
  const commit = result.commit ?? "";
  for (const entry of files) {
    if (entry.action !== "skip") {
      state.published[entry.path] = {
        sha256: entry.sha256,
        branch,
        commit,
        publishedAt,
      };
    }
  }
  for (const entry of migrations) {
    const record = state.migrations[`${entry.source}\0${entry.sha256}`];
    if (entry.action === "migrate" && record) {
      record.publishedAt = publishedAt;
      record.commit = commit;
    }
  }
  await saveState(args.homeDir, state);

  if (args.removeMigrated) {
    for (const entry of migrations) {
      if (entry.action !== "migrate") {
        continue;
      }
      const fullPath = join(root, entry.source);
      const current = await readFile(fullPath).catch(() => null);
      if (!current || sha256(current) !== entry.sha256) {
        continue;
      }
      if (entry.sourceState === "untracked") {
        await rm(fullPath);
      } else {
        await git.ok([
          "restore",
          "--source=HEAD",
          "--staged",
          "--worktree",
          "--",
          entry.source,
        ]);
      }
      entry.removed = true;
    }
  }

  if (args.pullRequest === false) {
    result.pullRequestMessage = "Pull request step skipped.";
  } else {
    const remoteUrl = (await git.ok(["remote", "get-url", remote])).trim();
    if (remoteUrl.includes("github.com")) {
      const pr = await findPullRequest({
        root,
        base,
        branch,
        title: "chore(review): publish review records",
        body: "Review records published by `fclt ai writeback publish`. Each record has a collision-free id; merging adds or updates only these review mirrors.",
        gitEnv: publishGitEnvironment(root),
      });
      if (pr.url) {
        result.pullRequest = { url: pr.url, created: pr.created === true };
      }
      result.pullRequestMessage = pr.message;
    } else {
      result.pullRequestMessage = `Remote ${remote} is not on GitHub; open a pull request for ${branch} manually.`;
    }
  }
  result.message = `Published ${writes.size} file(s) to ${remote}/${branch}.`;
  return result;
}
