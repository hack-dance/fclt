import {
  dlopen,
  type FFIFunction,
  FFIType,
  type Pointer,
  ptr,
  toArrayBuffer,
} from "bun:ffi";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  type Dirent,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, normalize, parse, relative, sep } from "node:path";

const DIRECTORY_ENTRY_TYPES = {
  blockDevice: 6,
  characterDevice: 2,
  directory: 4,
  fifo: 1,
  file: 8,
  socket: 12,
  symlink: 10,
} as const;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function directoryEntry(args: { name: string; type: number }): Dirent {
  const isType = (type: number): boolean => args.type === type;
  return {
    isBlockDevice: () => isType(DIRECTORY_ENTRY_TYPES.blockDevice),
    isCharacterDevice: () => isType(DIRECTORY_ENTRY_TYPES.characterDevice),
    isDirectory: () => isType(DIRECTORY_ENTRY_TYPES.directory),
    isFIFO: () => isType(DIRECTORY_ENTRY_TYPES.fifo),
    isFile: () => isType(DIRECTORY_ENTRY_TYPES.file),
    isSocket: () => isType(DIRECTORY_ENTRY_TYPES.socket),
    isSymbolicLink: () => isType(DIRECTORY_ENTRY_TYPES.symlink),
    name: args.name,
    parentPath: "",
  };
}

interface DirectoryStreamLibrary {
  close: () => void;
  closeFileDescriptor: (fileDescriptor: number) => number;
  closedir: (directory: Pointer) => number;
  dup: (fileDescriptor: number) => number;
  errnoPointer: () => Pointer;
  fdopendir: (fileDescriptor: number) => Pointer | null;
  readdir: (directory: Pointer) => Pointer | null;
  rewinddir: (directory: Pointer) => void;
}

interface PrivateFileSnapshot {
  contents: string;
  metadata: Stats;
}

interface DirectoryMutationSymbols {
  __errno_location?: () => Pointer;
  __error?: () => Pointer;
  close: (fd: number) => number;
  mkdirat: (directoryFd: number, name: Pointer, mode: number) => number;
  openat: (
    directoryFd: number,
    name: Pointer,
    flags: number,
    mode: number
  ) => number;
}

interface PrivateFileMutationSymbols extends DirectoryMutationSymbols {
  fchmod: (fd: number, mode: number) => number;
  flock: (fd: number, operation: number) => number;
  fsync: (fd: number) => number;
  read: (fd: number, buffer: Pointer, length: number) => number | bigint;
  renameat: (
    oldDirectoryFd: number,
    oldName: Pointer,
    newDirectoryFd: number,
    newName: Pointer
  ) => number;
  unlinkat: (directoryFd: number, name: Pointer, flags: number) => number;
  write: (fd: number, buffer: Pointer, length: number) => number | bigint;
}

function directoryStreamLibrary(): DirectoryStreamLibrary {
  const commonSymbols = {
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
    dup: { args: [FFIType.i32], returns: FFIType.i32 },
    fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
    readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
    rewinddir: { args: [FFIType.ptr], returns: FFIType.void },
  } as const;
  if (process.platform === "darwin") {
    const libc = dlopen("/usr/lib/libSystem.B.dylib", {
      ...commonSymbols,
      __error: { args: [], returns: FFIType.ptr },
    });
    return {
      close: () => libc.close(),
      closeFileDescriptor: (fileDescriptor) =>
        libc.symbols.close(fileDescriptor),
      closedir: (directory) => libc.symbols.closedir(directory),
      dup: (fileDescriptor) => libc.symbols.dup(fileDescriptor),
      errnoPointer: () => libc.symbols.__error()!,
      fdopendir: (fileDescriptor) => libc.symbols.fdopendir(fileDescriptor),
      readdir: (directory) => libc.symbols.readdir(directory),
      rewinddir: (directory) => libc.symbols.rewinddir(directory),
    };
  }
  if (process.platform === "linux") {
    const libc = dlopen("libc.so.6", {
      ...commonSymbols,
      __errno_location: { args: [], returns: FFIType.ptr },
    });
    return {
      close: () => libc.close(),
      closeFileDescriptor: (fileDescriptor) =>
        libc.symbols.close(fileDescriptor),
      closedir: (directory) => libc.symbols.closedir(directory),
      dup: (fileDescriptor) => libc.symbols.dup(fileDescriptor),
      errnoPointer: () => libc.symbols.__errno_location()!,
      fdopendir: (fileDescriptor) => libc.symbols.fdopendir(fileDescriptor),
      readdir: (directory) => libc.symbols.readdir(directory),
      rewinddir: (directory) => libc.symbols.rewinddir(directory),
    };
  }
  throw new Error(
    `Descriptor-bound directory enumeration is unavailable on ${process.platform}`
  );
}

function directoryEntryLayout(): {
  nameLengthOffset: number | null;
  nameOffset: number;
  recordLengthOffset: number;
  typeOffset: number;
} {
  return process.platform === "darwin"
    ? {
        nameLengthOffset: 18,
        nameOffset: 21,
        recordLengthOffset: 16,
        typeOffset: 20,
      }
    : {
        nameLengthOffset: null,
        nameOffset: 19,
        recordLengthOffset: 16,
        typeOffset: 18,
      };
}

export function readDirectoryEntriesAt(args: {
  directoryFd: number;
  maxEntries: number;
}): Dirent[] {
  const libc = directoryStreamLibrary();
  const duplicatedFd = libc.dup(args.directoryFd);
  if (duplicatedFd < 0) {
    libc.close();
    throw new Error("Descriptor-bound directory duplication failed closed");
  }
  const directory = libc.fdopendir(duplicatedFd);
  if (!directory) {
    libc.closeFileDescriptor(duplicatedFd);
    libc.close();
    throw new Error("Descriptor-bound directory open failed closed");
  }
  const errno = new DataView(toArrayBuffer(libc.errnoPointer(), 0, 4));
  const layout = directoryEntryLayout();
  const entries: Dirent[] = [];
  let failure: unknown;
  let closeResult = 0;
  try {
    while (true) {
      errno.setInt32(0, 0, true);
      const entryPointer = libc.readdir(directory);
      if (!entryPointer) {
        if (errno.getInt32(0, true) !== 0) {
          throw new Error("Descriptor-bound directory read failed closed");
        }
        break;
      }
      const header = new DataView(
        toArrayBuffer(entryPointer, 0, layout.nameOffset)
      );
      const recordLength = header.getUint16(layout.recordLengthOffset, true);
      const maxNameLength = recordLength - layout.nameOffset;
      const nameLength =
        layout.nameLengthOffset === null
          ? maxNameLength
          : header.getUint16(layout.nameLengthOffset, true);
      if (
        recordLength <= layout.nameOffset ||
        nameLength <= 0 ||
        nameLength > maxNameLength
      ) {
        throw new Error("Descriptor-bound directory entry is malformed");
      }
      const nameBytes = new Uint8Array(
        toArrayBuffer(entryPointer, layout.nameOffset, nameLength)
      );
      const terminatorIndex = nameBytes.indexOf(0);
      const exactNameBytes =
        terminatorIndex < 0
          ? nameBytes
          : nameBytes.subarray(0, terminatorIndex);
      if (exactNameBytes.length === 0) {
        throw new Error("Descriptor-bound directory entry has an empty name");
      }
      let name: string;
      try {
        name = UTF8_DECODER.decode(exactNameBytes);
      } catch {
        throw new Error("Descriptor-bound directory entry name is not UTF-8");
      }
      if (name === "." || name === "..") {
        continue;
      }
      if (entries.length >= args.maxEntries) {
        throw new Error("Audit discovery tree exceeds entry limit");
      }
      entries.push(
        directoryEntry({
          name,
          type: header.getUint8(layout.typeOffset),
        })
      );
    }
  } catch (error) {
    failure = error;
  } finally {
    libc.rewinddir(directory);
    closeResult = libc.closedir(directory);
    libc.close();
  }
  if (failure !== undefined) {
    throw failure;
  }
  if (closeResult !== 0) {
    throw new Error("Descriptor-bound directory close failed closed");
  }
  return entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  );
}

function permissionBits(mode: number): number {
  return mode % 0o1000;
}

function groupOrOtherWritable(mode: number): boolean {
  const permissions = permissionBits(mode);
  const group = Math.floor(permissions / 8) % 8;
  const other = permissions % 8;
  return Math.floor(group / 2) % 2 === 1 || Math.floor(other / 2) % 2 === 1;
}

function platformConfiguration(): {
  createExclusive: number;
  library: string;
} {
  if (process.platform === "darwin") {
    return {
      createExclusive: 0xa_01,
      library: "/usr/lib/libSystem.B.dylib",
    };
  }
  if (process.platform === "linux") {
    return { createExclusive: 0xc1, library: "libc.so.6" };
  }
  throw new Error(
    `Audit report persistence is unavailable on ${process.platform}: safe descriptor-relative creation is unsupported`
  );
}

export function auditReportPersistenceSupported(
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === "darwin" || platform === "linux";
}

export function openReadOnlyAt(args: {
  directoryFd: number;
  fileName: string;
}): number {
  if (args.fileName.includes("/") || args.fileName.includes("\\")) {
    throw new Error(
      "Descriptor-relative report names must be single path segments"
    );
  }
  const configuration = platformConfiguration();
  const libc = dlopen(configuration.library, {
    openat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
  });
  try {
    const fd = libc.symbols.openat(
      args.directoryFd,
      ptr(Buffer.from(`${args.fileName}\0`)),
      safeExistingOpenFlags(),
      0
    );
    if (fd < 0) {
      throw new Error(
        `Descriptor-relative report open failed closed: ${args.fileName}`
      );
    }
    return fd;
  } finally {
    libc.close();
  }
}

export function writeExclusiveAt(args: {
  contents: string;
  directoryFd: number;
  fileName: string;
}): void {
  if (args.fileName.includes("/") || args.fileName.includes("\\")) {
    throw new Error(
      "Descriptor-relative report names must be single path segments"
    );
  }
  const configuration = platformConfiguration();
  const libc = dlopen(configuration.library, {
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    fchmod: {
      args: [FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    fsync: { args: [FFIType.i32], returns: FFIType.i32 },
    linkat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    openat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    read: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
    unlinkat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    write: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
  });
  const verifyExisting = (): void => {
    const expected = Buffer.from(args.contents);
    const existingFd = libc.symbols.openat(
      args.directoryFd,
      ptr(Buffer.from(`${args.fileName}\0`)),
      safeExistingOpenFlags(),
      0
    );
    if (existingFd < 0) {
      throw new Error(
        `Descriptor-relative report commit failed closed: ${args.fileName}`
      );
    }
    try {
      let before = fstatSync(existingFd);
      for (let attempt = 0; before.nlink > 1 && attempt < 50; attempt += 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        before = fstatSync(existingFd);
      }
      const expectedOwner = process.getuid?.();
      if (
        !before.isFile() ||
        before.size !== expected.byteLength ||
        before.nlink !== 1 ||
        permissionBits(before.mode) !== 0o600 ||
        (expectedOwner !== undefined && before.uid !== expectedOwner)
      ) {
        throw new Error(
          `Audit report content-address collision: ${args.fileName}`
        );
      }
      let readOffset = 0;
      while (readOffset < expected.byteLength) {
        const chunk = Buffer.allocUnsafe(
          Math.min(64 * 1024, expected.byteLength - readOffset)
        );
        const count = Number(
          libc.symbols.read(existingFd, ptr(chunk), chunk.byteLength)
        );
        if (count <= 0) {
          throw new Error(`Could not verify existing report: ${args.fileName}`);
        }
        if (
          !chunk
            .subarray(0, count)
            .equals(expected.subarray(readOffset, readOffset + count))
        ) {
          throw new Error(
            `Audit report content-address collision: ${args.fileName}`
          );
        }
        readOffset += count;
      }
      const trailing = Buffer.allocUnsafe(1);
      if (Number(libc.symbols.read(existingFd, ptr(trailing), 1)) !== 0) {
        throw new Error(
          `Audit report content-address collision: ${args.fileName}`
        );
      }
      const after = fstatSync(existingFd);
      if (
        !after.isFile() ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.nlink !== 1 ||
        permissionBits(after.mode) !== 0o600 ||
        (expectedOwner !== undefined && after.uid !== expectedOwner)
      ) {
        throw new Error(
          `Descriptor-relative report identity changed: ${args.fileName}`
        );
      }
    } finally {
      libc.symbols.close(existingFd);
    }
  };
  const finalName = Buffer.from(`${args.fileName}\0`);
  const temporaryName = Buffer.from(`.${args.fileName}.${randomUUID()}.tmp\0`);
  let fd = libc.symbols.openat(
    args.directoryFd,
    ptr(temporaryName),
    configuration.createExclusive,
    0o600
  );
  try {
    if (fd < 0 || libc.symbols.fchmod(fd, 0o600) !== 0) {
      throw new Error(
        `Descriptor-relative temporary report creation failed closed: ${args.fileName}`
      );
    }
    const bytes = Buffer.from(args.contents);
    let offset = 0;
    while (offset < bytes.length) {
      const count = Number(
        libc.symbols.write(fd, ptr(bytes, offset), bytes.length - offset)
      );
      if (count <= 0) {
        throw new Error(`Could not write audit report: ${args.fileName}`);
      }
      offset += count;
    }
    if (libc.symbols.fsync(fd) !== 0) {
      throw new Error(`Could not sync audit report: ${args.fileName}`);
    }
    const temporaryMetadata = fstatSync(fd);
    const expectedOwner = process.getuid?.();
    if (
      !temporaryMetadata.isFile() ||
      temporaryMetadata.nlink !== 1 ||
      permissionBits(temporaryMetadata.mode) !== 0o600 ||
      (expectedOwner !== undefined && temporaryMetadata.uid !== expectedOwner)
    ) {
      throw new Error(
        `Descriptor-relative temporary report is not regular: ${args.fileName}`
      );
    }
    libc.symbols.close(fd);
    fd = -1;

    const linked = libc.symbols.linkat(
      args.directoryFd,
      ptr(temporaryName),
      args.directoryFd,
      ptr(finalName),
      0
    );
    if (linked === 0) {
      return;
    }
    verifyExisting();
  } finally {
    if (fd >= 0) {
      libc.symbols.close(fd);
    }
    libc.symbols.unlinkat(args.directoryFd, ptr(temporaryName), 0);
    libc.close();
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return (
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.ctimeMs === right.ctimeMs &&
    left.mtimeMs === right.mtimeMs
  );
}

function privateMutableFileIsSafe(metadata: Stats, maxBytes: number): boolean {
  const expectedOwner = process.getuid?.();
  return (
    metadata.isFile() &&
    metadata.nlink === 1 &&
    expectedOwner !== undefined &&
    metadata.uid === expectedOwner &&
    !groupOrOtherWritable(metadata.mode) &&
    Number.isSafeInteger(metadata.size) &&
    metadata.size >= 0 &&
    metadata.size <= maxBytes
  );
}

function privateDirectoryComponentIsSafe(metadata: Stats): boolean {
  const expectedOwner = process.getuid?.();
  return (
    metadata.isDirectory() &&
    (metadata.uid === 0 || metadata.uid === expectedOwner) &&
    !groupOrOtherWritable(metadata.mode)
  );
}

export function openOrCreatePrivateDirectory(directoryPath: string): number {
  if (
    !isAbsolute(directoryPath) ||
    normalize(directoryPath) !== directoryPath ||
    !auditReportPersistenceSupported()
  ) {
    throw new Error("Private directory path must be canonical and supported");
  }
  const configuration = platformConfiguration();
  const definitions: Record<string, FFIFunction> = {
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    mkdirat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    openat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
  };
  const libc = dlopen(configuration.library, definitions);
  const symbols = libc.symbols as unknown as DirectoryMutationSymbols;
  const root = parse(directoryPath).root;
  const segments = relative(root, directoryPath).split(sep).filter(Boolean);
  const directoryFlags =
    constants.O_RDONLY +
    (constants.O_DIRECTORY ?? 0) +
    (constants.O_NOFOLLOW ?? 0) +
    ((constants as typeof constants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0);
  let currentFd = openSync(root, directoryFlags);
  try {
    if (!privateDirectoryComponentIsSafe(fstatSync(currentFd))) {
      throw new Error("Private directory root is unsafe");
    }
    for (const segment of segments) {
      const name = Buffer.from(`${segment}\0`);
      let nextFd = symbols.openat(currentFd, ptr(name), directoryFlags, 0);
      if (nextFd < 0) {
        symbols.mkdirat(currentFd, ptr(name), 0o700);
        nextFd = symbols.openat(currentFd, ptr(name), directoryFlags, 0);
      }
      if (nextFd < 0) {
        throw new Error(`Could not open private directory: ${segment}`);
      }
      if (!privateDirectoryComponentIsSafe(fstatSync(nextFd))) {
        symbols.close(nextFd);
        throw new Error(`Private directory component is unsafe: ${segment}`);
      }
      closeSync(currentFd);
      currentFd = nextFd;
    }
    const descriptorMetadata = fstatSync(currentFd);
    const pathMetadata = lstatSync(directoryPath);
    if (
      pathMetadata.isSymbolicLink() ||
      !privateDirectoryComponentIsSafe(pathMetadata) ||
      descriptorMetadata.dev !== pathMetadata.dev ||
      descriptorMetadata.ino !== pathMetadata.ino ||
      realpathSync(directoryPath) !== directoryPath
    ) {
      throw new Error("Private directory changed while it was opened");
    }
    const result = currentFd;
    currentFd = -1;
    return result;
  } finally {
    if (currentFd >= 0) {
      closeSync(currentFd);
    }
    libc.close();
  }
}

export async function replacePrivateFileAt(args: {
  /** @internal Adversarial test hook; production callers must not set this. */
  beforeCommit?: () => Promise<void>;
  directoryFd: number;
  expectedPriorSha256?: string | null;
  fileName: string;
  maxBytes: number;
  transform: (contents: string | null) => string;
}): Promise<{ contents: string; previousContents: string | null }> {
  if (
    args.fileName.includes("/") ||
    args.fileName.includes("\\") ||
    args.fileName === "." ||
    args.fileName === ".."
  ) {
    throw new Error(
      "Descriptor-relative private file names must be one segment"
    );
  }
  const configuration = platformConfiguration();
  const definitions: Record<string, FFIFunction> = {
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    fchmod: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    fsync: { args: [FFIType.i32], returns: FFIType.i32 },
    openat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    read: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
    renameat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr],
      returns: FFIType.i32,
    },
    unlinkat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    write: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
  };
  definitions[process.platform === "darwin" ? "__error" : "__errno_location"] =
    { args: [], returns: FFIType.ptr };
  const libc = dlopen(configuration.library, definitions);
  const symbols = libc.symbols as unknown as PrivateFileMutationSymbols;
  const errnoPointer =
    process.platform === "darwin"
      ? symbols.__error!()
      : symbols.__errno_location!();
  const errno = new DataView(toArrayBuffer(errnoPointer!, 0, 4));
  const name = Buffer.from(`${args.fileName}\0`);
  const lockName = Buffer.from(`.${args.fileName}.lock\0`);
  const temporaryName = Buffer.from(`.${args.fileName}.${randomUUID()}.tmp\0`);
  let lockFd = -1;
  let temporaryFd = -1;

  const openExisting = (): number | null => {
    errno.setInt32(0, 0, true);
    const fd = symbols.openat(
      args.directoryFd,
      ptr(name),
      safeExistingOpenFlags(),
      0
    );
    if (fd >= 0) {
      return fd;
    }
    if (errno.getInt32(0, true) === 2) {
      return null;
    }
    throw new Error(
      `Descriptor-relative private file open failed closed: ${args.fileName}`
    );
  };
  const readExisting = (): PrivateFileSnapshot | null => {
    const fd = openExisting();
    if (fd === null) {
      return null;
    }
    try {
      const before = fstatSync(fd);
      if (!privateMutableFileIsSafe(before, args.maxBytes)) {
        throw new Error(`Private file is unsafe: ${args.fileName}`);
      }
      const bytes = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const count = Number(
          symbols.read(fd, ptr(bytes, offset), bytes.length - offset)
        );
        if (count < 0) {
          throw new Error(`Could not read private file: ${args.fileName}`);
        }
        if (count === 0) {
          break;
        }
        offset += count;
      }
      if (offset !== before.size) {
        throw new Error(`Private file changed while reading: ${args.fileName}`);
      }
      const after = fstatSync(fd);
      if (!sameFileIdentity(before, after)) {
        throw new Error(`Private file changed while reading: ${args.fileName}`);
      }
      return {
        contents: new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, offset)
        ),
        metadata: before,
      };
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(`Private file is not UTF-8: ${args.fileName}`);
      }
      throw error;
    } finally {
      symbols.close(fd);
    }
  };
  const assertUnchanged = (previous: PrivateFileSnapshot | null): void => {
    const current = readExisting();
    if (previous === null) {
      if (current !== null) {
        throw new Error(
          `Private file appeared during update: ${args.fileName}`
        );
      }
      return;
    }
    if (
      current === null ||
      !sameFileIdentity(previous.metadata, current.metadata) ||
      previous.contents !== current.contents
    ) {
      throw new Error(`Private file changed during update: ${args.fileName}`);
    }
  };

  try {
    lockFd = symbols.openat(
      args.directoryFd,
      ptr(lockName),
      constants.O_RDWR +
        constants.O_CREAT +
        (constants.O_NOFOLLOW ?? 0) +
        ((constants as typeof constants & { O_CLOEXEC?: number }).O_CLOEXEC ??
          0),
      0o600
    );
    if (
      lockFd < 0 ||
      symbols.fchmod(lockFd, 0o600) !== 0 ||
      !privateMutableFileIsSafe(fstatSync(lockFd), args.maxBytes) ||
      symbols.flock(lockFd, 6) !== 0
    ) {
      throw new Error(
        `Private file update is already active: ${args.fileName}`
      );
    }
    const currentLockFd = symbols.openat(
      args.directoryFd,
      ptr(lockName),
      safeExistingOpenFlags(),
      0
    );
    if (currentLockFd < 0) {
      throw new Error(`Private file lock changed: ${args.fileName}`);
    }
    try {
      if (!sameFileIdentity(fstatSync(lockFd), fstatSync(currentLockFd))) {
        throw new Error(`Private file lock changed: ${args.fileName}`);
      }
    } finally {
      symbols.close(currentLockFd);
    }

    const previous = readExisting();
    const priorSha256 = previous
      ? createHash("sha256").update(previous.contents).digest("hex")
      : null;
    if (
      args.expectedPriorSha256 !== undefined &&
      priorSha256 !== args.expectedPriorSha256
    ) {
      throw new Error(
        `Private file no longer matches its receipt: ${args.fileName}`
      );
    }
    const contents = args.transform(previous?.contents ?? null);
    if (Buffer.byteLength(contents) > args.maxBytes) {
      throw new Error(`Private file exceeds byte limit: ${args.fileName}`);
    }
    temporaryFd = symbols.openat(
      args.directoryFd,
      ptr(temporaryName),
      configuration.createExclusive,
      0o600
    );
    if (temporaryFd < 0 || symbols.fchmod(temporaryFd, 0o600) !== 0) {
      throw new Error(
        `Descriptor-relative private temporary creation failed: ${args.fileName}`
      );
    }
    const bytes = Buffer.from(contents);
    let offset = 0;
    while (offset < bytes.length) {
      const count = Number(
        symbols.write(temporaryFd, ptr(bytes, offset), bytes.length - offset)
      );
      if (count <= 0) {
        throw new Error(`Could not write private file: ${args.fileName}`);
      }
      offset += count;
    }
    if (symbols.fsync(temporaryFd) !== 0) {
      throw new Error(`Could not sync private file: ${args.fileName}`);
    }
    const temporaryMetadata = fstatSync(temporaryFd);
    if (!privateMutableFileIsSafe(temporaryMetadata, args.maxBytes)) {
      throw new Error(`Private temporary file is unsafe: ${args.fileName}`);
    }
    symbols.close(temporaryFd);
    temporaryFd = -1;

    await args.beforeCommit?.();
    assertUnchanged(previous);
    if (symbols.fsync(args.directoryFd) !== 0) {
      throw new Error(`Could not sync private directory: ${args.fileName}`);
    }
    if (
      symbols.renameat(
        args.directoryFd,
        ptr(temporaryName),
        args.directoryFd,
        ptr(name)
      ) !== 0
    ) {
      throw new Error(
        `Could not atomically replace private file: ${args.fileName}`
      );
    }
    symbols.fsync(args.directoryFd);
    const committed = readExisting();
    if (committed?.contents !== contents) {
      throw new Error(
        `Private file commit verification failed: ${args.fileName}`
      );
    }
    return { contents, previousContents: previous?.contents ?? null };
  } finally {
    if (lockFd >= 0) {
      symbols.close(lockFd);
    }
    if (temporaryFd >= 0) {
      symbols.close(temporaryFd);
    }
    symbols.unlinkat(args.directoryFd, ptr(temporaryName), 0);
    libc.close();
  }
}

function safeExistingOpenFlags(): number {
  if (!(constants.O_NOFOLLOW && constants.O_NONBLOCK !== undefined)) {
    throw new Error(
      "Descriptor-relative no-follow report verification is unsupported"
    );
  }
  return constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK;
}
