import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  acceptProposal,
  addWriteback,
  applyProposal,
  assessEvolution,
  dismissWriteback,
  draftProposal,
  groupWritebacks,
  linkWritebackIssue,
  listProposals,
  listWritebacks,
  promoteProposal,
  promoteWriteback,
  proposeEvolution,
  refreshAiReviewArtifacts,
  rejectProposal,
  setWritebackDisposition,
  showProposal,
  showWriteback,
  summarizeWritebacks,
  supersedeProposal,
  verifyProposalEffectiveness,
} from "./ai";
import {
  facultAiDraftDir,
  facultAiEvolutionReviewDir,
  facultAiGraphPath,
  facultAiJournalPath,
  facultAiProposalDir,
  facultAiReconciliationStatePath,
  facultAiWritebackQueuePath,
  facultAiWritebackReviewDir,
  facultMachineStateDir,
} from "./paths";
import { reconcileSources } from "./reconciliation";

let tempHome: string | null = null;
const originalHome = process.env.HOME;
const proposalEvidence = (ref: string) => [{ type: "session", ref }];

async function makeTempHome(): Promise<string> {
  const dir = join(
    tmpdir(),
    "fclt-ai-tests",
    `ai-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeGraph(home: string, rootDir: string, graph: unknown) {
  const graphPath = facultAiGraphPath(home, rootDir);
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
  it("degrades evolution assessment when reconciliation state is corrupt", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const rootDir = join(tempHome, ".ai");
    await mkdir(rootDir, { recursive: true });
    await Bun.write(
      join(rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "writebacks", type: "writebacks" }],
      })
    );
    const statePath = facultAiReconciliationStatePath(tempHome, rootDir);
    await mkdir(dirname(statePath), { recursive: true });
    await Bun.write(statePath, "{corrupt-state");

    const assessment = await assessEvolution({ homeDir: tempHome, rootDir });

    expect(assessment.reconciliation).toMatchObject({
      configured: true,
      coverageState: "degraded",
      signalCount: 0,
    });
    expect(await Bun.file(statePath).text()).toBe("{corrupt-state");
  });

  it("requires reconciliation after enabled source configuration changes", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const rootDir = join(tempHome, ".ai");
    await mkdir(rootDir, { recursive: true });
    const queuePath = facultAiWritebackQueuePath(tempHome, rootDir);
    await mkdir(dirname(queuePath), { recursive: true });
    await Bun.write(
      queuePath,
      JSON.stringify({
        id: "WB-00001",
        ts: "2026-07-05T12:00:00Z",
        kind: "capability_gap",
        summary: "Reconciled capability signal",
        evidence: [{ type: "session", ref: "reconciled" }],
      })
    );
    const configPath = join(rootDir, "reconciliation.json");
    await Bun.write(
      configPath,
      JSON.stringify({
        version: 1,
        sources: [{ id: "writebacks", type: "writebacks" }],
      })
    );
    await reconcileSources({
      homeDir: tempHome,
      rootDir,
      since: "2026-07-03",
      until: "2026-07-10",
    });
    await Bun.write(
      configPath,
      JSON.stringify({
        version: 1,
        sources: [
          { id: "writebacks", type: "writebacks" },
          { id: "notes", type: "markdown", paths: ["notes/*.md"] },
        ],
      })
    );

    const assessment = await assessEvolution({ homeDir: tempHome, rootDir });

    expect(assessment.recommendation).toBe("reconcile_sources");
    expect(assessment.reconciliation.coverageState).toBe("degraded");
    expect(assessment.reconciliation.signalCount).toBe(1);
  });

  it("matches reconciled path refs to canonical selected assets", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const projectRoot = join(tempHome, "repo");
    const rootDir = join(projectRoot, ".ai");
    const targetPath = join(rootDir, "instructions", "TESTING.md");
    const globalTargetPath = join(
      tempHome,
      ".ai",
      "instructions",
      "TESTING.md"
    );
    await mkdir(join(projectRoot, "notes"), { recursive: true });
    await mkdir(dirname(targetPath), { recursive: true });
    await mkdir(dirname(globalTargetPath), { recursive: true });
    await Bun.write(targetPath, "# Testing\n");
    await Bun.write(globalTargetPath, "# Global testing\n");
    await writeGraph(tempHome, rootDir, {
      version: 1,
      generatedAt: "2026-07-10T00:00:00.000Z",
      nodes: {
        "instruction:global:global:TESTING": {
          id: "instruction:global:global:TESTING",
          kind: "instruction",
          name: "TESTING",
          sourceKind: "global",
          scope: "global",
          canonicalRef: "@ai/instructions/TESTING.md",
          path: globalTargetPath,
        },
        "instruction:project:project:TESTING": {
          id: "instruction:project:project:TESTING",
          kind: "instruction",
          name: "TESTING",
          sourceKind: "project",
          scope: "project",
          canonicalRef: "@project/instructions/TESTING.md",
          path: targetPath,
        },
      },
      edges: [],
    });
    await Bun.write(
      join(projectRoot, "notes", "signal.md"),
      "# 2026-07-05 capability signal\n\ninstructions/TESTING.md. needs reconciliation.\n"
    );
    await Bun.write(
      join(rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "notes", type: "markdown", paths: ["notes/*.md"] }],
      })
    );
    await reconcileSources({
      homeDir: tempHome,
      rootDir,
      since: "2026-07-03",
      until: "2026-07-10",
    });
    await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "capability_gap",
      summary: "Repeated project testing guidance gap.",
      asset: "@project/instructions/TESTING.md",
      evidence: proposalEvidence("testing-gap"),
    });

    const assessment = await assessEvolution({
      homeDir: tempHome,
      rootDir,
      asset: "instruction:TESTING",
    });

    expect(assessment.recommendation).toBe("review_reconciled_signals");
    expect(assessment.reconciliation.matchingSignalIds).toHaveLength(1);
    const globalAssessment = await assessEvolution({
      homeDir: tempHome,
      rootDir,
      asset: "@ai/instructions/TESTING.md",
    });
    expect(globalAssessment.reconciliation.matchingSignalIds).toHaveLength(0);
  });

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
    expect(facultAiWritebackQueuePath(tempHome, rootDir)).toBe(
      join(
        facultMachineStateDir(tempHome, rootDir),
        "ai",
        "global",
        "writeback",
        "queue.jsonl"
      )
    );

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
    const review = await readFile(
      join(facultAiWritebackReviewDir(tempHome, rootDir), "WB-00001.md"),
      "utf8"
    );
    expect(review).toContain('artifact: "writeback"');
    expect(review).toContain('status: "recorded"');
    expect(review).toContain('scope: "global"');
    expect(review).toContain('assetRef: "@ai/instructions/VERIFICATION.md"');
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

  it("records writebacks against existing project files outside the graph", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const projectRoot = join(tempHome, "work", "repo");
    const rootDir = join(projectRoot, ".ai");
    await mkdir(join(rootDir, ".facult", "ai"), { recursive: true });
    await mkdir(join(projectRoot, "docs"), { recursive: true });
    await Bun.write(join(projectRoot, "docs", "target.md"), "# Target\n");
    await writeGraph(tempHome, rootDir, {
      version: 1,
      generatedAt: "2026-05-24T00:00:00.000Z",
      nodes: {},
      edges: [],
    });

    const record = await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "missing_context",
      summary: "The target-state doc needs a follow-up note.",
      asset: "docs/target.md",
      evidence: proposalEvidence("project-doc-writeback"),
    });

    expect(record.assetRef).toBe("@project/docs/target.md");
    expect(record.assetId).toBe("file:project:docs/target.md");
    expect(record.assetType).toBe("file");
  });

  it("stores project-scoped runtime state under machine-local project state", async () => {
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
        facultMachineStateDir(tempHome, rootDir),
        "ai",
        "project",
        "writeback",
        "queue.jsonl"
      )
    );
    const reviewDir = facultAiWritebackReviewDir(tempHome, rootDir);
    expect(reviewDir.startsWith(join(tempHome, ".ai", "writebacks"))).toBe(
      true
    );
    expect(reviewDir.startsWith(projectRoot)).toBe(false);
    const review = await readFile(join(reviewDir, "WB-00001.md"), "utf8");
    expect(review).toContain('scope: "project"');
    expect(review).toContain(`projectRoot: "${projectRoot}"`);
    expect(review).toContain(`cwd: "${projectRoot}"`);
  });

  it("reads legacy repo-local project writeback state", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const projectRoot = join(tempHome, "work", "repo");
    const rootDir = join(projectRoot, ".ai");
    const legacyQueuePath = join(
      rootDir,
      ".facult",
      "ai",
      "project",
      "writeback",
      "queue.jsonl"
    );
    await mkdir(dirname(legacyQueuePath), { recursive: true });
    await Bun.write(
      legacyQueuePath,
      `${JSON.stringify({
        id: "WB-00001",
        ts: "2026-05-28T22:04:57.770Z",
        scope: "project",
        projectSlug: "repo",
        projectRoot,
        kind: "rule",
        summary: "Legacy repo-local writeback should remain visible.",
        evidence: [{ type: "commit", ref: "abc123" }],
        confidence: "medium",
        source: "facult:manual",
        tags: [],
        status: "recorded",
      })}\n`
    );

    const rows = await listWritebacks({ homeDir: tempHome, rootDir });

    expect(rows.map((entry) => entry.id)).toEqual(["WB-00001"]);
    expect(rows[0]?.summary).toBe(
      "Legacy repo-local writeback should remain visible."
    );
  });

  it("reads legacy global writeback state from generated AI state", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    const legacyQueuePath = join(
      rootDir,
      ".facult",
      "ai",
      "global",
      "writeback",
      "queue.jsonl"
    );
    await mkdir(dirname(legacyQueuePath), { recursive: true });
    await Bun.write(
      legacyQueuePath,
      `${JSON.stringify({
        id: "WB-00009",
        ts: "2026-06-19T15:00:00.000Z",
        scope: "global",
        kind: "capability_gap",
        summary: "Legacy global writeback should remain visible.",
        evidence: [{ type: "session", ref: "legacy-global" }],
        confidence: "medium",
        source: "facult:manual",
        tags: [],
        status: "recorded",
      })}\n`
    );

    const rows = await listWritebacks({ homeDir: tempHome, rootDir });

    expect(rows.map((entry) => entry.id)).toEqual(["WB-00009"]);
    expect(rows[0]?.summary).toBe(
      "Legacy global writeback should remain visible."
    );
    expect(facultAiWritebackQueuePath(tempHome, rootDir)).toBe(
      join(
        facultMachineStateDir(tempHome, rootDir),
        "ai",
        "global",
        "writeback",
        "queue.jsonl"
      )
    );
  });

  it("reads and updates legacy repo-local project evolution proposals", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const projectRoot = join(tempHome, "work", "repo");
    const rootDir = join(projectRoot, ".ai");
    const targetPath = join(projectRoot, "AGENTS.md");
    const legacyProposalDir = join(
      rootDir,
      ".facult",
      "ai",
      "project",
      "evolution",
      "proposals"
    );
    const legacyDraftDir = join(
      rootDir,
      ".facult",
      "ai",
      "project",
      "evolution",
      "drafts"
    );
    const legacyDraftPath = join(legacyDraftDir, "EV-00009.md");
    await mkdir(legacyProposalDir, { recursive: true });
    await mkdir(legacyDraftDir, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await Bun.write(targetPath, "# Project\n");
    await Bun.write(
      legacyDraftPath,
      [
        "# Generated Draft: EV-00009",
        "",
        "## Proposed Addition",
        "<!-- facult:evolution:EV-00009:start -->",
        "Legacy proposal content.",
        "<!-- facult:evolution:EV-00009:end -->",
        "",
      ].join("\n")
    );
    await Bun.write(
      join(legacyProposalDir, "EV-00009.json"),
      `${JSON.stringify(
        {
          id: "EV-00009",
          ts: "2026-05-28T22:04:57.770Z",
          status: "drafted",
          scope: "project",
          projectSlug: "repo",
          projectRoot,
          kind: "update_asset",
          targets: ["@project/AGENTS.md"],
          sourceWritebacks: [],
          summary: "Legacy proposal should remain visible.",
          rationale: "Preserve existing project proposal state.",
          confidence: "medium",
          reviewRequired: false,
          policyClass: "medium-risk",
          draftRefs: [legacyDraftPath],
        },
        null,
        2
      )}\n`
    );

    const listed = await listProposals({ homeDir: tempHome, rootDir });
    const shown = await showProposal("EV-00009", {
      homeDir: tempHome,
      rootDir,
    });
    const applied = await applyProposal("EV-00009", {
      homeDir: tempHome,
      rootDir,
    });

    expect(listed.map((entry) => entry.id)).toEqual(["EV-00009"]);
    expect(shown?.summary).toBe("Legacy proposal should remain visible.");
    expect(applied.status).toBe("applied");
    expect(await readFile(targetPath, "utf8")).toContain(
      "Legacy proposal content."
    );
    expect(
      await readFile(
        join(facultAiProposalDir(tempHome, rootDir), "EV-00009.json"),
        "utf8"
      )
    ).toContain('"status": "applied"');
  });

  it("reads legacy global evolution proposals from generated AI state", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    const legacyProposalDir = join(
      rootDir,
      ".facult",
      "ai",
      "global",
      "evolution",
      "proposals"
    );
    await mkdir(legacyProposalDir, { recursive: true });
    await Bun.write(
      join(legacyProposalDir, "EV-00009.json"),
      `${JSON.stringify(
        {
          id: "EV-00009",
          ts: "2026-06-19T15:00:00.000Z",
          status: "rejected",
          scope: "global",
          kind: "update_instruction",
          targets: ["@ai/instructions/VERIFICATION.md"],
          sourceWritebacks: [],
          summary: "Legacy global proposal should remain visible.",
          rationale: "Preserve existing global proposal state.",
          confidence: "medium",
          reviewRequired: true,
          policyClass: "high-risk",
          draftRefs: [],
        },
        null,
        2
      )}\n`
    );

    const listed = await listProposals({ homeDir: tempHome, rootDir });
    const shown = await showProposal("EV-00009", {
      homeDir: tempHome,
      rootDir,
    });

    expect(listed.map((entry) => entry.id)).toEqual(["EV-00009"]);
    expect(shown?.summary).toBe(
      "Legacy global proposal should remain visible."
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
      join(
        facultMachineStateDir(tempHome, rootDir),
        "ai",
        "global",
        "evolution",
        "proposals"
      )
    );
    const review = await readFile(
      join(facultAiEvolutionReviewDir(tempHome, rootDir), "EV-00001.md"),
      "utf8"
    );
    expect(review).toContain('artifact: "evolution_proposal"');
    expect(review).toContain('status: "proposed"');
    expect(review).toContain('sourceWritebacks: ["WB-00001","WB-00002"]');
    expect(review).toContain(
      "- WB-00001 (weak_verification): Checks are too shallow."
    );

    const nextWritebacks = await listWritebacks({ homeDir: tempHome, rootDir });
    expect(nextWritebacks.every((entry) => entry.status === "recorded")).toBe(
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

  it("links implementation issues and persists a closed-loop disposition", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const rootDir = join(tempHome, ".ai");
    await mkdir(rootDir, { recursive: true });

    const writeback = await addWriteback({
      homeDir: tempHome,
      rootDir,
      kind: "capability_gap",
      summary: "Outcome tracking is missing.",
      evidence: proposalEvidence("closed-loop"),
    });
    await linkWritebackIssue(writeback.id, "TICKET-791", {
      homeDir: tempHome,
      rootDir,
    });
    const updated = await setWritebackDisposition(writeback.id, "task", {
      homeDir: tempHome,
      rootDir,
      target: "TICKET-791",
      nextTrigger: "Implementation ships.",
      expectedOutcome: "Applied proposals receive effectiveness grades.",
    });

    expect(updated.issueLinks).toEqual(["TICKET-791"]);
    expect(updated.disposition).toBe("task");
    expect(updated.dispositionTarget).toBe("TICKET-791");
    expect(updated.nextTrigger).toBe("Implementation ships.");
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
    const review = await readFile(
      join(facultAiEvolutionReviewDir(tempHome, rootDir), `${proposal!.id}.md`),
      "utf8"
    );
    expect(review).toContain('status: "drafted"');
    expect(review).toContain("## Current Draft");
    expect(review).toContain("# Work Units");

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

    await draftProposal(proposal!.id, {
      homeDir: tempHome,
      rootDir,
      append: "Require post-apply effectiveness verification.",
    });
    const revisedPatch = await readFile(
      join(facultAiDraftDir(tempHome, rootDir), `${proposal!.id}.patch`),
      "utf8"
    );
    expect(revisedPatch).toContain(
      "Require post-apply effectiveness verification."
    );

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
    expect(writeback?.status).toBe("promoted");

    const assessment = await assessEvolution({
      homeDir: tempHome,
      rootDir,
      asset: "instruction:VERIFICATION",
    });
    expect(assessment.recommendation).toBe("review_existing_proposal");
    expect(assessment.activeProposalIds).toEqual([proposal!.id]);

    const verified = await verifyProposalEffectiveness(proposal!.id, {
      homeDir: tempHome,
      rootDir,
      effectiveness: "improved",
      evidence: proposalEvidence("effectiveness-proof"),
    });
    expect(verified.effectiveness?.effectiveness).toBe("improved");
    expect(
      (await showWriteback("WB-00001", { homeDir: tempHome, rootDir }))?.status
    ).toBe("resolved");

    const refreshed = await showProposal(proposal!.id, {
      homeDir: tempHome,
      rootDir,
    });
    expect(refreshed?.applyResult?.draftRefs).toHaveLength(2);

    await refreshAiReviewArtifacts({ homeDir: tempHome, rootDir });
    const reviewText = await readFile(
      join(facultAiEvolutionReviewDir(tempHome, rootDir), `${proposal!.id}.md`),
      "utf8"
    );
    expect(reviewText).toContain("## Current Draft");
    expect(reviewText).toContain(
      "Verification guidance needs stronger proof language."
    );
  });

  it("does not repair generated graph state during assessment", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const rootDir = join(tempHome, ".ai");
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await Bun.write(
      join(rootDir, "instructions", "VERIFICATION.md"),
      "# Verification\n"
    );

    await expect(
      assessEvolution({
        homeDir: tempHome,
        rootDir,
        asset: "instruction:VERIFICATION",
      })
    ).rejects.toThrow("Graph not found");
    expect(await Bun.file(facultAiGraphPath(tempHome, rootDir)).exists()).toBe(
      false
    );
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
    await promoteWriteback("WB-00001", { homeDir: tempHome, rootDir });
    const rejected = await rejectProposal(first!.id, {
      homeDir: tempHome,
      rootDir,
      reason: "Needs a better draft.",
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.review?.rejectionReason).toBe("Needs a better draft.");
    expect(
      (await showWriteback("WB-00001", { homeDir: tempHome, rootDir }))?.status
    ).toBe("recorded");

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
