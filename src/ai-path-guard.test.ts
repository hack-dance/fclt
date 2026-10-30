import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  addWriteback,
  assessEvolution,
  listProposals,
  listWritebacks,
  proposeEvolution,
} from "./ai";
import { aiPathSafetyIssue, realUserHome } from "./ai-path-guard";
import { facultAiProposalDir, facultAiWritebackQueuePath } from "./paths";

const realHome = realUserHome();
const savedEnv = { ...process.env };
let tempHome: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "fclt-ai-path-guard-"));
  process.env.HOME = tempHome;
  process.env.FACULT_LOCAL_STATE_DIR = join(tempHome, "state");
  Reflect.deleteProperty(process.env, "FCLT_ALLOW_EPHEMERAL_AI_PATHS");
});

afterEach(async () => {
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
});

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
  ])("refuses proposal creation rooted at %s before writing state", async (rootDir) => {
    await expect(
      proposeEvolution({ homeDir: realHome, rootDir })
    ).rejects.toThrow("OS temporary directory");
    expect(existsSync(facultAiProposalDir(realHome, rootDir))).toBe(false);
  });

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
    const args = {
      ...writebackArgs(join(realHome, "fclt-guard-source")),
      homeDir: realHome,
      suggestedDestination: "/tmp/fclt-target/VERIFY.md",
    };
    await expect(addWriteback(args)).rejects.toThrow("OS temporary directory");
    expect(existsSync(facultAiWritebackQueuePath(realHome, args.rootDir))).toBe(
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
    // Only runtime fixtures are written. The normal source root is a nonexistent path.
    const rootDir = join(
      realHome,
      `fclt-guard-source-${crypto.randomUUID()}`,
      ".ai"
    );
    process.env.FACULT_ROOT_DIR = rootDir;
    process.env.FACULT_ROOT_SCOPE = "project";
    const args = { homeDir: realHome, rootDir };
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
    const queuePath = facultAiWritebackQueuePath(realHome, rootDir);
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
        join(facultAiProposalDir(realHome, rootDir), `${row.id}.json`),
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
      join(facultAiProposalDir(realHome, rootDir), `${proposal.id}.json`)
    );
    const withoutNormalProposal = await assessEvolution(args);
    expect(withoutNormalProposal.activeProposalIds).toEqual([]);
    expect(withoutNormalProposal.recommendation).toBe("propose");
    await expect(proposeEvolution(args)).rejects.toThrow(
      "OS temporary directory"
    );
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
