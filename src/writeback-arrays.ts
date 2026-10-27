import { AsyncLocalStorage } from "node:async_hooks";

export const writebackWarnings = new AsyncLocalStorage<Set<string>>();

interface WritebackArrays {
  id?: string;
  evidence?: unknown[];
  tags?: string[];
  issueLinks?: string[];
}

/** Normalize persisted arrays without changing the queue or its latest-entry selection. */
export function normalizeWritebackArrays<T extends WritebackArrays>(
  entry: T,
  warnings?: string[]
): T {
  const malformed = (["evidence", "tags", "issueLinks"] as const).filter(
    (field) => {
      const value = entry[field];
      return !(
        Array.isArray(value) ||
        (field === "issueLinks" && value === undefined)
      );
    }
  );
  if (malformed.length === 0) {
    return entry;
  }
  const warning = `Writeback ${entry.id}: missing or non-array ${malformed.join(", ")}; treating as empty arrays.`;
  warnings?.push(warning);
  const reported = writebackWarnings.getStore();
  const key = entry.id ?? warning;
  if (!reported?.has(key)) {
    console.error(`Warning: ${warning}`);
    reported?.add(key);
  }
  return {
    ...entry,
    evidence: Array.isArray(entry.evidence) ? entry.evidence : [],
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    issueLinks: Array.isArray(entry.issueLinks) ? entry.issueLinks : [],
  };
}
