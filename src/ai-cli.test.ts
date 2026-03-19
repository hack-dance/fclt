import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { aiCommand } from "./ai";

let tempHome: string | null = null;
const originalHome = process.env.HOME;
const originalCwd = process.cwd();

async function makeTempHome(): Promise<string> {
  const dir = join(
    process.cwd(),
    ".tmp-tests",
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
    await mkdir(rootDir, { recursive: true });
    await mkdir(join(tempHome, ".facult", "ai"), { recursive: true });
    await Bun.write(
      join(tempHome, ".facult", "ai", "graph.json"),
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

  it("supports grouping and summarizing writebacks through the ai namespace", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const rootDir = join(tempHome, ".ai");
    const verificationPath = join(rootDir, "instructions", "VERIFICATION.md");
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await mkdir(join(tempHome, ".facult", "ai"), { recursive: true });
    await Bun.write(verificationPath, "# Verification\n");
    await Bun.write(
      join(tempHome, ".facult", "ai", "graph.json"),
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

  it("generates and shows proposals through the ai namespace", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const rootDir = join(tempHome, ".ai");
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await mkdir(join(tempHome, ".facult", "ai"), { recursive: true });
    await Bun.write(
      join(tempHome, ".facult", "ai", "graph.json"),
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

  it("supports draft, accept, apply, reject, and supersede through the ai namespace", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const rootDir = join(tempHome, ".ai");
    const targetPath = join(rootDir, "instructions", "VERIFICATION.md");
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await mkdir(join(tempHome, ".facult", "ai"), { recursive: true });
    await Bun.write(targetPath, "# Verification\n");
    await Bun.write(
      join(tempHome, ".facult", "ai", "graph.json"),
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
    await mkdir(join(tempHome, ".facult", "ai"), { recursive: true });
    await Bun.write(targetPath, "# Testing\n");
    await Bun.write(
      join(projectRoot, ".facult", "ai", "graph.json"),
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
    await mkdir(join(rootDir, "instructions"), { recursive: true });
    await mkdir(join(tempHome, ".facult", "ai"), { recursive: true });
    await Bun.write(
      join(tempHome, ".facult", "ai", "graph.json"),
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
    await mkdir(join(tempHome, ".facult", "ai", "projects", "repo"), {
      recursive: true,
    });
    await Bun.write(
      join(tempHome, ".facult", "ai", "projects", "repo", "graph.json"),
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
