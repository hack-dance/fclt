import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createServer } from "node:net";
import { acquireExclusiveAdvisoryLock } from "./audit/safe-openat";
import {
  capabilityCollisionPath,
  safeCapabilityPath,
} from "./capability-files";
import { hashCapability } from "./capability-registry";

export class LibraryMutationBusy extends Error {}

export async function withLibraryMutationLock<A>(
  sourceRoot: string,
  operation: () => Promise<A>
): Promise<A> {
  await safeCapabilityPath(sourceRoot);
  if (process.platform === "win32") {
    const server = createServer((socket) => socket.destroy());
    const id = hashCapability(capabilityCollisionPath(sourceRoot)).slice(7);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", (error: NodeJS.ErrnoException) =>
          reject(
            error.code === "EADDRINUSE" ? new LibraryMutationBusy() : error
          )
        );
        server.listen(`\\\\.\\pipe\\fclt-library-${id}`, resolve);
      });
      return await operation();
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  }
  const descriptor = await open(
    sourceRoot,
    constants.O_RDONLY + (constants.O_NOFOLLOW ?? 0)
  );
  try {
    if (!(await descriptor.stat()).isDirectory()) {
      throw new Error("Library source must be a directory");
    }
    let release: () => void;
    try {
      release = acquireExclusiveAdvisoryLock(descriptor.fd);
    } catch {
      throw new LibraryMutationBusy();
    }
    try {
      return await operation();
    } finally {
      release();
    }
  } finally {
    await descriptor.close();
  }
}
