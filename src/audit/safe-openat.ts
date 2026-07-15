import { dlopen, FFIType, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { constants, type Dirent, fstatSync } from "node:fs";

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

function safeExistingOpenFlags(): number {
  if (!(constants.O_NOFOLLOW && constants.O_NONBLOCK !== undefined)) {
    throw new Error(
      "Descriptor-relative no-follow report verification is unsupported"
    );
  }
  return constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK;
}
