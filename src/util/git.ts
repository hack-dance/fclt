import { realpath } from "node:fs/promises";
import { dirname, relative } from "node:path";

export type GitPathExposure =
  | {
      insideRepo: false;
      repoRoot: null;
      state: "outside-repo";
    }
  | {
      insideRepo: true;
      repoRoot: string;
      state: "tracked" | "ignored" | "untracked";
    };

async function runGit(
  args: string[],
  cwd: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const gitBinary = Bun.which("git") ?? "/usr/bin/git";
  const proc = Bun.spawn({
    cmd: [gitBinary, ...args],
    cwd,
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

async function resolveGitRepoRoot(pathValue: string): Promise<string | null> {
  const cwd = dirname(pathValue);
  const result = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (result.exitCode !== 0) {
    return null;
  }
  const repoRoot = result.stdout.trim();
  if (!repoRoot) {
    return null;
  }
  return await realpath(repoRoot).catch(() => repoRoot);
}

export async function getGitPathExposure(
  pathValue: string
): Promise<GitPathExposure> {
  const repoRoot = await resolveGitRepoRoot(pathValue);
  if (!repoRoot) {
    return {
      insideRepo: false,
      repoRoot: null,
      state: "outside-repo",
    };
  }

  const resolvedPath = await realpath(pathValue).catch(() => pathValue);
  const repoRelativePath = relative(repoRoot, resolvedPath);
  if (
    !repoRelativePath ||
    repoRelativePath === "" ||
    repoRelativePath.startsWith("../")
  ) {
    return {
      insideRepo: false,
      repoRoot: null,
      state: "outside-repo",
    };
  }

  const tracked = await runGit(
    ["ls-files", "--error-unmatch", "--", repoRelativePath],
    repoRoot
  );
  if (tracked.exitCode === 0) {
    return {
      insideRepo: true,
      repoRoot,
      state: "tracked",
    };
  }

  const ignored = await runGit(
    ["check-ignore", "-q", "--", repoRelativePath],
    repoRoot
  );
  return {
    insideRepo: true,
    repoRoot,
    state: ignored.exitCode === 0 ? "ignored" : "untracked",
  };
}
