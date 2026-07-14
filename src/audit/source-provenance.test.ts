import { expect, test } from "bun:test";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
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

async function captureStrictTree(
  root: string,
  options?: {
    maxAggregateBytes?: number;
    maxDepth?: number;
    maxEntries?: number;
    maxFileBytes?: number;
    maxRelativePathBytes?: number;
  }
) {
  const tracker = new AuditSourceTracker();
  await tracker.captureTree(root, {
    ...options,
    rejectUnsupportedEntries: true,
  });
  return tracker.snapshot();
}

async function writeEmptyFiles(
  root: string,
  count: number,
  prefix = "entry"
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await writeFile(
      join(root, `${prefix}-${index.toString().padStart(4, "0")}`),
      ""
    );
  }
}

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

test("strict tree capture binds bytes and modes for every unselected file", async () => {
  const root = await mkdtemp(join(tmpdir(), "fclt-provenance-tree-file-"));
  const selected = join(root, "selected.json");
  const unselected = join(root, "assets", "unselected.txt");
  await writeFile(selected, "{}\n");
  await mkdir(join(root, "assets"));
  await writeFile(unselected, "before\n");

  const byteSnapshot = await captureStrictTree(root);
  expect(byteSnapshot.evaluatedFiles.map((entry) => entry.path).sort()).toEqual(
    [await realpath(selected), await realpath(unselected)].sort()
  );
  await writeFile(unselected, "after!\n");
  await expect(validateAuditSourceSnapshot(byteSnapshot)).rejects.toThrow(
    "captured tree changed"
  );

  await writeFile(unselected, "stable\n");
  const modeSnapshot = await captureStrictTree(root);
  const canonicalUnselected = await realpath(unselected);
  const originalMode = modeSnapshot.evaluatedFiles.find(
    (entry) => entry.path === canonicalUnselected
  )?.mode;
  expect(typeof originalMode).toBe("number");
  await chmod(unselected, originalMode! % 0o1000 === 0o600 ? 0o644 : 0o600);
  await expect(validateAuditSourceSnapshot(modeSnapshot)).rejects.toThrow(
    "captured tree changed"
  );
});

test("strict tree capture rejects file type replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "fclt-provenance-tree-type-"));
  const pathValue = join(root, "payload");
  await writeFile(pathValue, "regular\n");
  const snapshot = await captureStrictTree(root);

  await rm(pathValue);
  await mkdir(pathValue);

  await expect(validateAuditSourceSnapshot(snapshot)).rejects.toThrow(
    "captured tree changed"
  );
});

test("strict tree capture rejects additions, removals, renames, and directory mode drift", async () => {
  for (const mutation of [
    "add",
    "remove",
    "rename",
    "directory-mode",
  ] as const) {
    const root = await mkdtemp(
      join(tmpdir(), `fclt-provenance-tree-${mutation}-`)
    );
    const original = join(root, "original.txt");
    await writeFile(original, "stable\n");
    const snapshot = await captureStrictTree(root);
    await expect(
      validateAuditSourceSnapshot(snapshot)
    ).resolves.toBeUndefined();
    await expect(
      validateAuditSourceSnapshot(snapshot)
    ).resolves.toBeUndefined();

    if (mutation === "add") {
      await writeFile(join(root, "added.txt"), "late\n");
    } else if (mutation === "remove") {
      await rm(original);
    } else if (mutation === "rename") {
      await rename(original, join(root, "renamed.txt"));
    } else {
      await chmod(root, 0o755);
    }

    await expect(validateAuditSourceSnapshot(snapshot)).rejects.toThrow();
  }
});

test("strict tree validation reuses the exact aggregate entry budget", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "fclt-provenance-tree-revalidate-")
  );
  const snapshot = await captureStrictTree(root);

  expect(snapshot.capturedTrees).toHaveLength(1);
  expect(snapshot.capturedTrees[0]?.maxEntries).toBe(256);
  expect(snapshot.evaluatedDirectories[0]?.maxEntries).toBe(255);
  await writeEmptyFiles(root, 300);

  await expect(validateAuditSourceSnapshot(snapshot)).rejects.toThrow(
    "entry limit"
  );
  const directTracker = new AuditSourceTracker();
  await expect(
    directTracker.readDirectory(root, { maxEntries: 256 })
  ).rejects.toThrow("entry limit");
  await expect(validateAuditSourceSnapshot(snapshot)).rejects.toThrow(
    "entry limit"
  );
});

test("strict tree validation enforces nested aggregate entries across directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "fclt-provenance-tree-nested-"));
  await mkdir(join(root, "a"));
  await mkdir(join(root, "b"));
  const snapshot = await captureStrictTree(root, { maxEntries: 6 });

  await writeEmptyFiles(join(root, "a"), 2, "a");
  await writeEmptyFiles(join(root, "b"), 2, "b");

  await expect(validateAuditSourceSnapshot(snapshot)).rejects.toThrow(
    "entry limit"
  );
});

test("strict tree validation enforces aggregate entries across many directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "fclt-provenance-tree-many-dirs-"));
  for (let index = 0; index < 20; index += 1) {
    await mkdir(join(root, `dir-${index.toString().padStart(2, "0")}`));
  }
  const snapshot = await captureStrictTree(root, { maxEntries: 32 });
  for (let index = 0; index < 20; index += 1) {
    await writeFile(
      join(root, `dir-${index.toString().padStart(2, "0")}`, "late"),
      ""
    );
  }

  await expect(validateAuditSourceSnapshot(snapshot)).rejects.toThrow(
    "entry limit"
  );
});

test("strict tree snapshot rejects missing or expanded validation contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "fclt-provenance-tree-schema-"));
  const snapshot = await captureStrictTree(root);
  const missingContract = { ...snapshot } as Record<string, unknown>;
  missingContract.capturedTrees = undefined;
  await expect(
    validateAuditSourceSnapshot(missingContract as never)
  ).rejects.toThrow("schema is unsupported");
  await expect(
    validateAuditSourceSnapshot({
      ...snapshot,
      capturedTrees: [
        {
          ...snapshot.capturedTrees[0]!,
          maxEntries: 50_000,
        },
      ],
    })
  ).rejects.toThrow("schema is unsupported");
});

test("strict tree capture rejects sparse and growing files", async () => {
  const sparseRoot = await mkdtemp(
    join(tmpdir(), "fclt-provenance-tree-sparse-")
  );
  const sparse = join(sparseRoot, "sparse.bin");
  await writeFile(sparse, "");
  await truncate(sparse, 512 * 1024);
  const sparseTracker = new AuditSourceTracker();
  await expect(
    sparseTracker.captureTree(sparseRoot, {
      maxFileBytes: 1024 * 1024,
      rejectUnsupportedEntries: true,
    })
  ).rejects.toThrow("is sparse");

  const growthRoot = await mkdtemp(
    join(tmpdir(), "fclt-provenance-tree-growth-")
  );
  const growing = join(growthRoot, "growing.bin");
  await writeFile(growing, Buffer.alloc(140_000, 1));
  let mutated = false;
  const growthTracker = new AuditSourceTracker({
    beforeReadChunk: async ({ bytesRead }) => {
      if (bytesRead > 0 && !mutated) {
        mutated = true;
        await appendFile(growing, "growth");
      }
    },
  });
  await expect(
    growthTracker.captureTree(growthRoot, {
      rejectUnsupportedEntries: true,
    })
  ).rejects.toThrow("changed while it was read");
});

test("strict tree capture rejects a missing declared root", async () => {
  const root = await mkdtemp(join(tmpdir(), "fclt-provenance-tree-missing-"));
  const missing = join(root, "missing-plugin");

  await expect(captureStrictTree(missing)).rejects.toThrow(
    "disappeared while it was captured"
  );
});

test("strict tree capture enforces every resource bound", async () => {
  const entriesRoot = await mkdtemp(
    join(tmpdir(), "fclt-provenance-tree-entries-")
  );
  await writeFile(join(entriesRoot, "one"), "1");
  await writeFile(join(entriesRoot, "two"), "2");
  await expect(
    captureStrictTree(entriesRoot, { maxEntries: 2 })
  ).rejects.toThrow("entry limit");

  const fileRoot = await mkdtemp(
    join(tmpdir(), "fclt-provenance-tree-file-limit-")
  );
  await writeFile(join(fileRoot, "large"), "12345");
  await expect(
    captureStrictTree(fileRoot, { maxFileBytes: 4 })
  ).rejects.toThrow("byte limit");

  const aggregateRoot = await mkdtemp(
    join(tmpdir(), "fclt-provenance-tree-aggregate-")
  );
  await writeFile(join(aggregateRoot, "one"), "123");
  await writeFile(join(aggregateRoot, "two"), "456");
  await expect(
    captureStrictTree(aggregateRoot, {
      maxAggregateBytes: 5,
      maxFileBytes: 4,
    })
  ).rejects.toThrow("byte limit");

  const depthRoot = await mkdtemp(
    join(tmpdir(), "fclt-provenance-tree-depth-")
  );
  await mkdir(join(depthRoot, "one", "two"), { recursive: true });
  await expect(captureStrictTree(depthRoot, { maxDepth: 1 })).rejects.toThrow(
    "depth limit"
  );

  const pathRoot = await mkdtemp(join(tmpdir(), "fclt-provenance-tree-path-"));
  await writeFile(join(pathRoot, "too-long"), "x");
  await expect(
    captureStrictTree(pathRoot, { maxRelativePathBytes: 4 })
  ).rejects.toThrow("relative path limit");
});
