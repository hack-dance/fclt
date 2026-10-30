import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acceptProposal,
  addWriteback,
  applyProposal,
  assessEvolution,
  draftProposal,
  linkProposalWriteback,
  linkWritebackEvidence,
  listProposals,
  listWritebacks,
  promoteProposal,
  proposeEvolution,
  refreshAiReviewArtifacts,
  showWriteback,
} from "./ai";
import {
  readAiTarget,
  readAiText,
  replaceAiTarget,
  withAiMutationScope,
  writeAiText,
} from "./ai-filesystem";
import { aiPathSafetyIssue, realUserHome } from "./ai-path-guard";
import {
  facultAiDraftDir,
  facultAiEvolutionReviewDir,
  facultAiGraphPath,
  facultAiIndexPath,
  facultAiJournalPath,
  facultAiProposalDir,
  facultAiWritebackQueuePath,
  facultAiWritebackReviewDir,
  resolvePhysicalPath,
} from "./paths";

const CANONICAL_ERROR_RE = /canonical/i;
const PROVENANCE_ERROR_RE = /provenance|promotion/i;
const SCOPE_ERROR_RE = /scope/i;
const ROOT_ERROR_RE = /root|scope|bound|authorized/i;
const STAGING_ERROR_RE = /stag|chang|bound|parent/i;
const realHome = realUserHome();
const savedEnv = { ...process.env };
let tempHome: string;
let durableFixture: string | undefined;
let restorePathGuard: (() => void) | undefined;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "fclt-ai-path-guard-"));
  process.env.HOME = tempHome;
  process.env.FACULT_LOCAL_STATE_DIR = join(tempHome, "state");
  Reflect.deleteProperty(process.env, "FCLT_ALLOW_EPHEMERAL_AI_PATHS");
});

afterEach(async () => {
  restorePathGuard?.();
  restorePathGuard = undefined;
  for (const name of [
    "HOME",
    "FACULT_LOCAL_STATE_DIR",
    "FCLT_ALLOW_EPHEMERAL_AI_PATHS",
    "FACULT_ROOT_DIR",
    "FACULT_ROOT_SCOPE",
    "TMPDIR",
  ]) {
    if (savedEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = savedEnv[name];
    }
  }
  await rm(tempHome, { recursive: true, force: true });
  if (durableFixture) {
    await rm(durableFixture, { recursive: true, force: true });
    durableFixture = undefined;
  }
});

async function makeDurableFixture() {
  const parent = join(import.meta.dir, "..", "_internal");
  await mkdir(parent, { recursive: true });
  durableFixture = await mkdtemp(join(parent, "ai-path-guard-"));
  return durableFixture;
}

/** Model only account-home identity; even a regressed guard must write into owned fixtures. */
async function fixtureAccountHome(fixture: string) {
  process.env.FACULT_LOCAL_STATE_DIR = join(fixture, "state");
  const homeDir = join(fixture, "home");
  await mkdir(homeDir);
  const checkPaths = aiPathSafetyIssue;
  const mocked = spyOn(
    await import("./ai-path-guard"),
    "aiPathSafetyIssue"
  ).mockImplementation((args) =>
    checkPaths({
      ...args,
      homeDir: args.homeDir === homeDir ? realHome : args.homeDir,
      sourceHome: args.sourceHome === homeDir ? realHome : args.sourceHome,
    })
  );
  // These are untracked fixture directories. Do not inherit the surrounding
  // checkout's Git authority or spend each path lookup probing its worktree.
  const identity = await import("./repository-identity");
  const canonicalRoot = identity.canonicalProjectRoot;
  const commonIdentity = identity.repositoryCommonIdentitySync;
  const inFixture = (path: string) =>
    path === fixture || path.startsWith(`${fixture}${sep}`);
  const mockedRoot = spyOn(identity, "canonicalProjectRoot").mockImplementation(
    (path) => (inFixture(path) ? path : canonicalRoot(path))
  );
  const mockedIdentity = spyOn(
    identity,
    "repositoryCommonIdentitySync"
  ).mockImplementation((path) =>
    inFixture(path) ? null : commonIdentity(path)
  );
  restorePathGuard = () => {
    mocked.mockRestore();
    mockedRoot.mockRestore();
    mockedIdentity.mockRestore();
  };
  return homeDir;
}

async function runAiCli(argv: string[]) {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "index.ts"), "ai", ...argv],
    {
      cwd: tempHome,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function writebackArgs(rootDir = join(tempHome, ".ai")) {
  return {
    homeDir: tempHome,
    rootDir,
    kind: "missing_capability",
    confidence: "high" as const,
    summary: "Verification guidance needs a durable regression check.",
    suggestedDestination: "@ai/instructions/VERIFICATION.md",
    evidence: [{ type: "test", ref: "src/ai-path-guard.test.ts" }],
  };
}

async function seedJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(value)}\n`);
}

async function seedIndexedSkill(args: {
  homeDir: string;
  rootDir: string;
  scope: "project" | "global";
  temporaryTarget?: string;
}) {
  const directory = join(args.rootDir, "skills/guarded");
  const file = join(directory, "SKILL.md");
  await mkdir(directory, { recursive: true });
  if (args.temporaryTarget) {
    await symlink(args.temporaryTarget, file);
  } else {
    await Bun.write(
      file,
      "---\nname: guarded\ndescription: Guard fixture.\n---\n\n# Guarded skill\n"
    );
  }
  const id = `skill:${args.scope}:global:guarded`;
  await seedJson(facultAiGraphPath(args.homeDir, args.rootDir), {
    version: 1,
    generatedAt: new Date().toISOString(),
    edges: [],
    nodes: {
      [id]: {
        id,
        kind: "skill",
        name: "guarded",
        sourceKind: args.scope,
        scope: args.scope,
        canonicalRef: `@${args.scope === "project" ? "project" : "ai"}/skills/guarded`,
        path: directory,
      },
    },
  });
  return file;
}

describe("AI state path guard", () => {
  it.skipIf(process.platform === "win32")(
    "excludes dangling source homes without losing healthy writebacks and proposals",
    async () => {
      const fixture = await makeDurableFixture();
      const homeDir = await fixtureAccountHome(fixture);
      const rootDir = join(fixture, ".ai");
      process.env.FACULT_ROOT_DIR = rootDir;
      process.env.FACULT_ROOT_SCOPE = "global";
      const args = { ...writebackArgs(rootDir), homeDir };
      const healthyWriteback = await addWriteback(args);
      const [healthyProposal] = await proposeEvolution(args);
      const brokenHome = join(fixture, "broken-home");
      await symlink(join(tempHome, "missing-home"), brokenHome, "dir");
      expect(
        aiPathSafetyIssue({ homeDir, sourceHome: brokenHome, paths: [rootDir] })
      ).toContain("cannot verify HOME path");
      expect(
        aiPathSafetyIssue({ homeDir: brokenHome, paths: [rootDir] })
      ).toContain("dangling symbolic link");
      const badWriteback = {
        ...healthyWriteback,
        id: "WB-00002",
        sourceHome: brokenHome,
      };
      await Bun.write(
        facultAiWritebackQueuePath(homeDir, rootDir),
        [healthyWriteback, badWriteback]
          .map((entry) => `${JSON.stringify(entry)}\n`)
          .join("")
      );
      await seedJson(
        join(facultAiProposalDir(homeDir, rootDir), "EV-00002.json"),
        {
          ...healthyProposal,
          id: "EV-00002",
          sourceHome: brokenHome,
          sourceWritebacks: [badWriteback.id],
        }
      );
      const assessment = await assessEvolution(args);
      expect(assessment.recommendation).toBe("review_existing_proposal");
      expect(assessment.sourceWritebacks).toEqual([healthyWriteback.id]);
      expect(assessment.activeProposalIds).toEqual([healthyProposal!.id]);
      expect(assessment.warnings).toHaveLength(2);
      expect(
        assessment.warnings.every((warning) =>
          warning.includes("dangling symbolic link")
        )
      ).toBe(true);
    }
  );

  it.skipIf(process.platform === "win32")(
    "checks SKILL.md links at creation, assessment, draft and apply",
    async () => {
      const fixture = await makeDurableFixture();
      const homeDir = await fixtureAccountHome(fixture);
      const rootDir = join(fixture, ".ai");
      const temporaryTarget = join(tempHome, "SKILL.md");
      const original = "# Temporary target must stay unchanged\n";
      await Bun.write(temporaryTarget, original);
      await seedIndexedSkill({
        homeDir,
        rootDir,
        scope: "project",
        temporaryTarget,
      });
      const args = {
        ...writebackArgs(rootDir),
        homeDir,
        asset: "skill:guarded",
        suggestedDestination: undefined,
      };
      await expect(addWriteback(args)).rejects.toThrow(
        "OS temporary directory"
      );
      expect(existsSync(facultAiWritebackQueuePath(homeDir, rootDir))).toBe(
        false
      );
      const writeback = await addWriteback({ ...args, allowEphemeral: true });
      await expect(proposeEvolution(args)).rejects.toThrow(
        "OS temporary directory"
      );
      const [proposal] = await proposeEvolution({
        ...args,
        allowEphemeral: true,
      });
      const assessment = await assessEvolution(args);
      expect(assessment.activeProposalIds).toEqual([]);
      expect(assessment.sourceWritebacks).toEqual([]);
      expect(
        assessment.warnings.some((warning) => warning.includes(writeback.id))
      ).toBe(true);
      expect(
        assessment.warnings.some((warning) => warning.includes(proposal!.id))
      ).toBe(true);
      await expect(draftProposal(proposal!.id, args)).rejects.toThrow(
        "OS temporary directory"
      );
      // The main branch also confines final targets to the capability root.
      await expect(
        draftProposal(proposal!.id, { ...args, allowEphemeral: true })
      ).rejects.toThrow("Automatic drafting");
      const draft = join(
        facultAiDraftDir(homeDir, rootDir),
        `${proposal!.id}.md`
      );
      await mkdir(dirname(draft), { recursive: true });
      await Bun.write(
        draft,
        `<!-- facult:evolution:${proposal!.id}:start -->\nApproved content\n<!-- facult:evolution:${proposal!.id}:end -->\n`
      );
      await seedJson(
        join(facultAiProposalDir(homeDir, rootDir), `${proposal!.id}.json`),
        {
          ...proposal,
          status: "accepted",
          draftRefs: [draft],
        }
      );
      await expect(applyProposal(proposal!.id, args)).rejects.toThrow(
        "OS temporary directory"
      );
      await expect(
        applyProposal(proposal!.id, { ...args, allowEphemeral: true })
      ).rejects.toThrow("Automatic drafting");
      expect(await Bun.file(temporaryTarget).text()).toBe(original);
    }
  );

  it.skipIf(process.platform === "win32")(
    "validates the promoted skill's final SKILL.md file in the destination graph",
    async () => {
      const fixture = await makeDurableFixture();
      const homeDir = await fixtureAccountHome(fixture);
      const rootDir = join(fixture, "project/.ai");
      const globalRoot = join(fixture, "global/.ai");
      process.env.FACULT_ROOT_DIR = globalRoot;
      process.env.FACULT_ROOT_SCOPE = "global";
      const temporaryTarget = join(tempHome, "SKILL.md");
      await Bun.write(temporaryTarget, "# Temporary global skill\n");
      await seedIndexedSkill({ homeDir, rootDir, scope: "project" });
      await seedIndexedSkill({
        homeDir,
        rootDir: globalRoot,
        scope: "global",
        temporaryTarget,
      });
      const args = {
        ...writebackArgs(rootDir),
        homeDir,
        asset: "skill:guarded",
        suggestedDestination: undefined,
      };
      await addWriteback(args);
      const [proposal] = await proposeEvolution(args);
      await expect(
        promoteProposal(proposal!.id, { homeDir, rootDir, to: "global" })
      ).rejects.toThrow("OS temporary directory");
      expect(existsSync(facultAiProposalDir(homeDir, globalRoot))).toBe(false);
      const promoted = await promoteProposal(proposal!.id, {
        homeDir,
        rootDir,
        to: "global",
        allowEphemeral: true,
      });
      const assessmentArgs = {
        homeDir,
        rootDir: globalRoot,
        asset: "skill:guarded",
      };
      const assessment = await assessEvolution(assessmentArgs);
      expect(assessment.activeProposalIds).toEqual([]);
      expect(
        assessment.warnings.some((warning) => warning.includes(promoted.id))
      ).toBe(true);
      expect(
        (await assessEvolution({ ...assessmentArgs, allowEphemeral: true }))
          .activeProposalIds
      ).toEqual([promoted.id]);
    }
  );

  it("keeps a normal indexed skill usable through apply without an override", async () => {
    const fixture = await makeDurableFixture();
    process.env.FACULT_LOCAL_STATE_DIR = join(fixture, "state");
    const homeDir = await fixtureAccountHome(fixture);
    const rootDir = join(fixture, ".ai");
    const file = await seedIndexedSkill({ homeDir, rootDir, scope: "project" });
    const args = {
      ...writebackArgs(rootDir),
      homeDir,
      asset: "skill:guarded",
      suggestedDestination: undefined,
    };
    await addWriteback(args);
    const [proposal] = await proposeEvolution(args);
    expect((await assessEvolution(args)).activeProposalIds).toEqual([
      proposal!.id,
    ]);
    await draftProposal(proposal!.id, args);
    await acceptProposal(proposal!.id, args);
    const applied = await applyProposal(proposal!.id, args);
    expect(applied.applyResult?.changedFiles).toEqual([file]);
    expect(await Bun.file(file).text()).toContain(
      `facult:evolution:${proposal!.id}:start`
    );
  });

  it.each([
    "temporary",
    "symlink",
    "relative",
  ])("rejects a %s draft source before apply and revision", async (layout) => {
    const fixture = await makeDurableFixture();
    process.env.FACULT_LOCAL_STATE_DIR = join(fixture, "state");
    const homeDir = await fixtureAccountHome(fixture);
    const rootDir = join(fixture, ".ai");
    const file = await seedIndexedSkill({ homeDir, rootDir, scope: "project" });
    const args = {
      ...writebackArgs(rootDir),
      homeDir,
      asset: "skill:guarded",
      suggestedDestination: undefined,
    };
    await addWriteback(args);
    const [proposal] = await proposeEvolution(args);
    await draftProposal(proposal!.id, args);
    const accepted = await acceptProposal(proposal!.id, args);
    const temporaryDraft = join(tempHome, "external-draft.md");
    const draftBody = `# External draft\n<!-- facult:evolution:${proposal!.id}:start -->\nExternal temporary content\n<!-- facult:evolution:${proposal!.id}:end -->\n`;
    await Bun.write(temporaryDraft, draftBody);
    let draftSource = temporaryDraft;
    if (layout === "symlink") {
      draftSource = join(fixture, "draft-link.md");
      await symlink(temporaryDraft, draftSource);
    } else if (layout === "relative") {
      draftSource = relative(process.cwd(), temporaryDraft);
    }
    await seedJson(
      join(facultAiProposalDir(homeDir, rootDir), `${accepted.id}.json`),
      {
        ...accepted,
        draftRefs: [draftSource],
      }
    );
    const original = await Bun.file(file).text();
    const assessment = await assessEvolution(args);
    expect(assessment.activeProposalIds).toEqual([]);
    expect(
      assessment.warnings.some((warning) => warning.includes(accepted.id))
    ).toBe(true);
    await expect(applyProposal(accepted.id, args)).rejects.toThrow(
      "OS temporary directory"
    );
    expect(await Bun.file(file).text()).toBe(original);
    await expect(
      draftProposal(accepted.id, { ...args, append: "Revise the guidance" })
    ).rejects.toThrow("OS temporary directory");
    expect(await Bun.file(file).text()).toBe(original);
    expect(await Bun.file(temporaryDraft).text()).toBe(draftBody);
    await expect(
      applyProposal(accepted.id, { ...args, allowEphemeral: true })
    ).rejects.toThrow(ROOT_ERROR_RE);
    expect(await Bun.file(file).text()).toBe(original);
  });

  it.skipIf(process.platform === "win32")(
    "checks an automatically selected existing draft before reading it",
    async () => {
      const fixture = await makeDurableFixture();
      process.env.FACULT_LOCAL_STATE_DIR = join(fixture, "state");
      const homeDir = await fixtureAccountHome(fixture);
      const rootDir = join(fixture, ".ai");
      await seedIndexedSkill({ homeDir, rootDir, scope: "project" });
      const args = {
        ...writebackArgs(rootDir),
        homeDir,
        asset: "skill:guarded",
        suggestedDestination: undefined,
      };
      await addWriteback(args);
      const [proposal] = await proposeEvolution(args);
      const temporaryDraft = join(tempHome, "existing-draft.md");
      const body = `<!-- facult:evolution:${proposal!.id}:start -->\nExisting temporary content\n<!-- facult:evolution:${proposal!.id}:end -->\n`;
      await Bun.write(temporaryDraft, body);
      const draftPath = join(
        facultAiDraftDir(homeDir, rootDir),
        `${proposal!.id}.md`
      );
      await mkdir(dirname(draftPath), { recursive: true });
      await symlink(temporaryDraft, draftPath);
      await expect(draftProposal(proposal!.id, args)).rejects.toThrow(
        "OS temporary directory"
      );
      expect(await Bun.file(temporaryDraft).text()).toBe(body);
      expect(
        existsSync(
          join(facultAiDraftDir(homeDir, rootDir), `${proposal!.id}.patch`)
        )
      ).toBe(false);
    }
  );

  it("finds the account home even when Bun starts with an alternate HOME", async () => {
    const modulePath = join(import.meta.dir, "ai-path-guard.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { realUserHome } from ${JSON.stringify(modulePath)}; console.log(realUserHome());`,
      ],
      {
        env: { ...process.env, HOME: join(realHome, "alternate-home") },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    expect(stdout.trim()).toBe(realHome);
  });

  it("refuses a temp-HOME writeback before creating its queue", async () => {
    const args = writebackArgs();
    await expect(addWriteback(args)).rejects.toThrow("HOME differs");
    expect(existsSync(facultAiWritebackQueuePath(tempHome, args.rootDir))).toBe(
      false
    );
  });

  it.each([
    "/tmp/fclt-source/.ai",
    "/private/tmp/fclt-source/.ai",
    "/var/folders/fclt-source/.ai",
    "/private/var/folders/fclt-source/.ai",
    "/var/tmp/fclt-source/.ai",
    "/private/var/tmp/fclt-source/.ai",
  ])("refuses proposal creation rooted at %s before writing state", async (rootDir) => {
    process.env.FACULT_ROOT_DIR = rootDir;
    process.env.FACULT_ROOT_SCOPE = "global";
    await expect(
      proposeEvolution({ homeDir: realHome, rootDir })
    ).rejects.toThrow("OS temporary directory");
    expect(existsSync(facultAiProposalDir(realHome, rootDir))).toBe(false);
  });

  it.each([
    "/var/tmp",
    "/private/var/tmp",
  ])("rejects %s sources and targets independently of TMPDIR", (root) => {
    process.env.TMPDIR = tempHome;
    for (const path of [
      join(root, "fclt-source/.ai"),
      join(root, "fclt-target/VERIFY.md"),
    ]) {
      expect(aiPathSafetyIssue({ homeDir: realHome, paths: [path] })).toContain(
        "OS temporary directory"
      );
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects physical aliases into /var/tmp independently of TMPDIR",
    async () => {
      process.env.TMPDIR = tempHome;
      const alias = join(await makeDurableFixture(), "var-tmp");
      await symlink("/var/tmp", alias, "dir");
      expect(
        aiPathSafetyIssue({
          homeDir: realHome,
          paths: [join(alias, "missing/VERIFY.md")],
        })
      ).toContain("OS temporary directory");
    }
  );

  it.each([
    "--summary",
    "--details",
    "--impact",
    "--attempted-workaround",
    "--desired-outcome",
    "--tag",
  ])("does not authorize temporary writes when %s contains the override spelling", async (option) => {
    const args = writebackArgs();
    const command = [
      "writeback",
      "add",
      "--kind",
      args.kind,
      "--evidence",
      "test:override-parser",
      "--root",
      args.rootDir,
      "--json",
    ];
    if (option !== "--summary") {
      command.push("--summary", "Parser regression");
    }
    const refused = await runAiCli([...command, option, "--allow-ephemeral"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("HOME differs");
    expect(existsSync(facultAiWritebackQueuePath(tempHome, args.rootDir))).toBe(
      false
    );
    const overridden = await runAiCli([
      ...command,
      "--allow-ephemeral",
      option,
      "--allow-ephemeral",
    ]);
    expect(overridden.code, overridden.stderr).toBe(0);
    const record = JSON.parse(overridden.stdout);
    if (option === "--summary") {
      expect(record.summary).toBe("--allow-ephemeral");
    }
  });

  it("does not interpret inline values or positional text as the override", async () => {
    const args = writebackArgs();
    const base = [
      "writeback",
      "add",
      "--kind",
      args.kind,
      "--evidence",
      "test:override-parser",
      "--root",
      args.rootDir,
    ];
    for (const suffix of [
      ["--summary=--allow-ephemeral"],
      ["--summary", "Parser regression", "--", "--allow-ephemeral"],
    ]) {
      const result = await runAiCli([...base, ...suffix]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("HOME differs");
    }
  });

  it.skipIf(process.platform === "win32")(
    "refuses durable file and directory symlinks to missing temporary targets",
    async () => {
      const fixture = await makeDurableFixture();
      const homeDir = await fixtureAccountHome(fixture);
      const rootDir = join(fixture, ".ai");
      await mkdir(join(rootDir, "instructions"), { recursive: true });
      for (const kind of ["file", "directory"]) {
        const missing = join(
          "/tmp",
          `fclt-missing-${crypto.randomUUID()}`,
          "VERIFY.md"
        );
        const link =
          kind === "file"
            ? join(rootDir, "instructions/VERIFY.md")
            : join(rootDir, "linked");
        await symlink(missing, link);
        const target = kind === "file" ? link : join(link, "child.md");
        expect(
          aiPathSafetyIssue({ homeDir: realHome, paths: [target] })
        ).toContain("dangling symbolic link");
        await expect(
          addWriteback({
            ...writebackArgs(rootDir),
            homeDir,
            suggestedDestination: target,
          })
        ).rejects.toThrow("dangling symbolic link");
        expect(existsSync(facultAiWritebackQueuePath(homeDir, rootDir))).toBe(
          false
        );
      }
      const target = join(rootDir, "instructions/VERIFY.md");
      await seedJson(facultAiWritebackQueuePath(homeDir, rootDir), {
        id: "WB-00001",
        ts: "2026-10-01T00:00:00Z",
        scope: "project",
        status: "recorded",
        ...writebackArgs(rootDir),
        suggestedDestination: target,
        source: "test",
        tags: [],
      });
      await seedJson(
        join(facultAiProposalDir(homeDir, rootDir), "EV-00001.json"),
        {
          id: "EV-00001",
          ts: "2026-10-01T00:00:00Z",
          scope: "project",
          status: "proposed",
          targets: [target],
          sourceWritebacks: ["WB-00001"],
          draftRefs: [],
        }
      );
      const assessment = await assessEvolution({ homeDir, rootDir });
      expect(assessment.sourceWritebacks).toEqual([]);
      expect(assessment.activeProposalIds).toEqual([]);
      expect(assessment.recommendation).not.toBe("review_existing_proposal");
      expect(assessment.warnings).toHaveLength(2);
    }
  );

  it.skipIf(process.platform === "win32")(
    "checks transformed global promotion targets before writing any destination state",
    async () => {
      const fixture = await makeDurableFixture();
      const homeDir = await fixtureAccountHome(fixture);
      const rootDir = join(fixture, "project/.ai");
      const globalRoot = join(fixture, "global/.ai");
      await mkdir(join(rootDir, "instructions"), { recursive: true });
      await Bun.write(
        join(rootDir, "instructions/VERIFY.md"),
        "# Verification\n"
      );
      await mkdir(globalRoot, { recursive: true });
      const destination = join(tempHome, "destination");
      await mkdir(destination);
      await symlink(destination, join(globalRoot, "instructions"), "dir");
      process.env.FACULT_ROOT_DIR = globalRoot;
      process.env.FACULT_ROOT_SCOPE = "global";
      const proposal = {
        id: "EV-00001",
        ts: "2026-10-01T00:00:00Z",
        scope: "project",
        status: "proposed",
        sourceRoot: rootDir,
        sourceHome: homeDir,
        projectRoot: dirname(rootDir),
        kind: "update_instruction",
        targets: ["@project/instructions/VERIFY.md"],
        sourceWritebacks: [],
        summary: "Promote verification guidance",
        rationale: "Reusable guidance",
        confidence: "high",
        reviewRequired: true,
        policyClass: "high-risk",
        draftRefs: [],
      };
      await seedJson(
        join(facultAiProposalDir(homeDir, rootDir), `${proposal.id}.json`),
        proposal
      );
      await expect(
        promoteProposal(proposal.id, {
          homeDir,
          rootDir,
          to: "global",
        })
      ).rejects.toThrow("OS temporary directory");
      expect(existsSync(facultAiProposalDir(homeDir, globalRoot))).toBe(false);
      expect(existsSync(facultAiJournalPath(homeDir, globalRoot))).toBe(false);
      const overridden = await promoteProposal(proposal.id, {
        homeDir,
        rootDir,
        to: "global",
        allowEphemeral: true,
      });
      expect(overridden.targets).toEqual(["@ai/instructions/VERIFY.md"]);
      expect(
        existsSync(
          join(
            facultAiProposalDir(homeDir, globalRoot),
            `${overridden.id}.json`
          )
        )
      ).toBe(true);
    }
  );

  it("rejects an alternate non-temporary HOME using the account home", () => {
    const otherHome = join(realHome, "alternate-home");
    expect(
      aiPathSafetyIssue({ homeDir: otherHome, paths: [join(otherHome, ".ai")] })
    ).toBe("HOME differs from the real user home");
  });

  it("accepts normal source and target paths under the real home", () => {
    expect(
      aiPathSafetyIssue({
        homeDir: realHome,
        paths: [
          join(realHome, ".ai"),
          join(realHome, ".ai/instructions/VERIFY.md"),
        ],
      })
    ).toBeUndefined();
  });

  it("recognizes TMPDIR and its physical spelling for missing descendants", () => {
    process.env.TMPDIR = tempHome;
    const physical = realpathSync(tempHome);
    expect(
      aiPathSafetyIssue({
        homeDir: realHome,
        paths: [join(physical, "missing/.ai")],
      })
    ).toContain("OS temporary directory");
  });

  it("checks target paths as well as the source root before enqueueing", async () => {
    const fixture = await makeDurableFixture();
    const homeDir = await fixtureAccountHome(fixture);
    const args = {
      ...writebackArgs(join(fixture, ".ai")),
      homeDir,
      suggestedDestination: "/tmp/fclt-target/VERIFY.md",
    };
    await expect(addWriteback(args)).rejects.toThrow("OS temporary directory");
    expect(existsSync(facultAiWritebackQueuePath(homeDir, args.rootDir))).toBe(
      false
    );
  });

  it("allows explicit temporary work and preserves provenance", async () => {
    const args = writebackArgs();
    const writeback = await addWriteback({ ...args, allowEphemeral: true });
    await expect(proposeEvolution(args)).rejects.toThrow("HOME differs");
    const [proposal] = await proposeEvolution({
      ...args,
      allowEphemeral: true,
    });
    expect(writeback.sourceRoot).toBe(args.rootDir);
    expect(writeback.sourceHome).toBe(tempHome);
    expect(proposal?.sourceRoot).toBe(args.rootDir);
    expect(proposal?.sourceHome).toBe(tempHome);
    const excluded = await assessEvolution(args);
    expect(excluded.sourceWritebacks).toEqual([]);
    expect(excluded.activeProposalIds).toEqual([]);
    expect(excluded.recommendation).not.toBe("review_existing_proposal");
    expect(
      excluded.warnings.some((warning) => warning.includes(proposal!.id))
    ).toBe(true);
    const included = await assessEvolution({ ...args, allowEphemeral: true });
    expect(included.recommendation).toBe("review_existing_proposal");
    expect(included.activeProposalIds).toEqual([proposal!.id]);
  });

  it("supports the explicit environment override, independent of NODE_ENV", async () => {
    process.env.FCLT_ALLOW_EPHEMERAL_AI_PATHS = "1";
    const args = writebackArgs();
    await addWriteback(args);
    expect(await proposeEvolution(args)).toHaveLength(1);
    expect((await assessEvolution(args)).recommendation).toBe(
      "review_existing_proposal"
    );
    await expect(
      addWriteback({ ...args, allowEphemeral: false })
    ).rejects.toThrow("HOME differs");
  });

  it("CLI flag permits isolated creation, draft and apply while defaults refuse", async () => {
    const args = writebackArgs();
    const cli = join(import.meta.dir, "index.ts");
    async function run(argv: string[]) {
      const child = Bun.spawn(
        [
          process.execPath,
          cli,
          "ai",
          ...argv,
          "--root",
          args.rootDir,
          "--json",
        ],
        {
          env: { ...process.env },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    }
    const command = [
      "writeback",
      "add",
      "--kind",
      args.kind,
      "--summary",
      args.summary,
      "--suggested-destination",
      args.suggestedDestination,
      "--evidence",
      "test:path-guard",
    ];
    expect((await run(command)).code).toBe(1);
    expect((await run([...command, "--allow-ephemeral"])).code).toBe(0);
    expect((await run(["evolve", "propose"])).code).toBe(1);
    const proposed = await run(["evolve", "propose", "--allow-ephemeral"]);
    expect(proposed.code).toBe(0);
    const id = JSON.parse(proposed.stdout)[0].id as string;
    const assessment = await run(["evolve", "assess"]);
    expect(assessment.code).toBe(0);
    expect(JSON.parse(assessment.stdout).activeProposalIds).toEqual([]);
    const override = await run(["evolve", "assess", "--allow-ephemeral"]);
    expect(JSON.parse(override.stdout).recommendation).toBe(
      "review_existing_proposal"
    );
    expect((await run(["evolve", "draft", id])).code).toBe(1);
    expect(
      (await run(["evolve", "draft", id, "--append", "--allow-ephemeral"])).code
    ).toBe(1);
    const draft = await run(["evolve", "draft", id, "--allow-ephemeral"]);
    expect(draft.code, draft.stderr).toBe(0);
    expect((await run(["evolve", "accept", id])).code).toBe(1);
    expect(
      (await run(["evolve", "accept", id, "--allow-ephemeral"])).code
    ).toBe(0);
    expect((await run(["evolve", "apply", id])).code).toBe(1);
    const applied = await run(["evolve", "apply", id, "--allow-ephemeral"]);
    expect(applied.code, applied.stderr).toBe(0);
  });

  it("excludes legacy contamination and linked proposals while retaining normal entries", async () => {
    const fixture = await makeDurableFixture();
    const homeDir = await fixtureAccountHome(fixture);
    const rootDir = join(fixture, ".ai");
    process.env.FACULT_ROOT_DIR = rootDir;
    process.env.FACULT_ROOT_SCOPE = "project";
    const args = { homeDir, rootDir };
    const base = {
      id: "WB-00001",
      ts: "2026-10-01T00:00:00Z",
      scope: "project",
      ...writebackArgs(rootDir),
      status: "recorded",
      tags: [],
      source: "test",
    };
    const rows = [
      base,
      { ...base, id: "WB-00002", projectRoot: "/tmp/legacy-project" },
      {
        ...base,
        id: "WB-00003",
        suggestedDestination: "/private/tmp/legacy-target.md",
      },
      { ...base, id: "WB-00004", sourceRoot: "/var/folders/legacy/.ai" },
      { ...base, id: "WB-00005", sourceHome: join(realHome, "alternate-home") },
    ];
    const queuePath = facultAiWritebackQueuePath(homeDir, rootDir);
    await mkdir(dirname(queuePath), { recursive: true });
    await Bun.write(
      queuePath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
    );
    const proposal = {
      id: "EV-00001",
      ts: base.ts,
      scope: "project",
      status: "proposed",
      kind: "update_asset",
      targets: [base.suggestedDestination],
      sourceWritebacks: [base.id],
      summary: "Normal proposal",
      rationale: "Normal signal",
      confidence: "high",
      reviewRequired: true,
      policyClass: "high-risk",
      draftRefs: [],
    };
    const proposals = [
      proposal,
      { ...proposal, id: "EV-00002", projectRoot: "/tmp/legacy-project" },
      {
        ...proposal,
        id: "EV-00003",
        targets: [...proposal.targets, "/tmp/legacy-target.md"],
      },
      { ...proposal, id: "EV-00004", sourceRoot: "/var/folders/legacy/.ai" },
      { ...proposal, id: "EV-00005", sourceWritebacks: ["WB-00002"] },
      {
        ...proposal,
        id: "EV-00006",
        draftRefs: ["/private/tmp/old-home/draft.md"],
      },
    ];
    for (const row of proposals) {
      await seedJson(
        join(facultAiProposalDir(homeDir, rootDir), `${row.id}.json`),
        row
      );
    }
    const assessment = await assessEvolution(args);
    expect(assessment.recommendation).toBe("review_existing_proposal");
    expect(assessment.activeProposalIds).toEqual([proposal.id]);
    expect(assessment.sourceWritebacks).toEqual([base.id]);
    expect(assessment.warnings).toHaveLength(11);
    expect(await listWritebacks(args)).toHaveLength(3);
    expect(await listProposals(args)).toHaveLength(6);
    await rm(
      join(facultAiProposalDir(homeDir, rootDir), `${proposal.id}.json`)
    );
    const withoutNormalProposal = await assessEvolution(args);
    expect(withoutNormalProposal.activeProposalIds).toEqual([]);
    expect(withoutNormalProposal.recommendation).toBe("propose");
    await expect(proposeEvolution(args)).rejects.toThrow(
      "OS temporary directory"
    );
  });

  it.each([
    "current",
    "legacy",
  ])("checks promoted source writebacks with %s metadata despite global ID collisions", async (metadata) => {
    const fixture = await makeDurableFixture();
    const homeDir = await fixtureAccountHome(fixture);
    const projectRoot = join(fixture, "project/.ai");
    const globalRoot = join(fixture, "global/.ai");
    for (const root of [projectRoot, globalRoot]) {
      await mkdir(join(root, "instructions"), { recursive: true });
      await Bun.write(
        join(root, "instructions/VERIFICATION.md"),
        "# Verification\n"
      );
    }
    process.env.FACULT_ROOT_DIR = globalRoot;
    process.env.FACULT_ROOT_SCOPE = "global";
    const projectArgs = {
      ...writebackArgs(projectRoot),
      homeDir,
      suggestedDestination: "@project/instructions/VERIFICATION.md",
    };
    const projectWriteback = await addWriteback(projectArgs);
    const [projectProposal] = await proposeEvolution(projectArgs);
    if (metadata === "legacy") {
      await seedJson(
        join(
          facultAiProposalDir(homeDir, projectRoot),
          `${projectProposal!.id}.json`
        ),
        {
          ...projectProposal,
          sourceRoot: undefined,
          sourceHome: undefined,
        }
      );
    }
    const promoted = await promoteProposal(projectProposal!.id, {
      homeDir,
      rootDir: projectRoot,
      to: "global",
    });
    const globalArgs = { ...writebackArgs(globalRoot), homeDir };
    const badGlobalWriteback = await addWriteback({
      ...globalArgs,
      suggestedDestination: "/tmp/unrelated-global-target.md",
      allowEphemeral: true,
    });
    const safeGlobalWriteback = await addWriteback(globalArgs);
    expect(badGlobalWriteback.id).toBe(projectWriteback.id);
    expect(promoted.sourceRoot).toBe(projectRoot);
    expect(promoted.sourceHome).toBe(homeDir);
    const assessmentArgs = { homeDir, rootDir: globalRoot };
    const assessment = await assessEvolution(assessmentArgs);
    expect(assessment.recommendation).toBe("review_existing_proposal");
    expect(assessment.activeProposalIds).toEqual([promoted.id]);
    expect(assessment.sourceWritebacks).toEqual([safeGlobalWriteback.id]);

    // Reverse the contamination: a safe global ID must not hide its unsafe project namesake.
    await Bun.write(
      facultAiWritebackQueuePath(homeDir, globalRoot),
      [
        {
          ...badGlobalWriteback,
          suggestedDestination: globalArgs.suggestedDestination,
        },
        safeGlobalWriteback,
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join("")
    );
    await seedJson(facultAiWritebackQueuePath(homeDir, projectRoot), {
      ...projectWriteback,
      suggestedDestination: "/tmp/actual-project-source.md",
    });
    const contaminated = await assessEvolution(assessmentArgs);
    expect(contaminated.activeProposalIds).toEqual([]);
    expect(contaminated.recommendation).toBe("propose");
    expect(contaminated.writebackCount).toBe(2);
    expect(contaminated.warnings).toContain(
      `Excluded ${promoted.id}: source writeback has ephemeral paths.`
    );
    expect(
      (await assessEvolution({ ...assessmentArgs, allowEphemeral: true }))
        .activeProposalIds
    ).toEqual([promoted.id]);
  });

  it("recognizes a symlink into temporary storage for missing target files", async () => {
    const link = join(tempHome, "link");
    await symlink(
      tempHome,
      link,
      process.platform === "win32" ? "junction" : "dir"
    );
    expect(
      aiPathSafetyIssue({
        homeDir: realHome,
        paths: [join(link, "missing.md")],
      })
    ).toContain("OS temporary directory");
  });
});

async function durableProposalFixture() {
  const fixture = await makeDurableFixture();
  const homeDir = await fixtureAccountHome(fixture);
  const rootDir = join(fixture, "project/.ai");
  const file = await seedIndexedSkill({ homeDir, rootDir, scope: "project" });
  const args = {
    ...writebackArgs(rootDir),
    homeDir,
    asset: "skill:guarded",
    suggestedDestination: undefined,
  };
  const writeback = await addWriteback(args);
  const [proposal] = await proposeEvolution(args);
  return {
    fixture,
    homeDir,
    rootDir,
    file,
    args,
    writeback,
    proposal: proposal!,
  };
}

describe("AI filesystem mutation boundaries", () => {
  it.skipIf(process.platform === "win32")(
    "resolves symlinks before parent components for existing and missing targets",
    async () => {
      const fixture = await makeDurableFixture();
      const homeDir = await fixtureAccountHome(fixture);
      const rootDir = join(fixture, "project/.ai");
      await mkdir(rootDir, { recursive: true });
      const child = join(tempHome, "job/child");
      await mkdir(child, { recursive: true });
      const link = join(fixture, "link");
      await symlink(child, link, "dir");
      const victim = join(tempHome, "job/victim.md");
      for (const existing of [false, true]) {
        if (existing) {
          await Bun.write(victim, "Original evidence\n");
        }
        // join()/resolve() would erase the filesystem semantics under test.
        const raw = `${link}/../victim.md`;
        expect(resolvePhysicalPath(raw)).toBe(resolvePhysicalPath(victim));
        expect(aiPathSafetyIssue({ homeDir, paths: [raw] })).toContain(
          "OS temporary directory"
        );
        await expect(
          addWriteback({
            ...writebackArgs(rootDir),
            homeDir,
            suggestedDestination: raw,
          })
        ).rejects.toThrow("OS temporary directory");
      }
      const args = { ...writebackArgs(rootDir), homeDir };
      const healthy = await addWriteback(args);
      await seedJson(facultAiWritebackQueuePath(homeDir, rootDir), {
        ...healthy,
        suggestedDestination: `${link}/../victim.md`,
      });
      expect((await assessEvolution(args)).sourceWritebacks).toEqual([]);
      await expect(proposeEvolution(args)).rejects.toThrow(
        "OS temporary directory"
      );
      expect(await Bun.file(victim).text()).toBe("Original evidence\n");
    }
  );

  it.each([
    "target",
    "ancestor",
  ])("refuses an apply-time %s symlink swap without modifying either file", async (layout) => {
    const { file, args, proposal } = await durableProposalFixture();
    await draftProposal(proposal.id, args);
    await acceptProposal(proposal.id, args);
    const original = await Bun.file(file).text();
    const temporaryDirectory = join(tempHome, "swapped");
    await mkdir(temporaryDirectory);
    const victim = join(temporaryDirectory, "SKILL.md");
    await Bun.write(victim, "Temporary target must survive\n");
    const swapped = layout === "target" ? file : dirname(file);
    const moved = `${swapped}.before`;
    await expect(
      applyProposal(proposal.id, {
        ...args,
        onBeforeTargetWrite: async () => {
          await rename(swapped, moved);
          await symlink(
            layout === "target" ? victim : temporaryDirectory,
            swapped,
            layout === "target" ? "file" : "dir"
          );
        },
      })
    ).rejects.toThrow("OS temporary directory");
    expect(await Bun.file(victim).text()).toBe(
      "Temporary target must survive\n"
    );
    expect(
      await Bun.file(
        layout === "target" ? moved : join(moved, "SKILL.md")
      ).text()
    ).toBe(original);
    expect((await listProposals(args))[0]!.status).toBe("accepted");
  });

  it.each([
    "queue",
    "journal",
    "writeback review",
    "proposal",
    "proposal review",
    "draft",
    "patch",
    "runtime directory",
    "review directory",
  ])("checks the complete %s output path before mutating state", async (layout) => {
    const { homeDir, rootDir, args, proposal } = await durableProposalFixture();
    const queue = facultAiWritebackQueuePath(homeDir, rootDir);
    const journal = facultAiJournalPath(homeDir, rootDir);
    const proposalPath = join(
      facultAiProposalDir(homeDir, rootDir),
      `${proposal.id}.json`
    );
    const draft = join(facultAiDraftDir(homeDir, rootDir), `${proposal.id}.md`);
    const writebackReview = join(
      facultAiWritebackReviewDir(homeDir, rootDir),
      "WB-00002.md"
    );
    const proposalReview = join(
      facultAiEvolutionReviewDir(homeDir, rootDir),
      `${proposal.id}.md`
    );
    const paths: Record<string, string> = {
      queue,
      journal,
      "writeback review": writebackReview,
      proposal: proposalPath,
      "proposal review": proposalReview,
      draft,
      patch: `${draft.slice(0, -3)}.patch`,
      "runtime directory": dirname(queue),
      "review directory": facultAiWritebackReviewDir(homeDir, rootDir),
    };
    const path = paths[layout]!;
    const directory = layout.endsWith("directory");
    const temporary = join(tempHome, "redirected");
    await mkdir(dirname(path), { recursive: true });
    if (directory) {
      await cp(path, temporary, { recursive: true });
      await rm(path, { recursive: true });
    } else {
      await Bun.write(
        temporary,
        existsSync(path)
          ? await Bun.file(path).text()
          : layout === "draft"
            ? `<!-- facult:evolution:${proposal.id}:start -->\nGuard fixture\n<!-- facult:evolution:${proposal.id}:end -->\n`
            : ""
      );
      await rm(path, { force: true });
    }
    await symlink(temporary, path, directory ? "dir" : "file");
    const beforeQueue = await Bun.file(queue).text();
    const beforeJournal = await Bun.file(journal).text();
    const beforeProposal = await Bun.file(proposalPath).text();
    const capture = [
      "queue",
      "journal",
      "writeback review",
      "runtime directory",
      "review directory",
    ].includes(layout);
    const operation = (allowEphemeral = false) =>
      capture
        ? addWriteback({ ...args, allowEphemeral })
        : draftProposal(proposal.id, { ...args, allowEphemeral });
    await expect(operation()).rejects.toThrow("OS temporary directory");
    expect(await Bun.file(queue).text()).toBe(beforeQueue);
    expect(await Bun.file(journal).text()).toBe(beforeJournal);
    expect(await Bun.file(proposalPath).text()).toBe(beforeProposal);
    await expect(operation(true)).rejects.toThrow(ROOT_ERROR_RE);
    expect(await Bun.file(queue).text()).toBe(beforeQueue);
    expect(await Bun.file(journal).text()).toBe(beforeJournal);
    expect(await Bun.file(proposalPath).text()).toBe(beforeProposal);
  });

  it("revalidates original-scope writebacks during draft and apply of a promoted proposal", async () => {
    const { fixture, homeDir, rootDir, file, args, writeback, proposal } =
      await durableProposalFixture();
    const globalRoot = join(fixture, "global/.ai");
    process.env.FACULT_ROOT_DIR = globalRoot;
    process.env.FACULT_ROOT_SCOPE = "global";
    const globalFile = await seedIndexedSkill({
      homeDir,
      rootDir: globalRoot,
      scope: "global",
    });
    const globalArgs = { ...args, rootDir: globalRoot };
    const unrelated = await addWriteback(globalArgs);
    expect(unrelated.id).toBe(writeback.id);
    const promoted = await promoteProposal(proposal.id, {
      homeDir,
      rootDir,
      to: "global",
    });
    const queue = facultAiWritebackQueuePath(homeDir, rootDir);
    await seedJson(queue, {
      ...writeback,
      suggestedDestination: join(tempHome, "source.md"),
    });
    await expect(draftProposal(promoted.id, globalArgs)).rejects.toThrow(
      "OS temporary directory"
    );
    expect(
      existsSync(
        join(facultAiDraftDir(homeDir, globalRoot), `${promoted.id}.md`)
      )
    ).toBe(false);
    await seedJson(queue, writeback);
    // The unrelated global namesake must not prevent a healthy project source.
    await seedJson(facultAiWritebackQueuePath(homeDir, globalRoot), {
      ...unrelated,
      suggestedDestination: join(tempHome, "unrelated.md"),
    });
    await draftProposal(promoted.id, globalArgs);
    await acceptProposal(promoted.id, globalArgs);
    const original = await Bun.file(globalFile).text();
    await seedJson(queue, {
      ...writeback,
      evidence: [{ type: "file", ref: join(tempHome, "source.md") }],
    });
    await expect(draftProposal(promoted.id, globalArgs)).rejects.toThrow(
      "OS temporary directory"
    );
    await expect(applyProposal(promoted.id, globalArgs)).rejects.toThrow(
      "OS temporary directory"
    );
    expect(await Bun.file(globalFile).text()).toBe(original);
    await seedJson(queue, writeback);
    expect((await applyProposal(promoted.id, globalArgs)).status).toBe(
      "applied"
    );
    expect((await listWritebacks(args))[0]!.status).toBe("promoted");
    expect((await listWritebacks(globalArgs))[0]!.status).toBe("recorded");
    expect(await Bun.file(file).text()).not.toContain(
      `facult:evolution:${promoted.id}:start`
    );
  });

  it.each([
    "file scheme",
    "file URL",
    "absolute ref",
    "typed path",
    "symlink",
    "parent traversal",
  ])("guards %s evidence at capture, assessment and proposal creation", async (layout) => {
    const { fixture, homeDir, rootDir, args, writeback, proposal } =
      await durableProposalFixture();
    const evidencePath = join(tempHome, "evidence.md");
    await Bun.write(evidencePath, "Temporary evidence\n");
    let evidence = { type: "file", ref: evidencePath };
    if (layout === "file scheme") {
      evidence = { type: "ref", ref: `file:${evidencePath}` };
    } else if (layout === "file URL") {
      evidence.ref = pathToFileURL(evidencePath).href;
    } else if (layout === "absolute ref") {
      evidence.type = "ref";
    } else if (layout === "typed path") {
      evidence.type = "path";
    } else if (layout === "symlink") {
      evidence.ref = join(fixture, "evidence-link.md");
      await symlink(evidencePath, evidence.ref);
    } else {
      const child = join(tempHome, "child");
      await mkdir(child);
      const link = join(fixture, "evidence-link");
      await symlink(child, link, "dir");
      evidence.ref = `${link}/../evidence.md`;
    }
    await expect(
      addWriteback({ ...args, evidence: [evidence] })
    ).rejects.toThrow("OS temporary directory");
    await expect(
      linkWritebackEvidence(writeback.id, evidence, args)
    ).rejects.toThrow("OS temporary directory");
    const legacy = { ...writeback, evidence: [evidence] };
    await seedJson(facultAiWritebackQueuePath(homeDir, rootDir), legacy);
    const assessment = await assessEvolution(args);
    expect(assessment.sourceWritebacks).toEqual([]);
    expect(assessment.activeProposalIds).toEqual([]);
    expect(assessment.recommendation).not.toBe("review_existing_proposal");
    await expect(proposeEvolution(args)).rejects.toThrow(
      "OS temporary directory"
    );
    const overridden = await addWriteback({
      ...args,
      evidence: [evidence],
      allowEphemeral: true,
    });
    expect(overridden.evidence[0]!.type).toBe(evidence.type);
    expect(
      (await assessEvolution({ ...args, allowEphemeral: true }))
        .activeProposalIds
    ).toContain(proposal.id);
    const healthyPath = join(fixture, "evidence.md");
    await Bun.write(healthyPath, "Durable evidence\n");
    await seedJson(facultAiWritebackQueuePath(homeDir, rootDir), {
      ...writeback,
      evidence: [
        { type: "file", ref: healthyPath },
        { type: "session", ref: "test-session" },
      ],
    });
    expect((await assessEvolution(args)).activeProposalIds).toContain(
      proposal.id
    );
    const healthy = await addWriteback({
      ...args,
      evidence: [
        { type: "file", ref: healthyPath },
        { type: "session", ref: "test-session" },
      ],
    });
    expect(healthy.evidence).toEqual([
      { type: "file", ref: healthyPath },
      { type: "session", ref: "test-session" },
    ]);
  });
});

describe("AI generated-state repair guard", () => {
  for (const operation of ["capture", "propose"] as const) {
    it.each([
      "index",
      "graph",
      "directory",
    ])(`checks the generated %s destination before ${operation} repairs the graph`, async (layout) => {
      const fixture = await makeDurableFixture();
      const homeDir = await fixtureAccountHome(fixture);
      const rootDir = join(homeDir, ".ai");
      process.env.FACULT_ROOT_DIR = rootDir;
      process.env.FACULT_ROOT_SCOPE = "global";
      await seedIndexedSkill({ homeDir, rootDir, scope: "global" });
      const args = {
        ...writebackArgs(rootDir),
        homeDir,
        asset: "skill:guarded",
        suggestedDestination: undefined,
      };
      if (operation === "propose") {
        await addWriteback(args);
      }
      const indexPath = facultAiIndexPath(homeDir, rootDir);
      const graphPath = facultAiGraphPath(homeDir, rootDir);
      const temporary = join(tempHome, "generated-output");
      if (layout === "directory") {
        await rm(dirname(graphPath), { recursive: true });
        await mkdir(temporary);
        await symlink(temporary, dirname(graphPath), "dir");
      } else {
        await rm(graphPath);
        await Bun.write(temporary, "{}\n");
        // A present graph must be stale to exercise the rebuild branch.
        await utimes(temporary, 0, 0);
        await symlink(temporary, layout === "index" ? indexPath : graphPath);
      }
      const queue = facultAiWritebackQueuePath(homeDir, rootDir);
      const journal = facultAiJournalPath(homeDir, rootDir);
      const snapshot = async () =>
        await Promise.all(
          [indexPath, graphPath, queue, journal].map(async (path) =>
            existsSync(path) ? await Bun.file(path).text() : null
          )
        );
      const before = await snapshot();
      const mutate = (allowEphemeral = false) =>
        operation === "capture"
          ? addWriteback({ ...args, allowEphemeral })
          : proposeEvolution({ ...args, allowEphemeral });
      await expect(mutate()).rejects.toThrow("OS temporary directory");
      expect(await snapshot()).toEqual(before);
      expect(existsSync(facultAiProposalDir(homeDir, rootDir))).toBe(false);
      await expect(mutate(true)).rejects.toThrow(ROOT_ERROR_RE);
      expect(await snapshot()).toEqual(before);
    });
  }

  it("repairs durable generated outputs during capture and proposal creation", async () => {
    const fixture = await makeDurableFixture();
    const homeDir = await fixtureAccountHome(fixture);
    const rootDir = join(homeDir, ".ai");
    process.env.FACULT_ROOT_DIR = rootDir;
    process.env.FACULT_ROOT_SCOPE = "global";
    await seedIndexedSkill({ homeDir, rootDir, scope: "global" });
    await rm(facultAiGraphPath(homeDir, rootDir));
    const args = {
      ...writebackArgs(rootDir),
      homeDir,
      asset: "skill:guarded",
      suggestedDestination: undefined,
    };
    await addWriteback(args);
    expect(existsSync(facultAiIndexPath(homeDir, rootDir))).toBe(true);
    await rm(facultAiGraphPath(homeDir, rootDir));
    const [proposal] = await proposeEvolution(args);
    expect((await assessEvolution(args)).activeProposalIds).toEqual([
      proposal!.id,
    ]);
    expect(existsSync(facultAiGraphPath(homeDir, rootDir))).toBe(true);
  });
});

describe("security review r4 regressions", () => {
  it.each([
    "@ai/",
    "@project/",
  ])("rejects an absolute suffix after %s", async (prefix) => {
    const { fixture, file, args, proposal } = await durableProposalFixture();
    const outside = join(fixture, "outside.md");
    await Bun.write(outside, "# Outside file\n");
    const ref = `${prefix}${outside}`;
    await expect(
      addWriteback({ ...args, asset: undefined, suggestedDestination: ref })
    ).rejects.toThrow(CANONICAL_ERROR_RE);
    await draftProposal(proposal.id, args);
    const accepted = await acceptProposal(proposal.id, args);
    await seedJson(
      join(
        facultAiProposalDir(args.homeDir, args.rootDir),
        `${proposal.id}.json`
      ),
      {
        ...accepted,
        targets: [ref],
      }
    );
    await expect(
      draftProposal(proposal.id, { ...args, append: "Review update" })
    ).rejects.toThrow(CANONICAL_ERROR_RE);
    await expect(applyProposal(proposal.id, args)).rejects.toThrow(
      CANONICAL_ERROR_RE
    );
    await expect(
      applyProposal(proposal.id, { ...args, allowEphemeral: true })
    ).rejects.toThrow(CANONICAL_ERROR_RE);
    expect(
      (await assessEvolution({ ...args, asset: undefined })).activeProposalIds
    ).toEqual([]);
    expect(await Bun.file(outside).text()).toBe("# Outside file\n");
    expect(await Bun.file(file).text()).not.toContain(
      `facult:evolution:${proposal.id}:start`
    );
  });

  it.each([
    "project",
    "legacy",
    "promoted",
    "promoted-current-scope",
  ])("rejects forged %s proposal provenance before applying", async (layout) => {
    const { fixture, args, proposal, homeDir, rootDir, file, writeback } =
      await durableProposalFixture();
    const otherRoot = join(fixture, "other/.ai");
    await seedIndexedSkill({ homeDir, rootDir: otherRoot, scope: "project" });
    const otherQueue = facultAiWritebackQueuePath(homeDir, otherRoot);
    await seedJson(otherQueue, {
      ...writeback,
      sourceRoot: otherRoot,
      summary: "Unrelated project evidence",
    });
    let selected = proposal;
    let selectedArgs = args;
    let targetFile = file;
    if (layout.startsWith("promoted")) {
      const globalRoot = join(fixture, "global/.ai");
      process.env.FACULT_ROOT_DIR = globalRoot;
      process.env.FACULT_ROOT_SCOPE = "global";
      targetFile = await seedIndexedSkill({
        homeDir,
        rootDir: globalRoot,
        scope: "global",
      });
      selected = await promoteProposal(proposal.id, {
        homeDir,
        rootDir,
        to: "global",
      });
      selectedArgs = { ...args, rootDir: globalRoot };
    }
    await draftProposal(selected.id, selectedArgs);
    const accepted = await acceptProposal(selected.id, selectedArgs);
    const originalTarget = await Bun.file(targetFile).text();
    const originalOtherQueue = await Bun.file(otherQueue).text();
    const storedPath = join(
      facultAiProposalDir(homeDir, selectedArgs.rootDir),
      `${selected.id}.json`
    );
    const legacyPath = join(
      rootDir,
      ".facult/ai/project/evolution/proposals",
      `${selected.id}.json`
    );
    await seedJson(layout === "legacy" ? legacyPath : storedPath, {
      ...accepted,
      sourceRoot:
        layout === "promoted-current-scope" ? selectedArgs.rootDir : otherRoot,
    });
    if (layout === "legacy") {
      await rm(storedPath);
    }
    await expect(applyProposal(selected.id, selectedArgs)).rejects.toThrow(
      PROVENANCE_ERROR_RE
    );
    await expect(
      applyProposal(selected.id, { ...selectedArgs, allowEphemeral: true })
    ).rejects.toThrow(PROVENANCE_ERROR_RE);
    await expect(
      draftProposal(selected.id, { ...selectedArgs, append: "Forged revision" })
    ).rejects.toThrow(PROVENANCE_ERROR_RE);
    expect((await assessEvolution(selectedArgs)).activeProposalIds).toEqual([]);
    expect(await Bun.file(targetFile).text()).toBe(originalTarget);
    expect(await Bun.file(otherQueue).text()).toBe(originalOtherQueue);
  });

  it("rejects mixed-scope writeback links after promotion despite ID collisions", async () => {
    const { fixture, args, proposal, homeDir, rootDir } =
      await durableProposalFixture();
    const otherProjectWriteback = await addWriteback({
      ...args,
      summary: "Unrelated project WB-00002",
    });
    const globalRoot = join(fixture, "global/.ai");
    process.env.FACULT_ROOT_DIR = globalRoot;
    process.env.FACULT_ROOT_SCOPE = "global";
    await seedIndexedSkill({ homeDir, rootDir: globalRoot, scope: "global" });
    const globalArgs = { ...args, rootDir: globalRoot };
    await addWriteback(globalArgs);
    const globalWriteback = await addWriteback({
      ...globalArgs,
      summary: "Global evidence WB-00002",
    });
    expect(globalWriteback.id).toBe(otherProjectWriteback.id);
    const promoted = await promoteProposal(proposal.id, {
      homeDir,
      rootDir,
      to: "global",
    });
    const proposalPath = join(
      facultAiProposalDir(homeDir, globalRoot),
      `${promoted.id}.json`
    );
    const original = await Bun.file(proposalPath).text();
    await expect(
      linkProposalWriteback(promoted.id, globalWriteback.id, globalArgs)
    ).rejects.toThrow(SCOPE_ERROR_RE);
    expect(await Bun.file(proposalPath).text()).toBe(original);
    const linked = await linkProposalWriteback(
      proposal.id,
      otherProjectWriteback.id,
      args
    );
    expect(linked.sourceWritebacks).toContain(otherProjectWriteback.id);
    const promotedLinked = await promoteProposal(proposal.id, {
      homeDir,
      rootDir,
      to: "global",
    });
    await draftProposal(promotedLinked.id, globalArgs);
    await acceptProposal(promotedLinked.id, globalArgs);
    await applyProposal(promotedLinked.id, globalArgs);
    expect(
      (await listWritebacks(args)).every((entry) => entry.status === "promoted")
    ).toBe(true);
    expect(
      (await listWritebacks(globalArgs)).every(
        (entry) => entry.status === "recorded"
      )
    ).toBe(true);
  });

  it.each([
    "existing",
    "missing",
    "in-place",
    "parent",
  ])("binds the staged inode and parent for %s output", async (layout) => {
    const fixture = await makeDurableFixture();
    const homeDir = await fixtureAccountHome(fixture);
    const parent = join(fixture, "output");
    await mkdir(parent);
    const target = join(parent, "record.md");
    if (layout !== "missing") {
      await Bun.write(target, "Original destination\n");
    }
    const movedParent = `${parent}.before`;
    await expect(
      writeAiText(
        target,
        "Trusted generated bytes\n",
        homeDir,
        async () => {
          const name = (await readdir(parent)).find((entry) =>
            entry.endsWith(".tmp")
          );
          expect(name).toBeDefined();
          const staged = join(parent, name!);
          if (layout === "parent") {
            await rename(parent, movedParent);
            await mkdir(parent);
          } else if (layout !== "in-place") {
            await rename(staged, `${staged}.original`);
          }
          await Bun.write(staged, "Attacker replacement\n");
        },
        parent
      )
    ).rejects.toThrow(STAGING_ERROR_RE);
    if (layout === "missing" || layout === "parent") {
      expect(existsSync(target)).toBe(false);
    } else {
      expect(await Bun.file(target).text()).toBe("Original destination\n");
    }
    if (layout === "parent") {
      expect(await Bun.file(join(movedParent, "record.md")).text()).toBe(
        "Original destination\n"
      );
    }
  });
});

describe("security review r5 descriptor boundaries", () => {
  it("keeps the capability-root snapshot bound across the draft read", async () => {
    const { fixture, file, args, proposal } = await durableProposalFixture();
    const drafted = await draftProposal(proposal.id, args);
    await acceptProposal(proposal.id, args);
    const outside = join(fixture, "outside.md");
    await Bun.write(outside, "# Outside must stay unchanged\n");
    const fs = await import("node:fs/promises");
    const filesystem = await import("./ai-filesystem");
    const originalRead = fs.readFile;
    const boundRead = filesystem.readAiText;
    let swapped = false;
    const swap = async (path: unknown) => {
      if (String(path) === drafted.draftRefs[0] && !swapped) {
        swapped = true;
        await rename(file, `${file}.original`);
        await symlink(outside, file);
      }
    };
    const legacyRead = spyOn(fs, "readFile").mockImplementation((async (
      ...params: Parameters<typeof fs.readFile>
    ) => {
      const result = await originalRead(...params);
      await swap(params[0]);
      return result;
    }) as typeof fs.readFile);
    const guardedRead =
      typeof boundRead === "function"
        ? spyOn(filesystem, "readAiText").mockImplementation(
            async (...params) => {
              const result = await boundRead(...params);
              await swap(params[0]);
              return result;
            }
          )
        : undefined;
    try {
      await expect(applyProposal(proposal.id, args)).rejects.toThrow(
        STAGING_ERROR_RE
      );
      expect(swapped).toBe(true);
      expect(await Bun.file(outside).text()).toBe(
        "# Outside must stay unchanged\n"
      );
    } finally {
      legacyRead.mockRestore();
      guardedRead?.mockRestore();
    }
  });

  it("refuses a legacy source queue redirected to another project's runtime store", async () => {
    const { fixture, args, proposal, writeback } =
      await durableProposalFixture();
    const otherRoot = join(fixture, "other/.ai");
    await mkdir(otherRoot, { recursive: true });
    const otherQueue = facultAiWritebackQueuePath(args.homeDir, otherRoot);
    await seedJson(otherQueue, {
      ...writeback,
      sourceRoot: otherRoot,
      projectRoot: dirname(otherRoot),
      summary: "PRIVATE OTHER PROJECT SUMMARY",
    });
    const legacy = join(args.rootDir, ".facult/ai/project");
    await mkdir(join(legacy, "writeback"), { recursive: true });
    await symlink(otherQueue, join(legacy, "writeback/queue.jsonl"));
    await seedJson(
      join(legacy, "evolution/proposals", `${proposal.id}.json`),
      proposal
    );
    const runtimeProposal = join(
      facultAiProposalDir(args.homeDir, args.rootDir),
      `${proposal.id}.json`
    );
    await rename(runtimeProposal, `${runtimeProposal}.original`);
    await expect(draftProposal(proposal.id, args)).rejects.toThrow(
      SCOPE_ERROR_RE
    );
    expect(
      existsSync(
        join(facultAiDraftDir(args.homeDir, args.rootDir), `${proposal.id}.md`)
      )
    ).toBe(false);
    expect(await Bun.file(otherQueue).text()).toContain(
      "PRIVATE OTHER PROJECT SUMMARY"
    );
  });

  it("does not return another scope's record from an otherwise local queue", async () => {
    const { fixture, args, writeback } = await durableProposalFixture();
    const otherRoot = join(fixture, "other/.ai");
    await seedJson(facultAiWritebackQueuePath(args.homeDir, args.rootDir), {
      ...writeback,
      sourceRoot: otherRoot,
      projectRoot: dirname(otherRoot),
    });
    const { showWriteback } = await import("./ai");
    expect(await showWriteback(writeback.id, args)).toBeNull();
  });

  it.each([
    "parent",
    "leaf",
  ])("binds the append descriptor when its %s is replaced after open", async (layout) => {
    const fixture = await makeDurableFixture();
    const homeDir = await fixtureAccountHome(fixture);
    const parent = join(fixture, "queue");
    const queue = join(parent, "queue.jsonl");
    await mkdir(parent);
    await Bun.write(queue, '{"old":true}\n');
    const temporary = join(fixture, "temporary");
    await mkdir(temporary);
    process.env.TMPDIR = temporary;
    const moved = join(temporary, "moved");
    const fs = await import("node:fs/promises");
    const originalOpen = fs.open;
    let swapped = false;
    const swap = async () => {
      if (swapped) {
        return;
      }
      swapped = true;
      if (layout === "parent") {
        await rename(parent, moved);
        await mkdir(parent);
      } else {
        await rename(queue, moved);
        await Bun.write(queue, '{"replacement":true}\n');
      }
    };
    const opened = spyOn(fs, "open").mockImplementation(async (...params) => {
      const handle = await originalOpen(...params);
      if (String(params[0]) === queue) {
        await swap();
      }
      return handle;
    });
    const { appendAiJsonLine } = await import("./ai-filesystem");
    try {
      await expect(
        appendAiJsonLine(queue, { new: true }, homeDir, swap, parent)
      ).rejects.toThrow(STAGING_ERROR_RE);
      expect(swapped).toBe(true);
      expect(
        await Bun.file(
          layout === "parent" ? join(moved, "queue.jsonl") : moved
        ).text()
      ).toBe('{"old":true}\n');
    } finally {
      opened.mockRestore();
    }
  });
});

describe("security review r6 operation authority", () => {
  it("rejects unmatched reads and writes even for durable paths", async () => {
    const { fixture, args } = await durableProposalFixture();
    const outside = join(fixture, "private.md");
    await Bun.write(outside, "Private bytes must remain private\n");
    await withAiMutationScope(args, async () => {
      await expect(readAiText(outside)).rejects.toThrow(
        "authorized operation root"
      );
      await expect(
        writeAiText(outside, "Replacement", args.homeDir)
      ).rejects.toThrow("authorized operation root");
    });
    expect(await Bun.file(outside).text()).toBe(
      "Private bytes must remain private\n"
    );
  });

  it("excludes traversal-bearing stored writeback IDs before refreshing review output", async () => {
    const { fixture, args, writeback } = await durableProposalFixture();
    const outside = join(fixture, "unrelated.md");
    await Bun.write(outside, "Unrelated original\n");
    const id = relative(
      facultAiWritebackReviewDir(args.homeDir, args.rootDir),
      outside
    ).slice(0, -3);
    await seedJson(facultAiWritebackQueuePath(args.homeDir, args.rootDir), {
      ...writeback,
      id,
    });
    const refreshed = await refreshAiReviewArtifacts(args);
    expect(refreshed.writebackCount).toBe(0);
    expect(await Bun.file(outside).text()).toBe("Unrelated original\n");
    await expect(showWriteback(id, args)).rejects.toThrow("record identity");
  });

  it("does not apply a private external draftRef even with a temporary-path override", async () => {
    const { fixture, args, proposal, file } = await durableProposalFixture();
    await draftProposal(proposal.id, args);
    const accepted = await acceptProposal(proposal.id, args);
    const before = await Bun.file(file).text();
    const privatePath = join(fixture, "private.md");
    await Bun.write(
      privatePath,
      "Private source never authorized as a draft\n"
    );
    await seedJson(
      join(
        facultAiProposalDir(args.homeDir, args.rootDir),
        `${proposal.id}.json`
      ),
      { ...accepted, kind: "create_instruction", draftRefs: [privatePath] }
    );
    for (const allowEphemeral of [false, true]) {
      await expect(
        applyProposal(proposal.id, { ...args, allowEphemeral })
      ).rejects.toThrow("authorized proposal draft");
      expect(await Bun.file(file).text()).toBe(before);
      expect(
        (await assessEvolution({ ...args, allowEphemeral })).activeProposalIds
      ).toEqual([]);
    }
  });

  it("preserves explicit source containment when temporary paths are allowed", async () => {
    const { args } = await durableProposalFixture();
    const foreign = join(tempHome, "other-scope/queue.jsonl");
    await seedJson(foreign, {
      id: "WB-00088",
      scope: "project",
      summary: "Private foreign legacy record",
      evidence: [],
      tags: [],
      status: "recorded",
    });
    const queue = join(
      args.rootDir,
      ".facult/ai/project/writeback/queue.jsonl"
    );
    await mkdir(dirname(queue), { recursive: true });
    await symlink(foreign, queue);
    process.env.FCLT_ALLOW_EPHEMERAL_AI_PATHS = "1";
    await expect(
      withAiMutationScope({ ...args, allowEphemeral: true }, () =>
        showWriteback("WB-00088", args)
      )
    ).rejects.toThrow(SCOPE_ERROR_RE);
  });

  it("fails closed for Windows replacement before any pathname rename can overwrite outside", async () => {
    const { fixture, homeDir } = await durableProposalFixture();
    const root = join(fixture, "replacement");
    await mkdir(root);
    const target = join(root, "target.md");
    const outside = join(fixture, "outside.md");
    await Bun.write(target, "Original target\n");
    await Bun.write(outside, "Outside must survive\n");
    const snapshot = await readAiTarget(target, homeDir, root);
    const fs = await import("node:fs");
    const originalRename = fs.renameSync;
    const renameSpy = spyOn(fs, "renameSync").mockImplementation(
      (source, destination) => {
        // A successful pathname replacement here would redirect the victim.
        return originalRename(
          source,
          String(destination) === target ? outside : destination
        );
      }
    );
    try {
      await expect(
        replaceAiTarget({
          path: target,
          contents: "Replacement\n",
          snapshot,
          platform: "win32",
          homeDir,
        })
      ).rejects.toThrow("unavailable on win32");
      expect(renameSpy).not.toHaveBeenCalled();
      expect(await Bun.file(outside).text()).toBe("Outside must survive\n");
      expect(await Bun.file(target).text()).toBe("Original target\n");
    } finally {
      renameSpy.mockRestore();
    }
  });

  it("does not import private content through instruction swaps during graph repair", async () => {
    const { fixture, args } = await durableProposalFixture();
    const outside = join(fixture, "private-instruction.md");
    await Bun.write(
      outside,
      "# Private\n\nPRIVATE_OUTSIDE_DESCRIPTION_SHOULD_NOT_BE_INDEXED\n"
    );
    await mkdir(join(args.rootDir, "instructions"), { recursive: true });
    const instruction = join(args.rootDir, "instructions/UNTRUSTED.md");
    await Bun.write(instruction, "# Public\n\nHealthy public description.\n");
    const fs = await import("node:fs");
    const filesystem = await import("./ai-filesystem");
    const originalFile = Bun.file;
    const originalRead = filesystem.readAiText;
    let swapped = false;
    const swap = (path: unknown) => {
      if (String(path) === instruction && !swapped) {
        swapped = true;
        fs.renameSync(instruction, `${instruction}.original`);
        fs.symlinkSync(outside, instruction);
      }
    };
    const rawRead = spyOn(Bun, "file").mockImplementation(((
      ...params: Parameters<typeof Bun.file>
    ) => {
      swap(params[0]);
      return originalFile(...params);
    }) as typeof Bun.file);
    const guardedRead = spyOn(filesystem, "readAiText").mockImplementation(
      (...params) => {
        swap(params[0]);
        return originalRead(...params);
      }
    );
    try {
      const { buildIndexSnapshot } = await import("./index-builder");
      const result = await buildIndexSnapshot({ ...args, force: true }).catch(
        (error: unknown) => {
          expect(
            error instanceof Error ? error.message : String(error)
          ).toMatch(ROOT_ERROR_RE);
          return null;
        }
      );
      expect(swapped).toBe(true);
      expect(JSON.stringify(result)).not.toContain(
        "PRIVATE_OUTSIDE_DESCRIPTION_SHOULD_NOT_BE_INDEXED"
      );
    } finally {
      rawRead.mockRestore();
      guardedRead.mockRestore();
    }
  });
});
