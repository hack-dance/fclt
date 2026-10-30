import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  type Stats,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import {
  mutateEntryAt,
  openFileAt,
  readDirectoryEntriesAt,
} from "./audit/safe-openat";
import { absoluteFilesystemPath, resolvePhysicalPath } from "./paths";

const DIRECTORY_FLAGS =
  constants.O_RDONLY +
  (constants.O_DIRECTORY ?? 0) +
  (constants.O_NOFOLLOW ?? 0) +
  (constants.O_NONBLOCK ?? 0);

export function sameAiIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function aiPathWithin(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
  );
}

interface DirectoryBinding {
  fd: number;
  path: string;
  metadata: Stats;
}

/** Owns a root descriptor and its ancestry. Every component is opened without following links. */
export class AiDirectoryBoundary {
  readonly physical: string;
  readonly path: string;
  private readonly directories: DirectoryBinding[] = [];

  constructor(path: string, create = false) {
    this.path = absoluteFilesystemPath(path);
    this.physical = resolvePhysicalPath(this.path);
    try {
      const root = parse(this.physical).root;
      this.add(openSync(root, DIRECTORY_FLAGS), root);
      this.descend(
        relative(root, this.physical).split(sep).filter(Boolean),
        create
      );
      this.validate();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  get fd(): number {
    return this.directories.at(-1)!.fd;
  }

  private add(fd: number, path: string): void {
    const metadata = fstatSync(fd);
    this.directories.push({ fd, path, metadata });
    if (!metadata.isDirectory()) {
      throw new Error(`AI boundary is not a directory: ${path}`);
    }
  }

  private descend(segments: string[], create: boolean): void {
    for (const segment of segments) {
      const path = join(this.directories.at(-1)!.path, segment);
      this.validateEntries();
      let fd: number;
      try {
        fd = this.open(segment, DIRECTORY_FLAGS);
      } catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        this.mkdir(segment);
        fd = this.open(segment, DIRECTORY_FLAGS);
      }
      this.add(fd, path);
      this.validateEntries();
    }
  }

  private validateEntries(): void {
    for (const directory of this.directories) {
      const mapped = lstatSync(directory.path);
      if (
        mapped.isSymbolicLink() ||
        !sameAiIdentity(mapped, directory.metadata) ||
        !sameAiIdentity(fstatSync(directory.fd), directory.metadata)
      ) {
        throw new Error(`AI bound parent changed: ${directory.path}`);
      }
    }
  }

  validate(): void {
    this.validateEntries();
    if (resolvePhysicalPath(this.path) !== this.physical) {
      throw new Error(`AI root boundary changed: ${this.path}`);
    }
  }

  open(name: string, flags: number, mode = 0o600): number {
    this.validateEntries();
    if (process.platform === "win32") {
      return openSync(join(this.directories.at(-1)!.path, name), flags, mode);
    }
    return openFileAt({ directoryFd: this.fd, fileName: name, flags, mode });
  }

  mkdir(name: string): void {
    this.validateEntries();
    if (process.platform === "win32") {
      mkdirSync(join(this.directories.at(-1)!.path, name));
    } else {
      mutateEntryAt({
        directoryFd: this.fd,
        fileName: name,
        operation: "mkdir",
      });
    }
    this.validateEntries();
  }

  unlink(name: string): void {
    this.validate();
    if (process.platform === "win32") {
      unlinkSync(join(this.physical, name));
    } else {
      mutateEntryAt({
        directoryFd: this.fd,
        fileName: name,
        operation: "unlink",
      });
    }
    this.validate();
  }

  entries(): string[] {
    this.validate();
    const entries =
      process.platform === "win32"
        ? readdirSync(this.physical)
        : readDirectoryEntriesAt({
            directoryFd: this.fd,
            maxEntries: 100_000,
          }).map((entry) => entry.name);
    this.validate();
    return entries;
  }

  parentFor(path: string, create: boolean): AiDirectoryBoundary {
    this.validate();
    const physical = resolvePhysicalPath(path);
    if (!aiPathWithin(physical, this.physical)) {
      throw new Error(`AI path escapes authorized scope boundary: ${path}`);
    }
    const parent = Object.create(
      AiDirectoryBoundary.prototype
    ) as AiDirectoryBoundary;
    // The child owns duplicate descriptors; the root's descriptors stay alive for the whole operation.
    Object.assign(parent, {
      path: dirname(physical),
      physical: dirname(physical),
      directories: [],
    });
    try {
      for (const binding of this.directories) {
        parent.add(
          process.platform === "win32"
            ? openSync(binding.path, DIRECTORY_FLAGS)
            : openFileAt({
                directoryFd: binding.fd,
                fileName: ".",
                flags: DIRECTORY_FLAGS,
              }),
          binding.path
        );
      }
      parent.descend(
        relative(this.physical, dirname(physical)).split(sep).filter(Boolean),
        create
      );
      parent.validate();
      this.validate();
      return parent;
    } catch (error) {
      parent.close();
      throw error;
    }
  }

  close(): void {
    for (const directory of this.directories.splice(0).reverse()) {
      closeSync(directory.fd);
    }
  }
}
