import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AuditSourceSnapshot,
  AuditSourceTracker,
  assertAuditSourceSnapshot,
  validateAuditSourceSnapshot,
} from "./source-provenance";

const NON_NEGATIVE_DECIMAL_RE = /^\d+$/;
const POSITIVE_DECIMAL_RE = /^[1-9]\d*$/;

function recomputeValidationContract(
  snapshot: AuditSourceSnapshot
): AuditSourceSnapshot {
  const contract = structuredClone(snapshot) as AuditSourceSnapshot &
    Record<string, unknown>;
  Reflect.deleteProperty(contract, "validationContractSha256");
  snapshot.validationContractSha256 = createHash("sha256")
    .update(JSON.stringify(contract))
    .digest("hex");
  return snapshot;
}

async function makeFileFixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const targetDirectory = join(root, "target");
  const target = join(targetDirectory, "config.json");
  await mkdir(targetDirectory);
  await writeFile(target, "{}\n");
  return { root, target, targetDirectory };
}

test("derived context rejects a second symlink alias for one physical target", async () => {
  const { root, target, targetDirectory } = await makeFileFixture(
    "fclt-provenance-derived-alias-"
  );
  const aliasDirectory = join(root, "alias");
  const alias = join(aliasDirectory, "config.json");
  await symlink(targetDirectory, aliasDirectory, "dir");
  const tracker = new AuditSourceTracker();

  await tracker.recordGitPathExposure(target);
  await expect(tracker.recordGitPathExposure(alias)).rejects.toThrow();

  expect(tracker.snapshot().derivedContexts).toHaveLength(1);
});

test("recomputed contract digest cannot authorize a derived physical alias", async () => {
  const { root, target, targetDirectory } = await makeFileFixture(
    "fclt-provenance-derived-injected-alias-"
  );
  const aliasDirectory = join(root, "alias");
  const alias = join(aliasDirectory, "config.json");
  await symlink(targetDirectory, aliasDirectory, "dir");
  const tracker = new AuditSourceTracker();
  await tracker.recordGitPathExposure(target);
  const snapshot = tracker.snapshot();
  const originalDigest = snapshot.validationContractSha256;
  const original = snapshot.derivedContexts[0]!;
  snapshot.derivedContexts.push({ ...original, path: alias });
  snapshot.derivedContexts.sort((left, right) =>
    `${left.kind}\0${left.path}`.localeCompare(`${right.kind}\0${right.path}`)
  );
  recomputeValidationContract(snapshot);

  expect(snapshot.validationContractSha256).not.toBe(originalDigest);
  expect(() => assertAuditSourceSnapshot(snapshot)).toThrow(
    "schema is unsupported"
  );
  await expect(validateAuditSourceSnapshot(snapshot)).rejects.toThrow(
    "schema is unsupported"
  );
});

test("evaluated and protected records reject hardlink aliases", async () => {
  const { root, target } = await makeFileFixture(
    "fclt-provenance-hardlink-records-"
  );
  const alias = join(root, "hardlink.json");
  await link(target, alias);

  const evaluated = new AuditSourceTracker();
  await evaluated.read(target);
  await expect(evaluated.read(alias)).rejects.toThrow();

  const protectedTracker = new AuditSourceTracker();
  await expect(protectedTracker.protect([target, alias])).rejects.toThrow();
});

test("strict captured trees reject two paths for one hardlinked file", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "fclt-provenance-tree-hardlink-alias-")
  );
  const target = join(root, "a.json");
  const alias = join(root, "b.json");
  await writeFile(target, "{}\n");
  await link(target, alias);
  const tracker = new AuditSourceTracker();

  await expect(
    tracker.captureTree(root, { rejectUnsupportedEntries: true })
  ).rejects.toThrow();
  expect(tracker.snapshot().capturedTrees).toHaveLength(0);
});

test("cross-family hardlink aliases reject while exact canonical references are allowed", async () => {
  const { root, target } = await makeFileFixture(
    "fclt-provenance-cross-family-identity-"
  );
  const alias = join(root, "hardlink.json");
  await link(target, alias);

  const conflicting = new AuditSourceTracker();
  await conflicting.read(target);
  await expect(conflicting.recordGitPathExposure(alias)).rejects.toThrow();

  const coherent = new AuditSourceTracker();
  await coherent.protect([target]);
  await coherent.read(target);
  await coherent.recordGitPathExposure(target);
  const snapshot = coherent.snapshot();
  expect(() => assertAuditSourceSnapshot(snapshot)).not.toThrow();
  await expect(validateAuditSourceSnapshot(snapshot)).resolves.toBeUndefined();
});

test("absence proofs bind each lexical ancestor alias independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "fclt-provenance-absence-alias-"));
  const targetDirectory = join(root, "target");
  const aliasDirectory = join(root, "alias");
  await mkdir(targetDirectory);
  await symlink(targetDirectory, aliasDirectory, "dir");
  const tracker = new AuditSourceTracker();

  await tracker.capture(join(targetDirectory, "missing.json"));
  await tracker.capture(join(aliasDirectory, "missing.json"));
  expect(tracker.snapshot().absentPaths).toHaveLength(2);
  await expect(
    validateAuditSourceSnapshot(tracker.snapshot())
  ).resolves.toBeUndefined();

  const distinct = new AuditSourceTracker();
  await distinct.capture(join(targetDirectory, "missing-a.json"));
  await distinct.capture(join(targetDirectory, "missing-b.json"));
  const snapshot = distinct.snapshot();
  expect(snapshot.absentPaths).toHaveLength(2);
  await expect(validateAuditSourceSnapshot(snapshot)).resolves.toBeUndefined();
});

test("derived context rejects replacement during its bound evaluation", async () => {
  const { root, target } = await makeFileFixture(
    "fclt-provenance-derived-race-"
  );
  const original = join(root, "original.json");
  let replaced = false;
  const tracker = new AuditSourceTracker({
    beforeDerivedContextEvaluation: async ({ path }) => {
      if (replaced) {
        return;
      }
      replaced = true;
      await rename(path, original);
      await writeFile(path, "{}\n");
    },
  });

  await expect(tracker.recordGitPathExposure(target)).rejects.toThrow();
  expect(tracker.snapshot().derivedContexts).toHaveLength(0);
});

test("derived context validation rejects a same-content path replacement", async () => {
  const { root, target } = await makeFileFixture(
    "fclt-provenance-derived-replacement-"
  );
  const original = join(root, "original.json");
  const tracker = new AuditSourceTracker();
  await tracker.recordGitPathExposure(target);
  const snapshot = tracker.snapshot();
  await rename(target, original);
  await writeFile(target, "{}\n");

  await expect(validateAuditSourceSnapshot(snapshot)).rejects.toThrow(
    "requested path changed"
  );
});

test("one requested lexical path cannot retarget across evaluated and protected families", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "fclt-provenance-request-retarget-")
  );
  const firstDirectory = join(root, "a");
  const secondDirectory = join(root, "b");
  const aliasDirectory = join(root, "selected");
  const first = join(firstDirectory, "config.json");
  const second = join(secondDirectory, "config.json");
  const requested = join(aliasDirectory, "config.json");
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  await writeFile(first, "same-content\n");
  await writeFile(second, "same-content\n");
  await symlink(firstDirectory, aliasDirectory, "dir");
  const tracker = new AuditSourceTracker();

  await tracker.read(requested);
  expect(tracker.snapshot().evaluatedFiles[0]?.path).toBe(
    await realpath(first)
  );
  await rm(aliasDirectory);
  await symlink(secondDirectory, aliasDirectory, "dir");

  await expect(tracker.protect([requested])).rejects.toThrow();
  expect(tracker.snapshot().protectedRoots).toHaveLength(0);
});

test("recomputed contract cannot combine one lexical request bound to two physical targets", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "fclt-provenance-request-contract-retarget-")
  );
  const firstDirectory = join(root, "a");
  const secondDirectory = join(root, "b");
  const aliasDirectory = join(root, "selected");
  const first = join(firstDirectory, "config.json");
  const second = join(secondDirectory, "config.json");
  const requested = join(aliasDirectory, "config.json");
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  await writeFile(first, "same-content\n");
  await writeFile(second, "same-content\n");
  await symlink(firstDirectory, aliasDirectory, "dir");

  const evaluatedTracker = new AuditSourceTracker();
  await evaluatedTracker.read(requested);
  const evaluatedSnapshot = evaluatedTracker.snapshot();
  await rm(aliasDirectory);
  await symlink(secondDirectory, aliasDirectory, "dir");
  const protectedTracker = new AuditSourceTracker();
  await protectedTracker.protect([requested]);
  const protectedSnapshot = protectedTracker.snapshot();

  evaluatedSnapshot.protectedRoots = protectedSnapshot.protectedRoots;
  evaluatedSnapshot.requestedPaths.push(...protectedSnapshot.requestedPaths);
  evaluatedSnapshot.requestedPaths.sort((left, right) =>
    left.requestedPath.localeCompare(right.requestedPath)
  );
  recomputeValidationContract(evaluatedSnapshot);
  expect(() => assertAuditSourceSnapshot(evaluatedSnapshot)).toThrow(
    "schema is unsupported"
  );
  await expect(validateAuditSourceSnapshot(evaluatedSnapshot)).rejects.toThrow(
    "schema is unsupported"
  );
});

test("recomputed contract rejects an unreferenced requested-path binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "fclt-provenance-unreferenced-"));
  const firstPath = join(root, "first.txt");
  const secondPath = join(root, "second.txt");
  await writeFile(firstPath, "first\n");
  await writeFile(secondPath, "second\n");

  const firstTracker = new AuditSourceTracker();
  await firstTracker.read(firstPath);
  const snapshot = firstTracker.snapshot();
  const secondTracker = new AuditSourceTracker();
  await secondTracker.read(secondPath);
  snapshot.requestedPaths.push(secondTracker.snapshot().requestedPaths[0]!);
  snapshot.requestedPaths.sort((left, right) =>
    left.requestedPath.localeCompare(right.requestedPath)
  );
  recomputeValidationContract(snapshot);

  await expect(validateAuditSourceSnapshot(snapshot)).rejects.toThrow(
    "schema is unsupported"
  );
});

test("absence proof validation binds the original lexical request across ancestor retargets", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "fclt-provenance-absence-retarget-")
  );
  const absentDirectory = join(root, "a");
  const existingDirectory = join(root, "b");
  const aliasDirectory = join(root, "selected");
  const requested = join(aliasDirectory, "config.json");
  await mkdir(absentDirectory);
  await mkdir(existingDirectory);
  await writeFile(join(existingDirectory, "config.json"), "exists\n");
  await symlink(absentDirectory, aliasDirectory, "dir");
  const tracker = new AuditSourceTracker();
  await tracker.capture(requested);
  const snapshot = tracker.snapshot();
  expect(snapshot.absentPaths).toHaveLength(1);

  await rm(aliasDirectory);
  await symlink(existingDirectory, aliasDirectory, "dir");

  await expect(validateAuditSourceSnapshot(snapshot)).rejects.toThrow();
});

test("requested paths reject same-target lexical symlink replacement", async () => {
  const { root, target, targetDirectory } = await makeFileFixture(
    "fclt-provenance-same-target-link-replacement-"
  );
  const aliasDirectory = join(root, "alias");
  const requested = join(aliasDirectory, "config.json");
  await symlink(targetDirectory, aliasDirectory, "dir");
  const tracker = new AuditSourceTracker();
  await tracker.read(requested);
  const snapshot = tracker.snapshot();
  expect(snapshot.evaluatedFiles[0]?.path).toBe(await realpath(target));
  const aliasIdentity = snapshot.requestedPaths[0]!.lexicalChain.find(
    (component) => component.path === aliasDirectory
  );
  expect(aliasIdentity?.birthtimeNs).toMatch(NON_NEGATIVE_DECIMAL_RE);
  expect(aliasIdentity?.ctimeNs).toMatch(POSITIVE_DECIMAL_RE);
  expect(aliasIdentity?.parentCtimeNs).toMatch(POSITIVE_DECIMAL_RE);
  expect(aliasIdentity?.parentDev).toMatch(NON_NEGATIVE_DECIMAL_RE);
  expect(aliasIdentity?.parentIno).toMatch(POSITIVE_DECIMAL_RE);
  expect(aliasIdentity?.parentMtimeNs).toMatch(NON_NEGATIVE_DECIMAL_RE);
  expect(aliasIdentity?.kind).toBe("symlink");
  expect(aliasIdentity?.linkTarget).toBe(targetDirectory);
  expect(() => assertAuditSourceSnapshot(snapshot)).not.toThrow();

  await rm(aliasDirectory);
  await symlink(targetDirectory, aliasDirectory, "dir");

  await expect(validateAuditSourceSnapshot(snapshot)).rejects.toThrow(
    "requested path changed"
  );
  await expect(tracker.protect([requested])).rejects.toThrow(
    "requested path changed"
  );
});

test("requested paths bind a symlink replacement through its parent generation", async () => {
  const { root, targetDirectory } = await makeFileFixture(
    "fclt-provenance-parent-bound-link-replacement-"
  );
  const aliasDirectory = join(root, "alias");
  const requested = join(aliasDirectory, "config.json");
  await symlink(targetDirectory, aliasDirectory, "dir");
  const tracker = new AuditSourceTracker();
  await tracker.read(requested);
  const snapshot = tracker.snapshot();
  const recorded = snapshot.requestedPaths[0]!.lexicalChain.find(
    (component) => component.path === aliasDirectory
  )!;

  await rm(aliasDirectory);
  await symlink(targetDirectory, aliasDirectory, "dir");
  await utimes(root, new Date(1), new Date(1));
  const replacementTracker = new AuditSourceTracker();
  await replacementTracker.read(requested);
  const replacement = replacementTracker
    .snapshot()
    .requestedPaths[0]!.lexicalChain.find(
      (component) => component.path === aliasDirectory
    )!;
  expect(replacement.parentMtimeNs).not.toBe(recorded.parentMtimeNs);

  recorded.birthtimeNs = replacement.birthtimeNs;
  recorded.ctimeNs = replacement.ctimeNs;
  recorded.dev = replacement.dev;
  recorded.ino = replacement.ino;
  recorded.kind = replacement.kind;
  recorded.linkTarget = replacement.linkTarget;
  recomputeValidationContract(snapshot);

  await expect(validateAuditSourceSnapshot(snapshot)).rejects.toThrow(
    "requested path changed"
  );
});

test("absence proofs reject same-target lexical symlink replacement", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "fclt-provenance-absence-same-target-link-")
  );
  const targetDirectory = join(root, "target");
  const aliasDirectory = join(root, "alias");
  const requested = join(aliasDirectory, "future.json");
  await mkdir(targetDirectory);
  await symlink(targetDirectory, aliasDirectory, "dir");
  const tracker = new AuditSourceTracker();
  await tracker.capture(requested);
  const snapshot = tracker.snapshot();
  const recorded = snapshot.absentPaths[0]!.lexicalChain.find(
    (component) => component.path === aliasDirectory
  )!;

  await rm(aliasDirectory);
  await symlink(targetDirectory, aliasDirectory, "dir");
  await utimes(root, new Date(1), new Date(1));
  const replacementTracker = new AuditSourceTracker();
  await replacementTracker.capture(requested);
  const replacement = replacementTracker
    .snapshot()
    .absentPaths[0]!.lexicalChain.find(
      (component) => component.path === aliasDirectory
    )!;
  expect(replacement.parentMtimeNs).not.toBe(recorded.parentMtimeNs);

  recorded.birthtimeNs = replacement.birthtimeNs;
  recorded.ctimeNs = replacement.ctimeNs;
  recorded.dev = replacement.dev;
  recorded.ino = replacement.ino;
  recorded.kind = replacement.kind;
  recorded.linkTarget = replacement.linkTarget;
  recomputeValidationContract(snapshot);

  await expect(validateAuditSourceSnapshot(snapshot)).rejects.toThrow(
    "absent requested path changed"
  );
});

test("recomputed contracts cannot shorten, reorder, or inject lexical chains", async () => {
  const { target } = await makeFileFixture(
    "fclt-provenance-lexical-chain-contract-"
  );
  const tracker = new AuditSourceTracker();
  await tracker.read(target);
  const valid = tracker.snapshot();
  const mutations: AuditSourceSnapshot[] = [];

  const shortened = structuredClone(valid);
  shortened.requestedPaths[0]!.lexicalChain.shift();
  mutations.push(recomputeValidationContract(shortened));

  const reordered = structuredClone(valid);
  reordered.requestedPaths[0]!.lexicalChain.reverse();
  mutations.push(recomputeValidationContract(reordered));

  const injected = structuredClone(valid);
  const injectedComponent = injected.requestedPaths[0]!
    .lexicalChain[0] as unknown as Record<string, unknown>;
  injectedComponent.unexpected = true;
  mutations.push(recomputeValidationContract(injected));

  const generationRoot = await mkdtemp(
    join(tmpdir(), "fclt-provenance-lexical-generation-")
  );
  const generationTargetDirectory = join(generationRoot, "target");
  const generationAliasDirectory = join(generationRoot, "alias");
  const generationTarget = join(generationTargetDirectory, "target.json");
  const generationAlias = join(generationAliasDirectory, "target.json");
  await mkdir(generationTargetDirectory);
  await writeFile(generationTarget, "{}\n");
  await symlink(generationTargetDirectory, generationAliasDirectory, "dir");
  const generationTracker = new AuditSourceTracker();
  await generationTracker.read(generationAlias);
  const missingGeneration = generationTracker.snapshot();
  const symlinkComponent =
    missingGeneration.requestedPaths[0]!.lexicalChain.find(
      (component) => component.path === generationAliasDirectory
    )!;
  Reflect.deleteProperty(symlinkComponent, "ctimeNs");
  mutations.push(recomputeValidationContract(missingGeneration));

  const extended = structuredClone(valid);
  extended.requestedPaths[0]!.lexicalChain.push({
    ...extended.requestedPaths[0]!.lexicalChain.at(-1)!,
  });
  mutations.push(recomputeValidationContract(extended));

  const impossibleIntermediate = structuredClone(valid);
  const traversed =
    impossibleIntermediate.requestedPaths[0]!.lexicalChain.at(-2)!;
  traversed.kind = "file";
  traversed.linkTarget = null;
  mutations.push(recomputeValidationContract(impossibleIntermediate));

  const absentTracker = new AuditSourceTracker();
  await absentTracker.capture(join(dirname(target), "missing.json"));
  const impossibleAbsence = absentTracker.snapshot();
  const absentAncestor = impossibleAbsence.absentPaths[0]!.lexicalChain.at(-1)!;
  absentAncestor.kind = "file";
  absentAncestor.linkTarget = null;
  mutations.push(recomputeValidationContract(impossibleAbsence));

  for (const snapshot of mutations) {
    expect(() => assertAuditSourceSnapshot(snapshot)).toThrow(
      "schema is unsupported"
    );
    await expect(validateAuditSourceSnapshot(snapshot)).rejects.toThrow(
      "schema is unsupported"
    );
  }
});
