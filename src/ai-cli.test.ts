import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiCommand } from "./ai";

let tempHome: string | null = null;
const originalHome = process.env.HOME;
const originalRoot = process.env.FACULT_ROOT_DIR;
const originalCwd = process.cwd();
const proposalEvidenceArgs = (ref: string) => ["--evidence", `session:${ref}`];
const allowEmptyEvidenceArgs = ["--allow-empty-evidence"];

async function makeTempHome(): Promise<string> {
  const dir = join(
    tmpdir(),
    "fclt-ai-cli-tests",
    `ai-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

async function captureConsole(fn: () => Promise<void>) {
  const logs: string[] = [];
  const errors: string[] = [];
  const prevLog = console.log;
  const prevError = console.error;
  console.log = (...args: Parameters<typeof console.log>) => {
    logs.push(args.map((value) => String(value)).join(" "));
  };
  console.error = (...args: Parameters<typeof console.error>) => {
    errors.push(args.map((value) => String(value)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = prevLog;
    console.error = prevError;
  }
  return { logs, errors };
}

afterEach(async () => {
  process.chdir(originalCwd);
  process.env.HOME = originalHome;
  process.env.FACULT_ROOT_DIR = originalRoot;
  process.exitCode = 0;
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
  }
  tempHome = null;
});

describe("ai CLI", () => {
  it("records and lists writebacks through the ai namespace", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const rootDir = join(tempHome, ".ai");
    process.env.FACULT_ROOT_DIR = rootDir;
    await mkdir(rootDir, { recursive: true });
    await mkdir(join(tempHome, ".ai", ".facult", "ai"), { recursive: true });
    await Bun.write(
      join(tempHome, ".ai", ".facult", "ai", "graph.json"),
      `${JSON.stringify({ version: 1, generatedAt: "2026-03-18T00:00:00.000Z", nodes: {}, edges: [] }, null, 2)}\n`
    );
    process.chdir(tempHome);

    const addOut = await captureConsole(async () => {
      await aiCommand([
        "writeback",
        "add",
        "--kind",
        "capability_gap",
        "--summary",
        "Need a project operating layer review.",
        ...allowEmptyEvidenceArgs,
      ]);
    });
    expect(addOut.errors).toEqual([]);
    expect(addOut.logs.join("\n")).toContain("WB-00001");

    const listOut = await captureConsole(async () => {
      await aiCommand(["writeback", "list"]);
    });
    expect(listOut.errors).toEqual([]);
    expect(listOut.logs.join("\n")).toContain("WB-00001");
    expect(listOut.logs.join("\n")).toContain("capability_gap");
  });

  it("rejects evidence-free writebacks unless explicitly allowed", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const rootDir = join(tempHome, ".ai");
    process.env.FACULT_ROOT_DIR = rootDir;
    await mkdir(rootDir, { recursive: true });
    await mkdir(join(tempHome, ".ai", ".facult", "ai"), { recursive: true });
    await Bun.write(
      join(tempHome, ".ai", ".facult", "ai", "graph.json"),
      `${JSON.stringify({ version: 1, generatedAt: "2026-03-18T00:00:00.000Z", nodes: {}, edges: [] }, null, 2)}\n`
    );
    process.chdir(tempHome);

    const addOut = await captureConsole(async () => {
      await aiCommand([
        "writeback",
        "add",
        "--kind",
        "capability_gap",
        "--summary",
        "Need evidence to persist this.",
      ]);
    });
    expect(addOut.logs).toEqual([]);
    expect(addOut.errors.join("\n")).toContain(
      "writeback add requires at least one evidence item"
    );
  });

  it("supports grouping and summarizing writebacks through the ai namespace", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const rootDir = join(tempHome, ".ai");
    process.env.FACULT_ROOT_DIR = rootDir;
    const verificationPath = join(rootDir, "instructions", "VERIFICATION.md");
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await mkdir(join(tempHome, ".ai", ".facult", "ai"), { recursive: true });
    await Bun.write(verificationPath, "# Verification\n");
    await Bun.write(
      join(tempHome, ".ai", ".facult", "ai", "graph.json"),
      `${JSON.stringify(
        {
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
          },
          edges: [],
        },
        null,
        2
      )}\n`
    );
    process.chdir(tempHome);

    await aiCommand([
      "writeback",
      "add",
      "--kind",
      "weak_verification",
      "--summary",
      "Checks were too shallow.",
      "--asset",
      "instruction:VERIFICATION",
      ...proposalEvidenceArgs("group-1"),
    ]);
    await aiCommand([
      "writeback",
      "add",
      "--kind",
      "false_positive",
      "--summary",
      "Passing checks did not prove correctness.",
      "--asset",
      "instruction:VERIFICATION",
      ...proposalEvidenceArgs("group-2"),
    ]);

    const groupOut = await captureConsole(async () => {
      await aiCommand(["writeback", "group", "--by", "asset"]);
    });
    expect(groupOut.errors).toEqual([]);
    expect(groupOut.logs.join("\n")).toContain(
      "@ai/instructions/VERIFICATION.md"
    );

    const summarizeOut = await captureConsole(async () => {
      await aiCommand(["writeback", "summarize", "--by", "kind"]);
    });
    expect(summarizeOut.errors).toEqual([]);
    expect(summarizeOut.logs.join("\n")).toContain("weak_verification");
    expect(summarizeOut.logs.join("\n")).toContain("false_positive");

    const domainOut = await captureConsole(async () => {
      await aiCommand(["writeback", "group", "--by", "domain"]);
    });
    expect(domainOut.errors).toEqual([]);
    expect(domainOut.logs.join("\n")).toContain("unassigned");
  });

  it("accepts context flags before writeback and evolve operation names", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const rootDir = join(tempHome, ".ai");
    process.env.FACULT_ROOT_DIR = rootDir;
    const verificationPath = join(rootDir, "instructions", "VERIFICATION.md");
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await mkdir(join(tempHome, ".ai", ".facult", "ai"), { recursive: true });
    await Bun.write(verificationPath, "# Verification\n");
    await Bun.write(
      join(tempHome, ".ai", ".facult", "ai", "graph.json"),
      `${JSON.stringify(
        {
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
          },
          edges: [],
        },
        null,
        2
      )}\n`
    );
    process.chdir(tempHome);

    const addOut = await captureConsole(async () => {
      await aiCommand([
        "writeback",
        "--global",
        "add",
        "--kind",
        "weak_verification",
        "--summary",
        "Global checks were too shallow.",
        "--asset",
        "instruction:VERIFICATION",
        ...proposalEvidenceArgs("global-before-subcommand"),
      ]);
    });
    expect(addOut.errors).toEqual([]);
    expect(addOut.logs.join("\n")).toContain("WB-00001");

    const proposeOut = await captureConsole(async () => {
      await aiCommand(["evolve", "--global", "propose"]);
    });
    expect(proposeOut.errors).toEqual([]);
    expect(proposeOut.logs.join("\n")).toContain("EV-00001");

    const draftOut = await captureConsole(async () => {
      await aiCommand(["evolve", "--global", "draft", "EV-00001"]);
    });
    expect(draftOut.errors).toEqual([]);
    expect(draftOut.logs.join("\n")).toContain("Drafted EV-00001");
  });

  it("generates and shows proposals through the ai namespace", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const rootDir = join(tempHome, ".ai");
    process.env.FACULT_ROOT_DIR = rootDir;
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await mkdir(join(tempHome, ".ai", ".facult", "ai"), { recursive: true });
    await Bun.write(
      join(tempHome, ".ai", ".facult", "ai", "graph.json"),
      `${JSON.stringify(
        {
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
            },
          },
          edges: [],
        },
        null,
        2
      )}\n`
    );
    process.chdir(tempHome);

    await aiCommand([
      "writeback",
      "add",
      "--kind",
      "weak_verification",
      "--summary",
      "Verification guidance is too shallow.",
      "--asset",
      "instruction:VERIFICATION",
      ...proposalEvidenceArgs("show-proposal"),
    ]);

    const proposeOut = await captureConsole(async () => {
      await aiCommand(["evolve", "propose"]);
    });
    expect(proposeOut.errors).toEqual([]);
    expect(proposeOut.logs.join("\n")).toContain("EV-00001");

    const showOut = await captureConsole(async () => {
      await aiCommand(["evolve", "show", "EV-00001"]);
    });
    expect(showOut.errors).toEqual([]);
    expect(showOut.logs.join("\n")).toContain(
      "@ai/instructions/VERIFICATION.md"
    );
  });

  it("assesses evolution readiness before mutating proposal state", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const rootDir = join(tempHome, ".ai");
    process.env.FACULT_ROOT_DIR = rootDir;
    const verificationPath = join(rootDir, "instructions", "VERIFICATION.md");
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await mkdir(join(tempHome, ".ai", ".facult", "ai"), { recursive: true });
    await Bun.write(verificationPath, "# Verification\n");
    await Bun.write(
      join(tempHome, ".ai", ".facult", "ai", "graph.json"),
      `${JSON.stringify(
        {
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
          },
          edges: [],
        },
        null,
        2
      )}\n`
    );
    process.chdir(tempHome);

    await aiCommand([
      "writeback",
      "add",
      "--kind",
      "bad_default",
      "--summary",
      "The git fallback guidance missed a macOS sandbox edge case.",
      "--asset",
      "instruction:VERIFICATION",
      ...proposalEvidenceArgs("assess-singleton"),
    ]);

    const singletonOut = await captureConsole(async () => {
      await aiCommand([
        "evolve",
        "assess",
        "--asset",
        "instruction:VERIFICATION",
        "--json",
      ]);
    });
    expect(singletonOut.errors).toEqual([]);
    const singleton = JSON.parse(singletonOut.logs.join("\n")) as {
      recommendation: string;
      writebackCount: number;
      approvalRequired: boolean;
      sourceWritebacks: string[];
      suggestedCommands: { mutating: string[] };
    };
    expect(singleton.recommendation).toBe("record_more_writeback");
    expect(singleton.writebackCount).toBe(1);
    expect(singleton.approvalRequired).toBe(false);
    expect(singleton.sourceWritebacks).toEqual(["WB-00001"]);
    expect(singleton.suggestedCommands.mutating.join("\n")).toContain(
      "writeback add"
    );

    await aiCommand([
      "writeback",
      "add",
      "--kind",
      "bad_default",
      "--summary",
      "The same fallback guidance failed in another sandboxed macOS run.",
      "--asset",
      "instruction:VERIFICATION",
      ...proposalEvidenceArgs("assess-repeat"),
    ]);

    const repeatedOut = await captureConsole(async () => {
      await aiCommand([
        "evolve",
        "assess",
        "--asset",
        "instruction:VERIFICATION",
        "--json",
      ]);
    });
    expect(repeatedOut.errors).toEqual([]);
    const repeated = JSON.parse(repeatedOut.logs.join("\n")) as {
      recommendation: string;
      writebackCount: number;
      repeatedSignal: boolean;
      suggestedCommands: { mutating: string[] };
    };
    expect(repeated.recommendation).toBe("propose");
    expect(repeated.writebackCount).toBe(2);
    expect(repeated.repeatedSignal).toBe(true);
    expect(repeated.suggestedCommands.mutating).toContain(
      'fclt ai evolve propose --asset "instruction:VERIFICATION" --json'
    );

    await aiCommand([
      "evolve",
      "propose",
      "--asset",
      "instruction:VERIFICATION",
    ]);
    const existingOut = await captureConsole(async () => {
      await aiCommand([
        "evolve",
        "assess",
        "--asset",
        "instruction:VERIFICATION",
        "--json",
      ]);
    });
    expect(existingOut.errors).toEqual([]);
    const existing = JSON.parse(existingOut.logs.join("\n")) as {
      recommendation: string;
      activeProposalIds: string[];
    };
    expect(existing.recommendation).toBe("review_existing_proposal");
    expect(existing.activeProposalIds).toEqual(["EV-00001"]);
  });

  it("drafts existing skill evolution against SKILL.md", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const rootDir = join(tempHome, ".ai");
    process.env.FACULT_ROOT_DIR = rootDir;
    const skillDir = join(rootDir, "skills", "capability-evolution");
    const skillPath = join(skillDir, "SKILL.md");
    await mkdir(skillDir, { recursive: true });
    await mkdir(join(tempHome, ".ai", ".facult", "ai"), { recursive: true });
    await Bun.write(skillPath, "# capability-evolution\n");
    await Bun.write(
      join(tempHome, ".ai", ".facult", "ai", "graph.json"),
      `${JSON.stringify(
        {
          version: 1,
          generatedAt: "2026-03-18T00:00:00.000Z",
          nodes: {
            "skill:global:global:capability-evolution": {
              id: "skill:global:global:capability-evolution",
              kind: "skill",
              name: "capability-evolution",
              sourceKind: "global",
              scope: "global",
              canonicalRef: "@ai/skills/capability-evolution",
              path: skillDir,
            },
          },
          edges: [],
        },
        null,
        2
      )}\n`
    );
    process.chdir(tempHome);

    await aiCommand([
      "writeback",
      "add",
      "--kind",
      "capability_gap",
      "--summary",
      "Evolution reviews need a disposition table instead of repeated no-op summaries.",
      "--asset",
      "skill:capability-evolution",
      "--confidence",
      "high",
      ...proposalEvidenceArgs("skill-disposition-gap"),
    ]);

    const proposeOut = await captureConsole(async () => {
      await aiCommand([
        "evolve",
        "propose",
        "--asset",
        "skill:capability-evolution",
        "--json",
      ]);
    });
    expect(proposeOut.errors).toEqual([]);
    const proposals = JSON.parse(proposeOut.logs.join("\n")) as Array<{
      id: string;
      kind: string;
      targets: string[];
    }>;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.kind).toBe("update_asset");
    expect(proposals[0]?.targets).toEqual(["@ai/skills/capability-evolution"]);

    const draftOut = await captureConsole(async () => {
      await aiCommand(["evolve", "draft", "EV-00001"]);
    });
    expect(draftOut.errors).toEqual([]);
    const showOut = await captureConsole(async () => {
      await aiCommand(["evolve", "show", "EV-00001", "--json"]);
    });
    expect(showOut.errors).toEqual([]);
    const drafted = JSON.parse(showOut.logs.join("\n")) as {
      draftRefs: string[];
    };
    const patchPath = drafted.draftRefs.find((pathValue) =>
      pathValue.endsWith(".patch")
    );
    expect(patchPath).toBeTruthy();
    const patchText = await Bun.file(patchPath as string).text();
    expect(patchText).toContain("skills/capability-evolution/SKILL.md");
  });

  it("supports draft, accept, apply, reject, and supersede through the ai namespace", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const rootDir = join(tempHome, ".ai");
    process.env.FACULT_ROOT_DIR = rootDir;
    const targetPath = join(rootDir, "instructions", "VERIFICATION.md");
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await mkdir(join(tempHome, ".ai", ".facult", "ai"), { recursive: true });
    await Bun.write(targetPath, "# Verification\n");
    await Bun.write(
      join(tempHome, ".ai", ".facult", "ai", "graph.json"),
      `${JSON.stringify(
        {
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
        },
        null,
        2
      )}\n`
    );
    process.chdir(tempHome);

    await aiCommand([
      "writeback",
      "add",
      "--kind",
      "weak_verification",
      "--summary",
      "First proposal input.",
      "--asset",
      "instruction:VERIFICATION",
      ...proposalEvidenceArgs("draft-first"),
    ]);
    await aiCommand(["evolve", "propose"]);

    const draftOut = await captureConsole(async () => {
      await aiCommand(["evolve", "draft", "EV-00001"]);
    });
    expect(draftOut.errors).toEqual([]);
    expect(draftOut.logs.join("\n")).toContain("Drafted EV-00001");

    const acceptOut = await captureConsole(async () => {
      await aiCommand(["evolve", "accept", "EV-00001"]);
    });
    expect(acceptOut.errors).toEqual([]);
    expect(acceptOut.logs.join("\n")).toContain("Accepted EV-00001");

    const applyOut = await captureConsole(async () => {
      await aiCommand(["evolve", "apply", "EV-00001"]);
    });
    expect(applyOut.errors).toEqual([]);
    expect(applyOut.logs.join("\n")).toContain("Applied EV-00001");

    const targetText = await Bun.file(targetPath).text();
    expect(targetText).toContain("Facult Evolution Applied: EV-00001");

    await aiCommand([
      "writeback",
      "add",
      "--kind",
      "false_positive",
      "--summary",
      "Second proposal input.",
      "--asset",
      "instruction:VERIFICATION",
      ...proposalEvidenceArgs("draft-second"),
    ]);
    await aiCommand(["evolve", "propose"]);

    const rejectOut = await captureConsole(async () => {
      await aiCommand([
        "evolve",
        "reject",
        "EV-00002",
        "--reason",
        "Not ready yet.",
      ]);
    });
    expect(rejectOut.errors).toEqual([]);
    expect(rejectOut.logs.join("\n")).toContain("Rejected EV-00002");

    await aiCommand([
      "writeback",
      "add",
      "--kind",
      "missing_examples",
      "--summary",
      "Third proposal input.",
      "--asset",
      "instruction:VERIFICATION",
      ...proposalEvidenceArgs("draft-third"),
    ]);
    await aiCommand(["evolve", "propose"]);

    const supersedeOut = await captureConsole(async () => {
      await aiCommand(["evolve", "supersede", "EV-00002", "--by", "EV-00003"]);
    });
    expect(supersedeOut.errors).toEqual([]);
    expect(supersedeOut.logs.join("\n")).toContain("Superseded EV-00002");
  });

  it("supports project-to-global promotion through the ai namespace", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const globalRoot = join(tempHome, ".ai");
    const projectRoot = join(tempHome, "work", "repo");
    const rootDir = join(projectRoot, ".ai");
    const targetPath = join(rootDir, "instructions", "TESTING.md");
    await mkdir(join(globalRoot, "instructions"), { recursive: true });
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await mkdir(join(tempHome, ".ai", ".facult", "ai"), { recursive: true });
    await Bun.write(targetPath, "# Testing\n");
    await Bun.write(
      join(projectRoot, ".ai", ".facult", "ai", "graph.json"),
      `${JSON.stringify(
        {
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
              path: targetPath,
            },
          },
          edges: [],
        },
        null,
        2
      )}\n`
    );
    process.chdir(projectRoot);

    await aiCommand([
      "writeback",
      "add",
      "--kind",
      "reusable_pattern",
      "--summary",
      "Promote this pattern globally.",
      "--asset",
      "instruction:TESTING",
      "--project",
      ...proposalEvidenceArgs("promote-cli"),
    ]);
    await aiCommand(["evolve", "propose", "--project"]);

    const promoteOut = await captureConsole(async () => {
      await aiCommand([
        "evolve",
        "promote",
        "EV-00001",
        "--to",
        "global",
        "--project",
      ]);
    });
    expect(promoteOut.errors).toEqual([]);
    expect(promoteOut.logs.join("\n")).toContain("Promoted EV-00001");
    expect(promoteOut.logs.join("\n")).toContain("@ai/instructions/TESTING.md");
  });

  it("supports revising drafts and applying create_instruction proposals through the ai namespace", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const rootDir = join(tempHome, ".ai");
    process.env.FACULT_ROOT_DIR = rootDir;
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await mkdir(join(tempHome, ".ai", ".facult", "ai"), { recursive: true });
    await Bun.write(
      join(tempHome, ".ai", ".facult", "ai", "graph.json"),
      `${JSON.stringify({ version: 1, generatedAt: "2026-03-18T00:00:00.000Z", nodes: {}, edges: [] }, null, 2)}\n`
    );
    process.chdir(tempHome);

    await aiCommand([
      "writeback",
      "add",
      "--kind",
      "missing_context",
      "--summary",
      "Work units doc is missing.",
      "--suggested-destination",
      "@ai/instructions/WORK_UNITS.md",
      ...proposalEvidenceArgs("create-instruction-cli"),
    ]);
    await aiCommand(["evolve", "propose"]);

    await aiCommand(["evolve", "draft", "EV-00001"]);
    const reviseOut = await captureConsole(async () => {
      await aiCommand([
        "evolve",
        "draft",
        "EV-00001",
        "--append",
        "Add a rule about explicit verification plans.",
      ]);
    });
    expect(reviseOut.errors).toEqual([]);
    expect(reviseOut.logs.join("\n")).toContain("Drafted EV-00001");

    await aiCommand(["evolve", "accept", "EV-00001"]);
    await aiCommand(["evolve", "apply", "EV-00001"]);

    const targetText = await Bun.file(
      join(rootDir, "instructions", "WORK_UNITS.md")
    ).text();
    expect(targetText).toContain(
      "Add a rule about explicit verification plans."
    );
  });

  it("applies low-risk project instruction proposals after draft without accept", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const projectRoot = join(tempHome, "work", "repo");
    const rootDir = join(projectRoot, ".ai");
    await mkdir(rootDir, { recursive: true });
    await mkdir(join(projectRoot, ".ai", ".facult", "ai", "project"), {
      recursive: true,
    });
    await Bun.write(
      join(projectRoot, ".ai", ".facult", "ai", "project", "graph.json"),
      `${JSON.stringify({ version: 1, generatedAt: "2026-03-18T00:00:00.000Z", nodes: {}, edges: [] }, null, 2)}\n`
    );
    process.chdir(projectRoot);

    await aiCommand([
      "writeback",
      "add",
      "--kind",
      "missing_context",
      "--summary",
      "Local project context doc is missing.",
      "--suggested-destination",
      "@project/instructions/WORK_UNITS.md",
      "--root",
      rootDir,
      ...proposalEvidenceArgs("project-create-cli"),
    ]);
    await aiCommand(["evolve", "propose", "--root", rootDir]);
    await aiCommand(["evolve", "draft", "EV-00001", "--root", rootDir]);

    const applyOut = await captureConsole(async () => {
      await aiCommand(["evolve", "apply", "EV-00001", "--root", rootDir]);
    });
    expect(applyOut.errors).toEqual([]);
    expect(applyOut.logs.join("\n")).toContain("Applied EV-00001");

    const targetText = await Bun.file(
      join(rootDir, "instructions", "WORK_UNITS.md")
    ).text();
    expect(targetText).toContain("Local project context doc is missing.");
  });
});
