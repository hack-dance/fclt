import { randomBytes } from "node:crypto";

/**
 * Writeback (`WB-`) and evolution proposal (`EV-`) ids.
 *
 * Several machines can share one canonical `.ai` repository, so ids must not
 * depend on a machine-local counter. New ids are `<PREFIX>-<YYYYMMDD>-<8 chars>`:
 * the UTC date keeps them roughly time-sortable and readable, and the suffix
 * is 40 random bits in Crockford base32 (no I, L, O or U). Two machines would
 * need to draw the same 40 bits on the same day to collide, and allocation
 * also skips ids already known locally.
 *
 * Legacy sequential ids (`WB-00001`) stay valid everywhere; ids are opaque
 * strings outside this module. Both forms sort correctly with plain string
 * comparison: legacy ids start with `0`, new ids with the year.
 */
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_SUFFIX_LENGTH = 8;
const MAX_ALLOCATION_ATTEMPTS = 32;
const LEGACY_SEQUENTIAL_ID_RE = /^[A-Z]+-\d+$/;
const DATED_ID_RE = /^[A-Z]+-\d{8}-[0-9A-HJKMNP-TV-Z]{8}$/;

export type ArtifactIdPrefix = "WB" | "EV";

let generatorOverride: ((prefix: ArtifactIdPrefix) => string) | null = null;

/** Test seam: make allocation deterministic. Pass null to restore. */
export function setArtifactIdGeneratorForTests(
  generator: ((prefix: ArtifactIdPrefix) => string) | null
): void {
  generatorOverride = generator;
}

/** Deterministic dated ids for tests: `<PREFIX>-20260101-0000000N`. */
export function sequentialTestArtifactIds(): (
  prefix: ArtifactIdPrefix
) => string {
  const counters = new Map<ArtifactIdPrefix, number>();
  return (prefix) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}-20260101-${String(next).padStart(ID_SUFFIX_LENGTH, "0")}`;
  };
}

function utcDateStamp(now: Date): string {
  return now.toISOString().slice(0, 10).replaceAll("-", "");
}

function crockfordSuffix(bytes: Uint8Array): string {
  // 5 bytes = 40 bits, well inside Number's safe integer range.
  let value = 0;
  for (const byte of bytes) {
    value = value * 256 + byte;
  }
  let out = "";
  for (let i = 0; i < ID_SUFFIX_LENGTH; i += 1) {
    out = CROCKFORD_BASE32[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

export function generateArtifactId(
  prefix: ArtifactIdPrefix,
  options?: { now?: Date; random?: (size: number) => Uint8Array }
): string {
  const random = options?.random ?? ((size: number) => randomBytes(size));
  return `${prefix}-${utcDateStamp(options?.now ?? new Date())}-${crockfordSuffix(random(5))}`;
}

/** Allocate a new id, skipping any id for which `isTaken` returns true. */
export function allocateArtifactId(
  prefix: ArtifactIdPrefix,
  isTaken: (id: string) => boolean,
  options?: { now?: Date; random?: (size: number) => Uint8Array }
): string {
  for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
    const id = generatorOverride
      ? generatorOverride(prefix)
      : generateArtifactId(prefix, options);
    if (!isTaken(id)) {
      return id;
    }
  }
  throw new Error(
    `Unable to allocate a unique ${prefix} id after ${MAX_ALLOCATION_ATTEMPTS} attempts`
  );
}

export function isLegacySequentialId(id: string): boolean {
  return LEGACY_SEQUENTIAL_ID_RE.test(id);
}

export function isDatedArtifactId(id: string): boolean {
  return DATED_ID_RE.test(id);
}
