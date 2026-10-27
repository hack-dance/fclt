import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { aiCommand } from "./ai";
import { facultAiWritebackQueuePath, preferredGlobalAiRoot } from "./paths";
import { reconcileSources } from "./reconciliation";

let tempHome: string | null = null;
const originalHome = process.env.HOME;
const originalRoot = process.env.FACULT_ROOT_DIR;
const originalRootScope = process.env.FACULT_ROOT_SCOPE;
const originalLocalState = process.env.FACULT_LOCAL_STATE_DIR;
const originalCwd = process.cwd();

async function makeTempHome(): Promise<string> {
  const dir = join(
    tmpdir(),
    "fclt-ai-evolve-malformed-tests",
    `ai-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

async function seedMalformedWritebacks(
  home: string,
  rootDir: string,
  evidence: unknown
) {
  const record = {
    ts: "2026-10-01T00:00:00.000Z",
    scope: "global",
    kind: "weak_verification",
    summary: "Verification guidance needs another check.",
    confidence: "medium",
    source: "test",
    suggestedDestination: "@ai/instructions/VERIFICATION.md",
    status: "recorded",
    tags: [],
    evidence: [{ type: "session", ref: "regression" }],
  };
  const missing = {
    ...record,
    id: "WB-00001",
    evidence: undefined,
    tags: undefined,
    issueLinks: {},
  };
  const rows = [
    missing,
    missing,
    { ...record, id: "WB-00002", evidence },
    { ...record, id: "WB-00003", evidence: undefined },
    { ...record, id: "WB-00003" },
    { ...record, id: "WB-00004" },
    { ...record, id: "WB-00005", evidence: [] },
  ];
  const path = facultAiWritebackQueuePath(home, rootDir);
  await mkdir(dirname(path), { recursive: true });
  const contents = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  await Bun.write(path, contents);
  return { path, contents };
}

async function captureConsole(fn: () => Promise<void>) {
  const logs: string[] = [];
  const errors: string[] = [];
  const prevLog = console.log;
  const prevError = console.error;
  const prevWrite = process.stdout.write;
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void
  ) => {
    logs.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
    );
    const done =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return true;
  }) as typeof process.stdout.write;
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
    process.stdout.write = prevWrite;
  }
  return { logs, errors };
}

afterEach(async () => {
  process.chdir(originalCwd);
  for (const [key, value] of Object.entries({
    HOME: originalHome,
    FACULT_ROOT_DIR: originalRoot,
    FACULT_ROOT_SCOPE: originalRootScope,
    FACULT_LOCAL_STATE_DIR: originalLocalState,
  })) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  process.exitCode = 0;
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
  }
  tempHome = null;
});

describe("malformed evolution writebacks", () => {
  it.each([
    null,
    "invalid",
    42,
    false,
    {},
  ])("assesses good entries and warns once per malformed entry with evidence %j", async (evidence) => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const rootDir = preferredGlobalAiRoot(tempHome);
    process.env.FACULT_ROOT_DIR = rootDir;
    process.env.FACULT_LOCAL_STATE_DIR = join(tempHome, "state");
    process.chdir(tempHome);
    const queue = await seedMalformedWritebacks(tempHome, rootDir, evidence);

    const out = await captureConsole(() =>
      aiCommand(["evolve", "assess", "--json"])
    );

    expect(process.exitCode ?? 0).toBe(0);
    const assessment = JSON.parse(out.logs.join("\n"));
    expect(out.errors).toEqual(
      assessment.warnings.map((warning: string) => `Warning: ${warning}`)
    );
    expect(assessment.warnings[0]).toContain("evidence, tags, issueLinks");
    expect(assessment).toMatchObject({
      recommendation: "propose",
      writebackCount: 2,
      evidenceCount: 2,
      sourceWritebacks: ["WB-00003", "WB-00004"],
      warnings: [
        expect.stringContaining("WB-00001"),
        expect.stringContaining("WB-00002"),
      ],
    });
    expect(await Bun.file(queue.path).text()).toBe(queue.contents);
  });

  it.each(
    [
      ["evolve", "assess"],
      ["evolve", "propose", "--json"],
      ["writeback", "group", "--json"],
      ["writeback", "show", "WB-00001", "--json"],
      ["writeback", "link", "WB-00001", "--issue", "issue:123", "--json"],
      ["writeback", "dismiss", "WB-00001", "--json"],
    ].map((command) => ({ command }))
  )("keeps sibling command $command working with malformed writeback arrays", async ({
    command,
  }) => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const rootDir = preferredGlobalAiRoot(tempHome);
    process.env.FACULT_ROOT_DIR = rootDir;
    process.env.FACULT_LOCAL_STATE_DIR = join(tempHome, "state");
    process.chdir(tempHome);
    await seedMalformedWritebacks(tempHome, rootDir, {});

    const out = await captureConsole(() => aiCommand(command));

    expect(process.exitCode ?? 0).toBe(0);
    expect(out.errors).toEqual([
      expect.stringContaining("WB-00001"),
      expect.stringContaining("WB-00002"),
    ]);
    if (command[1] === "assess") {
      expect(out.logs.join("\n")).toContain(
        "writebacks: 2 (WB-00003, WB-00004)"
      );
    } else if (command[1] === "propose") {
      expect(JSON.parse(out.logs.join("\n"))).toEqual([
        expect.objectContaining({ sourceWritebacks: ["WB-00003", "WB-00004"] }),
      ]);
    } else if (command[1] !== "group") {
      expect(JSON.parse(out.logs.join("\n"))).toMatchObject({
        id: "WB-00001",
        evidence: [],
        tags: [],
      });
    }
  });

  it("reconciles malformed writeback arrays without losing good evidence", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;
    const rootDir = preferredGlobalAiRoot(tempHome);
    process.env.FACULT_ROOT_DIR = rootDir;
    process.env.FACULT_LOCAL_STATE_DIR = join(tempHome, "state");
    process.chdir(tempHome);
    const fixture = { homeDir: tempHome, rootDir };
    await mkdir(rootDir, { recursive: true });
    const queuePath = facultAiWritebackQueuePath(
      fixture.homeDir,
      fixture.rootDir
    );
    await mkdir(dirname(queuePath), { recursive: true });
    const base = {
      ts: "2026-07-10T12:00:00Z",
      summary: "Verification capability needs evidence.",
      tags: [],
    };
    const contents = [
      { ...base, id: "WB-00001" },
      { ...base, id: "WB-00002", evidence: {}, issueLinks: false },
      { ...base, id: "WB-00003", evidence: [{ ref: "TICKET-123" }] },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    await Bun.write(queuePath, contents);
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "writebacks", type: "writebacks" }],
      })
    );
    const warnings = spyOn(console, "error").mockImplementation(
      () => undefined
    );
    try {
      const review = await reconcileSources({
        ...fixture,
        since: "2026-07-10T00:00:00Z",
        until: "2026-07-11T00:00:00Z",
      });
      expect(review.coverageComplete).toBe(true);
      expect(review.evidence).toHaveLength(3);
      expect(review.evidence.flatMap((entry) => entry.issueRefs)).toContain(
        "TICKET-123"
      );
      expect(warnings.mock.calls).toEqual([
        [expect.stringContaining("WB-00001")],
        [expect.stringContaining("WB-00002")],
      ]);
      expect(await Bun.file(queuePath).text()).toBe(contents);
    } finally {
      warnings.mockRestore();
    }
  });
});
