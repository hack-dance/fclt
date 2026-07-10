import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { gitEnvironmentForRepository } from "../src/util/git-environment";

export async function runFixtureGit(args: {
  argv: string[];
  repoDir: string;
  homeDir: string;
  cwd?: string;
}): Promise<string> {
  await mkdir(args.homeDir, { recursive: true });
  const proc = Bun.spawn({
    cmd: ["git", ...args.argv],
    cwd: args.cwd ?? dirname(args.repoDir),
    env: gitEnvironmentForRepository({
      repoDir: args.repoDir,
      isolatedHome: args.homeDir,
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      [`git ${args.argv.join(" ")} failed`, stdout.trim(), stderr.trim()]
        .filter(Boolean)
        .join("\n")
    );
  }
  return stdout.trim();
}
