import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const SHA256_TAGGED_HEX_RE = /^sha256:([0-9a-f]{64})$/i;
const SHA256_TAGGED_BASE64_RE = /^sha256-([A-Za-z0-9+/]+={0,2})$/;

export interface ManifestIntegrity {
  algorithm: "sha256";
  encoding: "hex" | "base64";
  value: string;
}

export interface ManifestSignature {
  algorithm: "ed25519";
  value: string;
  keyId?: string;
  publicKey?: string;
  publicKeyPath?: string;
}

export type ManifestSignatureKeyStatus = "active" | "retired" | "revoked";

export interface ManifestSignatureKey {
  id: string;
  status: ManifestSignatureKeyStatus;
  publicKey?: string;
  publicKeyPath?: string;
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function parseManifestSignature(
  raw: unknown
): ManifestSignature | undefined {
  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value) {
      return undefined;
    }
    return {
      algorithm: "ed25519",
      value,
    };
  }

  if (!isPlainObject(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const algorithm =
    typeof obj.algorithm === "string" ? obj.algorithm.trim() : "ed25519";
  if (algorithm !== "ed25519") {
    return undefined;
  }
  const valueRaw =
    typeof obj.value === "string"
      ? obj.value
      : typeof obj.signature === "string"
        ? obj.signature
        : typeof obj.sig === "string"
          ? obj.sig
          : "";
  const value = valueRaw.trim();
  if (!value) {
    return undefined;
  }

  const publicKey =
    typeof obj.publicKey === "string"
      ? obj.publicKey
      : typeof obj.publicKeyPem === "string"
        ? obj.publicKeyPem
        : undefined;
  const keyId =
    typeof obj.keyId === "string"
      ? obj.keyId
      : typeof obj.kid === "string"
        ? obj.kid
        : undefined;
  const publicKeyPath =
    typeof obj.publicKeyPath === "string"
      ? obj.publicKeyPath
      : typeof obj.keyPath === "string"
        ? obj.keyPath
        : undefined;
  return {
    algorithm: "ed25519",
    value,
    keyId: keyId?.trim() || undefined,
    publicKey: publicKey?.trim() || undefined,
    publicKeyPath: publicKeyPath?.trim() || undefined,
  };
}

function parseKeyStatus(raw: unknown): ManifestSignatureKeyStatus {
  if (raw === "revoked") {
    return "revoked";
  }
  if (raw === "retired") {
    return "retired";
  }
  return "active";
}

export function parseManifestSignatureKeys(
  raw: unknown
): ManifestSignatureKey[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const out = new Map<string, ManifestSignatureKey>();
  for (const entry of raw) {
    if (!isPlainObject(entry)) {
      continue;
    }
    const obj = entry as Record<string, unknown>;
    const id =
      typeof obj.id === "string"
        ? obj.id.trim()
        : typeof obj.keyId === "string"
          ? obj.keyId.trim()
          : typeof obj.kid === "string"
            ? obj.kid.trim()
            : "";
    if (!id) {
      continue;
    }

    const publicKey =
      typeof obj.publicKey === "string"
        ? obj.publicKey
        : typeof obj.publicKeyPem === "string"
          ? obj.publicKeyPem
          : undefined;
    const publicKeyPath =
      typeof obj.publicKeyPath === "string"
        ? obj.publicKeyPath
        : typeof obj.keyPath === "string"
          ? obj.keyPath
          : undefined;
    out.set(id, {
      id,
      status: parseKeyStatus(obj.status),
      publicKey: publicKey?.trim() || undefined,
      publicKeyPath: publicKeyPath?.trim() || undefined,
    });
  }
  return Array.from(out.values()).sort((a, b) => a.id.localeCompare(b.id));
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

function decodeBase64(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!(trimmed && BASE64_RE.test(trimmed))) {
    throw new Error("Invalid base64 payload.");
  }
  return Buffer.from(trimmed, "base64");
}

function resolvePath(rawPath: string, cwd: string, homeDir: string): string {
  if (rawPath.startsWith("~/")) {
    return join(homeDir, rawPath.slice(2));
  }
  if (isAbsolute(rawPath)) {
    return rawPath;
  }
  return resolve(cwd, rawPath);
}

async function loadSignaturePublicKeyPem(args: {
  signature: ManifestSignature;
  signatureKeys?: ManifestSignatureKey[];
  cwd: string;
  homeDir: string;
}): Promise<string> {
  const keyId = args.signature.keyId?.trim();
  const keySet = args.signatureKeys ?? [];
  if (keyId) {
    const key = keySet.find((candidate) => candidate.id === keyId);
    if (!key) {
      throw new Error(
        `Manifest signature keyId "${keyId}" was not found in configured keys.`
      );
    }
    if (key.status === "revoked") {
      throw new Error(`Manifest signature keyId "${keyId}" is revoked.`);
    }
    if (key.publicKey?.trim()) {
      return key.publicKey;
    }
    if (key.publicKeyPath?.trim()) {
      const resolved = resolvePath(key.publicKeyPath, args.cwd, args.homeDir);
      return (await readFile(resolved, "utf8")).trim();
    }
    if (args.signature.publicKey?.trim()) {
      return args.signature.publicKey;
    }
    const path = args.signature.publicKeyPath?.trim();
    if (path) {
      const resolved = resolvePath(path, args.cwd, args.homeDir);
      return (await readFile(resolved, "utf8")).trim();
    }
    throw new Error(
      `Manifest signature keyId "${keyId}" does not provide key material.`
    );
  }

  if (args.signature.publicKey?.trim()) {
    return args.signature.publicKey;
  }
  const path = args.signature.publicKeyPath?.trim();
  if (!path) {
    const candidates = keySet.filter(
      (key) =>
        key.status !== "revoked" &&
        Boolean(key.publicKey?.trim() || key.publicKeyPath?.trim())
    );
    if (candidates.length === 1 && candidates[0]) {
      const selected = candidates[0];
      if (selected.publicKey?.trim()) {
        return selected.publicKey;
      }
      const selectedPath = selected.publicKeyPath?.trim();
      if (!selectedPath) {
        throw new Error(
          `Manifest signature key "${selected.id}" does not provide key material.`
        );
      }
      const resolved = resolvePath(selectedPath, args.cwd, args.homeDir);
      return (await readFile(resolved, "utf8")).trim();
    }
    if (candidates.length > 1) {
      throw new Error(
        "Manifest signature matches multiple configured keys; set signature.keyId."
      );
    }
    throw new Error(
      "Manifest signature requires publicKey/publicKeyPath or configured signature keys."
    );
  }
  const resolved = resolvePath(path, args.cwd, args.homeDir);
  return (await readFile(resolved, "utf8")).trim();
}

function publicKeyObjectFromInput(publicKeyPem: string) {
  const trimmed = publicKeyPem.trim();
  if (trimmed.includes("BEGIN PUBLIC KEY")) {
    return createPublicKey(trimmed);
  }
  const der = decodeBase64(trimmed);
  return createPublicKey({
    key: der,
    format: "der",
    type: "spki",
  });
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

export async function assertManifestSignature(args: {
  sourceName: string;
  sourceUrl: string;
  signature: ManifestSignature;
  signatureKeys?: ManifestSignatureKey[];
  manifestText: string;
  cwd: string;
  homeDir: string;
}): Promise<void> {
  const publicKeyPem = await loadSignaturePublicKeyPem({
    signature: args.signature,
    signatureKeys: args.signatureKeys,
    cwd: args.cwd,
    homeDir: args.homeDir,
  });
  const publicKey = publicKeyObjectFromInput(publicKeyPem);
  const signatureBytes = decodeBase64(args.signature.value);
  const verified = verify(
    null,
    Buffer.from(args.manifestText),
    publicKey,
    signatureBytes
  );
  if (verified) {
    return;
  }
  throw new Error(
    `Manifest signature check failed for source "${args.sourceName}" (${args.sourceUrl}).`
  );
}
