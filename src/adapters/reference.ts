import type { ToolAdapter } from "./types";

async function detectExplicitVersion(
  configPath: string
): Promise<string | null> {
  try {
    const raw = await Bun.file(configPath).text();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const version = parsed.version;
    if (typeof version === "string") {
      return version;
    }
    if (typeof version === "number") {
      return String(version);
    }
  } catch {
    return null;
  }
  return null;
}

export const referenceAdapter: ToolAdapter = {
  id: "reference",
  name: "Reference Adapter",
  versions: ["v1"],
  detectVersion: detectExplicitVersion,
};
