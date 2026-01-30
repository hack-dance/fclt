export const SNIPPET_MARKER_RE = /<!--\s*(\/?)tb:([^>]*?)\s*-->/g;

const VALID_MARKER_NAME_RE = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const WHITESPACE_RE = /\s/;
const NEWLINE_SPLIT_RE = /\r?\n/;

export function validateSnippetMarkerName(name: string): string | null {
  if (!name) {
    return "Marker name cannot be empty.";
  }

  if (name.trim() !== name) {
    return "Marker name cannot have leading or trailing whitespace.";
  }

  if (WHITESPACE_RE.test(name)) {
    return "Marker name cannot contain whitespace.";
  }

  if (name.startsWith("/") || name.endsWith("/")) {
    return "Marker name cannot start or end with '/'";
  }

  if (name.includes("..")) {
    return "Marker name cannot contain '..' (path traversal).";
  }

  if (name.includes("//")) {
    return "Marker name cannot contain empty path segments ('//').";
  }

  if (!VALID_MARKER_NAME_RE.test(name)) {
    return "Marker name may only contain letters, numbers, '-', '_', and '/' for scoping.";
  }

  return null;
}

function lineNumberAt(text: string, index: number): number {
  if (index <= 0) {
    return 1;
  }
  return text.slice(0, index).split(NEWLINE_SPLIT_RE).length;
}

export function validateSnippetMarkersInText(
  text: string,
  filePath?: string
): string[] {
  const errors: string[] = [];
  for (const match of text.matchAll(SNIPPET_MARKER_RE)) {
    const rawName = match[2] ?? "";
    const name = rawName.trim();
    const err = validateSnippetMarkerName(name);
    if (!err) {
      continue;
    }
    const line = lineNumberAt(text, match.index ?? 0);
    const location = filePath ? `${filePath}:${line}` : `line ${line}`;
    errors.push(
      `${location}: invalid snippet marker name "${rawName}": ${err}`
    );
  }
  return errors;
}
