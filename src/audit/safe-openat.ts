import { dlopen, FFIType, ptr } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { constants, fstatSync } from "node:fs";

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
