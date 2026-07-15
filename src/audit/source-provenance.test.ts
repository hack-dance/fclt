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
import { basename, dirname, join } from "node:path";
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

async function assertSchemaRejected(value: unknown): Promise<void> {
  try {
    await validateAuditSourceSnapshot(value as never);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("schema is unsupported")
    ) {
      return;
    }
    throw error;
  }
  throw new Error("Expected audit source snapshot schema rejection");
}

async function captureCanonicalContractFixture() {
  const root = await mkdtemp(join(tmpdir(), "fclt-provenance-contract-"));
  const firstRoot = join(root, "a-tree");
  const secondRoot = join(root, "b-tree");
  const firstNested = join(firstRoot, "nested");
  const secondNested = join(secondRoot, "nested");
  await mkdir(firstNested, { recursive: true });
  await mkdir(secondNested, { recursive: true });
  await writeFile(join(firstRoot, "root.txt"), "first\n");
  await writeFile(join(firstNested, "nested.txt"), "nested first\n");
  await writeFile(join(secondRoot, "root.txt"), "second\n");
  await writeFile(join(secondNested, "nested.txt"), "nested second\n");

  const tracker = new AuditSourceTracker();
  await tracker.protect([firstRoot, secondRoot]);
  for (const treeRoot of [firstRoot, secondRoot]) {
    await tracker.captureTree(treeRoot, {
      maxAggregateBytes: 256,
      maxDepth: 4,
      maxEntries: 8,
      maxFileBytes: 64,
      maxRelativePathBytes: 128,
      rejectUnsupportedEntries: true,
    });
  }
  await tracker.recordGitPathExposure(firstRoot);
  await tracker.recordGitPathExposure(secondRoot);
  await tracker.capture(join(root, "missing-a.json"));
  await tracker.capture(join(root, "missing-b.json"));
  return tracker.snapshot();
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

test("POSIX directory reads enumerate the opened descriptor during pathname swaps", async () => {
  const parent = await mkdtemp(join(tmpdir(), "fclt-provenance-dir-swap-"));
  const requestedContainer = join(parent, "requested-container");
  const movedContainer = join(parent, "moved-container");
  const replacementContainer = join(parent, "replacement-container");
  const requested = join(requestedContainer, "nested");
  const replacement = join(replacementContainer, "nested");
  await mkdir(requested, { recursive: true });
  await mkdir(replacement, { recursive: true });
  await writeFile(join(requested, "original.txt"), "original\n");
  await writeFile(join(replacement, "replacement.txt"), "replacement\n");

  const tracker = new AuditSourceTracker({
    afterDirectoryOpen: async () => {
      await rename(requestedContainer, movedContainer);
      await rename(replacementContainer, requestedContainer);
    },
    afterDirectoryEnumeration: async () => {
      await rename(requestedContainer, replacementContainer);
      await rename(movedContainer, requestedContainer);
    },
  });

  const entries = await tracker.readDirectory(requested);
  expect(entries?.map((entry) => entry.name)).toEqual(["original.txt"]);
  await expect(
    validateAuditSourceSnapshot(tracker.snapshot())
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
    "absent requested path changed"
  );
});

test("absence operations retain their first lexical ancestor observation", async () => {
  for (const operation of [
    "capture",
    "optional-text",
    "directory",
    "tree",
  ] as const) {
    const root = await mkdtemp(
      join(tmpdir(), `fclt-provenance-first-absence-${operation}-`)
    );
    const target = join(root, "target");
    const alias = join(root, "alias");
    const missing = join(alias, "missing");
    await mkdir(target);
    await symlink(target, alias, "dir");
    let replaced = false;
    const tracker = new AuditSourceTracker({
      beforeAbsentProof: async () => {
        if (replaced) {
          return;
        }
        replaced = true;
        await rm(alias);
        await symlink(target, alias, "dir");
      },
    });

    const run = async (): Promise<void> => {
      if (operation === "capture") {
        await tracker.capture(missing);
      } else if (operation === "optional-text") {
        await tracker.readOptionalText(missing);
      } else if (operation === "directory") {
        await tracker.readDirectory(missing);
      } else {
        await tracker.captureTree(missing, {
          rejectUnsupportedEntries: true,
        });
      }
    };

    await expect(run()).rejects.toThrow("requested path changed");
    expect(tracker.snapshot().absentPaths).toEqual([]);
  }
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

test("strict tree snapshot binds every exact resource limit and directory budget", async () => {
  const snapshot = await captureCanonicalContractFixture();
  const limitFields = [
    "maxEntries",
    "maxFileBytes",
    "maxAggregateBytes",
    "maxDepth",
    "maxRelativePathBytes",
  ] as const;

  for (const field of limitFields) {
    for (const delta of [-1, 1]) {
      const mutated = structuredClone(snapshot);
      const tree = mutated.capturedTrees[0]! as unknown as Record<
        string,
        number
      >;
      tree[field] = tree[field]! + delta;
      await assertSchemaRejected(mutated);
    }
  }

  const directoryBudget = snapshot.evaluatedDirectories[0]!.maxEntries;
  for (const value of [directoryBudget - 1, directoryBudget + 1, 50_000]) {
    const mutated = structuredClone(snapshot);
    mutated.evaluatedDirectories[0]!.maxEntries = value;
    await assertSchemaRejected(mutated);
  }
});

test("source snapshot rejects duplicate-first, duplicate-last, and conflicting identities", async () => {
  const snapshot = await captureCanonicalContractFixture();
  const firstFile = snapshot.evaluatedFiles[0]!;

  const duplicateFirst = structuredClone(snapshot);
  duplicateFirst.evaluatedFiles.unshift({
    ...firstFile,
    sha256: "0".repeat(64),
  });
  await assertSchemaRejected(duplicateFirst);

  const duplicateLast = structuredClone(snapshot);
  duplicateLast.evaluatedFiles.push({ ...firstFile });
  await assertSchemaRejected(duplicateLast);

  const conflictingLast = structuredClone(snapshot);
  conflictingLast.evaluatedFiles.push({
    ...firstFile,
    size: firstFile.size + 1,
  });
  await assertSchemaRejected(conflictingLast);

  const duplicateDirectory = structuredClone(snapshot);
  duplicateDirectory.evaluatedDirectories.push({
    ...snapshot.evaluatedDirectories[0]!,
  });
  await assertSchemaRejected(duplicateDirectory);

  const conflictingTree = structuredClone(snapshot);
  conflictingTree.capturedTrees.push({
    ...snapshot.capturedTrees[0]!,
    maxEntries: snapshot.capturedTrees[0]!.maxEntries + 1,
  });
  await assertSchemaRejected(conflictingTree);

  const duplicateRequestedPath = structuredClone(snapshot);
  duplicateRequestedPath.requestedPaths.push({
    ...snapshot.requestedPaths[0]!,
  });
  await assertSchemaRejected(duplicateRequestedPath);

  const missingRequestedPath = structuredClone(snapshot);
  missingRequestedPath.requestedPaths.shift();
  await assertSchemaRejected(missingRequestedPath);
});

test("source snapshot requires canonical ordering for every set-like list", async () => {
  const snapshot = await captureCanonicalContractFixture();
  const topLevelLists = [
    "protectedRoots",
    "evaluatedFiles",
    "evaluatedDirectories",
    "capturedTrees",
    "derivedContexts",
    "absentPaths",
    "requestedPaths",
  ] as const;

  for (const key of topLevelLists) {
    const mutated = structuredClone(snapshot);
    const list = mutated[key];
    expect(list.length).toBeGreaterThan(1);
    Reflect.set(mutated, key, [...list].reverse());
    await assertSchemaRejected(mutated);
  }

  for (const key of ["directoryPaths", "filePaths"] as const) {
    const mutated = structuredClone(snapshot);
    const list = mutated.capturedTrees[0]![key];
    expect(list.length).toBeGreaterThan(1);
    mutated.capturedTrees[0]![key] = [...list].reverse();
    await assertSchemaRejected(mutated);
  }
});

test("source snapshot enforces exact keys on the snapshot and every nested record", async () => {
  const snapshot = await captureCanonicalContractFixture();
  const nestedTargets = [
    {
      key: "path",
      select: (value: typeof snapshot) => value.protectedRoots[0]!,
    },
    {
      key: "sha256",
      select: (value: typeof snapshot) => value.evaluatedFiles[0]!,
    },
    {
      key: "entriesSha256",
      select: (value: typeof snapshot) => value.evaluatedDirectories[0]!,
    },
    {
      key: "root",
      select: (value: typeof snapshot) => value.capturedTrees[0]!,
    },
    {
      key: "kind",
      select: (value: typeof snapshot) => value.derivedContexts[0]!,
    },
    {
      key: "relativeSegments",
      select: (value: typeof snapshot) => value.absentPaths[0]!,
    },
    {
      key: "canonicalPath",
      select: (value: typeof snapshot) => value.requestedPaths[0]!,
    },
  ];

  const extraTopLevel = structuredClone(snapshot) as unknown as Record<
    string,
    unknown
  >;
  extraTopLevel.unexpected = true;
  await assertSchemaRejected(extraTopLevel);

  const missingTopLevel = structuredClone(snapshot) as unknown as Record<
    string,
    unknown
  >;
  Reflect.deleteProperty(missingTopLevel, "schemaVersion");
  await assertSchemaRejected(missingTopLevel);

  const missingDigest = structuredClone(snapshot) as unknown as Record<
    string,
    unknown
  >;
  Reflect.deleteProperty(missingDigest, "validationContractSha256");
  await assertSchemaRejected(missingDigest);

  const invalidDigest = structuredClone(snapshot);
  invalidDigest.validationContractSha256 = "0".repeat(64);
  await assertSchemaRejected(invalidDigest);

  for (const { key, select } of nestedTargets) {
    const extra = structuredClone(snapshot);
    const extraRecord = select(extra) as unknown as Record<string, unknown>;
    extraRecord.unexpected = true;
    await assertSchemaRejected(extra);

    const missing = structuredClone(snapshot);
    const missingRecord = select(missing) as unknown as Record<string, unknown>;
    Reflect.deleteProperty(missingRecord, key);
    await assertSchemaRejected(missing);
  }
});

test("source snapshot rejects canonical path aliases and cross-tree overlaps", async () => {
  const snapshot = await captureCanonicalContractFixture();
  const firstFile = snapshot.evaluatedFiles[0]!;

  const dotAlias = structuredClone(snapshot);
  dotAlias.evaluatedFiles[0]!.path = `${dirname(firstFile.path)}/./${basename(
    firstFile.path
  )}`;
  await assertSchemaRejected(dotAlias);

  const parentAlias = structuredClone(snapshot);
  parentAlias.capturedTrees[0]!.root =
    `${snapshot.capturedTrees[0]!.root}/nested/..`;
  await assertSchemaRejected(parentAlias);

  const symlinkAliasPath = join(dirname(firstFile.path), "file-alias");
  await symlink(firstFile.path, symlinkAliasPath);
  const symlinkAlias = structuredClone(snapshot);
  symlinkAlias.evaluatedFiles[0]!.path = symlinkAliasPath;
  symlinkAlias.capturedTrees[0]!.filePaths =
    symlinkAlias.capturedTrees[0]!.filePaths.map((path) =>
      path === firstFile.path ? symlinkAliasPath : path
    ).sort();
  await assertSchemaRejected(symlinkAlias);
  await rm(symlinkAliasPath);

  const overlappingTrees = structuredClone(snapshot);
  const firstTree = overlappingTrees.capturedTrees[0]!;
  const secondTree = overlappingTrees.capturedTrees[1]!;
  secondTree.root = firstTree.directoryPaths[1]!;
  secondTree.directoryPaths = [secondTree.root];
  secondTree.filePaths = firstTree.filePaths.filter((path) =>
    path.startsWith(`${secondTree.root}/`)
  );
  await assertSchemaRejected(overlappingTrees);
});

test("source snapshot rejects missing, extra, and wrong-kind tree members", async () => {
  const snapshot = await captureCanonicalContractFixture();

  const missingIdentity = structuredClone(snapshot);
  missingIdentity.evaluatedFiles.splice(0, 1);
  await assertSchemaRejected(missingIdentity);

  const extraIdentity = structuredClone(snapshot);
  extraIdentity.evaluatedFiles.push({
    ...snapshot.evaluatedFiles[0]!,
    path: join(dirname(snapshot.evaluatedFiles[0]!.path), "extra.txt"),
  });
  await assertSchemaRejected(extraIdentity);

  const missingMember = structuredClone(snapshot);
  missingMember.capturedTrees[0]!.filePaths.splice(0, 1);
  await assertSchemaRejected(missingMember);

  const wrongKind = structuredClone(snapshot);
  const filePath = wrongKind.capturedTrees[0]!.filePaths.shift()!;
  wrongKind.capturedTrees[0]!.directoryPaths.push(filePath);
  wrongKind.capturedTrees[0]!.directoryPaths.sort();
  await assertSchemaRejected(wrongKind);
});

test("strict tree reserves sibling and deep manifests against one aggregate entry budget", async () => {
  const siblingRoot = await mkdtemp(
    join(tmpdir(), "fclt-provenance-tree-reserve-siblings-")
  );
  await mkdir(join(siblingRoot, "a"));
  await mkdir(join(siblingRoot, "b"));
  await writeFile(join(siblingRoot, "a", "one"), "1");
  await writeFile(join(siblingRoot, "b", "two"), "2");
  await expect(
    captureStrictTree(siblingRoot, { maxEntries: 5 })
  ).resolves.toBeDefined();
  await writeFile(join(siblingRoot, "a", "overflow"), "3");
  await expect(
    captureStrictTree(siblingRoot, { maxEntries: 5 })
  ).rejects.toThrow("entry limit");

  const deepRoot = await mkdtemp(
    join(tmpdir(), "fclt-provenance-tree-reserve-deep-")
  );
  await mkdir(join(deepRoot, "a", "b"), { recursive: true });
  await writeFile(join(deepRoot, "a", "b", "leaf"), "x");
  await expect(
    captureStrictTree(deepRoot, { maxEntries: 4 })
  ).resolves.toBeDefined();
  await expect(captureStrictTree(deepRoot, { maxEntries: 3 })).rejects.toThrow(
    "entry limit"
  );
});

test("strict tree exact entry boundary revalidates repeatedly and boundary plus one fails", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "fclt-provenance-tree-exact-boundary-")
  );
  const child = join(root, "child");
  const exact = join(child, "exact");
  await mkdir(child);
  await writeFile(exact, "x");
  const readDirectories: string[] = [];
  const openedPaths: string[] = [];
  const tracker = new AuditSourceTracker({
    beforeDirectoryRead: ({ path }) => {
      readDirectories.push(path);
      return Promise.resolve();
    },
    beforeFileOpen: ({ path }) => {
      openedPaths.push(path);
      return Promise.resolve();
    },
  });
  await tracker.captureTree(root, {
    maxEntries: 3,
    rejectUnsupportedEntries: true,
  });
  const snapshot = tracker.snapshot();

  expect(readDirectories).toEqual([
    await realpath(root),
    await realpath(child),
  ]);
  expect(openedPaths).toEqual([exact]);

  await expect(validateAuditSourceSnapshot(snapshot)).resolves.toBeUndefined();
  await expect(validateAuditSourceSnapshot(snapshot)).resolves.toBeUndefined();

  await writeFile(join(root, "child", "plus-one"), "y");
  await expect(validateAuditSourceSnapshot(snapshot)).rejects.toThrow(
    "entry limit"
  );
  await expect(validateAuditSourceSnapshot(snapshot)).rejects.toThrow(
    "entry limit"
  );
});

test("strict tree never opens sibling or child files when its manifest exhausts the entry budget", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "fclt-provenance-tree-no-open-after-limit-")
  );
  const child = join(root, "child");
  const sentinel = join(child, "sentinel-secret.txt");
  await mkdir(child);
  await writeFile(join(root, "a-file.txt"), "must-not-open-first");
  await writeFile(sentinel, "must-not-open");
  const readDirectories: string[] = [];
  const openedPaths: string[] = [];
  const tracker = new AuditSourceTracker({
    beforeDirectoryRead: ({ path }) => {
      readDirectories.push(path);
      return Promise.resolve();
    },
    beforeFileOpen: ({ path }) => {
      openedPaths.push(path);
      return Promise.resolve();
    },
  });

  await expect(
    tracker.captureTree(root, {
      maxEntries: 3,
      rejectUnsupportedEntries: true,
    })
  ).rejects.toThrow("entry limit");
  expect(readDirectories).toEqual([await realpath(root)]);
  expect(openedPaths).toEqual([]);
});

test("strict tree never opens an exhausted later sibling or a lexically earlier file", async () => {
  const cases = [
    { earlierFile: false, laterFile: false, name: "empty-later" },
    { earlierFile: false, laterFile: true, name: "nonempty-later" },
    { earlierFile: true, laterFile: true, name: "earlier-file" },
  ];
  for (const fixtureCase of cases) {
    const root = await mkdtemp(
      join(tmpdir(), `fclt-provenance-tree-${fixtureCase.name}-`)
    );
    const first = join(root, "a");
    const later = join(root, "b");
    const earlierFile = join(root, "0-earlier.txt");
    const laterFile = join(later, "sentinel.txt");
    await mkdir(first);
    await mkdir(later);
    await writeFile(join(first, "one"), "1");
    await writeFile(join(first, "two"), "2");
    if (fixtureCase.earlierFile) {
      await writeFile(earlierFile, "must-not-open");
    }
    if (fixtureCase.laterFile) {
      await writeFile(laterFile, "must-not-open");
    }
    const readDirectories: string[] = [];
    const openedPaths: string[] = [];
    const tracker = new AuditSourceTracker({
      beforeDirectoryRead: ({ path }) => {
        readDirectories.push(path);
        return Promise.resolve();
      },
      beforeFileOpen: ({ path }) => {
        openedPaths.push(path);
        return Promise.resolve();
      },
    });

    await expect(
      tracker.captureTree(root, {
        maxEntries: fixtureCase.earlierFile ? 6 : 5,
        rejectUnsupportedEntries: true,
      })
    ).rejects.toThrow("entry limit");
    expect(readDirectories).toEqual([
      await realpath(root),
      await realpath(first),
    ]);
    expect(readDirectories).not.toContain(await realpath(later));
    expect(openedPaths).toEqual([]);
  }
});

test("strict tree reserves its manifest before validating an overlapping protected child", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "fclt-provenance-protected-tree-budget-")
  );
  const child = join(root, "a-child.txt");
  await writeFile(child, "stable\n");
  const tracker = new AuditSourceTracker();
  await tracker.captureTree(root, {
    maxEntries: 2,
    rejectUnsupportedEntries: true,
  });
  await tracker.protect([child]);
  const snapshot = tracker.snapshot();

  await rm(child);
  await symlink("missing-target", child);
  await writeFile(join(root, "z-late.txt"), "late\n");

  await expect(validateAuditSourceSnapshot(snapshot)).rejects.toThrow(
    "entry limit"
  );
});

test("strict tree deep exhaustion does not open a later root sibling or reserved leaf", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "fclt-provenance-tree-deep-later-sibling-")
  );
  const first = join(root, "a");
  const deep = join(first, "b");
  const later = join(root, "z");
  const leaf = join(deep, "leaf.txt");
  await mkdir(deep, { recursive: true });
  await mkdir(later);
  await writeFile(leaf, "must-not-open");
  const readDirectories: string[] = [];
  const openedPaths: string[] = [];
  const tracker = new AuditSourceTracker({
    beforeDirectoryRead: ({ path }) => {
      readDirectories.push(path);
      return Promise.resolve();
    },
    beforeFileOpen: ({ path }) => {
      openedPaths.push(path);
      return Promise.resolve();
    },
  });

  await expect(
    tracker.captureTree(root, {
      maxEntries: 5,
      rejectUnsupportedEntries: true,
    })
  ).rejects.toThrow("entry limit");
  expect(readDirectories).toEqual([
    await realpath(root),
    await realpath(first),
    await realpath(deep),
  ]);
  expect(readDirectories).not.toContain(await realpath(later));
  expect(openedPaths).toEqual([]);
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
