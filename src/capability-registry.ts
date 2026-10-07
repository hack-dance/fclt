import { createHash } from "node:crypto";
import { isAbsolute, posix, win32 } from "node:path";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const ENV = /^env:[A-Z_][A-Z0-9_]*$/;
const OP = /^op:\/\/[A-Za-z0-9._~%/-]+$/;
export type CapabilityKind = "skill" | "plugin" | "mcp";
export interface CapabilitySource {
  origin: string;
  revision: string;
  path?: string;
  sha256?: string;
}
export interface CapabilityOverride {
  host?: string;
  platform?: string;
  enabled?: boolean;
  source?: CapabilitySource;
  target?: string;
}
export interface CapabilityEntry {
  id: string;
  kind: CapabilityKind;
  owner: "fclt" | "external" | "native";
  enabled: boolean;
  source: CapabilitySource;
  target?: string;
  platforms?: string[];
  hosts?: string[];
  requires: string[];
  overrides: CapabilityOverride[];
}
export interface CapabilityRegistry {
  schemaVersion: 1;
  entries: CapabilityEntry[];
}
export function hashCapability(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
export function capabilityObject(
  value: unknown,
  keys: string[]
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a capability object");
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) {
    throw new Error("Unknown capability field");
  }
  return result;
}
function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error("Expected a nonempty capability string");
  }
  return value;
}
export function capabilityRelativePath(value: unknown): string {
  const path = text(value);
  if (
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path.includes("\\") ||
    path.includes(":") ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    posix.normalize(path) !== path
  ) {
    throw new Error("Capability paths must be normalized relative paths");
  }
  return path;
}
function strings(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Expected a nonempty selector array");
  }
  return value.map(text);
}
function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error("enabled must be boolean");
  }
  return value;
}
function origin(value: unknown): string {
  const result = text(value);
  if (result.includes("://")) {
    let url: URL;
    try {
      url = new URL(result);
    } catch {
      throw new Error("Invalid capability origin URL");
    }
    if (
      url.password ||
      (url.username && !(url.protocol === "ssh:" && url.username === "git")) ||
      url.search
    ) {
      throw new Error(
        "Capability origin must not contain credentials or query parameters"
      );
    }
  }
  return result;
}
function source(value: unknown, owned: boolean): CapabilitySource {
  const object = capabilityObject(value, [
    "origin",
    "revision",
    "path",
    "sha256",
  ]);
  const result: CapabilitySource = {
    origin: origin(object.origin),
    revision: text(object.revision),
  };
  if (object.path !== undefined) {
    result.path = capabilityRelativePath(object.path);
  }
  if (object.sha256 !== undefined) {
    result.sha256 = text(object.sha256);
    if (!HASH.test(result.sha256)) {
      throw new Error("Invalid capability source digest");
    }
  }
  if (owned && !(result.path && result.sha256)) {
    throw new Error("fclt ownership requires a pinned source path and sha256");
  }
  return result;
}
function override(value: unknown, owned: boolean): CapabilityOverride {
  const object = capabilityObject(value, [
    "host",
    "platform",
    "enabled",
    "source",
    "target",
  ]);
  if ((object.host === undefined) === (object.platform === undefined)) {
    throw new Error(
      "Each override requires exactly one host or platform selector"
    );
  }
  return {
    ...(object.host === undefined ? {} : { host: text(object.host) }),
    ...(object.platform === undefined
      ? {}
      : { platform: text(object.platform) }),
    ...(object.enabled === undefined
      ? {}
      : { enabled: boolean(object.enabled, true) }),
    ...(object.source === undefined
      ? {}
      : { source: source(object.source, owned) }),
    ...(object.target === undefined
      ? {}
      : { target: capabilityRelativePath(object.target) }),
  };
}
function entry(value: unknown): CapabilityEntry {
  const object = capabilityObject(value, [
    "id",
    "kind",
    "owner",
    "enabled",
    "source",
    "target",
    "platforms",
    "hosts",
    "requires",
    "overrides",
  ]);
  const id = text(object.id);
  if (!ID.test(id)) {
    throw new Error("Invalid capability id");
  }
  if (
    object.kind !== "skill" &&
    object.kind !== "plugin" &&
    object.kind !== "mcp"
  ) {
    throw new Error("Invalid capability kind");
  }
  if (
    object.owner !== "fclt" &&
    object.owner !== "native" &&
    object.owner !== "external"
  ) {
    throw new Error("Invalid capability owner");
  }
  if (object.overrides !== undefined && !Array.isArray(object.overrides)) {
    throw new Error("overrides must be an array");
  }
  const overrides = ((object.overrides ?? []) as unknown[]).map((item) =>
    override(item, object.owner === "fclt")
  );
  const selectors = overrides.map((item) =>
    item.host ? `host:${item.host}` : `platform:${item.platform}`
  );
  if (new Set(selectors).size !== selectors.length) {
    throw new Error("Duplicate capability override");
  }
  if (object.requires !== undefined && !Array.isArray(object.requires)) {
    throw new Error("requires must be an array");
  }
  const requires = ((object.requires ?? []) as unknown[]).map(text);
  if (requires.some((item) => !(ENV.test(item) || OP.test(item)))) {
    throw new Error("Credentials must be env:NAME or op:// references");
  }
  return {
    id,
    kind: object.kind,
    owner: object.owner,
    enabled: boolean(object.enabled, true),
    source: source(object.source, object.owner === "fclt"),
    target:
      object.target === undefined && object.owner !== "fclt"
        ? undefined
        : capabilityRelativePath(object.target),
    platforms: strings(object.platforms),
    hosts: strings(object.hosts),
    requires,
    overrides,
  };
}
export function parseCapabilityRegistry(value: unknown): CapabilityRegistry {
  const object = capabilityObject(value, ["schemaVersion", "entries"]);
  if (object.schemaVersion !== 1 || !Array.isArray(object.entries)) {
    throw new Error("Expected capability registry schemaVersion 1 and entries");
  }
  const entries = object.entries.map(entry);
  if (new Set(entries.map((item) => item.id)).size !== entries.length) {
    throw new Error("Duplicate capability id");
  }
  return { schemaVersion: 1, entries };
}
export function selectCapability(
  entryValue: CapabilityEntry,
  host: string,
  platform: string
): CapabilityEntry {
  let result = { ...entryValue };
  for (const selected of [
    entryValue.overrides.find((item) => item.platform === platform),
    entryValue.overrides.find((item) => item.host === host),
  ]) {
    if (selected) {
      result = {
        ...result,
        ...(selected.enabled === undefined
          ? {}
          : { enabled: selected.enabled }),
        ...(selected.source ? { source: selected.source } : {}),
        ...(selected.target ? { target: selected.target } : {}),
      };
    }
  }
  result.enabled =
    result.enabled &&
    (!result.hosts || result.hosts.includes(host)) &&
    (!result.platforms || result.platforms.includes(platform));
  return result;
}
