import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuditSourceSnapshot,
  AuditSourceTracker,
  assertAuditSourceSnapshot,
  validateAuditSourceSnapshot,
} from "./source-provenance";

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

test("absence proofs canonicalize an ancestor alias without duplicate records", async () => {
  const root = await mkdtemp(join(tmpdir(), "fclt-provenance-absence-alias-"));
  const targetDirectory = join(root, "target");
  const aliasDirectory = join(root, "alias");
  await mkdir(targetDirectory);
  await symlink(targetDirectory, aliasDirectory, "dir");
  const tracker = new AuditSourceTracker();

  await tracker.capture(join(targetDirectory, "missing.json"));
  await tracker.capture(join(aliasDirectory, "missing.json"));
  expect(tracker.snapshot().absentPaths).toHaveLength(1);

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
    "derived context changed"
  );
});
