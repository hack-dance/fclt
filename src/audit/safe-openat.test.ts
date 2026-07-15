import { expect, test } from "bun:test";
import { closeSync, constants, openSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditReportPersistenceSupported,
  linuxLibcCandidates,
  readDirectoryEntriesAt,
  resolveLinuxLibcPath,
} from "./safe-openat";

test("Linux libc candidates cover Bun-supported glibc and musl runtimes", () => {
  expect(linuxLibcCandidates("x64")).toEqual([
    "libc.so.6",
    "/lib/libc.musl-x86_64.so.1",
    "/lib/ld-musl-x86_64.so.1",
  ]);
  expect(linuxLibcCandidates("arm64")).toEqual([
    "libc.so.6",
    "/lib/libc.musl-aarch64.so.1",
    "/lib/ld-musl-aarch64.so.1",
  ]);
  expect(linuxLibcCandidates("unsupported-architecture")).toEqual([
    "libc.so.6",
  ]);
});

test("Linux libc resolution falls back deterministically and closes probes", () => {
  const attempts: string[] = [];
  const closes: string[] = [];
  const selected = resolveLinuxLibcPath({
    architecture: "arm64",
    openProbe: (library) => {
      attempts.push(library);
      if (library === "libc.so.6") {
        throw new Error("unavailable glibc detail must not escape");
      }
      return {
        close: () => {
          closes.push(library);
        },
      };
    },
  });

  expect(selected).toBe("/lib/libc.musl-aarch64.so.1");
  expect(attempts).toEqual(["libc.so.6", "/lib/libc.musl-aarch64.so.1"]);
  expect(closes).toEqual(["/lib/libc.musl-aarch64.so.1"]);
});

test("Linux libc probes require the complete report-writer symbol contract", () => {
  const closes: string[] = [];
  const selected = resolveLinuxLibcPath({
    architecture: "arm64",
    openProbe: (library, symbols) => {
      if (!("linkat" in symbols)) {
        throw new Error("linkat is unavailable");
      }
      return {
        close: () => {
          closes.push(library);
        },
      };
    },
  });

  expect(selected).toBe("libc.so.6");
  expect(closes).toEqual(["libc.so.6"]);
});

test("Linux libc resolution rejects failed probes without leaking loader details", () => {
  const attempts: string[] = [];
  const closed: string[] = [];
  expect(() =>
    resolveLinuxLibcPath({
      architecture: "x64",
      openProbe: (library) => {
        attempts.push(library);
        if (library === "/lib/libc.musl-x86_64.so.1") {
          return {
            close: () => {
              closed.push(library);
              throw new Error("unsafe probe close detail");
            },
          };
        }
        throw new Error("host loader detail");
      },
    })
  ).toThrow("System libc FFI is unsupported on linux/x64");
  expect(attempts).toEqual(["libc.so.6", "/lib/libc.musl-x86_64.so.1"]);
  expect(closed).toEqual(["/lib/libc.musl-x86_64.so.1"]);
});

test("Linux libc resolution fails closed when every candidate is unavailable", () => {
  const attempts: string[] = [];
  expect(() =>
    resolveLinuxLibcPath({
      architecture: "x64",
      openProbe: (library) => {
        attempts.push(library);
        throw new Error(`private loader detail for ${library}`);
      },
    })
  ).toThrow("System libc FFI is unsupported on linux/x64");
  expect(attempts).toEqual([...linuxLibcCandidates("x64")]);
});

test("runtime libc resolves and descriptor-bound directory reads work", async () => {
  if (!(process.platform === "darwin" || process.platform === "linux")) {
    expect(auditReportPersistenceSupported()).toBe(false);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "fclt-safe-openat-runtime-"));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "entry.txt"), "entry\n");
  const directoryFd = openSync(
    root,
    constants.O_RDONLY + (constants.O_DIRECTORY ?? 0)
  );
  try {
    expect(
      readDirectoryEntriesAt({ directoryFd, maxEntries: 8 }).map((entry) => ({
        directory: entry.isDirectory(),
        file: entry.isFile(),
        name: entry.name,
      }))
    ).toEqual([
      { directory: false, file: true, name: "entry.txt" },
      { directory: true, file: false, name: "nested" },
    ]);
    expect(auditReportPersistenceSupported()).toBe(true);
  } finally {
    closeSync(directoryFd);
    await rm(root, { force: true, recursive: true });
  }
});
