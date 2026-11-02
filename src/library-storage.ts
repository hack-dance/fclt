import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safeCapabilityPath } from "./capability-files";

export async function atomicLibraryWrite(
  path: string,
  content: string,
  mode = 0o600
) {
  await safeCapabilityPath(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await safeCapabilityPath(path);
  const temporary = join(dirname(path), `.fclt-library-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx", mode });
    await chmod(temporary, mode);
    await safeCapabilityPath(path);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
