import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import {
  facultAiReconciliationConfigPath,
  projectRootFromAiRoot,
} from "./paths";
import type {
  FileSourceConfig,
  GitSourceConfig,
  LinearSourceConfig,
  ReconciliationConfig,
  ReconciliationSourceConfig,
} from "./reconciliation-types";

const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const ENVIRONMENT_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const PATH_SEGMENT_RE = /[\\/]/;
const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertKnownFields(
  value: Record<string, unknown>,
  allowed: string[],
  context: string
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${context} has unknown fields: ${unknown.join(", ")}`);
  }
}

function validateId(value: unknown): string {
  if (typeof value !== "string" || !SOURCE_ID_RE.test(value)) {
    throw new Error(
      "Reconciliation source ids must use letters, numbers, dots, dashes, or underscores"
    );
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new Error(`${field} must be a non-empty string array`);
  }
  return value.map((entry) => String(entry).trim());
}

function parseSource(value: unknown): ReconciliationSourceConfig {
  if (!isPlainObject(value)) {
    throw new Error("Reconciliation sources must be objects");
  }
  const id = validateId(value.id);
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error(`Reconciliation source ${id} enabled must be boolean`);
  }
  const enabled = value.enabled !== false;
  if (value.type === "writebacks") {
    assertKnownFields(
      value,
      ["id", "type", "enabled", "scope"],
      `Writeback source ${id}`
    );
    if (
      value.scope !== undefined &&
      value.scope !== "context" &&
      value.scope !== "global"
    ) {
      throw new Error(`Writeback source ${id} scope must be context or global`);
    }
    return {
      id,
      type: "writebacks",
      enabled,
      scope: value.scope ?? "context",
    };
  }
  if (value.type === "git") {
    assertKnownFields(
      value,
      ["id", "type", "enabled", "repository", "paths", "allBranches"],
      `Git source ${id}`
    );
    const source: GitSourceConfig = { id, type: "git", enabled };
    if (value.repository !== undefined && value.repository !== "project") {
      throw new Error(`Git source ${id} repository must be project`);
    }
    if (value.paths !== undefined) {
      source.paths = stringArray(value.paths, `Git source ${id} paths`);
      for (const path of source.paths) {
        if (
          isAbsolute(path) ||
          path.split(PATH_SEGMENT_RE).includes("..") ||
          path.includes("\0")
        ) {
          throw new Error(
            `Git source ${id} path must stay inside the project: ${path}`
          );
        }
      }
    }
    if (value.allBranches !== undefined) {
      source.allBranches = value.allBranches === true;
    }
    return source;
  }
  if (value.type === "linear") {
    assertKnownFields(
      value,
      [
        "id",
        "type",
        "enabled",
        "endpoint",
        "teamKey",
        "tokenEnv",
        "exportPath",
      ],
      `Linear source ${id}`
    );
    const source: LinearSourceConfig = { id, type: "linear", enabled };
    for (const field of [
      "endpoint",
      "teamKey",
      "tokenEnv",
      "exportPath",
    ] as const) {
      const fieldValue = value[field];
      if (fieldValue !== undefined) {
        if (typeof fieldValue !== "string" || !fieldValue.trim()) {
          throw new Error(
            `Linear source ${id} ${field} must be a non-empty string`
          );
        }
        source[field] = fieldValue.trim();
      }
    }
    if (source.tokenEnv && !ENVIRONMENT_NAME_RE.test(source.tokenEnv)) {
      throw new Error(
        `Linear source ${id} tokenEnv must name an environment variable`
      );
    }
    if (source.endpoint && source.endpoint !== LINEAR_GRAPHQL_ENDPOINT) {
      throw new Error(
        `Linear source ${id} endpoint must be ${LINEAR_GRAPHQL_ENDPOINT}`
      );
    }
    if (!(source.exportPath || (source.teamKey && source.tokenEnv))) {
      throw new Error(
        `Linear source ${id} requires teamKey and tokenEnv unless exportPath is configured`
      );
    }
    return source;
  }
  if (value.type === "automation" || value.type === "markdown") {
    assertKnownFields(
      value,
      ["id", "type", "enabled", "root", "paths"],
      `${value.type} source ${id}`
    );
    const root =
      value.root ?? (value.type === "automation" ? "home" : "project");
    if (root !== "home" && root !== "project") {
      throw new Error(
        `${value.type} source ${id} root must be home or project`
      );
    }
    const source: FileSourceConfig = {
      id,
      type: value.type,
      enabled,
      root,
      paths: stringArray(value.paths, `${value.type} source ${id} paths`),
    };
    return source;
  }
  throw new Error(
    `Unsupported reconciliation source type: ${String(value.type)}`
  );
}

export function defaultReconciliationConfig(args: {
  homeDir: string;
  rootDir: string;
}): ReconciliationConfig {
  const sources: ReconciliationSourceConfig[] = [
    { id: "writebacks", type: "writebacks", enabled: true },
  ];
  if (projectRootFromAiRoot(args.rootDir, args.homeDir)) {
    sources.push({
      id: "git",
      type: "git",
      enabled: true,
      repository: "project",
      allBranches: true,
      paths: [".ai", "AGENTS.md", "docs"],
    });
  }
  return { version: 1, sources };
}

export function parseReconciliationConfig(
  value: unknown
): ReconciliationConfig {
  if (
    !isPlainObject(value) ||
    value.version !== 1 ||
    !Array.isArray(value.sources)
  ) {
    throw new Error(
      "Reconciliation config must have version 1 and a sources array"
    );
  }
  assertKnownFields(value, ["version", "sources"], "Reconciliation config");
  const sources = value.sources.map(parseSource);
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) {
      throw new Error(`Duplicate reconciliation source id: ${source.id}`);
    }
    ids.add(source.id);
  }
  return { version: 1, sources };
}

export async function loadReconciliationConfig(args: {
  homeDir: string;
  rootDir: string;
  configPath?: string;
}): Promise<{ config: ReconciliationConfig; path: string }> {
  const path =
    args.configPath ??
    facultAiReconciliationConfigPath(args.homeDir, args.rootDir);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(
      `Reconciliation config not found: ${path}. Run fclt ai review init.`
    );
  }
  return {
    config: parseReconciliationConfig(JSON.parse(await file.text())),
    path,
  };
}

export async function initializeReconciliationConfig(args: {
  homeDir: string;
  rootDir: string;
  dryRun?: boolean;
}): Promise<{ path: string; created: boolean; config: ReconciliationConfig }> {
  const path = facultAiReconciliationConfigPath(args.homeDir, args.rootDir);
  const config = defaultReconciliationConfig(args);
  if (await Bun.file(path).exists()) {
    return {
      path,
      created: false,
      config: parseReconciliationConfig(
        JSON.parse(await Bun.file(path).text())
      ),
    };
  }
  if (!args.dryRun) {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
  }
  return { path, created: true, config };
}
