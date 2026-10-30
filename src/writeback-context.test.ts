import { afterEach, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runFixtureGit } from "../test/git-fixture";
import type { AiWritebackRecord } from "./ai";
import {
  facultAiJournalPath,
  facultAiWritebackQueuePath,
  facultAiWritebackReviewDir,
  facultLocalStateRoot,
} from "./paths";
import {
  applyProjectEnrollment,
  planProjectEnrollment,
  projectCommand,
} from "./projects";

const fixtures: string[] = [];
const origin = "https://example.invalid/team/repo.git";

afterEach(async () => {
  for (const path of fixtures.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

async function fixture({ enroll = true, remote = true } = {}) {
  const homeDir = await realpath(
    await mkdtemp(join(tmpdir(), "fclt-writeback-context-"))
  );
  fixtures.push(homeDir);
  const primary = join(homeDir, "repo");
  const linked = join(homeDir, "linked");
  const clone = join(homeDir, "scratch");
  await mkdir(primary);
  const git = (repoDir: string, ...argv: string[]) =>
    runFixtureGit({
      argv: ["-C", repoDir, ...argv],
      repoDir,
      homeDir: join(homeDir, "git-home"),
    });
  await git(primary, "init", "-q");
  await Bun.write(join(primary, "AGENTS.md"), "# Fixture guidance\n");
  await git(primary, "add", "AGENTS.md");
  await git(
    primary,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "init"
  );
  await git(primary, "worktree", "add", "--detach", linked);
  await runFixtureGit({
    argv: ["clone", "--no-hardlinks", primary, clone],
    repoDir: clone,
    homeDir: join(homeDir, "git-home"),
  });
  await git(clone, "remote", "remove", "origin");
  if (remote) {
    await git(primary, "remote", "add", "origin", origin);
    await git(
      clone,
      "remote",
      "add",
      "origin",
      "git@example.invalid:team/repo.git"
    );
  }
  if (enroll) {
    const plan = await planProjectEnrollment({ projectRoot: primary, homeDir });
    await applyProjectEnrollment({
      plan,
      expectedPlanSha256: plan.planSha256,
      homeDir,
    });
  }
  return {
    homeDir,
    primary,
    linked,
    clone,
    git,
    rootDir: join(primary, ".ai"),
  };
}

async function cli(args: {
  homeDir: string;
  cwd: string;
  argv: string[];
  environmentRoot?: string;
  environmentScope?: string;
}) {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "index.ts"),
      "ai",
      "writeback",
      ...args.argv,
      "--json",
    ],
    {
      cwd: args.cwd,
      env: {
        ...process.env,
        HOME: args.homeDir,
        XDG_STATE_HOME: join(args.homeDir, "state"),
        XDG_CONFIG_HOME: join(args.homeDir, "config"),
        XDG_DATA_HOME: join(args.homeDir, "data"),
        XDG_CACHE_HOME: join(args.homeDir, "cache"),
        FACULT_LOCAL_STATE_DIR: facultLocalStateRoot(args.homeDir),
        FACULT_CACHE_DIR: join(args.homeDir, "cache", "fclt"),
        FACULT_ROOT_DIR: args.environmentRoot ?? "",
        FACULT_ROOT_SCOPE: args.environmentScope ?? "",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0 || stderr) {
    throw new Error(`CLI failed (${code}): ${stderr}`);
  }
  return stdout;
}

const addArgs = [
  "add",
  "--kind",
  "reusable_pattern",
  "--summary",
  "Fixture learning",
  "--evidence",
  "test:writeback-context",
  "--tag",
  "fixture",
];

it.each([
  "primary",
  "linked",
  "clone",
] as const)("routes %s and nested invocations to the enrolled queue", async (checkout) => {
  const args = await fixture();
  const cwd = join(args[checkout], "nested");
  await mkdir(cwd);
  const before = await readdir(
    join(facultLocalStateRoot(args.homeDir), "projects")
  );
  const record = JSON.parse(
    await cli({
      ...args,
      cwd,
      argv: [...addArgs, "--project", "--asset", "AGENTS.md"],
    })
  ) as AiWritebackRecord;
  expect(record.scope).toBe("project");
  expect(record.projectRoot).toBe(args.primary);
  expect(record.tags).toEqual(["fixture"]);
  expect(record.assetRef).toBe("@project/AGENTS.md");
  expect(
    await readFile(
      facultAiWritebackQueuePath(args.homeDir, args.rootDir),
      "utf8"
    )
  ).toContain(record.summary);
  expect(JSON.parse(await cli({ ...args, cwd, argv: ["list"] }))).toEqual([
    record,
  ]);
  expect(
    await readdir(join(facultLocalStateRoot(args.homeDir), "projects"))
  ).toEqual(before);
  expect(await Bun.file(join(args.clone, ".ai", "config.toml")).exists()).toBe(
    false
  );
});

it.each([
  true,
  false,
])("uses global storage and a project tag for an unenrolled repo (remote=%s)", async (remote) => {
  const args = await fixture({ enroll: false, remote });
  // A copied .ai directory does not establish enrollment.
  await Bun.write(join(args.primary, ".ai", "config.toml"), "version = 1\n");
  for (const scope of [[], ["--project"]]) {
    const record = JSON.parse(
      await cli({
        ...args,
        cwd: args.primary,
        argv: [...addArgs, ...scope, "--asset", "AGENTS.md"],
      })
    ) as AiWritebackRecord;
    expect(record.scope).toBe("global");
    expect(record.projectRoot).toBeUndefined();
    expect(record.tags).toEqual([
      "fixture",
      `project:${remote ? "example.invalid/team/repo" : "repo"}`,
    ]);
    expect(record.assetRef).toBe("@project/AGENTS.md");
  }
  const globalRoot = join(args.homeDir, ".ai");
  for (const path of [
    facultAiWritebackQueuePath(args.homeDir, globalRoot),
    facultAiJournalPath(args.homeDir, globalRoot),
    facultAiWritebackReviewDir(args.homeDir, globalRoot),
  ]) {
    expect(relative(args.homeDir, path).startsWith("..")).toBe(false);
    expect(
      (await Bun.file(path).exists()) ||
        (await readdir(path).catch(() => [])).length > 0
    ).toBe(true);
  }
  expect(
    await readdir(join(facultLocalStateRoot(args.homeDir), "projects")).catch(
      () => []
    )
  ).toEqual([]);
});

it("does not match shared history, upstream remotes, or similarly named forks", async () => {
  const args = await fixture();
  await args.git(
    args.clone,
    "remote",
    "set-url",
    "origin",
    "https://example.invalid/other/repo.git"
  );
  await args.git(args.clone, "remote", "add", "upstream", origin);
  const record = JSON.parse(
    await cli({ ...args, cwd: args.clone, argv: addArgs })
  ) as AiWritebackRecord;
  expect(record.scope).toBe("global");
  expect(record.tags).toContain("project:example.invalid/other/repo");
});

it("maps linked checkouts without a remote but leaves independent clones global", async () => {
  const args = await fixture({ remote: false });
  for (const checkout of ["linked", "clone"] as const) {
    const record = JSON.parse(
      await cli({ ...args, cwd: args[checkout], argv: addArgs })
    ) as AiWritebackRecord;
    expect(record.scope).toBe(checkout === "linked" ? "project" : "global");
  }
});

it("preserves explicit global, root, and environment selection", async () => {
  const args = await fixture();
  for (const options of [
    { argv: [...addArgs, "--global"] },
    {
      argv: addArgs,
      environmentRoot: join(args.homeDir, ".ai"),
      environmentScope: "global",
    },
    { argv: [...addArgs, "--root", join(args.homeDir, ".ai")] },
  ]) {
    const record = JSON.parse(
      await cli({ ...args, cwd: args.clone, ...options })
    ) as AiWritebackRecord;
    expect(record.scope).toBe("global");
    expect(record.tags).toEqual(["fixture"]);
  }
  const record = JSON.parse(
    await cli({
      ...args,
      cwd: args.linked,
      argv: [...addArgs, "--root", join(args.linked, ".ai")],
    })
  ) as AiWritebackRecord;
  expect(record.projectRoot).toBe(args.primary);
});

it("falls back globally when enrollment is disabled or its checkout is unavailable", async () => {
  const args = await fixture();
  const registryPath = join(
    facultLocalStateRoot(args.homeDir),
    "projects",
    "registry.json"
  );
  const before = await readFile(registryPath, "utf8");
  await projectCommand(["disable", "--project-root", args.primary, "--json"], {
    homeDir: args.homeDir,
  });
  const disabled = JSON.parse(
    await cli({ ...args, cwd: args.clone, argv: addArgs })
  ) as AiWritebackRecord;
  expect(disabled.scope).toBe("global");
  await Bun.write(registryPath, before);
  await rm(args.rootDir, { recursive: true });
  const stale = JSON.parse(
    await cli({ ...args, cwd: args.clone, argv: addArgs })
  ) as AiWritebackRecord;
  expect(stale.scope).toBe("global");
  expect(stale.tags).toContain("project:example.invalid/team/repo");
});

it("requires an explicit destination for ambiguous origins and prefers a shared checkout", async () => {
  const args = await fixture();
  const second = join(args.homeDir, "second-enrolled");
  await runFixtureGit({
    argv: ["clone", "--no-hardlinks", args.primary, second],
    repoDir: second,
    homeDir: join(args.homeDir, "git-home"),
  });
  await args.git(second, "remote", "set-url", "origin", origin);
  const plan = await planProjectEnrollment({
    projectRoot: second,
    homeDir: args.homeDir,
  });
  await applyProjectEnrollment({
    plan,
    expectedPlanSha256: plan.planSha256,
    homeDir: args.homeDir,
  });
  await expect(
    cli({ ...args, cwd: args.clone, argv: addArgs })
  ).rejects.toThrow("Multiple enrolled checkouts match this origin");
  const record = JSON.parse(
    await cli({ ...args, cwd: args.linked, argv: addArgs })
  ) as AiWritebackRecord;
  expect(record.projectRoot).toBe(args.primary);
  const explicit = JSON.parse(
    await cli({
      ...args,
      cwd: args.clone,
      argv: [...addArgs, "--root", args.rootDir],
    })
  ) as AiWritebackRecord;
  expect(explicit.projectRoot).toBe(args.primary);
});
