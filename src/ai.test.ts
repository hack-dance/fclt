import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  acceptProposal,
  addWriteback,
  applyProposal,
  dismissWriteback,
  draftProposal,
  groupWritebacks,
  listProposals,
  listWritebacks,
  promoteProposal,
  promoteWriteback,
  proposeEvolution,
  rejectProposal,
  showProposal,
  showWriteback,
  summarizeWritebacks,
  supersedeProposal,
} from "./ai";
import {
  facultAiDraftDir,
  facultAiJournalPath,
  facultAiProposalDir,
  facultAiWritebackQueuePath,
} from "./paths";

let tempHome: string | null = null;
const originalHome = process.env.HOME;
const proposalEvidence = (ref: string) => [{ type: "session", ref }];

async function makeTempHome(): Promise<string> {
  const dir = join(
    process.cwd(),
    ".tmp-tests",
    `ai-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeGraph(home: string, rootDir: string, graph: unknown) {
  const graphPath = join(
    rootDir.startsWith(join(home, ".ai"))
      ? join(home, ".ai", ".facult", "ai")
      : join(rootDir, ".facult", "ai"),
    "graph.json"
  );
  await mkdir(dirname(graphPath), { recursive: true });
  await Bun.write(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
}

afterEach(async () => {
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
  }
  tempHome = null;
  process.env.HOME = originalHome;
});

describe("ai writeback", () => {
  it("records a writeback with graph-backed asset resolution and journal entries", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await writeGraph(tempHome, rootDir, {
      version: 1,
      generatedAt: "2026-03-18T00:00:00.000Z",
      nodes: {
        "instruction:global:global:VERIFICATION": {
          id: "instruction:global:global:VERIFICATION",
          kind: "instruction",
          name: "VERIFICATION",
          sourceKind: "global",
          scope: "global",
          canonicalRef: "@ai/instructions/VERIFICATION.md",
          path: join(rootDir, "instructions", "VERIFICATION.md"),
        },
      },
      edges: [],
    });

    const record = await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "weak_verification",
      summary: "Guidance does not distinguish shallow from meaningful checks.",
      asset: "instruction:VERIFICATION",
      evidence: proposalEvidence("recorded-writeback"),
      tags: ["verification", "false-positive"],
    });

    expect(record.id).toBe("WB-00001");
    expect(record.assetRef).toBe("@ai/instructions/VERIFICATION.md");
    expect(record.assetId).toBe("instruction:global:global:VERIFICATION");
    expect(record.assetType).toBe("instruction");
    expect(record.status).toBe("recorded");

    const queue = await readFile(
      facultAiWritebackQueuePath(tempHome, rootDir),
      "utf8"
    );
    const journal = await readFile(
      facultAiJournalPath(tempHome, rootDir),
      "utf8"
    );
    expect(queue).toContain('"id":"WB-00001"');
    expect(journal).toContain('"kind":"writeback_recorded"');
  });

  it("resolves automation graph nodes for writeback targeting", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    await mkdir(join(rootDir, "automations", "learning-review"), {
      recursive: true,
    });
    await writeGraph(tempHome, rootDir, {
      version: 1,
      generatedAt: "2026-03-18T00:00:00.000Z",
      nodes: {
        "automation:global:global:learning-review": {
          id: "automation:global:global:learning-review",
          kind: "automation",
          name: "learning-review",
          sourceKind: "global",
          scope: "global",
          canonicalRef: "@ai/automations/learning-review/automation.toml",
          path: join(
            rootDir,
            "automations",
            "learning-review",
            "automation.toml"
          ),
        },
      },
      edges: [],
    });

    const record = await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "bad_default",
      summary: "Learning review attribution requires stronger source guidance.",
      asset: "automation:learning-review",
      evidence: proposalEvidence("automation-asset"),
    });

    expect(record.assetRef).toBe(
      "@ai/automations/learning-review/automation.toml"
    );
    expect(record.assetId).toBe("automation:global:global:learning-review");
    expect(record.assetType).toBe("automation");
  });

  it("stores project-scoped runtime state under the repo .ai/.fclt tree", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const projectRoot = join(tempHome, "work", "repo");
    const rootDir = join(projectRoot, ".ai");
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await writeGraph(tempHome, rootDir, {
      version: 1,
      generatedAt: "2026-03-18T00:00:00.000Z",
      nodes: {},
      edges: [],
    });

    const record = await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "capability_gap",
      summary: "Repo-local verification guidance is missing.",
      evidence: proposalEvidence("project-runtime-state"),
    });

    expect(record.scope).toBe("project");
    expect(facultAiWritebackQueuePath(tempHome, rootDir)).toBe(
      join(
        projectRoot,
        ".ai",
        ".facult",
        "ai",
        "project",
        "writeback",
        "queue.jsonl"
      )
    );
  });

  it("supports dismiss and promote as append-only status transitions", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    await mkdir(rootDir, { recursive: true });
    await writeGraph(tempHome, rootDir, {
      version: 1,
      generatedAt: "2026-03-18T00:00:00.000Z",
      nodes: {},
      edges: [],
    });

    const first = await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "bad_default",
      summary: "Default behavior is too optimistic.",
      evidence: proposalEvidence("append-only-status"),
    });
    await promoteWriteback(first.id, { homeDir: tempHome, rootDir });
    await dismissWriteback(first.id, { homeDir: tempHome, rootDir });

    const latest = await showWriteback(first.id, {
      homeDir: tempHome,
      rootDir,
    });
    expect(latest?.status).toBe("dismissed");

    const snapshots = (
      await readFile(facultAiWritebackQueuePath(tempHome, rootDir), "utf8")
    )
      .trim()
      .split("\n");
    expect(snapshots).toHaveLength(3);
  });

  it("requires evidence unless explicitly allowed", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    await mkdir(rootDir, { recursive: true });
    await writeGraph(tempHome, rootDir, {
      version: 1,
      generatedAt: "2026-03-18T00:00:00.000Z",
      nodes: {},
      edges: [],
    });

    await expect(
      addWriteback({
        homeDir: tempHome,
        rootDir,
        kind: "capability_gap",
        summary: "Missing evidence should fail.",
      })
    ).rejects.toThrow("writeback add requires at least one evidence item");

    const record = await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "capability_gap",
      summary: "Scratch note with explicit override.",
      allowEmptyEvidence: true,
    });
    expect(record.evidence).toEqual([]);
  });

  it("groups recorded writebacks into structured proposals", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await writeGraph(tempHome, rootDir, {
      version: 1,
      generatedAt: "2026-03-18T00:00:00.000Z",
      nodes: {
        "instruction:global:global:VERIFICATION": {
          id: "instruction:global:global:VERIFICATION",
          kind: "instruction",
          name: "VERIFICATION",
          sourceKind: "global",
          scope: "global",
          canonicalRef: "@ai/instructions/VERIFICATION.md",
          path: join(rootDir, "instructions", "VERIFICATION.md"),
        },
      },
      edges: [],
    });

    await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "weak_verification",
      summary: "Checks are too shallow.",
      asset: "instruction:VERIFICATION",
      evidence: proposalEvidence("group-1"),
    });
    await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "false_positive",
      summary: "Green checks did not prove correctness.",
      asset: "instruction:VERIFICATION",
      suggestedDestination: "@ai/instructions/VERIFICATION.md",
      evidence: proposalEvidence("group-2"),
    });

    const proposals = await proposeEvolution({
      homeDir: tempHome,
      rootDir,
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.id).toBe("EV-00001");
    expect(proposals[0]?.targets).toEqual(["@ai/instructions/VERIFICATION.md"]);
    expect(proposals[0]?.sourceWritebacks).toEqual(["WB-00001", "WB-00002"]);

    const listed = await listProposals({ homeDir: tempHome, rootDir });
    expect(listed.map((entry) => entry.id)).toEqual(["EV-00001"]);
    expect(facultAiProposalDir(tempHome, rootDir)).toBe(
      join(tempHome, ".ai", ".facult", "ai", "global", "evolution", "proposals")
    );

    const nextWritebacks = await listWritebacks({ homeDir: tempHome, rootDir });
    expect(nextWritebacks.every((entry) => entry.status === "promoted")).toBe(
      true
    );
  });

  it("groups and summarizes recurring writebacks by asset and kind", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    const verificationPath = join(rootDir, "instructions", "VERIFICATION.md");
    const testingPath = join(rootDir, "instructions", "TESTING.md");
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await Bun.write(verificationPath, "# Verification\n");
    await Bun.write(testingPath, "# Testing\n");
    await writeGraph(tempHome, rootDir, {
      version: 1,
      generatedAt: "2026-03-18T00:00:00.000Z",
      nodes: {
        "instruction:global:global:VERIFICATION": {
          id: "instruction:global:global:VERIFICATION",
          kind: "instruction",
          name: "VERIFICATION",
          sourceKind: "global",
          scope: "global",
          canonicalRef: "@ai/instructions/VERIFICATION.md",
          path: verificationPath,
        },
        "instruction:global:global:TESTING": {
          id: "instruction:global:global:TESTING",
          kind: "instruction",
          name: "TESTING",
          sourceKind: "global",
          scope: "global",
          canonicalRef: "@ai/instructions/TESTING.md",
          path: testingPath,
        },
      },
      edges: [],
    });

    await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "weak_verification",
      summary: "Checks were too shallow.",
      asset: "instruction:VERIFICATION",
      domain: "verification",
      evidence: proposalEvidence("group-summary-1"),
      tags: ["verification"],
    });
    await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "false_positive",
      summary: "Passing checks did not prove correctness.",
      asset: "instruction:VERIFICATION",
      domain: "verification",
      evidence: proposalEvidence("group-summary-2"),
      tags: ["false-positive"],
    });
    await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "weak_verification",
      summary: "Testing guidance also needs stronger proof.",
      asset: "instruction:TESTING",
      domain: "testing",
      evidence: proposalEvidence("group-summary-3"),
      tags: ["verification"],
    });

    const byAsset = await groupWritebacks({
      homeDir: tempHome,
      rootDir,
      by: "asset",
    });
    expect(byAsset).toHaveLength(2);
    expect(byAsset[0]?.key).toBe("@ai/instructions/TESTING.md");
    expect(byAsset[1]?.key).toBe("@ai/instructions/VERIFICATION.md");
    expect(byAsset[1]?.count).toBe(2);

    const byKind = await summarizeWritebacks({
      homeDir: tempHome,
      rootDir,
      by: "kind",
    });
    expect(byKind).toHaveLength(2);
    expect(byKind[0]?.summary).toContain("false_positive");
    expect(byKind[1]?.summary).toContain("weak_verification");
    expect(byKind[1]?.writebackIds).toEqual(["WB-00001", "WB-00003"]);

    const byDomain = await groupWritebacks({
      homeDir: tempHome,
      rootDir,
      by: "domain",
    });
    expect(byDomain).toHaveLength(2);
    expect(byDomain[0]?.key).toBe("testing");
    expect(byDomain[1]?.key).toBe("verification");
    expect(byDomain[1]?.count).toBe(2);
  });

  it("creates, revises, and applies a create_instruction proposal with draft history", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await writeGraph(tempHome, rootDir, {
      version: 1,
      generatedAt: "2026-03-18T00:00:00.000Z",
      nodes: {},
      edges: [],
    });

    await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "missing_context",
      summary: "A dedicated work-units instruction is missing.",
      suggestedDestination: "@ai/instructions/WORK_UNITS.md",
      domain: "work-units",
      evidence: proposalEvidence("create-instruction"),
    });

    const [proposal] = await proposeEvolution({ homeDir: tempHome, rootDir });
    expect(proposal?.kind).toBe("create_instruction");

    const drafted = await draftProposal(proposal!.id, {
      homeDir: tempHome,
      rootDir,
    });
    expect(drafted.draftHistory).toHaveLength(1);

    const revised = await draftProposal(proposal!.id, {
      homeDir: tempHome,
      rootDir,
      append:
        "Add an explicit rule that every work unit must define a verification plan.",
    });
    expect(revised.draftHistory).toHaveLength(2);
    expect(revised.draftHistory?.at(-1)?.action).toBe("revised");

    const draftText = await readFile(
      join(facultAiDraftDir(tempHome, rootDir), `${proposal!.id}.md`),
      "utf8"
    );
    expect(draftText).toContain(
      "Add an explicit rule that every work unit must define a verification plan."
    );

    await acceptProposal(proposal!.id, { homeDir: tempHome, rootDir });
    const applied = await applyProposal(proposal!.id, {
      homeDir: tempHome,
      rootDir,
    });
    const targetPath = join(rootDir, "instructions", "WORK_UNITS.md");
    expect(applied.applyResult?.changedFiles).toEqual([targetPath]);
    const targetText = await readFile(targetPath, "utf8");
    expect(targetText).toContain("# Work Units");
    expect(targetText).toContain(
      "every work unit must define a verification plan"
    );
  });

  it("creates and applies an add_skill proposal", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    await mkdir(rootDir, { recursive: true });
    await writeGraph(tempHome, rootDir, {
      version: 1,
      generatedAt: "2026-03-18T00:00:00.000Z",
      nodes: {},
      edges: [],
    });

    await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "reusable_pattern",
      summary: "A feedback loop setup skill should exist.",
      suggestedDestination: "@ai/skills/feedback-loop-setup/SKILL.md",
      domain: "feedback-loops",
      evidence: proposalEvidence("add-skill"),
    });

    const [proposal] = await proposeEvolution({ homeDir: tempHome, rootDir });
    expect(proposal?.kind).toBe("add_skill");

    await draftProposal(proposal!.id, { homeDir: tempHome, rootDir });
    await acceptProposal(proposal!.id, { homeDir: tempHome, rootDir });
    await applyProposal(proposal!.id, { homeDir: tempHome, rootDir });

    const skillPath = join(
      rootDir,
      "skills",
      "feedback-loop-setup",
      "SKILL.md"
    );
    const skillText = await readFile(skillPath, "utf8");
    expect(skillText).toContain("name: feedback-loop-setup");
    expect(skillText).toContain("A feedback loop setup skill should exist.");
  });

  it("classifies existing instruction targets as update_instruction proposals", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    const targetPath = join(rootDir, "instructions", "VERIFICATION.md");
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await Bun.write(targetPath, "# Verification\n");
    await writeGraph(tempHome, rootDir, {
      version: 1,
      generatedAt: "2026-03-18T00:00:00.000Z",
      nodes: {
        "instruction:global:global:VERIFICATION": {
          id: "instruction:global:global:VERIFICATION",
          kind: "instruction",
          name: "VERIFICATION",
          sourceKind: "global",
          scope: "global",
          canonicalRef: "@ai/instructions/VERIFICATION.md",
          path: targetPath,
        },
      },
      edges: [],
    });

    await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "weak_verification",
      summary: "Verification guidance is too shallow.",
      asset: "instruction:VERIFICATION",
      evidence: proposalEvidence("update-instruction"),
    });

    const [proposal] = await proposeEvolution({ homeDir: tempHome, rootDir });
    expect(proposal?.kind).toBe("update_instruction");
    expect(proposal?.policyClass).toBe("high-risk");
    expect(proposal?.reviewRequired).toBe(true);
  });

  it("skips evidence-free writebacks when proposing evolution", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    const targetPath = join(rootDir, "instructions", "VERIFICATION.md");
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await Bun.write(targetPath, "# Verification\n");
    await writeGraph(tempHome, rootDir, {
      version: 1,
      generatedAt: "2026-03-18T00:00:00.000Z",
      nodes: {
        "instruction:global:global:VERIFICATION": {
          id: "instruction:global:global:VERIFICATION",
          kind: "instruction",
          name: "VERIFICATION",
          sourceKind: "global",
          scope: "global",
          canonicalRef: "@ai/instructions/VERIFICATION.md",
          path: targetPath,
        },
      },
      edges: [],
    });

    await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "weak_verification",
      summary: "Verification guidance is too shallow.",
      asset: "instruction:VERIFICATION",
      allowEmptyEvidence: true,
    });

    const proposals = await proposeEvolution({ homeDir: tempHome, rootDir });
    expect(proposals).toEqual([]);

    const writebacks = await listWritebacks({ homeDir: tempHome, rootDir });
    expect(writebacks[0]?.status).toBe("recorded");
  });

  it("treats project instruction creation as low-risk and allows apply after draft", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const projectRoot = join(tempHome, "work", "repo");
    const rootDir = join(projectRoot, ".ai");
    await mkdir(rootDir, { recursive: true });
    await writeGraph(tempHome, rootDir, {
      version: 1,
      generatedAt: "2026-03-18T00:00:00.000Z",
      nodes: {},
      edges: [],
    });

    await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "missing_context",
      summary: "Local project context doc is missing.",
      suggestedDestination: "@project/instructions/WORK_UNITS.md",
      evidence: proposalEvidence("project-create-instruction"),
    });

    const [proposal] = await proposeEvolution({ homeDir: tempHome, rootDir });
    expect(proposal?.kind).toBe("create_instruction");
    expect(proposal?.policyClass).toBe("low-risk");
    expect(proposal?.reviewRequired).toBe(false);

    await draftProposal(proposal!.id, { homeDir: tempHome, rootDir });
    const applied = await applyProposal(proposal!.id, {
      homeDir: tempHome,
      rootDir,
    });

    expect(applied.status).toBe("applied");
    expect(applied.applyResult?.changedFiles).toEqual([
      join(rootDir, "instructions", "WORK_UNITS.md"),
    ]);
  });

  it("classifies agent targets as high-risk agent proposals", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    const targetPath = join(rootDir, "agents", "reviewer.md");
    await mkdir(join(rootDir, "agents"), { recursive: true });
    await Bun.write(targetPath, "# Reviewer\n");
    await writeGraph(tempHome, rootDir, {
      version: 1,
      generatedAt: "2026-03-18T00:00:00.000Z",
      nodes: {
        "agent:global:global:reviewer": {
          id: "agent:global:global:reviewer",
          kind: "agent",
          name: "reviewer",
          sourceKind: "global",
          scope: "global",
          canonicalRef: "@ai/agents/reviewer.md",
          path: targetPath,
        },
      },
      edges: [],
    });

    await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "agent_gap",
      summary: "Reviewer agent lacks escalation guidance.",
      asset: "agent:reviewer",
      evidence: proposalEvidence("update-agent"),
    });

    const [proposal] = await proposeEvolution({ homeDir: tempHome, rootDir });
    expect(proposal?.kind).toBe("update_agent");
    expect(proposal?.policyClass).toBe("high-risk");
    expect(proposal?.reviewRequired).toBe(true);
  });

  it("supports drafting, accepting, and applying a proposal with recorded provenance", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    const targetPath = join(rootDir, "instructions", "VERIFICATION.md");
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await Bun.write(targetPath, "# Verification\n\nStart here.\n");
    await writeGraph(tempHome, rootDir, {
      version: 1,
      generatedAt: "2026-03-18T00:00:00.000Z",
      nodes: {
        "instruction:global:global:VERIFICATION": {
          id: "instruction:global:global:VERIFICATION",
          kind: "instruction",
          name: "VERIFICATION",
          sourceKind: "global",
          scope: "global",
          canonicalRef: "@ai/instructions/VERIFICATION.md",
          path: targetPath,
        },
      },
      edges: [],
    });

    await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "weak_verification",
      summary: "Verification guidance needs stronger proof language.",
      asset: "instruction:VERIFICATION",
      evidence: proposalEvidence("draft-apply"),
    });

    const [proposal] = await proposeEvolution({
      homeDir: tempHome,
      rootDir,
    });
    expect(proposal?.status).toBe("proposed");

    const drafted = await draftProposal(proposal!.id, {
      homeDir: tempHome,
      rootDir,
    });
    expect(drafted.status).toBe("drafted");
    expect(drafted.draftRefs).toHaveLength(2);
    expect(drafted.review?.history?.at(-1)?.action).toBe("drafted");

    const draftText = await readFile(
      join(facultAiDraftDir(tempHome, rootDir), `${proposal!.id}.md`),
      "utf8"
    );
    expect(draftText).toContain("Generated Draft");
    expect(draftText).toContain("weak_verification");
    const patchText = await readFile(
      join(facultAiDraftDir(tempHome, rootDir), `${proposal!.id}.patch`),
      "utf8"
    );
    expect(patchText).toContain(`--- ${targetPath}`);
    expect(patchText).toContain(`+++ ${targetPath}`);
    expect(patchText).toContain("Facult Evolution Applied: EV-00001");

    const accepted = await acceptProposal(proposal!.id, {
      homeDir: tempHome,
      rootDir,
    });
    expect(accepted.status).toBe("accepted");
    expect(accepted.review?.status).toBe("accepted");

    const applied = await applyProposal(proposal!.id, {
      homeDir: tempHome,
      rootDir,
    });
    expect(applied.status).toBe("applied");
    expect(applied.applyResult?.status).toBe("applied");
    expect(applied.applyResult?.changedFiles).toEqual([targetPath]);

    const targetText = await readFile(targetPath, "utf8");
    expect(targetText).toContain("Facult Evolution Applied: EV-00001");
    expect(targetText).toContain(
      "Verification guidance needs stronger proof language."
    );

    const writeback = await showWriteback("WB-00001", {
      homeDir: tempHome,
      rootDir,
    });
    expect(writeback?.status).toBe("resolved");

    const refreshed = await showProposal(proposal!.id, {
      homeDir: tempHome,
      rootDir,
    });
    expect(refreshed?.applyResult?.draftRefs).toHaveLength(2);
  });

  it("supports rejecting and superseding proposals with review metadata", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    const targetPath = join(rootDir, "instructions", "VERIFICATION.md");
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await Bun.write(targetPath, "# Verification\n");
    await writeGraph(tempHome, rootDir, {
      version: 1,
      generatedAt: "2026-03-18T00:00:00.000Z",
      nodes: {
        "instruction:global:global:VERIFICATION": {
          id: "instruction:global:global:VERIFICATION",
          kind: "instruction",
          name: "VERIFICATION",
          sourceKind: "global",
          scope: "global",
          canonicalRef: "@ai/instructions/VERIFICATION.md",
          path: targetPath,
        },
      },
      edges: [],
    });

    await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "weak_verification",
      summary: "First proposal input.",
      asset: "instruction:VERIFICATION",
      evidence: proposalEvidence("supersede-first"),
    });
    const [first] = await proposeEvolution({ homeDir: tempHome, rootDir });
    const rejected = await rejectProposal(first!.id, {
      homeDir: tempHome,
      rootDir,
      reason: "Needs a better draft.",
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.review?.rejectionReason).toBe("Needs a better draft.");

    await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "false_positive",
      summary: "Second proposal input.",
      asset: "instruction:VERIFICATION",
      evidence: proposalEvidence("supersede-second"),
    });
    const proposals = await proposeEvolution({ homeDir: tempHome, rootDir });
    const second = proposals.at(-1);
    expect(second?.id).toBe("EV-00002");

    const superseded = await supersedeProposal(first!.id, second!.id, {
      homeDir: tempHome,
      rootDir,
    });
    expect(superseded.status).toBe("superseded");
    expect(superseded.review?.supersededBy).toBe("EV-00002");
  });

  it("creates a cross-scope promotion proposal from project to global", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const globalRoot = join(tempHome, ".ai");
    const projectRoot = join(tempHome, "work", "repo");
    const rootDir = join(projectRoot, ".ai");
    const projectTargetPath = join(rootDir, "instructions", "TESTING.md");
    await mkdir(join(globalRoot, "instructions"), { recursive: true });
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await Bun.write(projectTargetPath, "# Testing\n");
    await writeGraph(tempHome, rootDir, {
      version: 1,
      generatedAt: "2026-03-18T00:00:00.000Z",
      nodes: {
        "instruction:project:project:TESTING": {
          id: "instruction:project:project:TESTING",
          kind: "instruction",
          name: "TESTING",
          sourceKind: "project",
          scope: "project",
          canonicalRef: "@project/instructions/TESTING.md",
          path: projectTargetPath,
        },
      },
      edges: [],
    });

    await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "reusable_pattern",
      summary: "This testing pattern should be promoted globally.",
      asset: "instruction:TESTING",
      evidence: proposalEvidence("promote-project"),
    });
    const [proposal] = await proposeEvolution({
      homeDir: tempHome,
      rootDir,
    });
    const promoted = await promoteProposal(proposal!.id, {
      homeDir: tempHome,
      rootDir,
      to: "global",
    });

    expect(promoted.scope).toBe("global");
    expect(promoted.kind).toBe("promote_asset");
    expect(promoted.targets).toEqual(["@ai/instructions/TESTING.md"]);
    expect(promoted.sourceProposals).toEqual(["EV-00001"]);
    expect(promoted.policyClass).toBe("high-risk");

    const globalProposals = await listProposals({
      homeDir: tempHome,
      rootDir: globalRoot,
    });
    expect(globalProposals.map((entry) => entry.id)).toEqual(["EV-00001"]);
  });

  it("drafts and applies a promoted global proposal back into ~/.ai", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const globalRoot = join(tempHome, ".ai");
    const projectRoot = join(tempHome, "work", "repo");
    const rootDir = join(projectRoot, ".ai");
    const projectTargetPath = join(rootDir, "instructions", "TESTING.md");
    await mkdir(join(globalRoot, "instructions"), { recursive: true });
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await Bun.write(
      projectTargetPath,
      "# Testing\n\nProject-specific testing rule.\n"
    );
    await writeGraph(tempHome, rootDir, {
      version: 1,
      generatedAt: "2026-03-18T00:00:00.000Z",
      nodes: {
        "instruction:project:project:TESTING": {
          id: "instruction:project:project:TESTING",
          kind: "instruction",
          name: "TESTING",
          sourceKind: "project",
          scope: "project",
          canonicalRef: "@project/instructions/TESTING.md",
          path: projectTargetPath,
        },
      },
      edges: [],
    });

    await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "reusable_pattern",
      summary: "Promote this project testing guidance globally.",
      asset: "instruction:TESTING",
      evidence: proposalEvidence("promote-global"),
    });
    const [projectProposal] = await proposeEvolution({
      homeDir: tempHome,
      rootDir,
    });
    const promoted = await promoteProposal(projectProposal!.id, {
      homeDir: tempHome,
      rootDir,
      to: "global",
    });

    await draftProposal(promoted.id, {
      homeDir: tempHome,
      rootDir: globalRoot,
    });
    await acceptProposal(promoted.id, {
      homeDir: tempHome,
      rootDir: globalRoot,
    });
    await applyProposal(promoted.id, {
      homeDir: tempHome,
      rootDir: globalRoot,
    });

    const globalTarget = join(globalRoot, "instructions", "TESTING.md");
    const globalText = await readFile(globalTarget, "utf8");
    expect(globalText).toContain("# Testing");
    expect(globalText).toContain(
      "Promote this project testing guidance globally."
    );
  });
});
