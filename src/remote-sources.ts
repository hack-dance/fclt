import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { facultStateDir } from "./paths";
import {
  type ManifestSignature,
  type ManifestSignatureKey,
  parseManifestIntegrity,
  parseManifestSignature,
  parseManifestSignatureKeys,
} from "./remote-manifest-integrity";
import {
  BUILTIN_INDEX_NAME,
  BUILTIN_INDEX_URL,
  type IndexSource,
  KNOWN_PROVIDER_SOURCES,
} from "./remote-types";
import { parseJsonLenient } from "./util/json";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Bun.file(path).stat();
    return true;
  } catch {
    return false;
  }
}

function parseEntrySignature(
  entry: Record<string, unknown>
): ManifestSignature | undefined {
  if (isPlainObject(entry.signature) || typeof entry.signature === "string") {
    return parseManifestSignature(entry.signature);
  }
  const synthetic = {
    algorithm: entry.signatureAlgorithm,
    value: entry.sig ?? entry.signature,
    keyId: entry.keyId ?? entry.signatureKeyId ?? entry.kid,
    publicKey: entry.publicKey,
    publicKeyPath: entry.publicKeyPath ?? entry.keyPath,
  };
  return parseManifestSignature(synthetic);
}

function mergeSignatureKeys(
  globalKeys: ManifestSignatureKey[],
  sourceKeys: ManifestSignatureKey[]
): ManifestSignatureKey[] {
  const merged = new Map<string, ManifestSignatureKey>();
  for (const key of globalKeys) {
    merged.set(key.id, key);
  }
  for (const key of sourceKeys) {
    merged.set(key.id, key);
  }
  return Array.from(merged.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export async function readIndexSources(
  home: string,
  cwd: string
): Promise<IndexSource[]> {
  const out: IndexSource[] = [
    { name: BUILTIN_INDEX_NAME, url: BUILTIN_INDEX_URL, kind: "builtin" },
  ];
  const configPath = resolve(facultStateDir(home), "indices.json");
  if (!(await fileExists(configPath))) {
    return out;
  }

  try {
    const parsed = parseJsonLenient(await readFile(configPath, "utf8"));
    if (!isPlainObject(parsed)) {
      return out;
    }
    const obj = parsed as Record<string, unknown>;
    const globalKeys = parseManifestSignatureKeys(
      obj.signatureKeys ?? obj.trustedKeys ?? obj.keys
    );
    const candidateLists: unknown[] = [obj.indices, obj.sources];
    for (const list of candidateLists) {
      if (!Array.isArray(list)) {
        continue;
      }
      for (const entry of list) {
        if (!isPlainObject(entry)) {
          continue;
        }
        const name = typeof entry.name === "string" ? entry.name.trim() : "";
        if (!name) {
          continue;
        }
        const provider =
          typeof entry.provider === "string" ? entry.provider.trim() : "";
        const providerDefault = provider
          ? KNOWN_PROVIDER_SOURCES[provider]
          : undefined;
        const rawUrl = typeof entry.url === "string" ? entry.url.trim() : "";
        const integrity = parseManifestIntegrity(
          entry.integrity ?? entry.checksum
        );
        const signature = parseEntrySignature(entry);
        const sourceKeys = parseManifestSignatureKeys(
          entry.signatureKeys ?? entry.trustedKeys ?? entry.keys
        );
        const signatureKeys = mergeSignatureKeys(globalKeys, sourceKeys);

        if (providerDefault) {
          out.push({
            name,
            kind: providerDefault.kind,
            url: rawUrl || providerDefault.url,
            integrity,
            signature,
            signatureKeys: signatureKeys.length ? signatureKeys : undefined,
          });
          continue;
        }

        if (!rawUrl) {
          continue;
        }
        const resolvedUrl =
          rawUrl.startsWith("http://") ||
          rawUrl.startsWith("https://") ||
          rawUrl.startsWith("file://") ||
          isAbsolute(rawUrl)
            ? rawUrl
            : resolve(cwd, rawUrl);
        out.push({
          name,
          url: resolvedUrl,
          kind: "manifest",
          integrity,
          signature,
          signatureKeys: signatureKeys.length ? signatureKeys : undefined,
        });
      }
    }
  } catch {
    // Ignore malformed index config and keep builtin defaults.
  }

  const dedup = new Map<string, IndexSource>();
  for (const source of out) {
    dedup.set(source.name, source);
  }
  return Array.from(dedup.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

export function resolveKnownIndexSource(name: string): IndexSource | null {
  const source = KNOWN_PROVIDER_SOURCES[name];
  if (!source) {
    return null;
  }
  return { ...source };
}
