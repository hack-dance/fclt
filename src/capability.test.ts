import { afterEach, describe, expect, it } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { captureNativePipe } from "../test/native-pipe";
import { applyCapability } from "./capability-apply";
import { snapshotCapability } from "./capability-files";
import {
  buildCapabilityPlan,
  type CapabilityContext,
  loadCapabilityContext,
} from "./capability-plan";
import {
  type CapabilityEntry,
  parseCapabilityRegistry,
} from "./capability-registry";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fclt-capability-"))
  );
  roots.push(root);
  const sourceRoot = join(root, "canonical");
  const targetRoot = join(root, "home");
  const sourcePath = join(sourceRoot, "skills/example");
  const target = join(targetRoot, "skills/example");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(join(targetRoot, "skills"), { recursive: true });
  await writeFile(join(sourcePath, "SKILL.md"), "# Example\nv1\n");
  const entry: CapabilityEntry = {
    id: "example",
    kind: "skill",
    owner: "fclt",
    enabled: true,
    source: {
      path: "skills/example",
      origin: "https://example.org/skills",
      revision: "v1",
      sha256: (await snapshotCapability(sourcePath))!.hash,
    },
    target: "skills/example",
    requires: [],
    overrides: [],
  };
  const options: CapabilityContext = {
    manifest: join(sourceRoot, "capabilities.json"),
    sourceRoot,
    targetRoot,
    stateRoot: join(root, "state"),
    host: "workstation",
    platform: "darwin",
  };
  async function save(entries: CapabilityEntry[] = [entry]) {
    await writeFile(
      options.manifest,
      JSON.stringify({ schemaVersion: 1, entries })
    );
  }
  await save();
  async function plan() {
    return await buildCapabilityPlan(options, "example");
  }
  async function apply() {
    const current = await plan();
    return await applyCapability(options, "example", current.planId);
  }
  async function updateSource() {
    await writeFile(join(sourcePath, "SKILL.md"), "# Example\nv2\n");
    entry.source.sha256 = (await snapshotCapability(sourcePath))!.hash;
    entry.source.revision = "v2";
    await save();
  }
  return {
    root,
    entry,
    options,
    sourcePath,
    target,
    save,
    plan,
    apply,
    updateSource,
  };
}
describe("versioned capability ownership", () => {
  it("creates a copy, verifies provenance, and repeats without mutation", async () => {
    const f = await fixture();
    expect((await f.plan()).status).toBe("create");
    const applied = await f.apply();
    expect(applied.status).toBe("current");
    expect(applied.applied).toBe(true);
    expect((await lstat(f.target)).isSymbolicLink()).toBe(false);
    const before = await lstat(f.target);
    expect((await f.apply()).applied).toBe(false);
    expect((await lstat(f.target)).mtimeMs).toBe(before.mtimeMs);
  });
  it("detects installer link replacement and preserves both divergent copies", async () => {
    const f = await fixture();
    await symlink(f.sourcePath, f.target);
    await rm(f.target, { recursive: true, force: true });
    await mkdir(f.target);
    await writeFile(join(f.target, "SKILL.md"), "installed v2");
    expect((await f.plan()).status).toBe("conflict");
    await expect(f.apply()).rejects.toThrow("refused");
    expect(await readFile(join(f.sourcePath, "SKILL.md"), "utf8")).toContain(
      "v1"
    );
    expect(await readFile(join(f.target, "SKILL.md"), "utf8")).toBe(
      "installed v2"
    );
  });
  it("detects installer writes through canonical links against the pin", async () => {
    const f = await fixture();
    await symlink(f.sourcePath, f.target);
    await writeFile(join(f.target, "SKILL.md"), "through link");
    expect((await f.plan()).reason).toContain("pinned");
    await expect(f.apply()).rejects.toThrow("refused");
  });
  it("converts an exact canonical link without changing its source", async () => {
    const f = await fixture();
    await symlink(f.sourcePath, f.target);
    expect((await f.plan()).status).toBe("adopt");
    const result = await f.apply();
    expect(result.recoveryPath).not.toBeNull();
    expect(await readlink(result.recoveryPath!)).toBe(f.sourcePath);
    expect((await lstat(f.target)).isDirectory()).toBe(true);
  });
  it("preserves foreign and broken links", async () => {
    const f = await fixture();
    await symlink(join(f.root, "missing"), f.target);
    expect((await f.plan()).status).toBe("conflict");
    await expect(f.apply()).rejects.toThrow("refused");
    expect((await lstat(f.target)).isSymbolicLink()).toBe(true);
  });
  it("restores a missing owned target", async () => {
    const f = await fixture();
    await f.apply();
    await rm(f.target, { recursive: true });
    expect((await f.plan()).status).toBe("restore");
    expect((await f.apply()).status).toBe("current");
  });
  it("blocks a missing source even if a broken canonical link remains", async () => {
    const f = await fixture();
    await symlink(f.sourcePath, f.target);
    await rm(f.sourcePath, { recursive: true });
    expect((await f.plan()).status).toBe("blocked");
    expect((await lstat(f.target)).isSymbolicLink()).toBe(true);
  });
  it("updates source-only changes and retains old target for recovery", async () => {
    const f = await fixture();
    await f.apply();
    await f.updateSource();
    expect((await f.plan()).status).toBe("update");
    const applied = await f.apply();
    expect(
      await readFile(join(applied.recoveryPath!, "SKILL.md"), "utf8")
    ).toContain("v1");
    expect(await readFile(join(f.target, "SKILL.md"), "utf8")).toContain("v2");
  });
  it("preserves live changes when source also changed", async () => {
    const f = await fixture();
    await f.apply();
    await f.updateSource();
    await writeFile(join(f.target, "SKILL.md"), "local edit");
    expect((await f.plan()).status).toBe("conflict");
    await expect(f.apply()).rejects.toThrow("refused");
  });
  it("retains intentional disable without restoring a missing target", async () => {
    const f = await fixture();
    await f.apply();
    await rm(f.target, { recursive: true });
    f.entry.enabled = false;
    await f.save();
    expect((await f.plan()).status).toBe("disabled");
    await expect(f.apply()).rejects.toThrow("refused");
  });
  it("reports retained disabled targets without claiming provider disablement", async () => {
    const f = await fixture();
    await f.apply();
    f.entry.enabled = false;
    await f.save();
    const plan = await f.plan();
    expect(plan.status).toBe("disabled");
    expect(plan.targetPresence).toBe("present");
    expect(plan.reason).toContain("discoverable");
  });
  it("blocks missing references without exposing credential values", async () => {
    const f = await fixture();
    f.entry.requires = [
      "env:FCLT_TEST_MISSING_CREDENTIAL_7821",
      "op://vault/item/field",
    ];
    await f.save();
    const plan = await f.plan();
    expect(plan.status).toBe("blocked");
    expect(plan.missingReferences).toEqual(f.entry.requires);
    await expect(f.apply()).rejects.toThrow("refused");
  });
  it("does not require download credentials for ordinary skill documents", async () => {
    const f = await fixture();
    expect((await f.apply()).status).toBe("current");
  });
  it("inventories independent plugins without targets or readiness claims", async () => {
    const f = await fixture();
    f.entry.owner = "native";
    f.entry.source = { origin: "marketplace:example", revision: "1.0.0" };
    f.entry.target = undefined;
    await f.save();
    const plan = await f.plan();
    expect(plan.status).toBe("independent");
    expect(plan.targetPath).toBeNull();
    expect(plan.hashes.current).toBeNull();
    await expect(f.apply()).rejects.toThrow("refused");
  });
  it("allows independent MCP entries sharing a config but refuses owned overlap", async () => {
    const f = await fixture();
    const a = {
      ...f.entry,
      id: "a",
      kind: "mcp" as const,
      owner: "native" as const,
      target: "config.toml",
    };
    const b = { ...a, id: "b" };
    await f.save([a, b]);
    expect((await loadCapabilityContext(f.options)).entries).toHaveLength(2);
    await f.save([{ ...a, owner: "fclt" }, b]);
    await expect(loadCapabilityContext(f.options)).rejects.toThrow("overlap");
  });
  it("applies platform then host overrides, then ordered overlay files", async () => {
    const f = await fixture();
    f.entry.overrides = [
      { platform: "darwin", enabled: false },
      { host: "workstation", enabled: true },
    ];
    await f.save();
    expect((await f.plan()).status).toBe("create");
    const overlay = join(f.root, "private.json");
    await writeFile(
      overlay,
      JSON.stringify({
        schemaVersion: 1,
        entries: [{ id: "example", enabled: false }],
      })
    );
    f.options.overlays = [overlay];
    expect((await f.plan()).status).toBe("disabled");
  });
  it("rejects duplicate, unknown, ownership-changing overlays", async () => {
    const f = await fixture();
    const overlay = join(f.root, "private.json");
    f.options.overlays = [overlay];
    await writeFile(
      overlay,
      JSON.stringify({
        schemaVersion: 1,
        entries: [{ id: "example", owner: "native" }],
      })
    );
    await expect(f.plan()).rejects.toThrow("Unknown");
  });
  it("refuses stale plan after source, live, or overlay changes", async () => {
    const f = await fixture();
    const plan = await f.plan();
    await f.updateSource();
    await expect(
      applyCapability(f.options, "example", plan.planId)
    ).rejects.toThrow("Stale");
    expect(await Bun.file(join(f.target, "SKILL.md")).exists()).toBe(false);
  });
  it("rejects nested symlinks and source runtime material", async () => {
    const f = await fixture();
    await symlink(f.root, join(f.sourcePath, "escape"));
    expect((await f.plan()).reason).toContain("link");
    await rm(join(f.sourcePath, "escape"));
    await mkdir(join(f.sourcePath, "node_modules"));
    expect((await f.plan()).reason).toContain("runtime");
  });
  it("rejects symlink target ancestors", async () => {
    const f = await fixture();
    await rm(join(f.options.targetRoot, "skills"), { recursive: true });
    await symlink(f.sourcePath, join(f.options.targetRoot, "skills"));
    expect((await f.plan()).reason).toContain("symlink ancestor");
  });
  it("preserves target runtime caches and continues CLI inventory for other entries", async () => {
    const f = await fixture();
    await f.apply();
    await mkdir(join(f.target, "__pycache__"));
    await writeFile(join(f.target, "__pycache__/cache.pyc"), "runtime bytes");
    await f.save([
      f.entry,
      { ...f.entry, id: "other", target: "skills/other" },
    ]);
    const result = Bun.spawnSync([
      process.execPath,
      resolve(import.meta.dir, "index.ts"),
      "capability",
      "inventory",
      "--manifest",
      f.options.manifest,
      "--source-root",
      f.options.sourceRoot,
      "--target-root",
      f.options.targetRoot,
      "--state-root",
      f.options.stateRoot,
    ]);
    expect(result.exitCode).toBe(0);
    const inventory = JSON.parse(result.stdout.toString());
    expect(inventory.entries[0].status).toBe("conflict");
    expect(inventory.entries[0].reason).toContain("runtime");
    expect(inventory.entries[1].status).toBe("create");
    await expect(f.apply()).rejects.toThrow("refused");
    expect(
      await readFile(join(f.target, "__pycache__/cache.pyc"), "utf8")
    ).toBe("runtime bytes");
  });
  it("rejects traversal, unknown fields, unpinned sources and duplicate ids", async () => {
    const f = await fixture();
    for (const entry of [
      { ...f.entry, target: "../escape" },
      { ...f.entry, target: "C:\\escape" },
      { ...f.entry, secret: "value" },
      { ...f.entry, source: { origin: "repo", revision: "v1" } },
    ]) {
      expect(() =>
        parseCapabilityRegistry({ schemaVersion: 1, entries: [entry] })
      ).toThrow();
    }
    expect(() =>
      parseCapabilityRegistry({ schemaVersion: 1, entries: [f.entry, f.entry] })
    ).toThrow("Duplicate");
  });
  it("preserves executable scripts in the digest and projection", async () => {
    const f = await fixture();
    await writeFile(join(f.sourcePath, "run.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(f.sourcePath, "run.sh"), 0o700);
    f.entry.source.sha256 = (await snapshotCapability(f.sourcePath))!.hash;
    await f.save();
    expect((await f.apply()).status).toBe("current");
    expect((await lstat(join(f.target, "run.sh"))).mode.toString(8)).toEndWith(
      "700"
    );
  });
  it("allows a runtime state root under the target home outside actual targets", async () => {
    const f = await fixture();
    f.options.stateRoot = join(f.options.targetRoot, "runtime/fclt");
    expect((await f.apply()).status).toBe("current");
  });
  it("rejects oversized live files per entry without changing them", async () => {
    const f = await fixture();
    await f.apply();
    const large = join(f.target, "large");
    await writeFile(large, "");
    await truncate(large, 33 * 1024 * 1024);
    const plan = await f.plan();
    expect(plan.status).toBe("conflict");
    expect(plan.reason).toContain("byte limit");
    await expect(f.apply()).rejects.toThrow("refused");
    expect((await lstat(large)).size).toBe(33 * 1024 * 1024);
  });
  it("normalizes Unicode filenames in pinned digests", async () => {
    const f = await fixture();
    await writeFile(join(f.sourcePath, "e\u0301.txt"), "text");
    const snapshot = (await snapshotCapability(f.sourcePath))!;
    expect(snapshot.nodes.some((node) => node.path === "é.txt")).toBe(true);
    f.entry.source.sha256 = snapshot.hash;
    await f.save();
    expect((await f.apply()).status).toBe("current");
  });
  it("refuses tampered ownership receipt hashes", async () => {
    const f = await fixture();
    const result = await f.apply();
    const receipt = JSON.parse(await readFile(result.statePath, "utf8"));
    receipt.sourceHash = "invalid";
    await writeFile(result.statePath, JSON.stringify(receipt));
    expect((await f.plan()).status).toBe("conflict");
    await expect(f.apply()).rejects.toThrow("refused");
  });
  it("rejects credential-bearing provenance without echoing it", async () => {
    const f = await fixture();
    f.entry.source.origin = "https://example.org/skills?token=fixture-value";
    await f.save();
    await expect(f.plan()).rejects.toThrow("must not contain credentials");
  });
  it("flushes inventory JSON larger than a pipe buffer before subprocess exit", async () => {
    const f = await fixture();
    const entries: CapabilityEntry[] = Array.from(
      { length: 96 },
      (_, index) => ({
        ...f.entry,
        id: `native-${index}`,
        owner: "native",
        target: undefined,
        source: {
          origin: `https://example.org/${"x".repeat(2048)}/${index}`,
          revision: `v${index}`,
        },
      })
    );
    await f.save(entries);
    const result = captureNativePipe({
      command: [
        process.execPath,
        resolve(import.meta.dir, "index.ts"),
        "capability",
        "inventory",
        "--manifest",
        f.options.manifest,
        "--source-root",
        f.options.sourceRoot,
        "--target-root",
        f.options.targetRoot,
        "--state-root",
        f.options.stateRoot,
      ],
    });
    expect(result.status).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(128 * 1024);
    const inventory = JSON.parse(result.stdout.toString()) as {
      entries: Array<{ id: string; source: { origin: string } }>;
    };
    expect(inventory.entries.map((entry) => entry.id)).toEqual(
      entries.map((entry) => entry.id)
    );
    expect(inventory.entries.at(-1)?.source.origin).toBe(
      entries.at(-1)?.source.origin
    );
  });
  it("exposes the CLI digest and help contract", async () => {
    const f = await fixture();
    const result = Bun.spawnSync([
      process.execPath,
      resolve(import.meta.dir, "index.ts"),
      "capability",
      "digest",
      "--path",
      f.sourcePath,
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString()).sha256).toBe(
      f.entry.source.sha256
    );
  });
});
