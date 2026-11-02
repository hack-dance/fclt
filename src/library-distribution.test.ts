import { afterEach, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixtureGit } from "../test/git-fixture";
import { snapshotCapability } from "./capability-files";
import { libraryRpc } from "./library-command";
import {
  deployLibraryPublication,
  type LibraryPublication,
  publishLibraryChange,
  pullLibraryPublication,
  retryLibraryPublication,
} from "./library-distribution";
import { readLibraryAsset, saveLibraryAsset } from "./library-editor";
import { withLibraryMutationLock } from "./library-lock";
import { readLibrarySettings, saveLibrarySettings } from "./library-settings";
import { gitEnvironmentForRepository } from "./util/git-environment";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture(extraPath?: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "library-distribution-"))
  );
  roots.push(root);
  const sourceRoot = join(root, "writer");
  const homeDir = join(root, "home");
  const remote = join(root, "remote.git");
  const git = (repoDir: string, argv: string[]) =>
    runFixtureGit({ repoDir, homeDir, cwd: repoDir, argv });
  await mkdir(join(sourceRoot, "skills/example"), { recursive: true });
  await writeFile(join(sourceRoot, "skills/example/SKILL.md"), "# Initial\n");
  if (extraPath) {
    await writeFile(join(sourceRoot, extraPath), "# Initial\n");
  }
  await writeFile(join(sourceRoot, "staged.md"), "baseline\n");
  await writeFile(join(sourceRoot, "dirty.md"), "baseline\n");
  const pin = (await snapshotCapability(join(sourceRoot, "skills/example")))!
    .hash;
  await writeFile(
    join(sourceRoot, "capabilities.json"),
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
            sha256: pin,
          },
          target: "example",
        },
      ],
    })
  );
  await git(sourceRoot, ["init", "--bare", remote]);
  await git(sourceRoot, ["init", "-b", "main"]);
  await git(sourceRoot, ["config", "user.name", "Fixture"]);
  await git(sourceRoot, ["config", "user.email", "fixture@example.invalid"]);
  await git(sourceRoot, ["add", "."]);
  await git(sourceRoot, ["commit", "-m", "fixture baseline"]);
  await git(sourceRoot, ["remote", "add", "origin", remote]);
  await git(sourceRoot, ["push", "-u", "origin", "main"]);
  const peerRoot = join(root, "peer");
  await git(sourceRoot, ["clone", "--branch", "main", remote, peerRoot]);
  return {
    root,
    sourceRoot,
    peerRoot,
    remote,
    git,
    context: {
      sourceRoot,
      localRoot: join(root, "writer-state"),
      machine: "writer",
    },
    asset: { path: extraPath ?? "skills/example/SKILL.md" },
  };
}
it("publishes only the selected edit and its source pin, pulls the exact commit, and verifies owned runtime output", async () => {
  const f = await fixture();
  const fetchHead = "unrelated fetch evidence\n";
  for (const root of [f.sourceRoot, f.peerRoot]) {
    await writeFile(join(root, ".git/FETCH_HEAD"), fetchHead);
  }
  const peer = {
    ...f.context,
    sourceRoot: f.peerRoot,
    localRoot: join(f.root, "peer-state"),
    machine: "peer",
  };
  for (const root of [f.sourceRoot, f.peerRoot]) {
    await writeFile(join(root, "staged.md"), "staged user work\n");
    await f.git(root, ["add", "staged.md"]);
    await writeFile(join(root, "staged.md"), "extra unstaged user work\n");
    await writeFile(join(root, "dirty.md"), "dirty user work\n");
  }
  const indexBefore = await f.git(f.sourceRoot, [
    "diff",
    "--cached",
    "--binary",
  ]);
  const peerIndexBefore = await f.git(f.peerRoot, [
    "diff",
    "--cached",
    "--binary",
  ]);
  const view = await readLibraryAsset(f.context, f.asset);
  const writerTarget = join(f.root, "writer-provider");
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "index.ts"),
      "library",
      "rpc",
      "--global",
      "--root",
      f.sourceRoot,
      "--local-root",
      f.context.localRoot,
      "--machine",
      f.context.machine,
      "--target-root",
      writerTarget,
      "--capability-state-root",
      join(f.root, "writer-ownership"),
    ],
    env: gitEnvironmentForRepository({
      repoDir: f.sourceRoot,
      isolatedHome: join(f.root, "home"),
    }),
    stdin: new Blob([
      JSON.stringify({
        schemaVersion: 1,
        operation: "edit",
        asset: f.asset,
        revision: view.revision,
        values: { content: "# Published\n" },
      }),
    ]),
    stdout: "pipe",
    stderr: "ignore",
  });
  const [code, text] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  expect(code).toBe(0);
  const response = JSON.parse(text) as {
    ok: boolean;
    value: { publication: LibraryPublication; deployment: { state: string } };
  };
  expect(response.ok).toBe(true);
  expect(response.value.deployment.state).toBe("applied");
  expect(await readFile(join(writerTarget, "example/SKILL.md"), "utf8")).toBe(
    "# Published\n"
  );
  expect(await readFile(join(f.sourceRoot, ".git/FETCH_HEAD"), "utf8")).toBe(
    fetchHead
  );
  expect(
    await f.git(f.sourceRoot, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/fclt/library-fetch/",
    ])
  ).toBe("");
  const saved = response.value;
  expect(saved.publication?.state).toBe("published");
  const publication = saved.publication!;
  expect(
    await f.git(f.sourceRoot, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      publication.commit!,
    ])
  ).toBe("capabilities.json\nskills/example/SKILL.md");
  expect(await f.git(f.sourceRoot, ["diff", "--cached", "--binary"])).toBe(
    indexBefore
  );
  const pulled = await libraryRpc(peer, {
    schemaVersion: 1,
    operation: "pull",
    publication,
  });
  expect(pulled).toMatchObject({ state: "pulled" });
  expect(await readFile(join(f.peerRoot, ".git/FETCH_HEAD"), "utf8")).toBe(
    fetchHead
  );
  expect(
    await f.git(f.peerRoot, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/fclt/library-fetch/",
    ])
  ).toBe("");
  expect(await f.git(f.peerRoot, ["diff", "--cached", "--binary"])).toBe(
    peerIndexBefore
  );
  const options = {
    manifest: join(f.peerRoot, "capabilities.json"),
    sourceRoot: f.peerRoot,
    targetRoot: join(f.root, "provider"),
    stateRoot: join(f.root, "ownership"),
    host: "peer",
    platform: "linux",
    libraryStateRoot: peer.localRoot,
  };
  const alias = join(f.root, "peer-alias");
  await symlink(f.peerRoot, alias, "junction");
  const applied = await deployLibraryPublication(
    { ...peer, sourceRoot: alias },
    publication,
    {
      ...options,
      sourceRoot: alias,
      manifest: join(alias, "capabilities.json"),
    }
  );
  expect(applied.state).toBe("applied");
  expect(
    await readFile(join(options.targetRoot, "example/SKILL.md"), "utf8")
  ).toBe("# Published\n");
  await writeFile(
    join(options.targetRoot, "example/SKILL.md"),
    "user runtime edit\n"
  );
  expect(
    (await deployLibraryPublication(peer, publication, options)).state
  ).toBe("pending");
  expect(
    await readFile(join(options.targetRoot, "example/SKILL.md"), "utf8")
  ).toBe("user runtime edit\n");
  for (const root of [f.sourceRoot, f.peerRoot]) {
    expect(await readFile(join(root, "staged.md"), "utf8")).toBe(
      "extra unstaged user work\n"
    );
    expect(await readFile(join(root, "dirty.md"), "utf8")).toBe(
      "dirty user work\n"
    );
  }
});
it("refuses pre-existing unpublished commits and dirty selected files before changing canonical data", async () => {
  const f = await fixture();
  let view = await readLibraryAsset(f.context, f.asset);
  await writeFile(join(f.sourceRoot, f.asset.path), "preexisting draft\n");
  await expect(
    saveLibraryAsset(f.context, {
      ...f.asset,
      revision: view.revision,
      layer: "shared",
      values: { content: "new\n" },
      publish: true,
      updatePins: true,
    })
  ).rejects.toThrow();
  expect(await readFile(join(f.sourceRoot, f.asset.path), "utf8")).toBe(
    "preexisting draft\n"
  );
  await f.git(f.sourceRoot, [
    "commit",
    "--only",
    "-m",
    "user unpublished commit",
    "--",
    f.asset.path,
  ]);
  view = await readLibraryAsset(f.context, f.asset);
  await expect(
    saveLibraryAsset(f.context, {
      ...f.asset,
      revision: view.revision,
      layer: "shared",
      values: { content: "new\n" },
      publish: true,
      updatePins: true,
    })
  ).rejects.toThrow();
  expect(await readFile(join(f.sourceRoot, f.asset.path), "utf8")).toBe(
    "preexisting draft\n"
  );
});
it("keeps a failed push pending, retries only its owned commit, and refuses peer overlap or repository mismatch", async () => {
  const f = await fixture();
  await f.git(f.remote, ["config", "receive.denyCurrentBranch", "refuse"]);
  await writeFile(join(f.remote, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  const view = await readLibraryAsset(f.context, f.asset);
  const saved = await saveLibraryAsset(f.context, {
    ...f.asset,
    revision: view.revision,
    layer: "shared",
    values: { content: "# Retry\n" },
    publish: true,
    updatePins: true,
  });
  expect(saved.publication?.state).toBe("pending");
  expect(saved.publication?.sourceSaved).toBe(true);
  expect(saved.effective.content).toBe("# Retry\n");
  await writeFile(join(f.remote, "hooks/pre-receive"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  const published = await retryLibraryPublication(
    f.context,
    saved.publication!.id
  );
  expect(published.state).toBe("published");
  expect(published.commit).toBe(saved.publication!.commit);
  const peer = {
    ...f.context,
    sourceRoot: f.peerRoot,
    localRoot: join(f.root, "peer-state"),
    machine: "peer",
  };
  await writeFile(join(f.peerRoot, f.asset.path), "peer draft\n");
  expect((await pullLibraryPublication(peer, published)).state).toBe("pending");
  expect(await readFile(join(f.peerRoot, f.asset.path), "utf8")).toBe(
    "peer draft\n"
  );
  expect(
    (
      await pullLibraryPublication(peer, {
        ...published,
        repository: `sha256:${"0".repeat(64)}`,
      })
    ).state
  ).toBe("pending");
  await writeFile(join(f.sourceRoot, "dirty.md"), "later unrelated commit\n");
  await f.git(f.sourceRoot, [
    "commit",
    "--only",
    "-m",
    "later user work",
    "--",
    "dirty.md",
  ]);
  expect((await retryLibraryPublication(f.context, published.id)).state).toBe(
    "published"
  );
  expect(await f.git(f.remote, ["rev-parse", "refs/heads/main"])).toBe(
    published.commit!
  );
});

it("defaults Auto-sync on, then consumes the saved off preference without publishing the next edit", async () => {
  const f = await fixture();
  const preference = await readLibrarySettings(f.context, "global");
  expect(preference.enabled).toBe(true);
  await saveLibrarySettings(f.context, "global", preference.revision, false);
  await expect(
    saveLibrarySettings(f.context, "global", preference.revision, true)
  ).rejects.toThrow();
  const before = await f.git(f.sourceRoot, ["rev-parse", "HEAD"]);
  const view = await readLibraryAsset(f.context, f.asset);
  const deployment = {
    manifest: join(f.sourceRoot, "capabilities.json"),
    sourceRoot: f.sourceRoot,
    targetRoot: join(f.root, "machine-provider"),
    stateRoot: join(f.root, "machine-ownership"),
    host: f.context.machine,
    platform: "linux",
    libraryStateRoot: f.context.localRoot,
  };
  await libraryRpc(
    f.context,
    {
      schemaVersion: 1,
      operation: "edit",
      asset: f.asset,
      revision: view.revision,
      values: { content: "# Machine only\n" },
    },
    deployment
  );
  expect(await f.git(f.sourceRoot, ["rev-parse", "HEAD"])).toBe(before);
  expect((await readLibraryAsset(f.context, f.asset)).effective.content).toBe(
    "# Machine only\n"
  );
  expect(await readFile(join(f.sourceRoot, f.asset.path), "utf8")).toBe(
    "# Initial\n"
  );
  expect(
    await readFile(join(deployment.targetRoot, "example/SKILL.md"), "utf8")
  ).toBe("# Machine only\n");
  let current = await readLibraryAsset(f.context, f.asset);
  await libraryRpc(
    f.context,
    {
      schemaVersion: 1,
      operation: "edit",
      asset: f.asset,
      revision: current.revision,
      layer: "local",
      values: { content: "# Local only\n" },
    },
    deployment
  );
  expect(
    await readFile(join(deployment.targetRoot, "example/SKILL.md"), "utf8")
  ).toBe("# Local only\n");
  current = await readLibraryAsset(f.context, f.asset);
  await libraryRpc(
    f.context,
    {
      schemaVersion: 1,
      operation: "reset",
      asset: f.asset,
      revision: current.revision,
      layer: "local",
      fields: ["content"],
    },
    deployment
  );
  expect(
    await readFile(join(deployment.targetRoot, "example/SKILL.md"), "utf8")
  ).toBe("# Machine only\n");
  current = await readLibraryAsset(f.context, f.asset);
  await libraryRpc(
    f.context,
    {
      schemaVersion: 1,
      operation: "reset",
      asset: f.asset,
      revision: current.revision,
      layer: "machine",
      fields: ["content"],
    },
    deployment
  );
  expect(
    await readFile(join(deployment.targetRoot, "example/SKILL.md"), "utf8")
  ).toBe("# Initial\n");
  expect(await f.git(f.sourceRoot, ["rev-parse", "HEAD"])).toBe(before);
});

it("resumes a source save interrupted before its pin update and does not create another commit for a no-op save", async () => {
  const f = await fixture();
  const unsaved = await withLibraryMutationLock(f.sourceRoot, () =>
    publishLibraryChange(f.context, {
      path: f.asset.path,
      content: "# Unsaved\n",
      updatePins: true,
      mutate: () =>
        Promise.reject(new Error("fixture failure before replacement")),
    })
  );
  expect(unsaved.state).toBe("pending");
  expect(unsaved.sourceSaved).toBe(false);
  expect(await readFile(join(f.sourceRoot, f.asset.path), "utf8")).toBe(
    "# Initial\n"
  );
  const pending = await withLibraryMutationLock(f.sourceRoot, () =>
    publishLibraryChange(f.context, {
      path: f.asset.path,
      content: "# Interrupted\n",
      updatePins: true,
      mutate: async () => {
        await writeFile(join(f.sourceRoot, f.asset.path), "# Interrupted\n");
        throw new Error("fixture interruption after source replacement");
      },
    })
  );
  expect(pending.state).toBe("pending");
  expect(pending.commit).toBeNull();
  expect(pending.sourceSaved).toBe(true);
  const completed = await retryLibraryPublication(f.context, pending.id);
  expect(completed.state).toBe("published");
  const before = await f.git(f.sourceRoot, ["rev-parse", "HEAD"]);
  const view = await readLibraryAsset(f.context, f.asset);
  const repeated = await saveLibraryAsset(f.context, {
    ...f.asset,
    revision: view.revision,
    layer: "shared",
    values: { content: "# Interrupted\n" },
    publish: true,
    updatePins: true,
  });
  expect(repeated.publication?.state).toBe("published");
  expect(await f.git(f.sourceRoot, ["rev-parse", "HEAD"])).toBe(before);
  await f.git(f.sourceRoot, ["config", "core.autocrlf", "true"]);
  const failedNoop = await withLibraryMutationLock(f.sourceRoot, () =>
    publishLibraryChange(f.context, {
      path: f.asset.path,
      content: "# Interrupted\r\n",
      updatePins: false,
      mutate: () =>
        Promise.reject(
          new Error("fixture failure before equivalent source replacement")
        ),
    })
  );
  expect(failedNoop.sourceSaved).toBe(false);
  expect(await retryLibraryPublication(f.context, failedNoop.id)).toMatchObject(
    { state: "pending", sourceSaved: false }
  );
});

it("publishes exact Unicode and literal-pathspec filenames without selecting sibling files", async () => {
  const f = await fixture("skills/example/notes [1]-e\u0301.md");
  const view = await readLibraryAsset(f.context, f.asset);
  const saved = await saveLibraryAsset(f.context, {
    ...f.asset,
    revision: view.revision,
    layer: "shared",
    values: { content: "# Exact file\n" },
    publish: true,
    updatePins: true,
  });
  expect(saved.publication?.state).toBe("published");
  expect(
    await readFile(join(f.sourceRoot, "skills/example/SKILL.md"), "utf8")
  ).toBe("# Initial\n");
  expect(await readFile(join(f.sourceRoot, f.asset.path), "utf8")).toBe(
    "# Exact file\n"
  );
});

it("publishes and retries CRLF MCP edits using the path's Git clean filters", async () => {
  const f = await fixture();
  await f.git(f.sourceRoot, ["config", "core.autocrlf", "true"]);
  await mkdir(join(f.sourceRoot, "mcp"), { recursive: true });
  const asset = { path: "mcp/servers.json", name: "docs" };
  await writeFile(
    join(f.sourceRoot, asset.path),
    '{\r\n  "servers": { "docs": { "command": "before" } }\r\n}\r\n'
  );
  await f.git(f.sourceRoot, ["add", "--", asset.path]);
  await f.git(f.sourceRoot, ["commit", "-m", "fixture CRLF source"]);
  await f.git(f.sourceRoot, ["push", "origin", "main"]);
  await writeFile(join(f.remote, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  const view = await readLibraryAsset(f.context, asset);
  const saved = await saveLibraryAsset(f.context, {
    ...asset,
    revision: view.revision,
    layer: "shared",
    values: { command: "after" },
    publish: true,
    updatePins: true,
  });
  expect(saved.publication?.state).toBe("pending");
  expect(saved.publication?.sourceSaved).toBe(true);
  expect(saved.publication?.commit).toBeString();
  expect(await readFile(join(f.sourceRoot, asset.path), "utf8")).toContain(
    "\r\n"
  );
  await writeFile(join(f.remote, "hooks/pre-receive"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  const retried = await retryLibraryPublication(
    f.context,
    saved.publication!.id
  );
  expect(retried.state).toBe("published");
  expect(retried.commit).toBe(saved.publication!.commit);
});
it("does not deploy unpublished canonical content under a published commit identity", async () => {
  const f = await fixture();
  const before = await readLibraryAsset(f.context, f.asset);
  const saved = await saveLibraryAsset(f.context, {
    ...f.asset,
    revision: before.revision,
    layer: "shared",
    values: { content: "# Published\n" },
    publish: true,
    updatePins: true,
  });
  expect(saved.publication?.state).toBe("published");
  const options = {
    manifest: join(f.sourceRoot, "capabilities.json"),
    sourceRoot: f.sourceRoot,
    targetRoot: join(f.root, "provider"),
    stateRoot: join(f.root, "ownership"),
    host: f.context.machine,
    platform: "linux",
    libraryStateRoot: f.context.localRoot,
  };
  expect(
    (await deployLibraryPublication(f.context, saved.publication!, options))
      .state
  ).toBe("applied");
  let overlayView = await readLibraryAsset(f.context, f.asset);
  overlayView = await saveLibraryAsset(f.context, {
    ...f.asset,
    revision: overlayView.revision,
    layer: "local",
    values: { content: "# Local override\n" },
  });
  expect(
    (await deployLibraryPublication(f.context, saved.publication!, options))
      .state
  ).toBe("applied");
  expect(
    await readFile(join(options.targetRoot, "example/SKILL.md"), "utf8")
  ).toBe("# Local override\n");
  await libraryRpc(f.context, {
    schemaVersion: 1,
    operation: "reset",
    asset: f.asset,
    revision: overlayView.revision,
    layer: "local",
    fields: ["content"],
  });
  expect(
    (await deployLibraryPublication(f.context, saved.publication!, options))
      .state
  ).toBe("applied");
  await writeFile(join(f.sourceRoot, f.asset.path), "# Unpublished draft\n");
  const manifest = JSON.parse(await readFile(options.manifest, "utf8")) as {
    entries: { source: { sha256: string } }[];
  };
  manifest.entries[0]!.source.sha256 = (await snapshotCapability(
    join(f.sourceRoot, "skills/example")
  ))!.hash;
  await writeFile(options.manifest, JSON.stringify(manifest));
  expect(
    (await deployLibraryPublication(f.context, saved.publication!, options))
      .state
  ).toBe("pending");
  expect(
    await readFile(join(options.targetRoot, "example/SKILL.md"), "utf8")
  ).toBe("# Published\n");
});
it.each([
  { kind: "receipt bytes", count: 128, depth: 22 },
  { kind: "pin count", count: 4097, depth: 0 },
])("rejects oversized $kind before canonical mutation", async ({
  count,
  depth,
}) => {
  const f = await fixture();
  await f.git(f.sourceRoot, ["config", "core.longpaths", "true"]);
  const sourcePath = [
    "skills",
    ...Array.from({ length: depth }, () => "s".repeat(100)),
    "bounded",
  ].join("/");
  await mkdir(join(f.sourceRoot, sourcePath), { recursive: true });
  const asset = { path: `${sourcePath}/SKILL.md` };
  await writeFile(join(f.sourceRoot, asset.path), "# Initial\n");
  const hash = (await snapshotCapability(join(f.sourceRoot, sourcePath)))!.hash;
  const manifest = JSON.stringify({
    schemaVersion: 1,
    entries: Array.from({ length: count }, (_, index) => ({
      id: `e${index}`,
      kind: "skill",
      owner: "fclt",
      enabled: true,
      source: {
        path: sourcePath,
        origin: "fixture",
        revision: "a",
        sha256: hash,
      },
      target: `t${index}`,
    })),
  });
  expect(Buffer.byteLength(manifest)).toBeLessThan(1024 * 1024);
  await writeFile(join(f.sourceRoot, "capabilities.json"), manifest);
  await f.git(f.sourceRoot, ["add", "--", asset.path, "capabilities.json"]);
  await f.git(f.sourceRoot, ["commit", "-m", "fixture bounded recovery"]);
  await f.git(f.sourceRoot, ["push", "origin", "main"]);
  const view = await readLibraryAsset(f.context, asset);
  await expect(
    saveLibraryAsset(f.context, {
      ...asset,
      revision: view.revision,
      layer: "shared",
      values: { content: "# Must not persist\n" },
      publish: true,
      updatePins: true,
    })
  ).rejects.toThrow();
  expect(await readFile(join(f.sourceRoot, asset.path), "utf8")).toBe(
    "# Initial\n"
  );
  expect(await readFile(join(f.sourceRoot, "capabilities.json"), "utf8")).toBe(
    manifest
  );
});

it("accepts a publication trailer followed by a normal commit-msg hook trailer", async () => {
  const f = await fixture();
  await writeFile(
    join(f.sourceRoot, ".git/hooks/commit-msg"),
    "#!/bin/sh\nprintf 'Signed-off-by: Fixture <fixture@example.invalid>\\n' >> \"$1\"\n",
    { mode: 0o755 }
  );
  const view = await readLibraryAsset(f.context, f.asset);
  const saved = await saveLibraryAsset(f.context, {
    ...f.asset,
    revision: view.revision,
    layer: "shared",
    values: { content: "# Hook trailer\n" },
    publish: true,
    updatePins: true,
  });
  expect(saved.publication?.state).toBe("published");
  expect(
    await f.git(f.sourceRoot, [
      "show",
      "-s",
      "--format=%B",
      saved.publication!.commit!,
    ])
  ).toEndWith("Signed-off-by: Fixture <fixture@example.invalid>");
  expect(
    (await retryLibraryPublication(f.context, saved.publication!.id)).state
  ).toBe("published");
});
it("saves unsupported override kinds as unpublished shared edits when Auto-sync is off", async () => {
  const f = await fixture();
  const settings = await readLibrarySettings(f.context, "global");
  await saveLibrarySettings(f.context, "global", settings.revision, false);
  const before = await f.git(f.sourceRoot, ["rev-parse", "HEAD"]);
  for (const path of [
    "instructions/X.md",
    "snippets/X.md",
    "agents/X.md",
    "ROOT.md",
  ]) {
    await mkdir(join(f.sourceRoot, path, ".."), { recursive: true });
    await writeFile(join(f.sourceRoot, path), "# Original\n");
    const asset = { path };
    const view = await readLibraryAsset(f.context, asset);
    const result = await libraryRpc(f.context, {
      schemaVersion: 1,
      operation: "edit",
      asset,
      revision: view.revision,
      values: { content: "# Unpublished edit\n" },
    });
    expect(result).not.toHaveProperty("publication");
    expect(await readFile(join(f.sourceRoot, path), "utf8")).toBe(
      "# Unpublished edit\n"
    );
    expect(await f.git(f.sourceRoot, ["rev-parse", "HEAD"])).toBe(before);
    expect(await f.git(f.remote, ["rev-parse", "refs/heads/main"])).toBe(
      before
    );
  }
});
it.each([
  "no repository",
  "no upstream",
  "multiple push URLs",
  "behind upstream",
  "unavailable upstream",
])("reports publication setup or conflict for %s without losing the draft", async (kind) => {
  const f = await fixture();
  if (kind === "no repository") {
    await rm(join(f.sourceRoot, ".git"), { recursive: true, force: true });
  }
  if (kind === "no upstream") {
    await f.git(f.sourceRoot, ["config", "--unset", "branch.main.remote"]);
  }
  if (kind === "multiple push URLs") {
    await f.git(f.sourceRoot, [
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      f.remote,
    ]);
    await f.git(f.sourceRoot, [
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      `${f.remote}-other`,
    ]);
  }
  if (kind === "unavailable upstream") {
    await rename(f.remote, `${f.remote}-offline`);
  }
  if (kind === "behind upstream") {
    await f.git(f.peerRoot, ["config", "user.name", "Fixture"]);
    await f.git(f.peerRoot, [
      "config",
      "user.email",
      "fixture@example.invalid",
    ]);
    await writeFile(join(f.peerRoot, "dirty.md"), "upstream work\n");
    await f.git(f.peerRoot, [
      "commit",
      "--only",
      "-m",
      "fixture remote advance",
      "--",
      "dirty.md",
    ]);
    await f.git(f.peerRoot, ["push", "origin", "main"]);
  }
  const view = await readLibraryAsset(f.context, f.asset);
  await expect(
    libraryRpc(f.context, {
      schemaVersion: 1,
      operation: "edit",
      asset: f.asset,
      revision: view.revision,
      values: { content: "# Draft retained\n" },
    })
  ).rejects.toMatchObject({
    reason:
      kind === "behind upstream"
        ? "publication-conflict"
        : kind === "unavailable upstream"
          ? "publication-unavailable"
          : "publication-not-configured",
  });
  expect(await readFile(join(f.sourceRoot, f.asset.path), "utf8")).toBe(
    "# Initial\n"
  );
});
it("reports verified outputs when a later owned target cannot deploy", async () => {
  const f = await fixture();
  const file = join(f.sourceRoot, "capabilities.json");
  const manifest = JSON.parse(await readFile(file, "utf8")) as {
    schemaVersion: 1;
    entries: { id: string; target: string }[];
  };
  manifest.entries.push({
    ...manifest.entries[0]!,
    id: "second",
    target: "second",
  });
  await writeFile(file, JSON.stringify(manifest));
  await f.git(f.sourceRoot, [
    "commit",
    "--only",
    "-m",
    "fixture second target",
    "--",
    "capabilities.json",
  ]);
  await f.git(f.sourceRoot, ["push", "origin", "main"]);
  const view = await readLibraryAsset(f.context, f.asset);
  const saved = await saveLibraryAsset(f.context, {
    ...f.asset,
    revision: view.revision,
    layer: "shared",
    values: { content: "# Partial deployment\n" },
    publish: true,
    updatePins: true,
  });
  const options = {
    manifest: file,
    sourceRoot: f.sourceRoot,
    targetRoot: join(f.root, "provider"),
    stateRoot: join(f.root, "ownership"),
    host: f.context.machine,
    platform: "linux",
    libraryStateRoot: f.context.localRoot,
  };
  await mkdir(join(options.targetRoot, "second"), { recursive: true });
  await writeFile(
    join(options.targetRoot, "second/SKILL.md"),
    "# Preserve divergent target\n"
  );
  const result = await deployLibraryPublication(
    f.context,
    saved.publication!,
    options
  );
  expect(result).toMatchObject({
    state: "pending",
    entries: ["example"],
    changedEntries: ["example"],
    failedEntry: "second",
  });
  expect(
    await readFile(join(options.targetRoot, "example/SKILL.md"), "utf8")
  ).toBe("# Partial deployment\n");
  expect(
    await readFile(join(options.targetRoot, "second/SKILL.md"), "utf8")
  ).toBe("# Preserve divergent target\n");
});
it("retains the asset identity when only its pin changes in Git", async () => {
  const f = await fixture();
  await f.git(f.sourceRoot, ["config", "core.autocrlf", "true"]);
  await writeFile(join(f.remote, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  const view = await readLibraryAsset(f.context, f.asset);
  const saved = await saveLibraryAsset(f.context, {
    ...f.asset,
    revision: view.revision,
    layer: "shared",
    values: { content: "# Initial\r\n" },
    publish: true,
    updatePins: true,
  });
  expect(saved.publication?.state).toBe("pending");
  expect(saved.publication?.path).toBe(f.asset.path);
  expect(saved.publication?.sourceSaved).toBe(true);
  await writeFile(join(f.remote, "hooks/pre-receive"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  const retried = await retryLibraryPublication(
    f.context,
    saved.publication!.id
  );
  expect(retried.state).toBe("published");
  expect(retried.path).toBe(f.asset.path);
  expect(
    await f.git(f.sourceRoot, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      retried.commit!,
    ])
  ).toBe("capabilities.json");
  const options = {
    manifest: join(f.sourceRoot, "capabilities.json"),
    sourceRoot: f.sourceRoot,
    targetRoot: join(f.root, "provider"),
    stateRoot: join(f.root, "ownership"),
    host: f.context.machine,
    platform: "linux",
    libraryStateRoot: f.context.localRoot,
  };
  expect(
    (await deployLibraryPublication(f.context, retried, options)).state
  ).toBe("applied");
  expect(
    await readFile(join(options.targetRoot, "example/SKILL.md"), "utf8")
  ).toBe("# Initial\r\n");
});
