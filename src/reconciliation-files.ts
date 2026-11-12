import { isAbsolute } from "node:path";

const PATH_SEGMENT_RE = /[\\/]/;
export const MAX_RECONCILIATION_FILES = 500;
export const MAX_RECONCILIATION_FILE_BYTES = 1_000_000;

/** Use the adapter's bounded selection for both previews and actual scans. */
export async function reconciliationFilePaths(args: {
  root: string;
  patterns: string[];
}): Promise<{ paths: string[]; truncated: boolean }> {
  const paths = new Set<string>();
  for (const pattern of args.patterns) {
    if (
      isAbsolute(pattern) ||
      pattern.split(PATH_SEGMENT_RE).includes("..") ||
      pattern.includes("\0")
    ) {
      throw new Error(`Unsafe reconciliation path pattern: ${pattern}`);
    }
    for await (const path of new Bun.Glob(pattern).scan({
      cwd: args.root,
      onlyFiles: true,
      dot: true,
    })) {
      if (paths.has(path)) {
        continue;
      }
      if (paths.size >= MAX_RECONCILIATION_FILES) {
        return { paths: [...paths].sort(), truncated: true };
      }
      paths.add(path);
    }
  }
  return { paths: [...paths].sort(), truncated: false };
}
