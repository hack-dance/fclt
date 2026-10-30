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
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  sep,
  win32,
} from "node:path";
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

export function aiPathWithin(
  path: string,
  root: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const paths = platform === "win32" ? win32 : { relative, sep, isAbsolute };
  const suffix = paths.relative(root, path);
  return (
    suffix !== ".." &&
    !suffix.startsWith(`..${paths.sep}`) &&
    !paths.isAbsolute(suffix)
  );
}

interface DirectoryBinding {
  fd: number;
  path: string;
  metadata: Stats;
}

/** Binds root and ancestor identities; POSIX additionally opens each component without following links. */
export class AiDirectoryBoundary {
  readonly physical: string;
  readonly path: string;
  private readonly platform: NodeJS.Platform;
  private readonly directories: DirectoryBinding[] = [];

  constructor(
    path: string,
    create = false,
    platform: NodeJS.Platform = process.platform
  ) {
    this.platform = platform;
    this.path = absoluteFilesystemPath(path);
    this.physical = resolvePhysicalPath(this.path);
    try {
      const root = parse(this.physical).root;
      this.add(
        this.platform === "win32" ? -1 : openSync(root, DIRECTORY_FLAGS),
        root
      );
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
    const metadata = fd < 0 ? lstatSync(path) : fstatSync(fd);
    this.directories.push({ fd, path, metadata });
    if (!metadata.isDirectory()) {
      throw new Error(`AI boundary is not a directory: ${path}`);
    }
  }

  private descend(segments: string[], create: boolean): void {
    for (const segment of segments) {
      const path = join(this.directories.at(-1)!.path, segment);
      this.validateEntries();
      if (this.platform === "win32") {
        try {
          lstatSync(path);
        } catch (error) {
          if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
          this.mkdir(segment);
        }
        this.add(-1, path);
        this.validateEntries();
        continue;
      }
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
        (directory.fd >= 0 &&
          !sameAiIdentity(fstatSync(directory.fd), directory.metadata))
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

  private validateName(name: string): void {
    if (
      !name ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      name.includes("\0") ||
      (this.platform === "win32" && name.includes(":"))
    ) {
      throw new Error("AI bound entry names must be single path segments");
    }
  }

  metadata(): Stats {
    this.validate();
    const metadata =
      this.fd < 0 ? lstatSync(this.physical) : fstatSync(this.fd);
    this.validate();
    return metadata;
  }

  open(name: string, flags: number, mode = 0o600): number {
    this.validateName(name);
    this.validateEntries();
    if (this.platform === "win32") {
      return openSync(join(this.directories.at(-1)!.path, name), flags, mode);
    }
    return openFileAt({ directoryFd: this.fd, fileName: name, flags, mode });
  }

  mkdir(name: string): void {
    this.validateName(name);
    this.validateEntries();
    if (this.platform === "win32") {
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
    this.validateName(name);
    this.validate();
    if (this.platform === "win32") {
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
      this.platform === "win32"
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
      platform: this.platform,
    });
    try {
      for (const binding of this.directories) {
        parent.add(
          this.platform === "win32"
            ? -1
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
      if (directory.fd >= 0) {
        closeSync(directory.fd);
      }
    }
  }
}
