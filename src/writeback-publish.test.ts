import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runFixtureGit } from "../test/git-fixture";
import { addWriteback } from "./ai";
import {
  allocateArtifactId,
  generateArtifactId,
  isDatedArtifactId,
  isLegacySequentialId,
  setArtifactIdGeneratorForTests,
} from "./ai-ids";
import {
  facultAiPendingReviewRoot,
  facultAiReviewPublishStatePath,
  facultAiWritebackReviewDir,
} from "./paths";
import {
  publishReviewArtifacts,
  rewriteLegacyWritebackId,
} from "./writeback-publish";

const DATED_WB_RE = /^WB-\d{8}-[0-9A-HJKMNP-TV-Z]{8}$/;
const HOST_BRANCH_RE = /^fclt\/review-[0-9a-z]{8}$/;

let fixtureRoot: string | null = null;

afterEach(async () => {
  setArtifactIdGeneratorForTests(null);
  if (fixtureRoot) {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
  fixtureRoot = null;
});

const legacyMain16 = [
  "---",
  'id: "WB-00016"',
  'artifact: "writeback"',
  'status: "recorded"',
  "---",
  "",
  "# WB-00016: tracked record on main",
  "",
  "## Summary",
  "tracked record on main",
  "",
].join("\n");

const legacyMain63 = legacyMain16
  .replaceAll("WB-00016", "WB-00063")
  .replaceAll("tracked record on main", "record another machine landed");

async function git(repoDir: string, argv: string[], cwd?: string) {
  if (!fixtureRoot) {
    throw new Error("fixture root missing");
  }
  return await runFixtureGit({
    argv,
    repoDir,
    homeDir: join(fixtureRoot, "git-home"),
    cwd,
  });
}

/** A bare remote with legacy review records, cloned once per simulated host. */
async function setupHosts(hosts: string[]) {
  fixtureRoot = join(
    tmpdir(),
    `fclt-publish-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const remote = join(fixtureRoot, "remote.git");
  const seed = join(fixtureRoot, "seed");
  await mkdir(remote, { recursive: true });
  await git(remote, ["init", "--bare", "-b", "main", remote], fixtureRoot);
  await git(seed, ["init", "-b", "main", seed], fixtureRoot);
  await git(seed, ["config", "user.name", "Fixture"], seed);
  await git(seed, ["config", "user.email", "fixture@example.com"], seed);
  await mkdir(join(seed, "writebacks", "global"), { recursive: true });
  await writeFile(
    join(seed, "writebacks", "global", "WB-00016.md"),
    legacyMain16
  );
  await writeFile(join(seed, "AGENTS.md"), "# Agents\n");
  await git(seed, ["add", "."], seed);
  await git(seed, ["commit", "-m", "seed"], seed);
  await git(seed, ["remote", "add", "origin", remote], seed);
  await git(seed, ["push", "origin", "main"], seed);

  const homes: Record<string, string> = {};
  for (const host of hosts) {
    const home = join(fixtureRoot, host);
    const aiRoot = join(home, ".ai");
    await mkdir(home, { recursive: true });
    await git(aiRoot, ["clone", remote, aiRoot], home);
    await git(aiRoot, ["config", "user.name", host], aiRoot);
    await git(aiRoot, ["config", "user.email", `${host}@example.com`], aiRoot);
    homes[host] = home;
  }

  // Another machine lands a different WB-00063 on main after the clones.
  await mkdir(join(seed, "writebacks", "global"), { recursive: true });
  await writeFile(
    join(seed, "writebacks", "global", "WB-00063.md"),
    legacyMain63
  );
  await git(seed, ["add", "."], seed);
  await git(seed, ["commit", "-m", "land WB-00063"], seed);
  await git(seed, ["push", "origin", "main"], seed);
  return { remote, seed, homes };
}

async function addRecord(home: string, summary: string) {
  return await addWriteback({
    homeDir: home,
    rootDir: join(home, ".ai"),
    kind: "missing_context",
    summary,
    evidence: [{ type: "session", ref: summary }],
  });
}

async function statusPorcelain(home: string): Promise<string> {
  const aiRoot = join(home, ".ai");
  return await git(aiRoot, ["status", "--porcelain"], aiRoot);
}

async function remoteFile(remote: string, ref: string, path: string) {
  return await git(remote, ["show", `${ref}:${path}`], remote);
}

describe("artifact ids", () => {
  it("generates dated Crockford base32 ids", () => {
    const id = generateArtifactId("WB", {
      now: new Date("2026-10-30T23:59:00.000Z"),
      random: () => new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]),
    });
    expect(id).toBe("WB-20261030-ZZZZZZZZ");
    expect(
      generateArtifactId("EV", {
        now: new Date("2026-01-02T00:00:00.000Z"),
        random: () => new Uint8Array(5),
      })
    ).toBe("EV-20260102-00000000");
    expect(isDatedArtifactId(generateArtifactId("WB"))).toBe(true);
    expect(isLegacySequentialId("WB-00001")).toBe(true);
    expect(isLegacySequentialId("WB-20261030-ZZZZZZZZ")).toBe(false);
  });

  it("skips taken ids and sorts after legacy ids", () => {
    const sequence = ["WB-20261030-AAAAAAAA", "WB-20261030-BBBBBBBB"];
    setArtifactIdGeneratorForTests(() => sequence.shift() ?? "");
    expect(
      allocateArtifactId("WB", (id) => id === "WB-20261030-AAAAAAAA")
    ).toBe("WB-20261030-BBBBBBBB");
    const ids = ["WB-20261030-BBBBBBBB", "WB-00063", "WB-20260101-ZZZZZZZZ"];
    expect([...ids].sort((a, b) => a.localeCompare(b))).toEqual([
      "WB-00063",
      "WB-20260101-ZZZZZZZZ",
      "WB-20261030-BBBBBBBB",
    ]);
  });

  it("rewrites only the id lines of a legacy mirror", () => {
    const rewritten = rewriteLegacyWritebackId(
      legacyMain16,
      "WB-00016",
      "WB-20261030-CCCCCCCC"
    );
    expect(rewritten).toBe(
      legacyMain16
        .replace(
          'id: "WB-00016"',
          'id: "WB-20261030-CCCCCCCC"\nlegacyId: "WB-00016"'
        )
        .replace("# WB-00016:", "# WB-20261030-CCCCCCCC:")
    );
    expect(rewriteLegacyWritebackId("no ids", "WB-00016", "x")).toBeNull();
  });

  it("requires the legacy id in frontmatter and accepts YAML quoting", () => {
    const singleQuoted = legacyMain16.replace(
      'id: "WB-00016"',
      "id: 'WB-00016'"
    );
    expect(
      rewriteLegacyWritebackId(singleQuoted, "WB-00016", "WB-20261030-DDDDDDDD")
    ).toBe(
      singleQuoted
        .replace(
          "id: 'WB-00016'",
          'id: "WB-20261030-DDDDDDDD"\nlegacyId: "WB-00016"'
        )
        .replace("# WB-00016:", "# WB-20261030-DDDDDDDD:")
    );
    const crlf = legacyMain16.replaceAll("\n", "\r\n");
    expect(
      rewriteLegacyWritebackId(crlf, "WB-00016", "WB-20261030-DDDDDDDD")
    ).toContain('id: "WB-20261030-DDDDDDDD"\r\nlegacyId: "WB-00016"\r\n');
    // An id line outside the frontmatter does not count.
    const bodyOnly = "# WB-00016: no frontmatter\n\nid: WB-00016\n";
    expect(
      rewriteLegacyWritebackId(bodyOnly, "WB-00016", "WB-20261030-DDDDDDDD")
    ).toBeNull();
  });
});

describe("writeback publish", () => {
  it("keeps canonical trees clean and lands records from two hosts without collisions", async () => {
    const { remote, homes } = await setupHosts(["host-a", "host-b"]);
    const homeA = homes["host-a"] as string;
    const homeB = homes["host-b"] as string;

    const a1 = await addRecord(homeA, "host a first");
    const a2 = await addRecord(homeA, "host a second");
    const b1 = await addRecord(homeB, "host b first");
    const ids = [a1.id, a2.id, b1.id];
    for (const id of ids) {
      expect(id).toMatch(DATED_WB_RE);
    }
    expect(new Set(ids).size).toBe(3);

    // Mirrors land in machine-local pending state, not the tracked tree.
    expect(facultAiWritebackReviewDir(homeA)).toStartWith(
      facultAiPendingReviewRoot(homeA)
    );
    expect(await statusPorcelain(homeA)).toBe("");
    expect(await statusPorcelain(homeB)).toBe("");

    const dryRun = await publishReviewArtifacts({
      homeDir: homeA,
      dryRun: true,
      branch: "review/host-a",
    });
    expect(dryRun.pushed).toBe(false);
    expect(dryRun.base).toBe("main");
    expect(dryRun.files.map((file) => file.action)).toEqual(["add", "add"]);
    expect(
      await git(remote, ["branch", "--list", "review/host-a"], remote)
    ).toBe("");

    const publishedA = await publishReviewArtifacts({
      homeDir: homeA,
      branch: "review/host-a",
    });
    const previewB = await publishReviewArtifacts({
      homeDir: homeB,
      dryRun: true,
    });
    const publishedB = await publishReviewArtifacts({ homeDir: homeB });
    expect(publishedB.branch).toBe(previewB.branch);
    expect(publishedA.pushed).toBe(true);
    expect(publishedB.pushed).toBe(true);
    expect(publishedB.branch).toMatch(HOST_BRANCH_RE);
    expect(publishedA.pullRequestMessage).toContain("not on GitHub");

    const branchA = await git(
      remote,
      ["ls-tree", "-r", "--name-only", "review/host-a"],
      remote
    );
    expect(branchA.split("\n").sort()).toEqual(
      [
        "AGENTS.md",
        "writebacks/global/WB-00016.md",
        "writebacks/global/WB-00063.md",
        `writebacks/global/${a1.id}.md`,
        `writebacks/global/${a2.id}.md`,
      ].sort()
    );
    expect(
      await remoteFile(
        remote,
        publishedB.branch,
        `writebacks/global/${b1.id}.md`
      )
    ).toContain(`# ${b1.id}: host b first`);
    // Publishing never touched main or either working tree.
    expect(
      await git(remote, ["ls-tree", "-r", "--name-only", "main"], remote)
    ).not.toContain(a1.id);
    expect(await statusPorcelain(homeA)).toBe("");
    expect(await statusPorcelain(homeB)).toBe("");

    // A second publish adds only new records to the same branch.
    const again = await publishReviewArtifacts({
      homeDir: homeA,
      branch: "review/host-a",
    });
    expect(again.pushed).toBe(false);
    expect(again.files.map((file) => file.reason)).toEqual([
      "on-branch",
      "on-branch",
    ]);
    const a3 = await addRecord(homeA, "host a third");
    const third = await publishReviewArtifacts({
      homeDir: homeA,
      branch: "review/host-a",
    });
    expect(third.files.filter((file) => file.action === "add")).toEqual([
      expect.objectContaining({ path: `writebacks/global/${a3.id}.md` }),
    ]);
    expect(
      await git(remote, ["rev-list", "--count", "main..review/host-a"], remote)
    ).toBe("2");
  });

  it("skips allocated ids already present in the tracked review tree", async () => {
    const { homes } = await setupHosts(["host-a"]);
    const homeA = homes["host-a"] as string;
    const tracked = join(homeA, ".ai", "writebacks", "global");
    await writeFile(
      join(tracked, "WB-20261030-AAAAAAAA.md"),
      "# WB-20261030-AAAAAAAA: tracked\n"
    );
    const sequence = ["WB-20261030-AAAAAAAA", "WB-20261030-BBBBBBBB"];
    setArtifactIdGeneratorForTests(() => sequence.shift() ?? "");
    const record = await addRecord(homeA, "avoid tracked id");
    expect(record.id).toBe("WB-20261030-BBBBBBBB");
  });

  it("does not publish pending records that still carry legacy ids", async () => {
    const { homes } = await setupHosts(["host-a"]);
    const homeA = homes["host-a"] as string;
    const pendingDir = join(
      facultAiPendingReviewRoot(homeA),
      "writebacks",
      "global"
    );
    await mkdir(pendingDir, { recursive: true });
    await writeFile(join(pendingDir, "WB-00070.md"), legacyMain16);
    const result = await publishReviewArtifacts({
      homeDir: homeA,
      branch: "review/host-a",
    });
    expect(result.files).toEqual([
      expect.objectContaining({ action: "skip", reason: "legacy-id" }),
    ]);
    expect(result.pushed).toBe(false);
  });

  it("migrates dirty legacy mirrors to new ids without rewriting tracked records", async () => {
    const { remote, homes } = await setupHosts(["host-a"]);
    const homeA = homes["host-a"] as string;
    const aiRoot = join(homeA, ".ai");
    const reviewDir = join(aiRoot, "writebacks", "global");
    // An old release rewrote a tracked record in place and wrote a local
    // WB-00063 that differs from the WB-00063 another machine landed.
    const modified16 = legacyMain16.replace(
      "tracked record on main",
      "local edit that reused the id"
    );
    const untracked63 = legacyMain63.replace(
      "record another machine landed",
      "local record with the same id"
    );
    await writeFile(join(reviewDir, "WB-00016.md"), modified16);
    await writeFile(join(reviewDir, "WB-00063.md"), untracked63);
    const sha = (value: string) =>
      createHash("sha256").update(value).digest("hex");

    const dryRun = await publishReviewArtifacts({
      homeDir: homeA,
      dryRun: true,
      branch: "review/host-a",
      includeLegacy: true,
    });
    expect(dryRun.migrations).toEqual([
      expect.objectContaining({
        source: "writebacks/global/WB-00016.md",
        sourceState: "modified",
        legacyId: "WB-00016",
        action: "migrate",
        sha256: sha(modified16),
      }),
      expect.objectContaining({
        source: "writebacks/global/WB-00063.md",
        sourceState: "untracked",
        legacyId: "WB-00063",
        action: "migrate",
        sha256: sha(untracked63),
      }),
    ]);
    expect(await readFile(join(reviewDir, "WB-00016.md"), "utf8")).toBe(
      modified16
    );

    const result = await publishReviewArtifacts({
      homeDir: homeA,
      branch: "review/host-a",
      includeLegacy: true,
      removeMigrated: true,
    });
    expect(result.pushed).toBe(true);
    const [m16, m63] = result.migrations;
    expect(m16?.newId).toMatch(DATED_WB_RE);
    expect(m63?.newId).toMatch(DATED_WB_RE);
    expect(m16?.removed).toBe(true);
    expect(m63?.removed).toBe(true);

    const landed16 = await remoteFile(
      remote,
      "review/host-a",
      `writebacks/global/${m16?.newId}.md`
    );
    expect(`${landed16}\n`).toBe(
      rewriteLegacyWritebackId(
        modified16,
        "WB-00016",
        m16?.newId as string
      ) as string
    );
    expect(landed16).toContain('legacyId: "WB-00016"');
    // Tracked records on the default branch stay exactly as they were.
    expect(
      await remoteFile(remote, "review/host-a", "writebacks/global/WB-00016.md")
    ).toBe(legacyMain16.trimEnd());
    expect(
      await remoteFile(remote, "review/host-a", "writebacks/global/WB-00063.md")
    ).toBe(legacyMain63.trimEnd());
    expect(
      await git(
        remote,
        ["diff", "--name-status", "main", "review/host-a"],
        remote
      )
    ).toBe(
      [
        `A\twritebacks/global/${m16?.newId}.md`,
        `A\twritebacks/global/${m63?.newId}.md`,
      ]
        .sort()
        .join("\n")
    );

    // Local copies were removed only after the push: the tracked file is
    // restored and the untracked copy is gone, so the tree is clean.
    expect(await statusPorcelain(homeA)).toBe("");
    expect(await readFile(join(reviewDir, "WB-00016.md"), "utf8")).toBe(
      legacyMain16
    );

    const rerun = await publishReviewArtifacts({
      homeDir: homeA,
      branch: "review/host-a",
      includeLegacy: true,
    });
    expect(rerun.migrations).toEqual([]);
    expect(rerun.pushed).toBe(false);
  });

  it("never writes a stale local copy over a reviewed record and reports conflicts", async () => {
    const { remote, seed, homes } = await setupHosts(["host-a"]);
    const homeA = homes["host-a"] as string;
    const record = await addRecord(homeA, "reviewed later");
    const relPath = `writebacks/global/${record.id}.md`;
    await publishReviewArtifacts({ homeDir: homeA, branch: "review/host-a" });
    // A reviewer edits the record, it merges, and the branch is deleted.
    await git(seed, ["pull", "-q", remote, "main"], seed);
    await git(seed, ["fetch", "-q", remote, "review/host-a"], seed);
    await git(seed, ["merge", "-q", "--no-edit", "FETCH_HEAD"], seed);
    await writeFile(
      join(seed, relPath),
      `${await readFile(join(seed, relPath), "utf8")}\nReviewed.\n`
    );
    await git(seed, ["commit", "-qam", "review edit"], seed);
    await git(seed, ["push", "-q", remote, "HEAD:main"], seed);
    await git(remote, ["branch", "-D", "review/host-a"], remote);

    const stale = await publishReviewArtifacts({
      homeDir: homeA,
      branch: "review/host-a",
    });
    expect(stale.files).toEqual([
      expect.objectContaining({ path: relPath, reason: "published" }),
    ]);
    expect(stale.pushed).toBe(false);

    const pending = join(facultAiPendingReviewRoot(homeA), relPath);
    await writeFile(pending, "# local change after publish\n");
    const conflict = await publishReviewArtifacts({
      homeDir: homeA,
      branch: "review/host-a",
    });
    expect(conflict.files).toEqual([
      expect.objectContaining({ path: relPath, reason: "conflict" }),
    ]);
    expect(conflict.pushed).toBe(false);
    expect(await remoteFile(remote, "main", relPath)).toContain("Reviewed.");
  });

  it("updates its own record when the shared copy is the one it published", async () => {
    const { remote, seed, homes } = await setupHosts(["host-a"]);
    const homeA = homes["host-a"] as string;
    const record = await addRecord(homeA, "status changes later");
    const relPath = `writebacks/global/${record.id}.md`;
    await publishReviewArtifacts({ homeDir: homeA, branch: "review/host-a" });
    await git(seed, ["pull", "-q", remote, "main"], seed);
    await git(seed, ["fetch", "-q", remote, "review/host-a"], seed);
    await git(seed, ["merge", "-q", "--no-edit", "FETCH_HEAD"], seed);
    await git(seed, ["push", "-q", remote, "HEAD:main"], seed);
    await git(remote, ["branch", "-D", "review/host-a"], remote);
    await writeFile(
      join(facultAiPendingReviewRoot(homeA), relPath),
      "# status changed\n"
    );
    const result = await publishReviewArtifacts({
      homeDir: homeA,
      branch: "review/host-a",
    });
    expect(result.files).toEqual([
      expect.objectContaining({ path: relPath, action: "update" }),
    ]);
    expect(result.pushed).toBe(true);
    expect(await remoteFile(remote, "review/host-a", relPath)).toBe(
      "# status changed"
    );
  });

  it("retries the pull request step for an unmerged branch with nothing new", async () => {
    const { homes } = await setupHosts(["host-a"]);
    const homeA = homes["host-a"] as string;
    await addRecord(homeA, "pull request step failed");
    const first = await publishReviewArtifacts({
      homeDir: homeA,
      branch: "review/host-a",
      pullRequest: false,
    });
    expect(first.pushed).toBe(true);
    const retry = await publishReviewArtifacts({
      homeDir: homeA,
      branch: "review/host-a",
    });
    expect(retry.pushed).toBe(false);
    expect(retry.message).toContain("still has unmerged records");
    expect(retry.pullRequestMessage).toContain("not on GitHub");
  });

  it("reruns a landed migration for cleanup without another commit and keeps staged copies", async () => {
    const { remote, homes } = await setupHosts(["host-a"]);
    const homeA = homes["host-a"] as string;
    const aiRoot = join(homeA, ".ai");
    const reviewDir = join(aiRoot, "writebacks", "global");
    const staged16 = legacyMain16.replace("tracked record on main", "staged");
    const worktree16 = legacyMain16.replace(
      "tracked record on main",
      "working tree"
    );
    await writeFile(join(reviewDir, "WB-00016.md"), staged16);
    await git(aiRoot, ["add", "writebacks/global/WB-00016.md"], aiRoot);
    await writeFile(join(reviewDir, "WB-00016.md"), worktree16);
    await writeFile(
      join(reviewDir, "WB-00077.md"),
      legacyMain16.replaceAll("WB-00016", "WB-00077")
    );

    const first = await publishReviewArtifacts({
      homeDir: homeA,
      branch: "review/host-a",
      includeLegacy: true,
    });
    expect(first.pushed).toBe(true);
    const head = await git(remote, ["rev-parse", "review/host-a"], remote);

    const cleanup = await publishReviewArtifacts({
      homeDir: homeA,
      branch: "review/host-a",
      includeLegacy: true,
      removeMigrated: true,
    });
    expect(cleanup.pushed).toBe(false);
    expect(await git(remote, ["rev-parse", "review/host-a"], remote)).toBe(
      head
    );
    expect(cleanup.migrations.map((entry) => entry.newId)).toEqual(
      first.migrations.map((entry) => entry.newId)
    );
    const [m16, m77] = cleanup.migrations;
    expect(m16).toMatchObject({ landed: true, kept: "staged" });
    expect(m77).toMatchObject({ landed: true, removed: true });
    // The staged and working-tree versions of the tracked file are untouched.
    expect(await readFile(join(reviewDir, "WB-00016.md"), "utf8")).toBe(
      worktree16
    );
    expect(
      await git(aiRoot, ["show", ":writebacks/global/WB-00016.md"], aiRoot)
    ).toBe(staged16.trimEnd());
    expect(existsSync(join(reviewDir, "WB-00077.md"))).toBe(false);
  });

  it("serializes publishes and replaces a lock left by a dead process", async () => {
    const { homes } = await setupHosts(["host-a"]);
    const homeA = homes["host-a"] as string;
    const lockPath = `${facultAiReviewPublishStatePath(homeA)}.lock`;
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, `${process.pid}\n`);
    await expect(
      publishReviewArtifacts({ homeDir: homeA, dryRun: true })
    ).rejects.toThrow("Another writeback publish is running");
    await writeFile(lockPath, "999999999\n");
    const result = await publishReviewArtifacts({
      homeDir: homeA,
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("refuses to remove migrated files without migrating and to publish to the base branch", async () => {
    const { homes } = await setupHosts(["host-a"]);
    const homeA = homes["host-a"] as string;
    await expect(
      publishReviewArtifacts({ homeDir: homeA, removeMigrated: true })
    ).rejects.toThrow("--remove-migrated requires --include-legacy");
    await expect(
      publishReviewArtifacts({ homeDir: homeA, branch: "main" })
    ).rejects.toThrow("Refusing to publish straight to the default branch");
  });
});
