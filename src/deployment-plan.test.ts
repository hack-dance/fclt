import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
  buildDeploymentPlan,
  type DeploymentPlanV1,
  type DeploymentStateV1,
  readStableRegularFileForTest,
  scanDeploymentStateDirectoryForTest,
  serializeDeploymentState,
} from "./deployment-plan";

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const DESTINATION_IDENTITY_RE =
  /^physical-path-v3:(?:posix|win32):[A-Za-z0-9_-]+$/;
const DESTINATION_COLLISION_KEY_RE =
  /^case-folded-path-v2:unicode-case-folding@1\.1\.1:.+/;
const SOURCE_DIR_SUFFIX_RE = /\/src$/;
const DOLLAR = "$";

interface Fixture {
  canonicalRoot: string;
  root: string;
  sourcePath: string;
  stateRoot: string;
  targetRoot: string;
}

async function createFixture(
  source = "# Work units\n\nKeep work explicit.\n"
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "fclt-deployment-plan-"));
  const canonicalRoot = join(root, ".ai");
  const sourcePath = join(canonicalRoot, "instructions", "WORK_UNITS.md");
  const targetRoot = join(root, "codex-home");
  const stateRoot = join(root, "state");
  await mkdir(dirname(sourcePath), { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  await Bun.write(sourcePath, source);
  return { canonicalRoot, root, sourcePath, stateRoot, targetRoot };
}

function planOptions(fixture: Fixture) {
  return {
    adapterVersion: "v1",
    asset: "instruction:WORK_UNITS",
    canonicalRoot: fixture.canonicalRoot,
    destination: "instructions/WORK_UNITS.md",
    expectedCurrentHash: null,
    plannerVersion: "2.24.1",
    scope: "global" as const,
    stateRoot: fixture.stateRoot,
    targetRoot: fixture.targetRoot,
    tool: "codex",
  };
}

function sha256(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function visit(pathValue: string, relativePath: string): Promise<void> {
    const stat = await lstat(pathValue).catch(() => null);
    if (!stat) {
      return;
    }
    const key = relativePath || ".";
    if (stat.isSymbolicLink()) {
      snapshot[key] = `symlink:${await readlink(pathValue)}`;
      return;
    }
    if (stat.isDirectory()) {
      snapshot[key] = "directory";
      for (const entry of (await readdir(pathValue)).sort()) {
        await visit(join(pathValue, entry), join(relativePath, entry));
      }
      return;
    }
    snapshot[key] = `file:${(await readFile(pathValue)).toString("base64")}`;
  }
  await visit(root, "");
  return snapshot;
}

function deploymentStateWrite(plan: Readonly<DeploymentPlanV1>): {
  path: string;
  state: DeploymentStateV1;
} {
  const write = plan.operations.writes.find(
    (candidate) => candidate.kind === "deployment-state"
  );
  if (!write || write.contentSource.kind !== "inline-state") {
    throw new Error("Expected deployment-state write");
  }
  return { path: write.path, state: write.contentSource.state };
}

async function materializePlanFixture(
  plan: Readonly<DeploymentPlanV1>
): Promise<void> {
  for (const write of plan.operations.writes) {
    await mkdir(dirname(write.path), { recursive: true });
    if (write.contentSource.kind === "path") {
      await Bun.write(write.path, await readFile(write.contentSource.path));
    } else {
      await Bun.write(
        write.path,
        serializeDeploymentState(write.contentSource.state)
      );
    }
  }
}

async function expectDeterministicReadOnlyFailure(args: {
  action: () => Promise<unknown>;
  message: string;
  root: string;
}): Promise<void> {
  const before = await snapshotTree(args.root);
  const messages: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await args.action();
      throw new Error("Expected planning to fail closed");
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      messages.push(error.message);
      if (!error.message.includes(args.message)) {
        throw new Error(
          `Expected failure containing ${args.message}, received ${error.message}`
        );
      }
    }
  }
  if (messages[1] !== messages[0]) {
    throw new Error("Repeated fail-closed planning was not deterministic");
  }
  if (
    JSON.stringify(await snapshotTree(args.root)) !== JSON.stringify(before)
  ) {
    throw new Error("Fail-closed planning mutated the fixture tree");
  }
}

async function runCli(args: string[]): Promise<{
  code: number;
  stderr: string;
  stdout: string;
}> {
  const child = Bun.spawn(["bun", "run", "./src/index.ts", ...args], {
    cwd: import.meta.dir.replace(SOURCE_DIR_SUFFIX_RE, ""),
    env: { ...globalThis.process.env },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { code, stderr, stdout };
}

describe("immutable per-asset deployment planning", () => {
  it("plans one global instruction into an isolated Codex home deterministically without mutation", async () => {
    const fixture = await createFixture();
    const generatedIndex = join(
      fixture.canonicalRoot,
      ".facult",
      "ai",
      "index.json"
    );
    await mkdir(dirname(generatedIndex), { recursive: true });
    await Bun.write(generatedIndex, '{"stale":true}\n');
    await rm(generatedIndex);
    const before = await snapshotTree(fixture.root);

    const first = await buildDeploymentPlan(planOptions(fixture));
    const second = await buildDeploymentPlan(planOptions(fixture));
    const after = await snapshotTree(fixture.root);

    expect(second).toEqual(first);
    expect(after).toEqual(before);
    expect(first.schemaVersion).toBe(1);
    expect(first.planner).toEqual({ name: "fclt", version: "2.24.1" });
    expect(first.planId).toMatch(SHA256_RE);
    expect(first.binding.asset).toEqual({
      kind: "instruction",
      selector: "instruction:WORK_UNITS",
      canonicalRef: "@ai/instructions/WORK_UNITS.md",
      path: fixture.sourcePath,
    });
    expect(first.binding.destination.path).toBe(
      join(fixture.targetRoot, "instructions", "WORK_UNITS.md")
    );
    expect(first.binding.destination.identity).toMatch(DESTINATION_IDENTITY_RE);
    expect(first.binding.destination.collisionKey).toMatch(
      DESTINATION_COLLISION_KEY_RE
    );
    expect(first.hashes.source).toBe(first.hashes.desired);
    expect(first.hashes.current).toBeNull();
    expect(first.ownerMode).toBe("unowned");
    expect(first.adapter).toEqual({ id: "codex", version: "v1" });
    expect(first.lossReport).toEqual({ lossless: true, entries: [] });
    expect(first.secretReferences).toEqual([]);
    expect(first.operations.reads.map((read) => read.kind)).toEqual([
      "canonical-source",
      "current-target",
      "ownership-directory",
      "deployment-state",
    ]);
    expect(first.operations.writes.map((write) => write.kind)).toEqual([
      "target",
      "deployment-state",
    ]);
    expect(first.operations.removals).toEqual([]);
    expect(first.operations.nativeCommands).toEqual([]);
    expect(first.verificationProbe).toEqual({
      kind: "file-sha256",
      path: join(fixture.targetRoot, "instructions", "WORK_UNITS.md"),
      expectedHash: first.hashes.desired,
    });
    expect(first.rollbackTarget).toEqual({
      kind: "absent",
      path: join(fixture.targetRoot, "instructions", "WORK_UNITS.md"),
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.operations.writes)).toBe(true);
  });

  it("proves the fclt 2.24.1 CLI consumer against an isolated Codex home", async () => {
    const fixture = await createFixture();
    const before = await snapshotTree(fixture.root);
    const result = await runCli([
      "deploy",
      "plan",
      "--asset",
      "instruction:WORK_UNITS",
      "--destination",
      "instructions/WORK_UNITS.md",
      "--tool",
      "codex",
      "--adapter-version",
      "v1",
      "--root",
      fixture.canonicalRoot,
      "--target-root",
      fixture.targetRoot,
      "--state-root",
      fixture.stateRoot,
      "--scope",
      "global",
      "--expected-current-hash",
      "absent",
      "--json",
    ]);
    const after = await snapshotTree(fixture.root);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    const plan = JSON.parse(result.stdout) as DeploymentPlanV1;
    expect(plan.planner.version).toBe("2.24.1");
    expect(plan.binding.destination.root).toBe(fixture.targetRoot);
    expect(plan.operations.writes.map((write) => write.kind)).toEqual([
      "target",
      "deployment-state",
    ]);
    expect(after).toEqual(before);
  });

  it("exposes no deployment apply executor", async () => {
    const result = await runCli(["deploy", "apply"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "deploy requires the read-only subcommand: plan\n"
    );
  });

  it("fails closed on stale source and current hashes", async () => {
    const fixture = await createFixture();
    await expect(
      buildDeploymentPlan({
        ...planOptions(fixture),
        expectedSourceHash: `sha256:${"0".repeat(64)}`,
      })
    ).rejects.toThrow("Stale source hash");

    const targetPath = join(
      fixture.targetRoot,
      "instructions",
      "WORK_UNITS.md"
    );
    await mkdir(dirname(targetPath), { recursive: true });
    await Bun.write(targetPath, "tampered\n");
    await expect(buildDeploymentPlan(planOptions(fixture))).rejects.toThrow(
      "Stale current hash"
    );
  });

  it("fails closed when owned target content was tampered with", async () => {
    const fixture = await createFixture();
    const first = await buildDeploymentPlan(planOptions(fixture));
    const stateWrite = deploymentStateWrite(first);
    await mkdir(dirname(stateWrite.path), { recursive: true });
    await Bun.write(stateWrite.path, `${JSON.stringify(stateWrite.state)}\n`);
    const targetPath = first.binding.destination.path;
    await mkdir(dirname(targetPath), { recursive: true });
    await Bun.write(targetPath, "not the planned content\n");

    await expect(
      buildDeploymentPlan({
        ...planOptions(fixture),
        expectedCurrentHash: undefined,
      })
    ).rejects.toThrow("Target tamper detected");
  });

  it("fails closed on corrupt deployment state", async () => {
    const fixture = await createFixture();
    const first = await buildDeploymentPlan(planOptions(fixture));
    const stateWrite = deploymentStateWrite(first);
    await mkdir(dirname(stateWrite.path), { recursive: true });
    await Bun.write(stateWrite.path, "{not-json\n");

    await expect(buildDeploymentPlan(planOptions(fixture))).rejects.toThrow(
      "Deployment state is corrupt JSON"
    );
  });

  it("rejects unknown persisted-state keys at root, binding, and rollback levels", async () => {
    const fixture = await createFixture();
    const initial = await buildDeploymentPlan(planOptions(fixture));
    await materializePlanFixture(initial);
    const stateWrite = deploymentStateWrite(initial);
    const variants: unknown[] = [
      { ...stateWrite.state, unexpectedRoot: true },
      {
        ...stateWrite.state,
        binding: { ...stateWrite.state.binding, unexpectedBinding: true },
      },
      {
        ...stateWrite.state,
        rollbackTarget: {
          ...stateWrite.state.rollbackTarget,
          unexpectedRollback: true,
        },
      },
    ];
    for (const variant of variants) {
      await Bun.write(stateWrite.path, `${JSON.stringify(variant)}\n`);
      await expectDeterministicReadOnlyFailure({
        action: async () =>
          await buildDeploymentPlan({
            ...planOptions(fixture),
            expectedCurrentHash: undefined,
          }),
        message: "Deployment state",
        root: fixture.root,
      });
    }
  });

  it("bounds deployment-state directory entry count before ownership selection", async () => {
    const fixture = await createFixture();
    const initial = await buildDeploymentPlan(planOptions(fixture));
    await materializePlanFixture(initial);
    const stateWrite = deploymentStateWrite(initial);
    const directory = dirname(stateWrite.path);
    for (let index = 0; index < 128; index += 1) {
      await Bun.write(
        join(directory, `extra-${index.toString().padStart(3, "0")}.json`),
        serializeDeploymentState(stateWrite.state)
      );
    }
    await expectDeterministicReadOnlyFailure({
      action: async () =>
        await buildDeploymentPlan({
          ...planOptions(fixture),
          expectedCurrentHash: undefined,
        }),
      message: "exceeds the 128-record limit",
      root: fixture.root,
    });
  });

  it("bounds each deployment-state record before retaining or parsing it", async () => {
    const fixture = await createFixture();
    const initial = await buildDeploymentPlan(planOptions(fixture));
    await materializePlanFixture(initial);
    const stateWrite = deploymentStateWrite(initial);
    const serialized = serializeDeploymentState(stateWrite.state);
    await Bun.write(stateWrite.path, `${serialized}${" ".repeat(256 * 1024)}`);
    await expectDeterministicReadOnlyFailure({
      action: async () =>
        await buildDeploymentPlan({
          ...planOptions(fixture),
          expectedCurrentHash: undefined,
        }),
      message: "exceeds the 262144-byte planning read limit",
      root: fixture.root,
    });
  });

  it("bounds cumulative deployment-state bytes across duplicate and unowned records", async () => {
    const fixture = await createFixture();
    const initial = await buildDeploymentPlan(planOptions(fixture));
    await materializePlanFixture(initial);
    const stateWrite = deploymentStateWrite(initial);
    const directory = dirname(stateWrite.path);
    const unownedTargetRoot = join(fixture.root, "unowned-codex-home");
    await mkdir(unownedTargetRoot);
    const unownedPlan = await buildDeploymentPlan({
      ...planOptions(fixture),
      targetRoot: unownedTargetRoot,
    });
    const serialized = serializeDeploymentState(
      deploymentStateWrite(unownedPlan).state
    );
    const recordBytes = `${serialized}${" ".repeat(245_000 - serialized.length)}`;
    for (let index = 0; index < 18; index += 1) {
      await Bun.write(
        join(directory, `aggregate-${index.toString().padStart(2, "0")}.json`),
        recordBytes
      );
    }
    await expectDeterministicReadOnlyFailure({
      action: async () =>
        await buildDeploymentPlan({
          ...planOptions(fixture),
          expectedCurrentHash: undefined,
        }),
      message: "exceed the 4194304-byte aggregate limit",
      root: fixture.root,
    });
  });

  it("rejects relative, cwd-dependent, unnormalized, and NUL persisted paths", async () => {
    const fixture = await createFixture();
    const initial = await buildDeploymentPlan(planOptions(fixture));
    await materializePlanFixture(initial);
    const stateWrite = deploymentStateWrite(initial);
    const targetPath = initial.binding.destination.path;
    const relativeTarget = relative(fixture.root, targetPath);
    const relativeState: DeploymentStateV1 = {
      ...stateWrite.state,
      binding: {
        ...stateWrite.state.binding,
        destinationPath: relativeTarget,
      },
      rollbackTarget: { kind: "absent", path: relativeTarget },
    };
    await Bun.write(stateWrite.path, serializeDeploymentState(relativeState));

    const originalCwd = process.cwd();
    const beforeRelative = await snapshotTree(fixture.root);
    try {
      for (const cwd of [fixture.root, dirname(fixture.root)]) {
        process.chdir(cwd);
        await expect(
          buildDeploymentPlan({
            ...planOptions(fixture),
            expectedCurrentHash: undefined,
          })
        ).rejects.toThrow(
          "Persisted destination path must be an absolute normalized safe path"
        );
      }
    } finally {
      process.chdir(originalCwd);
    }
    expect(await snapshotTree(fixture.root)).toEqual(beforeRelative);

    const relativeRollbackState: DeploymentStateV1 = {
      ...stateWrite.state,
      rollbackTarget: {
        kind: "snapshot",
        path: "rollback/snapshot",
        expectedHash: stateWrite.state.desiredHash,
      },
    };
    await Bun.write(
      stateWrite.path,
      serializeDeploymentState(relativeRollbackState)
    );
    const beforeRelativeRollback = await snapshotTree(fixture.root);
    await expect(
      buildDeploymentPlan({
        ...planOptions(fixture),
        expectedCurrentHash: undefined,
      })
    ).rejects.toThrow(
      "Persisted rollback path must be an absolute normalized safe path"
    );
    expect(await snapshotTree(fixture.root)).toEqual(beforeRelativeRollback);

    const unnormalizedTarget = `${dirname(targetPath)}/nested/../${basename(targetPath)}`;
    const unnormalizedState: DeploymentStateV1 = {
      ...stateWrite.state,
      binding: {
        ...stateWrite.state.binding,
        destinationPath: unnormalizedTarget,
      },
      rollbackTarget: { kind: "absent", path: unnormalizedTarget },
    };
    await Bun.write(
      stateWrite.path,
      serializeDeploymentState(unnormalizedState)
    );
    const beforeUnnormalized = await snapshotTree(fixture.root);
    await expect(
      buildDeploymentPlan({
        ...planOptions(fixture),
        expectedCurrentHash: undefined,
      })
    ).rejects.toThrow(
      "Persisted destination path must be an absolute normalized safe path"
    );
    expect(await snapshotTree(fixture.root)).toEqual(beforeUnnormalized);

    const nulRollbackState: DeploymentStateV1 = {
      ...stateWrite.state,
      rollbackTarget: {
        kind: "snapshot",
        path: `${targetPath}\0snapshot`,
        expectedHash: stateWrite.state.desiredHash,
      },
    };
    await Bun.write(
      stateWrite.path,
      serializeDeploymentState(nulRollbackState)
    );
    const beforeNul = await snapshotTree(fixture.root);
    await expect(
      buildDeploymentPlan({
        ...planOptions(fixture),
        expectedCurrentHash: undefined,
      })
    ).rejects.toThrow(
      "Persisted rollback path must be an absolute normalized safe path"
    );
    expect(await snapshotTree(fixture.root)).toEqual(beforeNul);
  });

  it("fails closed on an escaped rollback target in otherwise valid owned state", async () => {
    const fixture = await createFixture();
    const first = await buildDeploymentPlan(planOptions(fixture));
    const stateWrite = deploymentStateWrite(first);
    const escapedState: DeploymentStateV1 = {
      ...stateWrite.state,
      rollbackTarget: {
        kind: "snapshot",
        path: join(fixture.root, "outside-rollback"),
        expectedHash: stateWrite.state.desiredHash,
      },
    };
    await mkdir(dirname(stateWrite.path), { recursive: true });
    await Bun.write(stateWrite.path, `${JSON.stringify(escapedState)}\n`);
    await mkdir(dirname(first.binding.destination.path), { recursive: true });
    await Bun.write(
      first.binding.destination.path,
      await readFile(fixture.sourcePath)
    );

    await expect(
      buildDeploymentPlan({
        ...planOptions(fixture),
        expectedCurrentHash: undefined,
      })
    ).rejects.toThrow("escapes its root");
  });

  it("preserves an absent rollback target across post-apply no-op and update replans", async () => {
    const fixture = await createFixture();
    const initial = await buildDeploymentPlan(planOptions(fixture));
    await materializePlanFixture(initial);

    const options = {
      ...planOptions(fixture),
      expectedCurrentHash: undefined,
    };
    const beforeNoOp = await snapshotTree(fixture.root);
    const firstNoOp = await buildDeploymentPlan(options);
    const secondNoOp = await buildDeploymentPlan(options);
    const afterNoOp = await snapshotTree(fixture.root);

    expect(afterNoOp).toEqual(beforeNoOp);
    expect(secondNoOp).toEqual(firstNoOp);
    expect(firstNoOp.ownerMode).toBe("fclt-owned");
    expect(firstNoOp.rollbackTarget).toEqual(initial.rollbackTarget);
    expect(firstNoOp.operations.writes).toEqual([]);

    await Bun.write(fixture.sourcePath, "# Updated\n\nNew desired content.\n");
    const beforeUpdatePlan = await snapshotTree(fixture.root);
    const update = await buildDeploymentPlan(options);
    const afterUpdatePlan = await snapshotTree(fixture.root);

    expect(afterUpdatePlan).toEqual(beforeUpdatePlan);
    expect(update.rollbackTarget).toEqual(initial.rollbackTarget);
    expect(update.operations.writes.map((write) => write.kind)).toEqual([
      "target",
      "deployment-state",
    ]);
    expect(
      update.operations.writes.some(
        (write) => write.kind === "rollback-snapshot"
      )
    ).toBe(false);
  });

  it("preserves and verifies the original snapshot rollback across owned replans", async () => {
    const fixture = await createFixture();
    const targetPath = join(
      fixture.targetRoot,
      "instructions",
      "WORK_UNITS.md"
    );
    const legacy = "legacy user content\n";
    await mkdir(dirname(targetPath), { recursive: true });
    await Bun.write(targetPath, legacy);
    const initial = await buildDeploymentPlan({
      ...planOptions(fixture),
      expectedCurrentHash: sha256(legacy),
    });
    expect(initial.rollbackTarget.kind).toBe("snapshot");
    await materializePlanFixture(initial);

    const options = {
      ...planOptions(fixture),
      expectedCurrentHash: undefined,
    };
    const before = await snapshotTree(fixture.root);
    const noOp = await buildDeploymentPlan(options);
    const after = await snapshotTree(fixture.root);
    expect(after).toEqual(before);
    expect(noOp.rollbackTarget).toEqual(initial.rollbackTarget);
    expect(noOp.operations.writes).toEqual([]);
    expect(
      noOp.operations.reads.find((read) => read.kind === "rollback-snapshot")
    ).toMatchObject({
      required: true,
      expectedHash: sha256(legacy),
    });

    if (initial.rollbackTarget.kind !== "snapshot") {
      throw new Error("Expected snapshot rollback target");
    }
    await rm(initial.rollbackTarget.path);
    await expect(buildDeploymentPlan(options)).rejects.toThrow(
      "Rollback snapshot is missing"
    );
    await Bun.write(initial.rollbackTarget.path, "tampered snapshot\n");
    await expect(buildDeploymentPlan(options)).rejects.toThrow(
      "Rollback snapshot tamper detected"
    );
  });

  it("enforces one destination ownership record and rejects implicit transfers", async () => {
    const fixture = await createFixture();
    const initial = await buildDeploymentPlan(planOptions(fixture));
    await materializePlanFixture(initial);
    const stateWrite = deploymentStateWrite(initial);

    const secondSource = join(
      fixture.canonicalRoot,
      "instructions",
      "SECOND.md"
    );
    await Bun.write(secondSource, await readFile(fixture.sourcePath));
    await expect(
      buildDeploymentPlan({
        ...planOptions(fixture),
        asset: "instruction:SECOND",
        expectedCurrentHash: undefined,
      })
    ).rejects.toThrow("future explicit migration/transfer command");

    const changedAdapterState: DeploymentStateV1 = {
      ...stateWrite.state,
      binding: { ...stateWrite.state.binding, adapterVersion: "v0" },
    };
    await Bun.write(
      stateWrite.path,
      serializeDeploymentState(changedAdapterState)
    );
    await expect(
      buildDeploymentPlan({
        ...planOptions(fixture),
        expectedCurrentHash: undefined,
      })
    ).rejects.toThrow("future explicit migration/transfer command");

    await Bun.write(
      stateWrite.path,
      serializeDeploymentState(stateWrite.state)
    );
    const orphanPath = join(dirname(stateWrite.path), "orphan.json");
    await Bun.write(orphanPath, serializeDeploymentState(stateWrite.state));
    await expect(
      buildDeploymentPlan({
        ...planOptions(fixture),
        expectedCurrentHash: undefined,
      })
    ).rejects.toThrow("Conflicting deployment ownership claims");

    await rm(stateWrite.path);
    await expect(
      buildDeploymentPlan({
        ...planOptions(fixture),
        expectedCurrentHash: undefined,
      })
    ).rejects.toThrow("Orphaned deployment ownership claim");
  });

  it("uses one ownership identity through a portable realpath alias", async () => {
    const fixture = await createFixture();
    const initial = await buildDeploymentPlan(planOptions(fixture));
    await materializePlanFixture(initial);

    const aliasRoot = join(
      dirname(fixture.root),
      `${basename(fixture.root)}-alias`
    );
    await symlink(fixture.root, aliasRoot);
    const before = await snapshotTree(fixture.root);
    const aliasPlan = await buildDeploymentPlan({
      ...planOptions(fixture),
      expectedCurrentHash: undefined,
      targetRoot: join(aliasRoot, "codex-home"),
    });
    const after = await snapshotTree(fixture.root);

    expect(after).toEqual(before);
    expect(aliasPlan.binding.destination.path).not.toBe(
      initial.binding.destination.path
    );
    expect(aliasPlan.binding.destination.identity).toBe(
      initial.binding.destination.identity
    );
    expect(aliasPlan.binding.destination.collisionKey).toBe(
      initial.binding.destination.collisionKey
    );
    expect(aliasPlan.ownerMode).toBe("fclt-owned");
    expect(aliasPlan.rollbackTarget).toEqual(initial.rollbackTarget);
    expect(aliasPlan.operations.writes).toEqual([]);
    expect(
      aliasPlan.operations.reads.find(
        (read) => read.kind === "deployment-state"
      )?.path
    ).toBe(deploymentStateWrite(initial).path);
  });

  it("keeps POSIX backslash paths lossless while failing closed on portable collisions", async () => {
    if (process.platform === "win32") {
      return;
    }
    const fixture = await createFixture();
    const backslashRoot = join(fixture.root, "tool\\home");
    const slashRoot = join(fixture.root, "tool", "home");
    await mkdir(backslashRoot, { recursive: true });
    await mkdir(slashRoot, { recursive: true });
    const [backslashStat, slashStat] = await Promise.all([
      lstat(backslashRoot),
      lstat(slashRoot),
    ]);
    expect(backslashRoot).not.toBe(slashRoot);
    expect(await readdir(fixture.root)).toContain("tool\\home");
    expect([backslashStat.dev, backslashStat.ino]).not.toEqual([
      slashStat.dev,
      slashStat.ino,
    ]);

    const beforeInitialPlan = await snapshotTree(fixture.root);
    let initial: Readonly<DeploymentPlanV1>;
    try {
      initial = await buildDeploymentPlan({
        ...planOptions(fixture),
        targetRoot: backslashRoot,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "identity cannot be established safely"
      );
      expect(await snapshotTree(fixture.root)).toEqual(beforeInitialPlan);
      return;
    }
    await materializePlanFixture(initial);
    const encodedPath = initial.binding.destination.identity.split(":").at(-1);
    expect(encodedPath).toBeTruthy();
    expect(Buffer.from(encodedPath ?? "", "base64url").toString("utf8")).toBe(
      await realpath(initial.binding.destination.path)
    );

    const before = await snapshotTree(fixture.root);
    await expect(
      buildDeploymentPlan({
        ...planOptions(fixture),
        targetRoot: slashRoot,
      })
    ).rejects.toThrow("Case-folded destination collision is ambiguous");
    expect(await snapshotTree(fixture.root)).toEqual(before);
  });

  it("keeps normalization-distinct paths lossless where the filesystem preserves them", async () => {
    if (process.platform === "win32") {
      return;
    }
    const fixture = await createFixture();
    const composedRoot = join(fixture.root, "tool-\u00e9");
    const decomposedRoot = join(fixture.root, "tool-e\u0301");
    await mkdir(composedRoot, { recursive: true });
    await mkdir(decomposedRoot, { recursive: true });
    const [composedStat, decomposedStat] = await Promise.all([
      lstat(composedRoot),
      lstat(decomposedRoot),
    ]);
    if (
      composedStat.dev === decomposedStat.dev &&
      composedStat.ino === decomposedStat.ino
    ) {
      return;
    }
    const [composedRealpath, decomposedRealpath] = await Promise.all([
      realpath(composedRoot),
      realpath(decomposedRoot),
    ]);
    expect(composedRealpath).not.toBe(decomposedRealpath);
    expect([composedStat.dev, composedStat.ino]).not.toEqual([
      decomposedStat.dev,
      decomposedStat.ino,
    ]);

    const initial = await buildDeploymentPlan({
      ...planOptions(fixture),
      targetRoot: composedRoot,
    });
    await materializePlanFixture(initial);
    const encodedPath = initial.binding.destination.identity.split(":").at(-1);
    expect(encodedPath).toBeTruthy();
    expect(Buffer.from(encodedPath ?? "", "base64url").toString("utf8")).toBe(
      await realpath(initial.binding.destination.path)
    );
    const before = await snapshotTree(fixture.root);
    await expect(
      buildDeploymentPlan({
        ...planOptions(fixture),
        targetRoot: decomposedRoot,
      })
    ).rejects.toThrow("Case-folded destination collision is ambiguous");
    expect(await snapshotTree(fixture.root)).toEqual(before);
  });

  it("uses pinned full Unicode folding for sharp-s, sigma classes, and normalization interactions", async () => {
    const collisionClasses = [
      ["tool-Straße", "tool-STRASSE"],
      ["tool-Σ", "tool-σ", "tool-ς"],
      ["tool-Straße-é", "tool-STRASSE-e\u0301"],
    ];
    for (const names of collisionClasses) {
      const fixture = await createFixture();
      const roots = names.map((name) => join(fixture.root, name));
      for (const root of roots) {
        await mkdir(root, { recursive: true });
      }
      const plans: Readonly<DeploymentPlanV1>[] = [];
      for (const targetRoot of roots) {
        plans.push(
          await buildDeploymentPlan({
            ...planOptions(fixture),
            targetRoot,
          })
        );
      }
      expect(
        new Set(plans.map((plan) => plan.binding.destination.collisionKey)).size
      ).toBe(1);
      for (const plan of plans) {
        expect(plan.binding.destination.collisionKey).toMatch(
          DESTINATION_COLLISION_KEY_RE
        );
      }

      const initialPlan = plans[0];
      if (!initialPlan) {
        throw new Error("Expected a Unicode collision-class fixture plan");
      }
      await materializePlanFixture(initialPlan);
      for (let index = 1; index < plans.length; index += 1) {
        if (
          plans[index]?.binding.destination.identity ===
          initialPlan.binding.destination.identity
        ) {
          continue;
        }
        await expectDeterministicReadOnlyFailure({
          action: async () =>
            await buildDeploymentPlan({
              ...planOptions(fixture),
              expectedCurrentHash: undefined,
              targetRoot: roots[index] ?? "",
            }),
          message: "Case-folded destination collision is ambiguous",
          root: fixture.root,
        });
      }
    }
  });

  it("coalesces case-only destination aliases on case-insensitive filesystems", async () => {
    const fixture = await createFixture();
    const initial = await buildDeploymentPlan(planOptions(fixture));
    await materializePlanFixture(initial);

    const originalPath = initial.binding.destination.path;
    const caseAliasPath = join(
      fixture.targetRoot,
      "instructions",
      "work_units.md"
    );
    const [originalStat, aliasStat] = await Promise.all([
      lstat(originalPath),
      lstat(caseAliasPath).catch(() => null),
    ]);
    if (
      !aliasStat ||
      originalStat.dev !== aliasStat.dev ||
      originalStat.ino !== aliasStat.ino
    ) {
      return;
    }

    const before = await snapshotTree(fixture.root);
    const aliasPlan = await buildDeploymentPlan({
      ...planOptions(fixture),
      destination: "instructions/work_units.md",
      expectedCurrentHash: undefined,
    });
    const after = await snapshotTree(fixture.root);

    expect(after).toEqual(before);
    expect(aliasPlan.binding.destination.identity).toBe(
      initial.binding.destination.identity
    );
    expect(aliasPlan.binding.destination.collisionKey).toBe(
      initial.binding.destination.collisionKey
    );
    expect(aliasPlan.ownerMode).toBe("fclt-owned");
    expect(aliasPlan.operations.writes).toEqual([]);
  });

  it("rejects distinct case-only files on case-sensitive filesystems", async () => {
    const fixture = await createFixture();
    const initial = await buildDeploymentPlan(planOptions(fixture));
    await materializePlanFixture(initial);

    const originalPath = initial.binding.destination.path;
    const caseCollisionPath = join(
      fixture.targetRoot,
      "instructions",
      "work_units.md"
    );
    const [originalStat, collisionStat] = await Promise.all([
      lstat(originalPath),
      lstat(caseCollisionPath).catch(() => null),
    ]);
    if (
      collisionStat &&
      originalStat.dev === collisionStat.dev &&
      originalStat.ino === collisionStat.ino
    ) {
      return;
    }

    await Bun.write(caseCollisionPath, await readFile(fixture.sourcePath));
    const before = await snapshotTree(fixture.root);
    await expect(
      buildDeploymentPlan({
        ...planOptions(fixture),
        destination: "instructions/work_units.md",
        expectedCurrentHash: undefined,
      })
    ).rejects.toThrow("Case-folded destination collision is ambiguous");
    const after = await snapshotTree(fixture.root);
    expect(after).toEqual(before);
  });

  it("rejects a corrupt persisted collision key before selecting case competitors", async () => {
    const fixture = await createFixture();
    const initial = await buildDeploymentPlan(planOptions(fixture));
    await materializePlanFixture(initial);
    const originalPath = initial.binding.destination.path;
    const competitorPath = join(
      fixture.targetRoot,
      "instructions",
      "work_units.md"
    );
    const [originalStat, competitorStat] = await Promise.all([
      lstat(originalPath),
      lstat(competitorPath).catch(() => null),
    ]);
    if (
      competitorStat &&
      originalStat.dev === competitorStat.dev &&
      originalStat.ino === competitorStat.ino
    ) {
      return;
    }

    await Bun.write(competitorPath, await readFile(fixture.sourcePath));
    const stateWrite = deploymentStateWrite(initial);
    const corruptState: DeploymentStateV1 = {
      ...stateWrite.state,
      binding: {
        ...stateWrite.state.binding,
        destinationCollisionKey:
          "case-folded-path-v2:unicode-case-folding@1.1.1:corrupt",
      },
    };
    await Bun.write(stateWrite.path, serializeDeploymentState(corruptState));
    const before = await snapshotTree(fixture.root);
    await expect(
      buildDeploymentPlan({
        ...planOptions(fixture),
        destination: "instructions/work_units.md",
        expectedCurrentHash: undefined,
      })
    ).rejects.toThrow("Deployment state has a corrupt destination identity");
    expect(await snapshotTree(fixture.root)).toEqual(before);
  });

  it("supports multiple target roots in one shared deployment state root", async () => {
    const fixture = await createFixture();
    const first = await buildDeploymentPlan(planOptions(fixture));
    await materializePlanFixture(first);

    const secondTargetRoot = join(fixture.root, "second-codex-home");
    await mkdir(secondTargetRoot);
    const secondOptions = {
      ...planOptions(fixture),
      targetRoot: secondTargetRoot,
    };
    const beforeSecondPlan = await snapshotTree(fixture.root);
    const second = await buildDeploymentPlan(secondOptions);
    const afterSecondPlan = await snapshotTree(fixture.root);

    expect(afterSecondPlan).toEqual(beforeSecondPlan);
    expect(second.ownerMode).toBe("unowned");
    expect(second.binding.destination.identity).not.toBe(
      first.binding.destination.identity
    );
    expect(deploymentStateWrite(second).path).not.toBe(
      deploymentStateWrite(first).path
    );
    await materializePlanFixture(second);

    const firstNoOp = await buildDeploymentPlan({
      ...planOptions(fixture),
      expectedCurrentHash: undefined,
    });
    const secondNoOp = await buildDeploymentPlan({
      ...secondOptions,
      expectedCurrentHash: undefined,
    });
    expect(firstNoOp.operations.writes).toEqual([]);
    expect(secondNoOp.operations.writes).toEqual([]);
  });

  it("anchors state enumeration and record opens against whole-directory substitution", async () => {
    const fixture = await createFixture();
    const initial = await buildDeploymentPlan(planOptions(fixture));
    await materializePlanFixture(initial);
    const stateWrite = deploymentStateWrite(initial);
    const directory = dirname(stateWrite.path);
    const parkedDirectory = join(fixture.stateRoot, "parked-deployments");
    const substituteDirectory = join(
      fixture.stateRoot,
      "substitute-deployments"
    );
    const activeSubstitute = join(fixture.stateRoot, "active-substitute");
    const substitutedState: DeploymentStateV1 = {
      ...stateWrite.state,
      desiredHash: `sha256:${"0".repeat(64)}`,
    };
    await mkdir(substituteDirectory);
    await Bun.write(
      join(substituteDirectory, basename(stateWrite.path)),
      serializeDeploymentState(substitutedState)
    );
    const before = await snapshotTree(fixture.root);
    let swapped = false;
    try {
      await expect(
        scanDeploymentStateDirectoryForTest({
          afterEnumeration: async () => {
            await rename(directory, parkedDirectory);
            await rename(substituteDirectory, directory);
            swapped = true;
          },
          directory,
          expectedPath: stateWrite.path,
          requestedBinding: stateWrite.state.binding,
          stateRoot: fixture.stateRoot,
        })
      ).rejects.toThrow("Deployment state path changed during planning");
    } finally {
      if (swapped) {
        await rename(directory, activeSubstitute);
        await rename(parkedDirectory, directory);
        await rename(activeSubstitute, substituteDirectory);
      }
    }
    expect(await snapshotTree(fixture.root)).toEqual(before);
  });

  it("rejects descriptor replacement races for every planner file role", async () => {
    const fixture = await createFixture();
    const labels = [
      "Canonical source",
      "Current target",
      "Deployment state",
      "Rollback snapshot",
    ];
    for (const [index, label] of labels.entries()) {
      const root = join(fixture.root, `replacement-race-${index}`);
      const path = join(root, "observed");
      const replacement = join(root, "replacement");
      await mkdir(root);
      await Bun.write(path, "before\n");
      await Bun.write(replacement, "after!\n");
      const beforeStat = await lstat(path);

      await expect(
        readStableRegularFileForTest({
          afterOpen: async () => {
            await rm(path);
            await rename(replacement, path);
          },
          label,
          path,
          root,
        })
      ).rejects.toThrow(`${label} changed`);
      const afterStat = await lstat(path);
      expect([afterStat.dev, afterStat.ino]).not.toEqual([
        beforeStat.dev,
        beforeStat.ino,
      ]);
    }
  });

  it("rejects final-component symlink swaps for every planner file role", async () => {
    if (process.platform === "win32") {
      return;
    }
    const fixture = await createFixture();
    const labels = [
      "Canonical source",
      "Current target",
      "Deployment state",
      "Rollback snapshot",
    ];
    for (const [index, label] of labels.entries()) {
      const root = join(fixture.root, `symlink-race-${index}`);
      const path = join(root, "observed");
      const parked = join(root, "parked");
      const replacement = join(root, "replacement");
      await mkdir(root);
      await Bun.write(path, "before\n");
      await Bun.write(replacement, "after!\n");

      await expect(
        readStableRegularFileForTest({
          afterOpen: async () => {
            await rename(path, parked);
            await symlink(basename(replacement), path);
          },
          label,
          path,
          root,
        })
      ).rejects.toThrow(`${label} changed`);
      expect((await lstat(path)).isSymbolicLink()).toBe(true);
      await expect(
        readStableRegularFileForTest({
          afterOpen: async () => undefined,
          label,
          path,
          root,
        })
      ).rejects.toThrow("regular non-symlink file");
    }
  });

  it("fails closed on path traversal and symlink escape", async () => {
    const fixture = await createFixture();
    await expect(
      buildDeploymentPlan({
        ...planOptions(fixture),
        destination: "../escape.md",
      })
    ).rejects.toThrow("safe relative path");

    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    await symlink(outside, join(fixture.targetRoot, "instructions"));
    await expect(buildDeploymentPlan(planOptions(fixture))).rejects.toThrow(
      "traverses a symlink"
    );

    const blocked = await createFixture();
    await Bun.write(join(blocked.targetRoot, "blocked"), "not a directory\n");
    await expect(
      buildDeploymentPlan({
        ...planOptions(blocked),
        destination: "blocked/WORK_UNITS.md",
      })
    ).rejects.toThrow("identity cannot be established safely");
  });

  it("fails closed on unsupported adapter versions, unresolved variables, and lossy translation", async () => {
    const fixture = await createFixture(`Use ${DOLLAR}{HOME}.\n`);
    await expect(
      buildDeploymentPlan({ ...planOptions(fixture), adapterVersion: "v999" })
    ).rejects.toThrow("Unsupported codex adapter version");
    await expect(buildDeploymentPlan(planOptions(fixture))).rejects.toThrow(
      "Invalid interpolation at line 1, column 5 (expression redacted)."
    );

    const clean = await createFixture();
    await expect(
      buildDeploymentPlan({
        ...planOptions(clean),
        translation: {
          desiredContent: new TextEncoder().encode("translated\n"),
          lossReport: {
            lossless: false,
            entries: [
              {
                code: "dropped-frontmatter",
                message: "Frontmatter was dropped.",
              },
            ],
          },
        },
      })
    ).rejects.toThrow("Lossy translation");
  });

  it("reports secret references without reading or emitting their values", async () => {
    const fixture = await createFixture(
      `Token: ${DOLLAR}{secret:API_TOKEN}\nVault: op://Engineering/Codex/token\n`
    );
    const previous = process.env.API_TOKEN;
    process.env.API_TOKEN = "must-never-appear";
    try {
      const plan = await buildDeploymentPlan(planOptions(fixture));
      expect(plan.secretReferences).toEqual([
        { kind: "environment", name: "API_TOKEN" },
        { kind: "one-password", reference: "op://Engineering/Codex/token" },
      ]);
      expect(JSON.stringify(plan)).not.toContain("must-never-appear");
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, "API_TOKEN");
      } else {
        process.env.API_TOKEN = previous;
      }
    }
  });

  it("keeps planner provenance deterministic despite ambient package-manager variables", async () => {
    const fixture = await createFixture();
    const priorFacultVersion = process.env.FACULT_NPM_PACKAGE_VERSION;
    const priorNpmVersion = process.env.npm_package_version;
    try {
      process.env.FACULT_NPM_PACKAGE_VERSION = "99.0.0";
      process.env.npm_package_version = "98.0.0";
      const first = await buildDeploymentPlan({
        ...planOptions(fixture),
        plannerVersion: undefined,
      });
      process.env.FACULT_NPM_PACKAGE_VERSION = "1.0.0";
      process.env.npm_package_version = "2.0.0";
      const second = await buildDeploymentPlan({
        ...planOptions(fixture),
        plannerVersion: undefined,
      });
      expect(second).toEqual(first);
      expect(second.planner.version).toBe("2.24.1");
      await expect(
        buildDeploymentPlan({
          ...planOptions(fixture),
          plannerVersion: "2.24.0",
        })
      ).rejects.toThrow("does not match the authoritative fclt version");
    } finally {
      if (priorFacultVersion === undefined) {
        Reflect.deleteProperty(process.env, "FACULT_NPM_PACKAGE_VERSION");
      } else {
        process.env.FACULT_NPM_PACKAGE_VERSION = priorFacultVersion;
      }
      if (priorNpmVersion === undefined) {
        Reflect.deleteProperty(process.env, "npm_package_version");
      } else {
        process.env.npm_package_version = priorNpmVersion;
      }
    }
  });

  it("redacts malformed interpolation expressions from CLI stderr", async () => {
    const fallbackLiteral = "credential-literal-must-not-leak";
    const fixture = await createFixture(
      `Token: ${DOLLAR}{secret:API_TOKEN:-${fallbackLiteral}}\n`
    );
    const before = await snapshotTree(fixture.root);
    const result = await runCli([
      "deploy",
      "plan",
      "--asset",
      "instruction:WORK_UNITS",
      "--destination",
      "instructions/WORK_UNITS.md",
      "--tool",
      "codex",
      "--adapter-version",
      "v1",
      "--root",
      fixture.canonicalRoot,
      "--target-root",
      fixture.targetRoot,
      "--state-root",
      fixture.stateRoot,
      "--expected-current-hash",
      "absent",
      "--json",
    ]);
    const after = await snapshotTree(fixture.root);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Invalid interpolation at line 1, column 8 (expression redacted).\n"
    );
    expect(result.stderr).not.toContain("API_TOKEN");
    expect(result.stderr).not.toContain(fallbackLiteral);
    expect(result.stderr).not.toContain("secret:");
    expect(after).toEqual(before);

    await Bun.write(fixture.sourcePath, `Token: ${DOLLAR}{secret:API_TOKEN`);
    await expect(buildDeploymentPlan(planOptions(fixture))).rejects.toThrow(
      "Invalid interpolation at line 1, column 8 (expression redacted)."
    );
  });
});
