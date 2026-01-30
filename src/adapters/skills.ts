import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CanonicalSkill } from "./types";

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

async function skillFromDir(dir: string): Promise<CanonicalSkill | null> {
  const path = join(dir, "SKILL.md");
  try {
    const file = Bun.file(path);
    const st = await file.stat();
    if (!st.isFile()) {
      return null;
    }
    const body = await file.text();
    return {
      name: basename(dir),
      body,
      path: dir,
    };
  } catch {
    return null;
  }
}

export async function parseSkillsDir(
  skillsDir: string
): Promise<CanonicalSkill[]> {
  const dirs = await listSubdirs(skillsDir);
  const out: CanonicalSkill[] = [];
  for (const dir of dirs) {
    const skill = await skillFromDir(dir);
    if (skill) {
      out.push(skill);
    }
  }
  return out;
}
