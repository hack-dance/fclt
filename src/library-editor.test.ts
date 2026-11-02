import { afterEach, expect, it } from "bun:test";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCapability } from "./capability-apply";
import { snapshotCapability } from "./capability-files";
import { buildCapabilityPlan } from "./capability-plan";
import {
  readLibraryAsset,
  resetLibraryAsset,
  saveLibraryAsset,
  snapshotLibraryCapability,
} from "./library-editor";
import { withLibraryMutationLock } from "./library-lock";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fclt-library-")));
  roots.push(root);
  const context = {
    sourceRoot: join(root, "canonical"),
    localRoot: join(root, "runtime"),
    machine: "workstation-a",
  };
  await mkdir(join(context.sourceRoot, "skills/example"), { recursive: true });
  await writeFile(
    join(context.sourceRoot, "skills/example/SKILL.md"),
    "# Shared\n"
  );
  return { root, context, asset: { path: "skills/example/SKILL.md" } };
}
it("keeps machine and local layers separate and deploys their effective content through a capability snapshot", async () => {
  const { root, context, asset } = await fixture();
  let view = await readLibraryAsset(context, asset);
  view = await saveLibraryAsset(context, {
    ...asset,
    revision: view.revision,
    layer: "machine",
    values: { content: "# Machine\n" },
  });
  expect(view.effective.content).toBe("# Machine\n");
  expect(
    (await readLibraryAsset({ ...context, machine: "workstation-b" }, asset))
      .effective.content
  ).toBe("# Shared\n");
  expect(await readFile(join(context.sourceRoot, asset.path), "utf8")).toBe(
    "# Shared\n"
  );
  const stale = view.revision;
  view = await saveLibraryAsset(context, {
    ...asset,
    revision: view.revision,
    layer: "local",
    values: { content: "# Local\n" },
  });
  await expect(
    saveLibraryAsset(context, {
      ...asset,
      revision: stale,
      layer: "machine",
      values: { content: "# Stale\n" },
    })
  ).rejects.toMatchObject({ reason: "conflict" });
  const sourcePath = join(context.sourceRoot, "skills/example");
  const beforeStaging = (await snapshotCapability(sourcePath))!;
  await writeFile(
    join(sourcePath, ".fclt-library-00000000-0000-4000-8000-000000000000.tmp"),
    "owned staging fixture"
  );
  const base = (await snapshotCapability(sourcePath))!;
  expect(base.hash).toBe(beforeStaging.hash);
  const effective = await snapshotLibraryCapability(
    context,
    sourcePath,
    base,
    "skill"
  );
  const target = join(root, "provider-skill");
  const manifest = join(context.sourceRoot, "capabilities.json");
  await writeFile(
    manifest,
    JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          id: "example",
          kind: "skill",
          owner: "fclt",
          enabled: true,
          source: {
            path: "skills/example",
            origin: "https://example.org/skills",
            revision: "fixture",
            sha256: base.hash,
          },
          target: "provider-skill",
        },
      ],
    })
  );
  const options = {
    manifest,
    sourceRoot: context.sourceRoot,
    targetRoot: root,
    stateRoot: join(root, "ownership"),
    host: context.machine,
    platform: "linux",
    libraryStateRoot: context.localRoot,
  };
  const alias = join(root, "library-target-alias");
  await mkdir(target, { recursive: true });
  await symlink(target, alias, "dir");
  expect(
    (
      await buildCapabilityPlan(
        { ...options, libraryStateRoot: alias },
        "example"
      )
    ).status
  ).toBe("blocked");
  await rm(target, { recursive: true });
  const plan = await buildCapabilityPlan(options, "example");
  expect(plan.hashes.source).toBe(effective.snapshot.hash);
  view = await saveLibraryAsset(context, {
    ...asset,
    revision: view.revision,
    layer: "local",
    values: { content: "# Local\n" },
  });
  await applyCapability(options, "example", plan.planId);
  expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("# Local\n");
  const stalePlan = await buildCapabilityPlan(options, "example");
  view = await saveLibraryAsset(context, {
    ...asset,
    revision: view.revision,
    layer: "local",
    values: { content: "# Updated local\n" },
  });
  await expect(
    applyCapability(options, "example", stalePlan.planId)
  ).rejects.toThrow();
  expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("# Local\n");
  await writeFile(join(context.sourceRoot, asset.path), "# New shared\n");
  await expect(
    snapshotLibraryCapability(context, sourcePath, base, "skill")
  ).rejects.toMatchObject({ reason: "conflict" });
  view = await readLibraryAsset(context, asset);
  expect(view.changed.machine).toEqual(["content"]);
  view = await resetLibraryAsset(context, {
    ...asset,
    revision: view.revision,
    layer: "local",
    fields: ["content"],
  });
  expect(view.effective.content).toBe("# Machine\n");
  view = await saveLibraryAsset(context, {
    ...asset,
    revision: view.revision,
    layer: "machine",
    values: { content: "# Machine\n" },
  });
  expect(view.changed.machine).toEqual([]);
  view = await resetLibraryAsset(context, {
    ...asset,
    revision: view.revision,
    layer: "machine",
    fields: ["content"],
  });
  expect(view.effective.content).toBe("# New shared\n");
});
it("merges MCP fields and preserves environment bindings and unrelated servers", async () => {
  const { context } = await fixture();
  const asset = { path: "mcp/servers.json", name: "docs" };
  await mkdir(join(context.sourceRoot, "mcp"));
  const source = {
    servers: {
      docs: {
        command: "docs-search",
        args: ["--root", "./shared"],
        env: { DOCS_ACCESS: "fixture-only" },
      },
      other: { command: "other-tool" },
    },
  };
  await writeFile(join(context.sourceRoot, asset.path), JSON.stringify(source));
  const baseSnapshot = (await snapshotCapability(
    join(context.sourceRoot, asset.path)
  ))!;
  expect(
    (
      await snapshotLibraryCapability(
        context,
        join(context.sourceRoot, asset.path),
        baseSnapshot,
        "mcp"
      )
    ).snapshot.hash
  ).toBe(baseSnapshot.hash);
  let view = await readLibraryAsset(context, asset);
  expect(JSON.stringify(view)).not.toContain("fixture-only");
  view = await saveLibraryAsset(context, {
    ...asset,
    revision: view.revision,
    layer: "machine",
    values: { args: ["--root", "./machine"] },
  });
  view = await saveLibraryAsset(context, {
    ...asset,
    revision: view.revision,
    layer: "shared",
    values: { command: "new-docs-search" },
  });
  expect(view.effective).toEqual({
    command: "new-docs-search",
    args: ["--root", "./machine"],
  });
  const persisted = JSON.parse(
    await readFile(join(context.sourceRoot, asset.path), "utf8")
  );
  expect(persisted.servers.docs.env).toEqual(source.servers.docs.env);
  expect(persisted.servers.other).toEqual(source.servers.other);
  const sharedSnapshot = (await snapshotCapability(
    join(context.sourceRoot, asset.path)
  ))!;
  const effectiveSnapshot = await snapshotLibraryCapability(
    context,
    join(context.sourceRoot, asset.path),
    sharedSnapshot,
    "mcp"
  );
  const effectiveConfig = JSON.parse(
    effectiveSnapshot.snapshot.nodes[0]!.content!.toString()
  );
  expect(effectiveConfig.servers.docs.command).toBe("new-docs-search");
  expect(effectiveConfig.servers.docs.args).toEqual(["--root", "./machine"]);
  expect(effectiveConfig.servers.docs.env).toEqual(source.servers.docs.env);
  expect(effectiveConfig.servers.other).toEqual(source.servers.other);
  for (const file of await readdir(
    join(context.localRoot, "library/recovery")
  )) {
    expect(
      await readFile(join(context.localRoot, "library/recovery", file), "utf8")
    ).not.toContain("fixture-only");
  }
  await expect(
    saveLibraryAsset(context, {
      ...asset,
      revision: view.revision,
      layer: "local",
      values: { env: {} },
    })
  ).rejects.toMatchObject({ reason: "unsupported" });
});
it("serves the bounded CLI RPC and rejects traversal and unknown fields without echoing input", async () => {
  const { context, asset } = await fixture();
  const args = [
    process.execPath,
    join(import.meta.dir, "index.ts"),
    "library",
    "rpc",
    "--global",
    "--root",
    context.sourceRoot,
    "--local-root",
    context.localRoot,
    "--machine",
    context.machine,
  ];
  const read = Bun.spawnSync(args, {
    stdin: Buffer.from(
      JSON.stringify({ schemaVersion: 1, operation: "read", asset })
    ),
  });
  expect(read.exitCode).toBe(0);
  expect(JSON.parse(read.stdout.toString()).value.effective.content).toBe(
    "# Shared\n"
  );
  for (const request of [
    ...[
      "../outside.md",
      "skills/../../outside.md",
      "C:/outside.md",
      "skills\\outside.md",
      "/outside.md",
    ].map((path) => ({ schemaVersion: 1, operation: "read", asset: { path } })),
    {
      schemaVersion: 1,
      operation: "read",
      asset,
      privateInput: "fixture-not-for-output",
    },
  ]) {
    const rejected = Bun.spawnSync(args, {
      stdin: Buffer.from(JSON.stringify(request)),
    });
    expect(rejected.exitCode).toBe(1);
    expect(JSON.parse(rejected.stdout.toString())).toEqual({
      ok: false,
      error: { reason: "unsupported" },
    });
    expect(`${rejected.stdout}${rejected.stderr}`).not.toContain(
      "fixture-not-for-output"
    );
  }
});

it("rejects linked sources and overlay ancestors without modifying their destinations", async () => {
  for (const kind of ["symlink", "hardlink", "ancestor"] as const) {
    const { root, context, asset } = await fixture();
    const external = join(root, "external.md");
    await writeFile(external, "# External\n");
    if (kind === "ancestor") {
      const view = await readLibraryAsset(context, asset);
      await symlink(root, join(context.sourceRoot, "profiles"));
      await expect(readLibraryAsset(context, asset)).rejects.toMatchObject({
        reason: "unavailable",
      });
      await expect(
        saveLibraryAsset(context, {
          ...asset,
          revision: view.revision,
          layer: "machine",
          values: { content: "# Rejected\n" },
        })
      ).rejects.toMatchObject({ reason: "unavailable" });
    } else {
      const source = join(context.sourceRoot, asset.path);
      await rm(source);
      if (kind === "symlink") {
        await symlink(external, source);
      } else {
        await link(external, source);
      }
      await expect(readLibraryAsset(context, asset)).rejects.toBeInstanceOf(
        Error
      );
    }
    expect(await readFile(external, "utf8")).toBe("# External\n");
  }
});
it("serializes competing saves with one revision and preserves externally held locks", async () => {
  const { context, asset } = await fixture();
  const view = await readLibraryAsset(context, asset);
  const results = await Promise.allSettled(
    ["A", "B"].map((content) =>
      saveLibraryAsset(context, {
        ...asset,
        revision: view.revision,
        layer: "local",
        values: { content },
      })
    )
  );
  expect(
    results.filter((result) => result.status === "fulfilled")
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1
  );
  const current = await readLibraryAsset(context, asset);
  expect(["A", "B"]).toContain(String(current.effective.content));
  await withLibraryMutationLock(context.sourceRoot, async () => {
    await expect(
      saveLibraryAsset(context, {
        ...asset,
        revision: current.revision,
        layer: "shared",
        values: { content: "# Rejected\n" },
      })
    ).rejects.toMatchObject({ reason: "busy" });
  });
  expect(await readFile(join(context.sourceRoot, asset.path), "utf8")).toBe(
    "# Shared\n"
  );
});

it.each([
  "large",
  "decomposed",
  "mcp",
] as const)("preserves unedited assets and resolves %s source paths", async (variant) => {
  const { context } = await fixture();
  const path =
    variant === "mcp"
      ? "mcp/servers.json"
      : variant === "large"
        ? "skills/example/guide.md"
        : "skills/example/cafe\u0301.md";
  const content =
    variant === "mcp"
      ? JSON.stringify({
          servers: {
            docs: { command: "docs-search", description: "x".repeat(262_145) },
          },
        })
      : variant === "large"
        ? "x".repeat(262_145)
        : "# Original\n";
  if (variant === "mcp") {
    await mkdir(join(context.sourceRoot, "mcp"));
  }
  await writeFile(join(context.sourceRoot, path), content);
  if (variant === "decomposed") {
    const asset = { path };
    const view = await readLibraryAsset(context, asset);
    await saveLibraryAsset(context, {
      ...asset,
      revision: view.revision,
      layer: "machine",
      values: { content: "# Overridden\n" },
    });
  }
  const sourcePath =
    variant === "mcp"
      ? join(context.sourceRoot, path)
      : join(context.sourceRoot, "skills/example");
  const base = (await snapshotCapability(sourcePath))!;
  const effective = await snapshotLibraryCapability(
    context,
    sourcePath,
    base,
    variant === "mcp" ? "mcp" : "skill"
  );
  const nodePath =
    variant === "mcp" ? "" : path.split("/").at(-1)!.normalize("NFC");
  expect(
    effective.snapshot.nodes
      .find((node) => node.path === nodePath)
      ?.content?.toString()
  ).toBe(variant === "decomposed" ? "# Overridden\n" : content);
  if (variant !== "decomposed") {
    expect(effective.snapshot.hash).toBe(base.hash);
  }
});

it("rejects a merged overlay above its read limit without losing the previous revision", async () => {
  const { context } = await fixture();
  const asset = { path: "mcp/servers.json", name: "docs" };
  await mkdir(join(context.sourceRoot, "mcp"));
  await writeFile(
    join(context.sourceRoot, asset.path),
    JSON.stringify({ servers: { docs: { command: "docs-search" } } })
  );
  let view = await readLibraryAsset(context, asset);
  view = await saveLibraryAsset(context, {
    ...asset,
    revision: view.revision,
    layer: "local",
    values: { args: Array.from({ length: 256 }, () => "é".repeat(4090)) },
  });
  await expect(
    saveLibraryAsset(context, {
      ...asset,
      revision: view.revision,
      layer: "local",
      values: { command: "x".repeat(4096) },
    })
  ).rejects.toMatchObject({ reason: "unsupported" });
  expect((await readLibraryAsset(context, asset)).revision).toBe(view.revision);
});
it("rejects non-exact source aliases and unsupported override kinds", async () => {
  const { context } = await fixture();
  const path = "skills/example/cafe\u0301.md";
  await writeFile(join(context.sourceRoot, path), "# Exact\n");
  for (const alias of [path.normalize("NFC"), "skills/Example/SKILL.md"]) {
    await expect(
      readLibraryAsset(context, { path: alias })
    ).rejects.toMatchObject({ reason: "unsupported" });
  }
  const asset = { path: "GUIDE.md" };
  await writeFile(join(context.sourceRoot, asset.path), "# Shared\n");
  const view = await readLibraryAsset(context, asset);
  for (const layer of ["machine", "local"] as const) {
    await expect(
      saveLibraryAsset(context, {
        ...asset,
        revision: view.revision,
        layer,
        values: { content: "# Not deployed\n" },
      })
    ).rejects.toMatchObject({ reason: "unsupported" });
  }
  expect(
    (
      await saveLibraryAsset(context, {
        ...asset,
        revision: view.revision,
        layer: "shared",
        values: { content: "# Saved\n" },
      })
    ).effective.content
  ).toBe("# Saved\n");
});
it.each([
  '// JSONC\n{ "servers": { "docs": { "command": "docs-search" } } }',
  '{"docs":{"command":"docs-search"}}',
])("preserves unedited alternative MCP bytes: %s", async (content) => {
  const { context } = await fixture();
  const path = join(context.sourceRoot, "mcp/servers.json");
  await mkdir(join(context.sourceRoot, "mcp"));
  await writeFile(path, content);
  const snapshot = (await snapshotCapability(path))!;
  expect(
    (await snapshotLibraryCapability(context, path, snapshot, "mcp")).snapshot
      .hash
  ).toBe(snapshot.hash);
});
it("preserves unrelated MCP bytes and avoids creating a missing empty argument list", async () => {
  const { context } = await fixture();
  const asset = { path: "mcp/servers.json", name: "docs" };
  await mkdir(join(context.sourceRoot, "mcp"));
  const original =
    '{ "number": 9007199254740993, "meta": 1, "meta": 2, "servers": { "docs": { "command": "docs-search", "env": { "ACCESS": "fixture-only" } }, "other": { "command": "other-tool" } } }\n';
  await writeFile(join(context.sourceRoot, asset.path), original);
  let view = await readLibraryAsset(context, asset);
  view = await saveLibraryAsset(context, {
    ...asset,
    revision: view.revision,
    layer: "shared",
    values: { command: "new-docs-search" },
  });
  const changed = original.replace(
    '"command": "docs-search"',
    '"command": "new-docs-search"'
  );
  expect(await readFile(join(context.sourceRoot, asset.path), "utf8")).toBe(
    changed
  );
  const noOp = await saveLibraryAsset(context, {
    ...asset,
    revision: view.revision,
    layer: "shared",
    values: { args: [] },
  });
  expect(noOp.revision).toBe(view.revision);
  for (const name of await readdir(
    join(context.localRoot, "library/recovery")
  )) {
    expect(
      await readFile(join(context.localRoot, "library/recovery", name), "utf8")
    ).not.toContain("fixture-only");
  }
});
it("does not strand writes behind a legacy source lock or report missing roots as busy", async () => {
  const { context, asset } = await fixture();
  const lock = join(context.sourceRoot, ".library-editor.lock");
  await writeFile(lock, "stale fixture owner");
  const view = await readLibraryAsset(context, asset);
  expect(
    (
      await saveLibraryAsset(context, {
        ...asset,
        revision: view.revision,
        layer: "local",
        values: { content: "# Saved\n" },
      })
    ).effective.content
  ).toBe("# Saved\n");
  expect(await readFile(lock, "utf8")).toBe("stale fixture owner");
  await expect(
    saveLibraryAsset(
      { ...context, sourceRoot: join(context.sourceRoot, "missing") },
      {
        ...asset,
        revision: view.revision,
        layer: "shared",
        values: { content: "# Missing\n" },
      }
    )
  ).rejects.toMatchObject({ reason: "unavailable" });
});
