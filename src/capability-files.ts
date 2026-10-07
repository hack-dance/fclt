import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { caseFold } from "unicode-case-folding";
import { hashCapability } from "./capability-registry";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_NODES = 4096;
export interface CapabilityNode {
  path: string;
  kind: "file" | "directory";
  executable: boolean;
  content?: Buffer;
}
export interface CapabilitySnapshot {
  hash: string;
  nodes: CapabilityNode[];
}
export function capabilityCollisionPath(path: string): string {
  return caseFold(resolve(path).normalize("NFC"));
}
export function pathsOverlap(first: string, second: string): boolean {
  const a = capabilityCollisionPath(first);
  const b = capabilityCollisionPath(second);
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}
/** Reject symlink ancestors, including missing-tail paths, before reads or writes. */
export async function safeCapabilityPath(path: string): Promise<string> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = await optionalStat(current);
    if (stat?.isSymbolicLink()) {
      throw new Error("Capability path contains a symlink ancestor");
    }
    if (stat && current !== absolute && !stat.isDirectory()) {
      throw new Error("Capability ancestor is not a directory");
    }
  }
  return absolute;
}
export async function optionalStat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
export async function capabilityRoot(path: string): Promise<string> {
  // The explicitly supplied root may itself be a platform alias (/tmp on macOS).
  // Descendants are still checked without following links.
  const absolute = resolve(path);
  let existing = absolute;
  while (!(await optionalStat(existing))) {
    existing = dirname(existing);
  }
  const physical = await realpath(existing);
  return safeCapabilityPath(resolve(physical, relative(existing, absolute)));
}
/** Snapshot regular files only; neither nested symlinks nor special files are copied. */
export async function snapshotCapability(
  path: string
): Promise<CapabilitySnapshot | null> {
  await safeCapabilityPath(dirname(path));
  if (!(await optionalStat(path))) {
    return null;
  }
  const nodes: CapabilityNode[] = [];
  let totalBytes = 0;
  async function visit(current: string, name: string): Promise<void> {
    const stat = await lstat(current);
    if (nodes.length >= MAX_NODES) {
      throw new Error("Capability exceeds node limit");
    }
    if (stat.isDirectory()) {
      nodes.push({ path: name, kind: "directory", executable: false });
      const children = (await readdir(current)).sort();
      if (
        children.some((child) =>
          ["node_modules", "__pycache__", ".git", ".local", ".env"].includes(
            child
          )
        )
      ) {
        throw new Error(
          "Capability contains runtime or private material; prepare a clean source snapshot"
        );
      }
      const folded = children.map((child) => caseFold(child.normalize("NFC")));
      if (new Set(folded).size !== children.length) {
        throw new Error("Capability has case-colliding paths");
      }
      for (const child of children) {
        const normalizedChild = child.normalize("NFC");
        await visit(
          join(current, child),
          name ? `${name}/${normalizedChild}` : normalizedChild
        );
      }
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error("Capability contains a link or special file");
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_BYTES) {
      throw new Error("Capability exceeds byte limit");
    }
    const handle = await open(
      current,
      // biome-ignore lint/suspicious/noBitwiseOperators: combine filesystem open flags
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.ino !== stat.ino ||
        before.dev !== stat.dev ||
        before.size !== stat.size
      ) {
        throw new Error("Capability changed during read");
      }
      const buffer = Buffer.alloc(before.size + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const read = await handle.read(
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          bytesRead
        );
        if (read.bytesRead === 0) {
          break;
        }
        bytesRead += read.bytesRead;
      }
      const content = buffer.subarray(0, bytesRead);
      const after = await handle.stat();
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        content.length !== before.size
      ) {
        throw new Error("Capability changed during read");
      }
      nodes.push({
        path: name,
        kind: "file",
        // biome-ignore lint/suspicious/noBitwiseOperators: preserve executable file semantics
        executable: Boolean(stat.mode & 0o111),
        content,
      });
    } finally {
      await handle.close();
    }
  }
  await visit(path, "");
  nodes.sort((first, second) =>
    first.path < second.path ? -1 : first.path > second.path ? 1 : 0
  );
  const hash = hashCapability(
    JSON.stringify(
      nodes.map((node) => ({
        path: node.path,
        kind: node.kind,
        executable: node.executable,
        ...(node.content ? { sha256: hashCapability(node.content) } : {}),
      }))
    )
  );
  return { hash, nodes };
}
export async function currentCapability(
  path: string
): Promise<{ hash: string | null; link: string | null }> {
  await safeCapabilityPath(dirname(path));
  const stat = await optionalStat(path);
  if (stat?.isSymbolicLink()) {
    const link = await readlink(path);
    return {
      hash: hashCapability(`symlink:${link}`),
      link: resolve(dirname(path), link),
    };
  }
  return { hash: (await snapshotCapability(path))?.hash ?? null, link: null };
}
export async function stageCapability(
  path: string,
  snapshot: CapabilitySnapshot
): Promise<void> {
  for (const node of snapshot.nodes) {
    const target = node.path ? join(path, node.path) : path;
    if (node.kind === "directory") {
      await mkdir(target, { mode: 0o700 });
    } else {
      await writeFile(target, node.content!, {
        flag: "wx",
        mode: node.executable ? 0o700 : 0o600,
      });
      await chmod(target, node.executable ? 0o700 : 0o600);
    }
  }
}
