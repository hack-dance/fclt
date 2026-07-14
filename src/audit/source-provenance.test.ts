import { expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuditSourceTracker,
  validateAuditSourceSnapshot,
} from "./source-provenance";

test("Windows provenance binds directories without POSIX directory descriptors", async () => {
  const root = await mkdtemp(join(tmpdir(), "fclt-provenance-win32-"));
  await mkdir(join(root, "skills"));
  const tracker = new AuditSourceTracker({ platform: "win32" });

  await tracker.protect([root]);
  await tracker.readDirectory(root);
  const snapshot = tracker.snapshot();

  expect(snapshot.protectedRoots).toHaveLength(1);
  expect(snapshot.protectedRoots[0]?.kind).toBe("directory");
  expect(snapshot.evaluatedDirectories).toHaveLength(1);
  await expect(
    validateAuditSourceSnapshot(snapshot, { platform: "win32" })
  ).resolves.toBeUndefined();
});

test("bounded provenance rejects large, sparse, growing, symlink, and special inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "fclt-provenance-bounds-"));
  const large = join(root, "large.bin");
  const sparse = join(root, "sparse.bin");
  const growing = join(root, "growing.bin");
  const alias = join(root, "alias.bin");
  const directory = join(root, "special-directory");
  await writeFile(large, Buffer.alloc(50_001, 1));
  await writeFile(sparse, "");
  await truncate(sparse, 5_000_000);
  await writeFile(growing, Buffer.alloc(140_000, 2));
  await symlink(large, alias);
  await mkdir(directory);

  const bounded = new AuditSourceTracker();
  await expect(bounded.read(large, { maxBytes: 50_000 })).rejects.toThrow(
    "exceeds byte limit"
  );
  await expect(bounded.read(sparse, { maxBytes: 50_000 })).rejects.toThrow(
    "exceeds byte limit"
  );
  await expect(bounded.read(alias)).rejects.toThrow("non-symlink file");
  await expect(bounded.read(directory)).rejects.toThrow("non-symlink file");

  let mutated = false;
  const racing = new AuditSourceTracker({
    beforeReadChunk: async ({ bytesRead }) => {
      if (bytesRead > 0 && !mutated) {
        mutated = true;
        await appendFile(growing, "growth");
      }
    },
  });
  await expect(racing.read(growing, { maxBytes: 200_000 })).rejects.toThrow(
    "changed while it was read"
  );
});

test("absence proofs reject newly created symlink ancestors", async () => {
  const root = await mkdtemp(join(tmpdir(), "fclt-provenance-absent-"));
  const reportRoot = await mkdtemp(join(tmpdir(), "fclt-provenance-report-"));
  const candidate = join(root, "future", "nested", "config.json");
  const tracker = new AuditSourceTracker();
  await tracker.capture(candidate);
  const snapshot = tracker.snapshot();

  await mkdir(join(root, "future"));
  await symlink(reportRoot, join(root, "future", "nested"));

  await expect(validateAuditSourceSnapshot(snapshot)).rejects.toThrow(
    "became a symlink"
  );
});
