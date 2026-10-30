import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import {
  pathIsInsideOrEqual,
  pathIsPhysicallyInsideOrEqual,
  pathsPhysicallyEquivalent,
} from "./paths";

export interface AiSourcePaths {
  sourceRoot?: string;
  sourceHome?: string;
}

let accountHome: string | undefined;

/** Bun caches HOME at startup even in userInfo(); consult the OS account database. */
export function realUserHome(): string {
  if (accountHome) {
    return accountHome;
  }
  if (!process.versions.bun || process.platform === "win32") {
    accountHome = userInfo().homedir;
    return accountHome;
  }
  const uid = String(process.getuid!());
  const command =
    process.platform === "darwin"
      ? ["/usr/bin/dscacheutil", "-q", "user", "-a", "uid", uid]
      : ["getent", "passwd", uid];
  const result = spawnSync(command[0]!, command.slice(1), {
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const output = result.status === 0 ? result.stdout : "";
  const home =
    process.platform === "darwin"
      ? output
          .split("\n")
          .find((line) => line.startsWith("dir: "))
          ?.slice(5)
          .trim()
      : output.trim().split(":")[5];
  const fallback =
    home ||
    readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .map((line) => line.split(":"))
      .find((fields) => fields[2] === uid)?.[5];
  if (!fallback) {
    throw new Error(
      "Cannot determine the real user home from the OS account database"
    );
  }
  accountHome = fallback;
  return accountHome;
}

export function allowEphemeralAiPaths(explicit?: boolean): boolean {
  return explicit ?? process.env.FCLT_ALLOW_EPHEMERAL_AI_PATHS === "1";
}

export function aiPathSafetyIssue(args: {
  homeDir: string;
  paths: string[];
  sourceHome?: string;
}): string | undefined {
  const realHome = realUserHome();
  for (const home of [args.homeDir, args.sourceHome].filter(
    (value): value is string => Boolean(value)
  )) {
    if (!pathsPhysicallyEquivalent(home, realHome)) {
      return "HOME differs from the real user home";
    }
  }
  const temporaryRoots = [
    tmpdir(),
    process.env.TMPDIR,
    ...(process.platform === "win32"
      ? []
      : [
          "/tmp",
          "/private/tmp",
          "/var/tmp",
          "/private/var/tmp",
          "/var/folders",
          "/private/var/folders",
        ]),
  ].filter((value): value is string => Boolean(value));
  for (const path of args.paths) {
    try {
      if (
        temporaryRoots.some(
          (root) =>
            pathIsInsideOrEqual(path, root) ||
            pathIsPhysicallyInsideOrEqual(path, root)
        )
      ) {
        return `path is under an OS temporary directory: ${path}`;
      }
    } catch (error) {
      return `cannot verify physical path ${path}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return undefined;
}
