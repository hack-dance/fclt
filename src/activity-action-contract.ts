import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import type { AiProposalRecord } from "./ai";
import type { LoopQueueItem } from "./evolution-loop";
import { machineStateProjectKey, machineStateProjectScopeId } from "./paths";

export const ACTIVITY_ACTION_LOCATOR_VERSION = 1 as const;
export const ACTIVITY_ACTION_LOCATOR_PATTERN =
  /^fclt-act-v(\d+)\.([a-f0-9]{64})\.([a-f0-9]{64})$/;
const ACTIVITY_ACTION_LOCATOR_VERSION_PREFIX_PATTERN = /^fclt-act-v(\d+)[.:]/;

export type ActivityActionClass =
  | "review"
  | "decide"
  | "apply"
  | "verify"
  | "handoff";

export type ActivityActionResourceKind = "proposal" | "signal" | "coverage";

export interface ActivityActionScopeBinding {
  scope: "global" | "project";
  scopeId: string;
  runtimeIdentity: string;
}

export function activityActionRootIdentity(rootDir: string): string | null {
  try {
    const lexical = lstatSync(rootDir);
    if (!lexical.isDirectory() || lexical.isSymbolicLink()) {
      return null;
    }
    const canonicalPath = realpathSync(rootDir);
    const canonical = lstatSync(canonicalPath);
    if (!canonical.isDirectory() || canonical.isSymbolicLink()) {
      return null;
    }
    return createHash("sha256")
      .update(
        JSON.stringify({
          canonicalPath,
          device: String(canonical.dev),
          inode: String(canonical.ino),
        })
      )
      .digest("hex");
  } catch {
    return null;
  }
}

export interface ActivityActionLocatorCandidate {
  actionClass: ActivityActionClass;
  bindingDigest: string;
  identityDigest: string;
  locator: string;
  queueRevision: number;
  resourceId: string;
  resourceKind: ActivityActionResourceKind;
}

export function activityActionScopeBinding(args: {
  homeDir: string;
  rootDir: string;
  runtimeId: string;
  scope: "global" | "project";
}): ActivityActionScopeBinding | null {
  const rootIdentity = activityActionRootIdentity(args.rootDir);
  if (!rootIdentity) {
    return null;
  }
  const runtimeIdentity = createHash("sha256")
    .update(`${args.runtimeId}:${rootIdentity}`)
    .digest("hex");
  if (args.scope === "global") {
    return {
      scope: "global",
      scopeId: "global",
      runtimeIdentity,
    };
  }
  const machineKey = machineStateProjectKey(args.rootDir, args.homeDir);
  return {
    scope: "project",
    scopeId: machineStateProjectScopeId(machineKey),
    runtimeIdentity,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value
      .map((entry) => (entry === undefined ? "null" : canonicalJson(entry)))
      .join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function resourceIdentity(item: LoopQueueItem): {
  id: string;
  kind: ActivityActionResourceKind;
} {
  if (item.proposalId) {
    return { id: item.proposalId, kind: "proposal" };
  }
  if (item.kind === "coverage") {
    return { id: item.id, kind: "coverage" };
  }
  return { id: item.familyId ?? item.id, kind: "signal" };
}

export function activityActionClass(args: {
  item: LoopQueueItem;
  proposal?: AiProposalRecord | null;
}): ActivityActionClass | null {
  if (args.item.state === "resolved" || args.item.state === "deferred") {
    return null;
  }
  if (!args.item.proposalId) {
    return "handoff";
  }
  if (!args.proposal) {
    return null;
  }
  if (args.proposal.status === "proposed") {
    return "review";
  }
  if (
    args.proposal.status === "drafted" ||
    args.proposal.status === "in_review"
  ) {
    return "decide";
  }
  if (args.proposal.status === "accepted") {
    return "apply";
  }
  if (args.proposal.status === "applied") {
    return "verify";
  }
  return "handoff";
}

export function createActivityActionLocator(args: {
  item: LoopQueueItem;
  proposal?: AiProposalRecord | null;
  runId: string;
  scope: ActivityActionScopeBinding;
}): ActivityActionLocatorCandidate | null {
  const actionClass = activityActionClass({
    item: args.item,
    proposal: args.proposal,
  });
  if (!actionClass) {
    return null;
  }
  const resource = resourceIdentity(args.item);
  const identityDigest = digest({
    version: ACTIVITY_ACTION_LOCATOR_VERSION,
    scopeId: args.scope.scopeId,
    resource,
  });
  const resourceRevision = digest(
    resource.kind === "proposal"
      ? (args.proposal ?? { id: resource.id, missing: true })
      : args.item
  );
  const bindingDigest = digest({
    version: ACTIVITY_ACTION_LOCATOR_VERSION,
    identityDigest,
    runtimeIdentity: args.scope.runtimeIdentity,
    runId: args.runId,
    queueRevision: args.item.revision,
    resourceRevision,
    actionClass,
  });
  return {
    actionClass,
    bindingDigest,
    identityDigest,
    locator: `fclt-act-v${ACTIVITY_ACTION_LOCATOR_VERSION}.${identityDigest}.${bindingDigest}`,
    queueRevision: args.item.revision,
    resourceId: resource.id,
    resourceKind: resource.kind,
  };
}

export function parseActivityActionLocator(locator: string):
  | {
      ok: true;
      version: 1;
      identityDigest: string;
      bindingDigest: string;
    }
  | {
      ok: false;
      code: "invalid_locator" | "incompatible_locator";
      message: string;
    } {
  const match = ACTIVITY_ACTION_LOCATOR_PATTERN.exec(locator);
  if (!match) {
    const versionMatch =
      ACTIVITY_ACTION_LOCATOR_VERSION_PREFIX_PATTERN.exec(locator);
    if (versionMatch && Number(versionMatch[1]) !== 1) {
      return {
        ok: false,
        code: "incompatible_locator",
        message: `Unsupported activity action locator version: ${versionMatch[1]}`,
      };
    }
    return {
      ok: false,
      code: "invalid_locator",
      message: "The activity action locator is malformed.",
    };
  }
  const [, version, identityDigest, bindingDigest] = match;
  if (version !== "1") {
    return {
      ok: false,
      code: "incompatible_locator",
      message: `Unsupported activity action locator version: ${version}`,
    };
  }
  if (!(identityDigest && bindingDigest)) {
    return {
      ok: false,
      code: "invalid_locator",
      message: "The activity action locator is malformed.",
    };
  }
  return {
    ok: true,
    version: 1,
    identityDigest,
    bindingDigest,
  };
}
