import { basename } from "node:path";
import type { ScanResult } from "../scan";

export interface SkillOccurrence {
  name: string;
  count: number;
  // One entry per appearance, formatted as "<sourceId>:<entryDir>".
  locations: string[];
}

function skillNameFromEntryDir(entryDir: string): string {
  // The skill name is derived from the directory that contains SKILL.md.
  // e.g. /path/to/skills/my-skill -> my-skill
  return basename(entryDir);
}

export function computeSkillOccurrences(res: ScanResult): SkillOccurrence[] {
  const byName = new Map<string, { count: number; locations: Set<string> }>();

  for (const src of res.sources) {
    for (const entryDir of src.skills.entries) {
      const name = skillNameFromEntryDir(entryDir);
      const cur = byName.get(name) ?? {
        count: 0,
        locations: new Set<string>(),
      };
      cur.count += 1;
      cur.locations.add(`${src.id}:${entryDir}`);
      byName.set(name, cur);
    }
  }

  return [...byName.entries()]
    .map(([name, v]) => ({
      name,
      count: v.count,
      locations: [...v.locations].sort(),
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export async function lastModified(p: string): Promise<Date | null> {
  try {
    const st = await Bun.file(p).stat();
    if (st.mtime instanceof Date) {
      return st.mtime;
    }
    if (typeof st.mtimeMs === "number") {
      return new Date(st.mtimeMs);
    }
    return null;
  } catch {
    return null;
  }
}
