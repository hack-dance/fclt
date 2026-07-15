import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  buildDeploymentPlan,
  type DeploymentPlanV1,
  type DeploymentStateV1,
  serializeDeploymentState,
} from "./deployment-plan";

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const DESTINATION_IDENTITY_RE = /^physical-path-v1:.+/;
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
    expect(aliasPlan.ownerMode).toBe("fclt-owned");
    expect(aliasPlan.rollbackTarget).toEqual(initial.rollbackTarget);
    expect(aliasPlan.operations.writes).toEqual([]);
    expect(
      aliasPlan.operations.reads.find(
        (read) => read.kind === "deployment-state"
      )?.path
    ).toBe(deploymentStateWrite(initial).path);
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
    expect(aliasPlan.ownerMode).toBe("fclt-owned");
    expect(aliasPlan.operations.writes).toEqual([]);
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
