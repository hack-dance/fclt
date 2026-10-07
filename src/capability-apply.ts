import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  capabilityCollisionPath,
  optionalStat,
  safeCapabilityPath,
  snapshotCapability,
  stageCapability,
} from "./capability-files";
import {
  buildCapabilityPlan,
  type CapabilityContext,
  type CapabilityPlan,
  type CapabilityReceipt,
} from "./capability-plan";
import { hashCapability } from "./capability-registry";

const APPLY_STATUSES = new Set([
  "create",
  "restore",
  "adopt",
  "update",
  "current",
]);
export async function applyCapability(
  options: CapabilityContext,
  id: string,
  expectedPlan: string
) {
  const initial = await buildCapabilityPlan(options, id);
  assertApplicable(initial, expectedPlan);
  if (initial.status === "current") {
    return { ...initial, applied: false, recoveryPath: null };
  }
  const parent = dirname(initial.targetPath!);
  await safeCapabilityPath(parent);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await safeCapabilityPath(parent);
  const lock = join(
    parent,
    `.fclt-${hashCapability(capabilityCollisionPath(initial.targetPath!)).slice(7)}.lock`
  );
  await mkdir(lock, { mode: 0o700 });
  let transaction: string | null = null;
  let recoveryPath: string | null = null;
  let installed = false;
  try {
    const plan = await buildCapabilityPlan(options, id);
    assertApplicable(plan, expectedPlan);
    const snapshot = await snapshotCapability(plan.sourcePath!);
    if (snapshot?.hash !== plan.hashes.source) {
      throw new Error("Capability source changed after planning");
    }
    const stateParent = dirname(plan.statePath);
    await safeCapabilityPath(stateParent);
    await mkdir(stateParent, { recursive: true, mode: 0o700 });
    await safeCapabilityPath(stateParent);
    const stateDirectory = await lstat(stateParent);
    // biome-ignore lint/suspicious/noBitwiseOperators: ownership state must not be writable by other users
    if ((stateDirectory.mode & 0o022) !== 0) {
      throw new Error(
        "Capability runtime state must not be writable by other users"
      );
    }
    if (stateDirectory.dev !== (await lstat(parent)).dev) {
      throw new Error(
        "Capability runtime state and target must share a filesystem for recoverable publication"
      );
    }
    transaction = await mkdtemp(join(stateParent, "recovery-"));
    const staged = join(transaction, "next");
    await stageCapability(staged, snapshot);
    if ((await snapshotCapability(staged))?.hash !== plan.hashes.source) {
      throw new Error("Staged capability verification failed");
    }
    assertApplicable(await buildCapabilityPlan(options, id), expectedPlan);
    if (plan.hashes.current !== plan.hashes.source) {
      if (plan.hashes.current !== null) {
        recoveryPath = join(transaction, "previous");
        await rename(plan.targetPath!, recoveryPath);
      }
      await rename(staged, plan.targetPath!);
      installed = true;
    }
    if ((await snapshotCapability(plan.targetPath!))?.hash !== snapshot.hash) {
      throw new Error(
        "Deployed capability verification failed; recovery content retained"
      );
    }
    const receipt: CapabilityReceipt = {
      schemaVersion: 1,
      id,
      sourcePath: plan.sourcePath!,
      targetPath: plan.targetPath!,
      sourceHash: snapshot.hash,
      targetHash: snapshot.hash,
      revision: plan.source.revision,
      origin: plan.source.origin,
    };
    const temporaryReceipt = `${plan.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryReceipt, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await safeCapabilityPath(plan.statePath);
    await rename(temporaryReceipt, plan.statePath);
    const verified = await buildCapabilityPlan(options, id);
    if (verified.status !== "current") {
      throw new Error(
        "Capability changed during verification; recovery content retained"
      );
    }
    return { ...verified, applied: true, recoveryPath };
  } catch (error) {
    // If publication fails after moving the old target, restore it only into an
    // absent destination. A competing writer's content must remain untouched.
    if (
      recoveryPath &&
      !installed &&
      !(await optionalStat(initial.targetPath!))
    ) {
      await safeCapabilityPath(dirname(initial.targetPath!));
      await rename(recoveryPath, initial.targetPath!);
      recoveryPath = null;
    }
    throw error;
  } finally {
    // Never delete the previous target, including after interruption or failed publication.
    if (transaction && !recoveryPath) {
      await rm(transaction, { recursive: true, force: true });
    }
    await rmdir(lock);
  }
}
function assertApplicable(plan: CapabilityPlan, expectedPlan: string): void {
  if (plan.planId !== expectedPlan) {
    throw new Error(
      "Stale capability plan; inspect a fresh plan before applying"
    );
  }
  if (!APPLY_STATUSES.has(plan.status)) {
    throw new Error(`Capability apply refused: ${plan.status}: ${plan.reason}`);
  }
}
