import { parse as parseJsonc } from "jsonc-parser";

type JsoncParseError = { error: number; offset: number; length: number };

/**
 * Parse JSON, falling back to JSONC (comments + trailing commas).
 *
 * This is mainly needed for VS Code-like settings files (`settings.json`) which
 * are commonly JSONC.
 */
export function parseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // fall through to JSONC
  }

  const errors: JsoncParseError[] = [];
  const value = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length) {
    const first = errors[0];
    throw new Error(
      `JSONC Parse error at offset ${first?.offset ?? 0} (code ${first?.error ?? "unknown"})`
    );
  }

  return value as unknown;
}
