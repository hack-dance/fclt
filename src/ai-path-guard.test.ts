import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  addWriteback,
  assessEvolution,
  listProposals,
  listWritebacks,
  promoteProposal,
  proposeEvolution,
} from "./ai";
import { aiPathSafetyIssue, realUserHome } from "./ai-path-guard";
import {
  facultAiJournalPath,
  facultAiProposalDir,
  facultAiWritebackQueuePath,
} from "./paths";

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
  restorePathGuard = () => mocked.mockRestore();
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

describe("AI state path guard", () => {
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

  it("CLI flag permits isolated writebacks and proposals while the default refuses", async () => {
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
    expect((await run(["evolve", "propose", "--allow-ephemeral"])).code).toBe(
      0
    );
    const assessment = await run(["evolve", "assess"]);
    expect(assessment.code).toBe(0);
    expect(JSON.parse(assessment.stdout).activeProposalIds).toEqual([]);
    const override = await run(["evolve", "assess", "--allow-ephemeral"]);
    expect(JSON.parse(override.stdout).recommendation).toBe(
      "review_existing_proposal"
    );
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
      scope: "global",
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
      scope: "global",
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
    expect(assessment.warnings).toHaveLength(9);
    expect(await listWritebacks(args)).toHaveLength(5);
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
