import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  utimes,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { facultStateDir } from "./paths";

export type QuarantineMode = "move" | "copy";

export interface QuarantineItem {
  /** Absolute or relative path to a file or directory. */
  path: string;
  /** Optional label metadata for manifest/debugging. */
  kind?: string;
  item?: string;
}

export interface QuarantineEntry {
  originalPath: string;
  quarantinedPath: string;
  mode: QuarantineMode;
  kind?: string;
  item?: string;
}

export interface QuarantineManifest {
  version: 1;
  timestamp: string;
  entries: QuarantineEntry[];
}

function isSafePathString(p: string): boolean {
  return !p.includes("\0");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(p: string) {
  await mkdir(p, { recursive: true });
}

function isSubpath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || !(rel.startsWith("..") || rel.startsWith(`..${sep}`));
}

function relPathInQuarantine(args: { absPath: string; home: string }): string {
  const { absPath, home } = args;

  // Prefer preserving relative layout under the user's home for readability.
  if (absPath === home) {
    return join("home");
  }
  if (absPath.startsWith(home + sep)) {
    return join("home", absPath.slice(home.length + 1));
  }

  // Fallback: treat as absolute path materialized under "abs/".
  // On Unix, strip leading "/" so join doesn't ignore the prefix.
  if (absPath.startsWith("/")) {
    return join("abs", absPath.slice(1));
  }

  // Last resort: sanitize path-ish strings (e.g. Windows drive letters).
  return join("abs", absPath.replace(/[:\\\\/]+/g, "_"));
}

async function uniqueDestinationPath(p: string): Promise<string> {
  if (!(await pathExists(p))) {
    return p;
  }
  const base = p;
  for (let i = 2; i < 10_000; i += 1) {
    const next = `${base}.dup${i}`;
    if (!(await pathExists(next))) {
      return next;
    }
  }
  throw new Error(`Could not find unique quarantine path for ${p}`);
}

async function copyTree(src: string, dst: string): Promise<void> {
  const st = await lstat(src);

  if (st.isSymbolicLink()) {
    const target = await readlink(src);
    await ensureDir(dirname(dst));
    await symlink(target, dst);
    return;
  }

  if (st.isDirectory()) {
    await ensureDir(dst);
    const entries = await readdir(src, { withFileTypes: true });
    for (const ent of entries) {
      const name = String(ent.name ?? "");
      if (!name) {
        continue;
      }
      await copyTree(join(src, name), join(dst, name));
    }
    const s = await stat(src);
    await utimes(dst, s.atime, s.mtime).catch(() => null);
    return;
  }

  if (st.isFile()) {
    await ensureDir(dirname(dst));
    await copyFile(src, dst);
    const s = await stat(src);
    await utimes(dst, s.atime, s.mtime).catch(() => null);
  }
}

async function movePath(src: string, dst: string): Promise<void> {
  await ensureDir(dirname(dst));
  try {
    await rename(src, dst);
    return;
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException | null;
    if (err?.code !== "EXDEV") {
      throw e;
    }
  }

  // Cross-device move fallback.
  await copyTree(src, dst);
  await rm(src, { recursive: true, force: true });
}

export async function quarantineItems(args: {
  items: QuarantineItem[];
  mode: QuarantineMode;
  dryRun?: boolean;
  timestamp?: string;
  homeDir?: string;
  /** Optional explicit destination directory (for deterministic runs). */
  destDir?: string;
}): Promise<{ quarantineDir: string; manifest: QuarantineManifest }> {
  const home = args.homeDir ?? homedir();
  const ts = args.timestamp ?? new Date().toISOString();
  const stamp = ts.replace(/[:.]/g, "-");
  const quarantineDir =
    args.destDir ?? join(facultStateDir(home), "quarantine", stamp);

  const entries: QuarantineEntry[] = [];

  for (const it of args.items) {
    const raw = it.path;
    const abs = raw.startsWith("/") ? raw : resolve(raw);

    if (!isSafePathString(abs)) {
      continue;
    }

    const rel = relPathInQuarantine({ absPath: abs, home });
    const planned = resolve(quarantineDir, rel);
    if (!isSubpath(quarantineDir, planned)) {
      continue;
    }

    const dst = await uniqueDestinationPath(planned);
    entries.push({
      originalPath: abs,
      quarantinedPath: dst,
      mode: args.mode,
      kind: it.kind,
      item: it.item,
    });
  }

  const manifest: QuarantineManifest = {
    version: 1,
    timestamp: ts,
    entries,
  };

  if (args.dryRun) {
    return { quarantineDir, manifest };
  }

  await ensureDir(quarantineDir);

  for (const e of entries) {
    if (!(await pathExists(e.originalPath))) {
      continue;
    }
    if (args.mode === "move") {
      await movePath(e.originalPath, e.quarantinedPath);
    } else {
      await copyTree(e.originalPath, e.quarantinedPath);
    }
  }

  await Bun.write(
    join(quarantineDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  return { quarantineDir, manifest };
}
