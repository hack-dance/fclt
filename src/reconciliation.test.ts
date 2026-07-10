import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  facultAiReconciliationReviewDir,
  facultAiReconciliationStatePath,
  facultAiWritebackQueuePath,
} from "./paths";
import { reconcileSources } from "./reconciliation";
import {
  initializeReconciliationConfig,
  parseReconciliationConfig,
} from "./reconciliation-config";

let tempRoot: string | null = null;

async function makeFixture(): Promise<{
  homeDir: string;
  projectRoot: string;
  rootDir: string;
}> {
  tempRoot = join(
    tmpdir(),
    "fclt-reconciliation-tests",
    `fixture-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const homeDir = join(tempRoot, "home");
  const projectRoot = join(tempRoot, "cos");
  const rootDir = join(projectRoot, ".ai");
  await mkdir(rootDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  return { homeDir, projectRoot, rootDir };
}

async function writeQueue(args: {
  homeDir: string;
  rootDir: string;
}): Promise<void> {
  const path = facultAiWritebackQueuePath(args.homeDir, args.rootDir);
  await mkdir(join(path, ".."), { recursive: true });
  const records = [
    {
      id: "WB-00020",
      ts: "2026-07-10T15:51:00.000Z",
      updatedAt: "2026-07-10T15:54:00.000Z",
      kind: "capability_gap",
      summary: "Full-window source reconciliation is missing.",
      status: "recorded",
      issueLinks: ["HACK-793"],
      disposition: "task",
      dispositionTarget: "HACK-793",
    },
    {
      id: "WB-00021",
      ts: "2026-07-10T15:52:00.000Z",
      updatedAt: "2026-07-10T15:55:00.000Z",
      kind: "bad_default",
      summary: "Unchanged heartbeat blocker prose repeats.",
      status: "recorded",
      issueLinks: ["HACK-794"],
      disposition: "resolve-watch",
      dispositionTarget: "HACK-794",
    },
    {
      id: "WB-00022",
      ts: "2026-07-10T15:53:00.000Z",
      kind: "missing_context",
      summary: "Evolution needs outcome and effectiveness links.",
      status: "recorded",
      issueLinks: ["HACK-791"],
      disposition: "resolve-watch",
      dispositionTarget: "HACK-791",
    },
    {
      id: "WB-00023",
      ts: "2026-07-10T15:54:00.000Z",
      kind: "false_positive",
      summary: "EV-00006 draft lifecycle reported a false positive.",
      status: "recorded",
      issueLinks: ["HACK-791"],
      disposition: "resolve-watch",
      dispositionTarget: "HACK-791",
    },
  ];
  await Bun.write(
    path,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
  );
}

async function runFixtureGit(args: {
  projectRoot: string;
  argv: string[];
  date?: string;
}): Promise<void> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("GIT_")) {
      env[name] = value;
    }
  }
  if (args.date) {
    env.GIT_AUTHOR_DATE = args.date;
    env.GIT_COMMITTER_DATE = args.date;
  }
  const proc = Bun.spawn({
    cmd: [Bun.which("git") ?? "/usr/bin/git", ...args.argv],
    cwd: args.projectRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr);
  }
}

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
  tempRoot = null;
});

describe("reconciliation config", () => {
  it("seeds safe automatic defaults and rejects unknown or secret-shaped config", async () => {
    const fixture = await makeFixture();
    const initialized = await initializeReconciliationConfig(fixture);
    expect(initialized.created).toBe(true);
    expect(initialized.config.sources.map((source) => source.type)).toEqual([
      "writebacks",
      "git",
    ]);

    expect(() =>
      parseReconciliationConfig({
        version: 1,
        sources: [
          {
            id: "linear",
            type: "linear",
            endpoint: "http://linear.invalid/graphql",
            token: "inline-secret",
          },
        ],
      })
    ).toThrow();
  });
});

describe("source reconciliation", () => {
  it("recovers the COS writeback cluster without ticket proposal spam and is idempotent", async () => {
    const fixture = await makeFixture();
    await writeQueue(fixture);
    const linearPath = join(
      fixture.projectRoot,
      "fixtures",
      "linear-window.json"
    );
    const markdownPath = join(
      fixture.projectRoot,
      "notes",
      "evolution-runbook.md"
    );
    await mkdir(join(fixture.projectRoot, "fixtures"), { recursive: true });
    await mkdir(join(fixture.projectRoot, "notes"), { recursive: true });
    await Bun.write(
      linearPath,
      JSON.stringify({
        issues: {
          nodes: [
            {
              id: "issue-793",
              identifier: "HACK-793",
              title: "Add automatic source reconciliation",
              description: "Implementation target for WB-00020.",
              updatedAt: "2026-07-10T16:15:45.198Z",
              state: { name: "In Progress", type: "started" },
              comments: {
                nodes: [
                  {
                    id: "comment-793",
                    body: "Preserve implementation tickets as evidence, not proposals.",
                    updatedAt: "2026-07-10T16:20:00.000Z",
                  },
                ],
              },
              history: {
                nodes: [
                  {
                    id: "history-793",
                    createdAt: "2026-07-10T16:15:45.198Z",
                    fromState: { name: "Backlog" },
                    toState: { name: "In Progress" },
                  },
                ],
              },
            },
          ],
        },
      })
    );
    await Bun.write(
      markdownPath,
      [
        "# Full-window reconciliation",
        "",
        "WB-00020 requires HACK-793 to harvest all configured sources.",
        "Never copy token=lin_api_abcdefghijklmnopqrstuvwxyz into review output.",
      ].join("\n")
    );
    const fixtureTime = new Date("2026-07-10T16:30:00.000Z");
    await utimes(markdownPath, fixtureTime, fixtureTime);
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      `${JSON.stringify(
        {
          version: 1,
          sources: [
            { id: "writebacks", type: "writebacks" },
            {
              id: "linear",
              type: "linear",
              exportPath: "fixtures/linear-window.json",
            },
            {
              id: "runbooks",
              type: "markdown",
              root: "project",
              paths: ["notes/**/*.md"],
            },
          ],
        },
        null,
        2
      )}\n`
    );

    const first = await reconcileSources({
      ...fixture,
      since: "2026-07-03T00:00:00.000Z",
      until: "2026-07-11T00:00:00.000Z",
    });
    expect(first.coverageComplete).toBe(true);
    expect(first.degraded).toBe(false);
    expect(first.evidence.flatMap((entry) => entry.writebackRefs)).toEqual(
      expect.arrayContaining(["WB-00020", "WB-00021", "WB-00022", "WB-00023"])
    );
    expect(first.linkedWork).toEqual(
      expect.arrayContaining(["HACK-791", "HACK-793", "HACK-794"])
    );
    expect(
      first.signals.some((signal) => signal.disposition === "propose")
    ).toBe(false);
    expect(
      first.decisions
        .filter((decision) => decision.included)
        .every((decision) => decision.disposition)
    ).toBe(true);
    expect(first.evidence.every((entry) => entry.isNew)).toBe(true);
    expect(JSON.stringify(first)).not.toContain(
      "lin_api_abcdefghijklmnopqrstuvwxyz"
    );

    const second = await reconcileSources({
      ...fixture,
      since: "2026-07-03T00:00:00.000Z",
      until: "2026-07-11T00:00:00.000Z",
    });
    expect(second.reviewId).toBe(first.reviewId);
    expect(second.generatedAt).toBe(first.generatedAt);
    expect(second.evidence).toEqual(first.evidence);
    const state = JSON.parse(
      await readFile(
        facultAiReconciliationStatePath(fixture.homeDir, fixture.rootDir),
        "utf8"
      )
    ) as { reviews: Record<string, unknown> };
    expect(Object.keys(state.reviews)).toEqual([first.reviewId]);
    expect(
      await Bun.file(
        join(
          facultAiReconciliationReviewDir(fixture.homeDir, fixture.rootDir),
          "latest.md"
        )
      ).exists()
    ).toBe(true);
  });

  it("reports unavailable sources as degraded instead of a false empty review", async () => {
    const fixture = await makeFixture();
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      `${JSON.stringify({
        version: 1,
        sources: [
          {
            id: "automation-runs",
            type: "automation",
            root: "home",
            paths: [".codex/automations/**/runs/*.jsonl"],
          },
        ],
      })}\n`
    );
    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03T00:00:00.000Z",
      until: "2026-07-11T00:00:00.000Z",
    });
    expect(review.coverageComplete).toBe(false);
    expect(review.degraded).toBe(true);
    expect(review.coverage[0]?.state).toBe("unavailable");
    expect(review.emptyReason).toContain("not a proven empty review");
  });

  it("deduplicates a renamed capability patch across branches and overlapping windows", async () => {
    const fixture = await makeFixture();
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["init", "--quiet"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["config", "user.email", "fixture@example.invalid"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["config", "user.name", "Fixture"],
    });
    const firstPath = join(fixture.rootDir, "instructions", "SOURCE.md");
    await mkdir(join(fixture.rootDir, "instructions"), { recursive: true });
    await Bun.write(
      firstPath,
      "# Source\n\nReconcile HACK-793 capability signal.\n"
    );
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["add", ".ai"],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["commit", "--quiet", "-m", "docs: add HACK-793 capability source"],
      date: "2026-07-04T12:00:00Z",
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: [
        "mv",
        ".ai/instructions/SOURCE.md",
        ".ai/instructions/RECONCILIATION.md",
      ],
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: [
        "commit",
        "--quiet",
        "-m",
        "docs: rename HACK-793 capability source",
      ],
      date: "2026-07-05T12:00:00Z",
    });
    await runFixtureGit({
      projectRoot: fixture.projectRoot,
      argv: ["branch", "duplicate-branch", "HEAD"],
    });
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      `${JSON.stringify({
        version: 1,
        sources: [
          {
            id: "git",
            type: "git",
            repository: "project",
            allBranches: true,
            paths: [".ai"],
          },
        ],
      })}\n`
    );

    const full = await reconcileSources({
      ...fixture,
      since: "2026-07-03T00:00:00Z",
      until: "2026-07-10T00:00:00Z",
    });
    expect(full.evidence).toHaveLength(2);
    expect(full.signals).toHaveLength(1);
    expect(full.signals[0]?.issueRefs).toEqual(["HACK-793"]);

    const overlap = await reconcileSources({
      ...fixture,
      since: "2026-07-05T00:00:00Z",
      until: "2026-07-10T00:00:00Z",
    });
    expect(overlap.evidence).toHaveLength(1);
    expect(overlap.evidence[0]?.isNew).toBe(false);
  });

  it("permits a proven empty review only after every configured source is checked", async () => {
    const fixture = await makeFixture();
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      `${JSON.stringify({
        version: 1,
        sources: [{ id: "writebacks", type: "writebacks" }],
      })}\n`
    );
    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03T00:00:00Z",
      until: "2026-07-10T00:00:00Z",
    });
    expect(review.coverageComplete).toBe(true);
    expect(review.degraded).toBe(false);
    expect(review.signals).toHaveLength(0);
    expect(review.emptyReason).toContain("every configured source was checked");
  });

  it("windows dated memory sections and prevents high-fanout ledgers from merging signals", async () => {
    const fixture = await makeFixture();
    await writeQueue(fixture);
    const memoryPath = join(
      fixture.homeDir,
      ".codex",
      "automations",
      "weekly-review",
      "memory.md"
    );
    await mkdir(join(memoryPath, ".."), { recursive: true });
    await Bun.write(
      memoryPath,
      [
        "# Memory",
        "",
        "## 2026-06-19 12:00 EDT",
        "Old capability signal HACK-700 WB-00001.",
        "",
        "## 2026-07-10 12:00 EDT",
        "Ledger links WB-00020 WB-00021 to HACK-793 HACK-794 without making them one signal.",
      ].join("\n")
    );
    await Bun.write(
      join(fixture.rootDir, "reconciliation.json"),
      `${JSON.stringify({
        version: 1,
        sources: [
          { id: "writebacks", type: "writebacks" },
          {
            id: "memory",
            type: "automation",
            root: "home",
            paths: [".codex/automations/**/memory.md"],
          },
        ],
      })}\n`
    );
    const review = await reconcileSources({
      ...fixture,
      since: "2026-07-03T00:00:00Z",
      until: "2026-07-11T00:00:00Z",
    });
    expect(
      review.coverage.find((entry) => entry.sourceId === "memory")
        ?.recordsScanned
    ).toBe(2);
    const wb20 = review.signals.find(
      (signal) =>
        signal.writebackRefs.includes("WB-00020") &&
        signal.sourceIds.includes("writebacks")
    );
    const wb21 = review.signals.find(
      (signal) =>
        signal.writebackRefs.includes("WB-00021") &&
        signal.sourceIds.includes("writebacks")
    );
    expect(wb20?.id).not.toBe(wb21?.id);
    expect(wb20?.disposition).toBe("task");
    expect(wb21?.disposition).toBe("resolve-watch");
  });
});
