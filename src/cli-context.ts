import { resolve } from "node:path";
import type { AssetSourceKind } from "./graph";
import {
  facultContextRootDir,
  facultRootDir,
  findNearestProjectAiRoot,
  projectRootFromAiRoot,
} from "./paths";

export type CapabilityScopeMode = "merged" | "global" | "project";

export interface ParsedCliContext {
  argv: string[];
  rootArg?: string;
  scope: CapabilityScopeMode;
  sourceKind?: AssetSourceKind;
}

function missingProjectAiRootMessage(pathValue?: string): string {
  const suffix = pathValue ? `: ${pathValue}` : "";
  return `No project-local .ai root found${suffix}. Run "fclt templates init project-ai" in the repo first, or pass --root <repo>/.ai.`;
}

function expandHomePath(pathValue: string, home: string): string {
  if (pathValue === "~") {
    return home;
  }
  if (pathValue.startsWith("~/")) {
    return `${home}/${pathValue.slice(2)}`;
  }
  return pathValue;
}

function resolveRootArgument(pathValue: string, homeDir: string): string {
  return resolve(expandHomePath(pathValue, homeDir));
}

function parseStringFlagValue(
  arg: string,
  nextArg: string | undefined,
  flag: string
): { value: string; advance: number } | null {
  if (arg === flag) {
    if (!nextArg) {
      throw new Error(`${flag} requires a value`);
    }
    return { value: nextArg, advance: 1 };
  }
  if (arg.startsWith(`${flag}=`)) {
    const value = arg.slice(flag.length + 1);
    if (!value) {
      throw new Error(`${flag} requires a value`);
    }
    return { value, advance: 0 };
  }
  return null;
}

function parseScopeValue(value: string): CapabilityScopeMode {
  if (value === "merged" || value === "global" || value === "project") {
    return value;
  }
  throw new Error(`Unknown scope: ${value}`);
}

function parseSourceValue(value: string): AssetSourceKind {
  if (value === "builtin" || value === "global" || value === "project") {
    return value;
  }
  throw new Error(`Unknown source: ${value}`);
}

export function parseCliContextArgs(
  argv: string[],
  opts?: { allowSource?: boolean; allowScope?: boolean }
): ParsedCliContext {
  const rest: string[] = [];
  let rootArg: string | undefined;
  let scope: CapabilityScopeMode = "merged";
  let sourceKind: AssetSourceKind | undefined;
  let explicitRoot = false;
  let explicitScope = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }

    const root = parseStringFlagValue(arg, argv[i + 1], "--root");
    if (root) {
      if (explicitRoot) {
        throw new Error("--root may only be provided once");
      }
      rootArg = root.value;
      explicitRoot = true;
      i += root.advance;
      continue;
    }

    if (arg === "--global") {
      if (explicitScope && scope !== "global") {
        throw new Error("Conflicting scope flags");
      }
      scope = "global";
      explicitScope = true;
      continue;
    }

    if (arg === "--project") {
      if (explicitScope && scope !== "project") {
        throw new Error("Conflicting scope flags");
      }
      scope = "project";
      explicitScope = true;
      continue;
    }

    if (opts?.allowScope !== false) {
      const parsedScope = parseStringFlagValue(arg, argv[i + 1], "--scope");
      if (parsedScope) {
        const value = parseScopeValue(parsedScope.value);
        if (explicitScope && scope !== value) {
          throw new Error("Conflicting scope flags");
        }
        scope = value;
        explicitScope = true;
        i += parsedScope.advance;
        continue;
      }
    }

    if (opts?.allowSource) {
      const parsedSource = parseStringFlagValue(arg, argv[i + 1], "--source");
      if (parsedSource) {
        sourceKind = parseSourceValue(parsedSource.value);
        i += parsedSource.advance;
        continue;
      }
    }

    rest.push(arg);
  }

  return {
    argv: rest,
    rootArg,
    scope,
    sourceKind,
  };
}

function coerceCanonicalRoot(pathValue: string, homeDir: string): string {
  const resolved = resolveRootArgument(pathValue, homeDir);
  const nearestProjectAi = findNearestProjectAiRoot(resolved);
  if (nearestProjectAi) {
    const projectRoot = projectRootFromAiRoot(nearestProjectAi, homeDir);
    if (
      resolved === nearestProjectAi ||
      resolved === resolve(projectRoot ?? "")
    ) {
      return nearestProjectAi;
    }
  }
  return resolved;
}

export function resolveCliContextRoot(args?: {
  homeDir?: string;
  cwd?: string;
  rootArg?: string;
  scope?: CapabilityScopeMode;
}): string {
  const homeDir = args?.homeDir ?? process.env.HOME ?? "";
  const cwd = args?.cwd ?? process.cwd();
  const scope = args?.scope ?? "merged";

  if (args?.rootArg) {
    const rootDir = coerceCanonicalRoot(args.rootArg, homeDir);
    if (scope === "project" && !projectRootFromAiRoot(rootDir, homeDir)) {
      throw new Error(missingProjectAiRootMessage(rootDir));
    }
    return rootDir;
  }

  if (scope === "global") {
    return facultRootDir(homeDir);
  }

  if (scope === "project") {
    const projectRoot = findNearestProjectAiRoot(cwd);
    if (!projectRoot) {
      throw new Error(missingProjectAiRootMessage(cwd));
    }
    return projectRoot;
  }

  return facultContextRootDir({ home: homeDir, cwd });
}
