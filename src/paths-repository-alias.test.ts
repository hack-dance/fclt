import { afterEach, expect, it, spyOn } from "bun:test";
import {
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
import { runFixtureGit } from "../test/git-fixture";
import {
  facultLocalStateRoot,
  machineStateProjectKey,
  repositoryMachineStateProjectKey,
} from "./paths";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fclt-state-alias-"))
  );
  const home = join(root, "home");
  const repo = join(root, "repo");
  const linked = join(root, "linked");
  const git = (argv: string[]) =>
    runFixtureGit({ argv, repoDir: repo, homeDir: home, cwd: root });
  await git(["init", "-b", "main", repo]);
  await git([
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  await git(["-C", repo, "worktree", "add", "--detach", linked]);
  const identity = await import("./repository-identity");
  const legacy = identity.repositoryCommonIdentitySync(repo, {
    legacyDeviceIdentity: true,
  });
  if (!legacy) {
    throw new Error("Missing fixture repository identity");
  }
  // Model distinct Btrfs identities on every filesystem; Git discovery remains real.
  const stable = { ...legacy, id: "repo_fixture_stable" };
  const original = identity.repositoryCommonIdentitySync;
  const mocked = spyOn(
    identity,
    "repositoryCommonIdentitySync"
  ).mockImplementation((path, options) => {
    if (path === repo || path === linked) {
      return options?.legacyDeviceIdentity ? legacy : stable;
    }
    return original(path, options);
  });
  cleanup = async () => {
    mocked.mockRestore();
    await rm(root, { recursive: true, force: true });
  };
  const projects = join(facultLocalStateRoot(home), "projects");
  const legacyStore = join(projects, legacy.id);
  const stableStore = join(projects, stable.id);
  const queue = join(legacyStore, "ai", "project", "writeback", "queue.jsonl");
  await mkdir(join(legacyStore, "ai", "project", "writeback"), {
    recursive: true,
  });
  await writeFile(queue, '{"id":"legacy-record"}\n');
  return {
    home,
    repo,
    linked,
    legacy,
    stable,
    legacyStore,
    stableStore,
    queue,
    projects,
  };
}

it("uses the populated device alias without copying or deleting state, including from a worktree", async () => {
  const f = await fixture();
  for (const repo of [f.repo, f.linked]) {
    expect(repositoryMachineStateProjectKey(join(repo, ".ai"), f.home)).toBe(
      f.legacy.id
    );
    expect(machineStateProjectKey(join(repo, ".ai"), f.home)).toBe(f.legacy.id);
  }
  expect(await readFile(f.queue, "utf8")).toBe('{"id":"legacy-record"}\n');
  expect(await readdir(f.projects)).toEqual([f.legacy.id]);
});

it("refuses two populated stores and preserves both", async () => {
  const f = await fixture();
  await mkdir(f.stableStore);
  const stableQueue = join(f.stableStore, "queue.jsonl");
  await writeFile(stableQueue, '{"id":"stable-record"}\n');
  for (const repo of [f.repo, f.linked]) {
    expect(() => machineStateProjectKey(join(repo, ".ai"), f.home)).toThrow(
      "Conflicting device-based and stable repository state"
    );
  }
  expect(await readFile(f.queue, "utf8")).toBe('{"id":"legacy-record"}\n');
  expect(await readFile(stableQueue, "utf8")).toBe('{"id":"stable-record"}\n');
});

it("uses the alias when the stable store contains only empty directories", async () => {
  const f = await fixture();
  await mkdir(join(f.stableStore, "ai", "project"), { recursive: true });
  expect(machineStateProjectKey(join(f.repo, ".ai"), f.home)).toBe(f.legacy.id);
});

it("uses stable identity when the legacy store contains only empty directories", async () => {
  const f = await fixture();
  await rm(f.queue);
  expect(machineStateProjectKey(join(f.repo, ".ai"), f.home)).toBe(f.stable.id);
});

it("retains the primary execution-store conflict check when selecting an alias", async () => {
  const f = await fixture();
  const identity = await import("./repository-identity");
  const executionStore = join(
    f.projects,
    identity.repositoryExecutionIdentity(f.repo).id
  );
  await mkdir(executionStore);
  await writeFile(join(executionStore, "queue.jsonl"), "{}\n");
  expect(() => machineStateProjectKey(join(f.repo, ".ai"), f.home)).toThrow(
    "Existing primary-checkout execution state"
  );
});

it("refuses an unsafe stable store rather than selecting the alias", async () => {
  const f = await fixture();
  await symlink(f.legacyStore, f.stableStore, "junction");
  expect(() => machineStateProjectKey(join(f.repo, ".ai"), f.home)).toThrow(
    "Refusing unsafe machine-local project state directory"
  );
});
