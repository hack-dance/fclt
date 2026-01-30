import { claudeCliAdapter } from "./claude-cli";
import { claudeDesktopAdapter } from "./claude-desktop";
import { clawdbotAdapter } from "./clawdbot";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { referenceAdapter } from "./reference";
import type { ResolveVersionOptions, ToolAdapter } from "./types";

const registry = new Map<string, ToolAdapter>();

export function registerAdapter(adapter: ToolAdapter) {
  if (registry.has(adapter.id)) {
    throw new Error(`Adapter already registered: ${adapter.id}`);
  }
  registry.set(adapter.id, adapter);
}

export function getAdapter(id: string): ToolAdapter | undefined {
  return registry.get(id);
}

export function getAllAdapters(): ToolAdapter[] {
  return Array.from(registry.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export function clearAdapters() {
  registry.clear();
}

export async function resolveAdapterVersion(
  adapter: ToolAdapter,
  configPath: string,
  options: ResolveVersionOptions = {}
): Promise<string> {
  const warn = options.warn ?? console.warn;
  const fallback =
    options.fallbackVersion ?? adapter.versions.at(-1) ?? "unknown";

  if (!adapter.detectVersion) {
    warn(
      `Adapter ${adapter.id} has no version detection; using fallback ${fallback}.`
    );
    return fallback;
  }

  const detected = await adapter.detectVersion(configPath);
  if (detected && adapter.versions.includes(detected)) {
    return detected;
  }

  if (detected && !adapter.versions.includes(detected)) {
    warn(
      `Adapter ${adapter.id} detected unsupported version ${detected}; using fallback ${fallback}.`
    );
    return fallback;
  }

  warn(
    `Adapter ${adapter.id} could not detect a version; using fallback ${fallback}.`
  );
  return fallback;
}

registerAdapter(referenceAdapter);
registerAdapter(cursorAdapter);
registerAdapter(codexAdapter);
registerAdapter(claudeCliAdapter);
registerAdapter(claudeDesktopAdapter);
registerAdapter(clawdbotAdapter);
