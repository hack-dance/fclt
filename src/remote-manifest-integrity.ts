import { createHash } from "node:crypto";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const SHA256_TAGGED_HEX_RE = /^sha256:([0-9a-f]{64})$/i;
const SHA256_TAGGED_BASE64_RE = /^sha256-([A-Za-z0-9+/]+={0,2})$/;

export interface ManifestIntegrity {
  algorithm: "sha256";
  encoding: "hex" | "base64";
  value: string;
}

export function parseManifestIntegrity(
  raw: unknown
): ManifestIntegrity | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  const taggedHex = trimmed.match(SHA256_TAGGED_HEX_RE)?.[1];
  if (taggedHex) {
    return {
      algorithm: "sha256",
      encoding: "hex",
      value: taggedHex.toLowerCase(),
    };
  }

  const taggedBase64 = trimmed.match(SHA256_TAGGED_BASE64_RE)?.[1];
  if (taggedBase64) {
    return {
      algorithm: "sha256",
      encoding: "base64",
      value: taggedBase64,
    };
  }

  if (SHA256_HEX_RE.test(trimmed)) {
    return {
      algorithm: "sha256",
      encoding: "hex",
      value: trimmed.toLowerCase(),
    };
  }

  return undefined;
}

function sha256Hex(input: string): string {
  if (typeof Bun !== "undefined" && "CryptoHasher" in Bun) {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(input);
    return hasher.digest("hex");
  }
  return createHash("sha256").update(input).digest("hex");
}

function toBase64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

export function assertManifestIntegrity(args: {
  sourceName: string;
  sourceUrl: string;
  integrity: ManifestIntegrity;
  manifestText: string;
}): void {
  const digestHex = sha256Hex(args.manifestText);
  const digestBase64 = toBase64(digestHex);
  const matched =
    args.integrity.encoding === "hex"
      ? digestHex.toLowerCase() === args.integrity.value.toLowerCase()
      : digestBase64 === args.integrity.value;

  if (matched) {
    return;
  }

  throw new Error(
    `Manifest integrity check failed for source "${args.sourceName}" (${args.sourceUrl}).`
  );
}
