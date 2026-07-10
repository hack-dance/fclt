import { dirname, join, resolve } from "node:path";

const LOCAL_GIT_ENVIRONMENT_NAMES = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_NAMESPACE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
]);

function isLocalGitEnvironmentName(name: string): boolean {
  return (
    LOCAL_GIT_ENVIRONMENT_NAMES.has(name) ||
    name.startsWith("GIT_CONFIG_KEY_") ||
    name.startsWith("GIT_CONFIG_VALUE_")
  );
}

export function withoutLocalGitEnvironment(
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !isLocalGitEnvironmentName(name)) {
      sanitized[name] = value;
    }
  }
  return sanitized;
}

export function gitEnvironmentForRepository(args: {
  repoDir: string;
  env?: NodeJS.ProcessEnv;
  isolatedHome?: string;
}): Record<string, string> {
  const repoDir = resolve(args.repoDir);
  const env = withoutLocalGitEnvironment(args.env);
  env.GIT_CEILING_DIRECTORIES = dirname(repoDir);
  env.GIT_DISCOVERY_ACROSS_FILESYSTEM = "0";

  if (args.isolatedHome) {
    const home = resolve(args.isolatedHome);
    env.HOME = home;
    env.XDG_CONFIG_HOME = join(home, ".config");
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  } else {
    const sourceEnv = args.env ?? process.env;
    for (const name of [
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
      "GIT_CONFIG_NOSYSTEM",
    ]) {
      const value = sourceEnv[name];
      if (value !== undefined) {
        env[name] = value;
      }
    }
  }

  return env;
}
