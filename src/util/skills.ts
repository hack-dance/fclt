import * as path from "node:path";
import type { ScanResult } from "../scan";

export type SkillOccurrence = {
  name: string;
  count: number;
  // One entry per appearance, formatted as "<sourceId>:<entryDir>".
  locations: string[];
};

function skillNameFromEntryDir(entryDir: string): string {
  // The skill name is derived from the directory that contains SKILL.md.
  // e.g. /path/to/skills/my-skill -> my-skill
  return path.basename(entryDir);
}

export function computeSkillOccurrences(res: ScanResult): SkillOccurrence[] {
  const byName = new Map<string, { count: number; locations: Set<string> }>();

  for (const src of res.sources) {
    for (const entryDir of src.skills.entries) {
      const name = skillNameFromEntryDir(entryDir);
      const cur = byName.get(name) ?? { count: 0, locations: new Set<string>() };
      cur.count += 1;
      cur.locations.add(`${src.id}:${entryDir}`);
      byName.set(name, cur);
    }
  }

  return [...byName.entries()]
    .map(([name, v]) => ({ name, count: v.count, locations: [...v.locations].sort() }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
