import { describe, expect, it } from "bun:test";
import {
  buildActivityFeed,
  redactPortableActivityText,
  renderActivityFeed,
} from "./activity";
import type { AiWritebackRecord } from "./ai";
import type { EvolutionLoopReport, LoopQueueItem } from "./evolution-loop";
import type { ReconciliationReview } from "./reconciliation-types";

function queueItem(overrides?: Partial<LoopQueueItem>): LoopQueueItem {
  return {
    id: "family:SF-stable",
    kind: "signal",
    title: "Setup repeatedly loses project context",
    state: "open",
    revision: 1,
    firstSeenAt: "2026-07-13T00:00:00.000Z",
    lastSeenAt: "2026-07-13T00:00:00.000Z",
    lastChangedAt: "2026-07-13T00:00:00.000Z",
    disposition: "task",
    familyId: "SF-stable",
    linkedWork: ["TASK-1"],
    approvalRequired: false,
    sourceIds: ["git-history", "writebacks"],
    evidenceRefs: ["evidence-1", "evidence-2"],
    ...overrides,
  };
}

function report(overrides?: Partial<EvolutionLoopReport>): EvolutionLoopReport {
  return {
    version: 1,
    runId: "LR-stable",
    generatedAt: "2026-07-13T00:00:00.000Z",
    scope: "project",
    projectRoot: "/Users/example/private/repo",
    status: "complete",
    trigger: "scheduled",
    generationBefore: 1,
    generationAfter: 2,
    reviewId: "RW-stable",
    coverage: [
      {
        sourceId: "git-history",
        sourceType: "git",
        state: "checked",
        checkedAt: "2026-07-13T00:00:00.000Z",
        recordsScanned: 2,
        signalsDiscovered: 1,
      },
    ],
    coverageComplete: true,
    queue: [queueItem()],
    delta: {
      new: ["family:SF-stable"],
      changed: [],
      resolved: [],
      notifiable: ["family:SF-stable"],
      unchangedSuppressed: 0,
    },
    mutations: [],
    attempts: [{ attempt: 1, ok: true }],
    artifactPath: "/Users/example/.ai/evolution/LR-stable.md",
    auditPath: "/Users/example/Library/Application Support/fclt/audit.jsonl",
    ...overrides,
  };
}

function review(): ReconciliationReview {
  return {
    version: 1,
    reviewId: "RW-stable",
    generatedAt: "2026-07-13T00:00:00.000Z",
    window: {
      id: "RW-stable",
      mode: "incremental",
      since: "2026-07-12T00:00:00.000Z",
      until: "2026-07-13T00:00:00.000Z",
      scope: "project",
      rootDir: "/Users/example/private/repo/.ai",
      projectRoot: "/Users/example/private/repo",
      configDigest: "digest",
    },
    coverageComplete: true,
    degraded: false,
    coverage: report().coverage,
    decisions: [],
    evidence: [],
    signals: [
      {
        id: "SIG-1",
        familyId: "SF-stable",
        subjectKeys: ["setup"],
        title: "Setup repeatedly loses project context",
        evidenceKeys: ["evidence-1", "evidence-2"],
        sourceIds: ["git-history", "writebacks"],
        classifications: ["capability-source"],
        assetRefs: ["@project/instructions/SETUP.md"],
        issueRefs: ["TASK-1"],
        writebackRefs: ["WB-00002", "WB-00001"],
        disposition: "task",
        dispositionTarget: "TASK-1",
        rationale: "Repeated evidence points to one project setup gap.",
        unresolved: true,
      },
    ],
    resolvedEvidenceKeys: [],
    unresolvedSignals: ["SIG-1"],
    linkedWork: ["TASK-1"],
    dispositionCounts: {
      propose: 0,
      "apply-local": 0,
      task: 1,
      "resolve-watch": 0,
      defer: 0,
    },
    artifactPath: "/Users/example/.ai/evolution/RW-stable.md",
  };
}

function writeback(
  id: string,
  sensitivity: "public" | "internal" | "private"
): AiWritebackRecord {
  return {
    id,
    ts: `2026-07-13T00:00:0${id.endsWith("1") ? "1" : "2"}.000Z`,
    scope: "project",
    kind: id.endsWith("1") ? "tool_friction" : "reusable_pattern",
    summary: id.endsWith("1")
      ? "Setup command lost project context."
      : "A scoped setup check prevented recurrence.",
    capture: {
      category: id.endsWith("1") ? "friction" : "reusable-success",
      details: "Supplemental detail",
      impact: "Agents had to repeat setup",
      desiredOutcome: "Project context remains available",
      sensitivity,
    },
    evidence: [{ type: "test", ref: id }],
    confidence: "high",
    source: "facult:manual",
    tags: [],
    status: "recorded",
  };
}

describe("activity feed", () => {
  it("produces a deterministic portable snapshot with bounded privacy-aware observations", () => {
    const feed = buildActivityFeed({
      report: report(),
      review: review(),
      writebacks: [
        writeback("WB-00002", "private"),
        writeback("WB-00001", "internal"),
      ],
      proposals: [],
    });

    expect(feed).toMatchObject({
      version: 1,
      mode: "latest",
      snapshot: "embedded",
      project: { key: "repo", name: "repo" },
      counts: { new: 1, needsAttention: 1 },
    });
    expect(feed.items[0]?.categories).toEqual(["friction", "reusable-success"]);
    expect(
      feed.items[0]?.observations.map((entry) => entry.writebackId)
    ).toEqual(["WB-00001", "WB-00002"]);
    expect(feed.items[0]?.observations[1]).toMatchObject({
      sensitivity: "private",
      contextOmitted: true,
    });
    expect(feed.items[0]?.observations[1]?.details).toBeUndefined();
    expect(JSON.stringify(feed)).not.toContain("/Users/");
    expect(renderActivityFeed(feed)).toContain("Needs attention");
  });

  it("never describes a failed empty run as checked and clear", () => {
    const failed = buildActivityFeed({
      report: report({
        status: "failed",
        coverage: [],
        coverageComplete: false,
        queue: [],
        delta: {
          new: [],
          changed: [],
          resolved: [],
          notifiable: [],
          unchangedSuppressed: 0,
        },
      }),
      review: null,
      writebacks: [],
      proposals: [],
    });

    expect(renderActivityFeed(failed)).toContain(
      "did not prove complete coverage"
    );
    expect(renderActivityFeed(failed)).not.toContain(
      "configured coverage was checked"
    );
  });

  it("scrubs credentials and absolute paths from every portable text source", () => {
    const unixPath = "/Users/example/private/repo";
    const windowsPath = String.raw`C:\Users\example\private\repo`;
    const uncPath = String.raw`\\server\share\private\repo`;
    const basicCredential = ["dXNlcjpw", "YXNz"].join("");
    const awsAccessKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const jwt = [
      "eyJhbGciOiJIUzI1NiJ9",
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
      "signaturevalue",
    ].join(".");
    const unsafeReview = review();
    unsafeReview.signals[0] = {
      ...unsafeReview.signals[0]!,
      rationale: `Observed at ${unixPath}; Authorization: Basic ${basicCredential}`,
      dispositionTarget: windowsPath,
    };
    const unsafeWriteback = writeback("WB-00001", "internal");
    unsafeWriteback.summary = `Failure at ${unixPath} using ${awsAccessKey}`;
    unsafeWriteback.capture = {
      ...unsafeWriteback.capture!,
      details: `Compared ${windowsPath} and ${uncPath}`,
      impact: "Could not read ~/private/config",
      attemptedWorkaround: "Opened file:///Users/example/private/repo/config",
      desiredOutcome: `No path from ${unixPath}; JWT ${jwt}`,
    };
    const unsafeReport = report({
      coverage: [
        {
          ...report().coverage[0]!,
          sourceId: unixPath,
          state: "unavailable",
          unavailableReason: `Could not read ${windowsPath}`,
        },
      ],
      coverageComplete: false,
      queue: [
        queueItem({
          title: `Setup failed at ${unixPath}`,
          sourceIds: [unixPath],
          linkedWork: [uncPath],
        }),
      ],
    });

    const feed = buildActivityFeed({
      report: unsafeReport,
      review: unsafeReview,
      writebacks: [unsafeWriteback],
      proposals: [],
    });
    const portable = JSON.stringify(feed);

    for (const secret of [
      unixPath,
      windowsPath,
      uncPath,
      "~/private/config",
      "file:///Users/example/private/repo/config",
      basicCredential,
      awsAccessKey,
      jwt,
    ]) {
      expect(portable).not.toContain(secret);
    }
    expect(portable).toContain("<redacted-path>");
    expect(portable).toContain("<redacted>");
    expect(redactPortableActivityText(`Authorization: Bearer ${jwt}`)).toBe(
      "Authorization: <redacted>"
    );
    expect(redactPortableActivityText("Authorization: Bearer abc~def")).toBe(
      "Authorization: <redacted>"
    );
    const partialPrivateKey = [
      "-----BEGIN PRIVATE KEY-----",
      "c2Vuc2l0aXZlLWtleS1tYXRlcmlhbA==",
    ].join("\n");
    expect(
      redactPortableActivityText(`Captured key: ${partialPrivateKey}`)
    ).toBe("Captured key: <redacted-private-key>");
    for (const path of ["/etc/passwd", "/usr/bin", "/repo/config", "/secret"]) {
      expect(redactPortableActivityText(`Failure at ${path}`)).toBe(
        "Failure at <redacted-path>"
      );
    }
    for (const fileUrl of [
      "file:///Users/example/private.log",
      "file://localhost/Users/example/private.log",
      "file://server/share/private.log",
    ]) {
      expect(redactPortableActivityText(`Failure at ${fileUrl}`)).toBe(
        "Failure at file:///<redacted-path>"
      );
    }
    for (const url of [
      "https://example.com/docs",
      "https://example.com:8443/a/b?next=/guides/setup/install#fragment",
    ]) {
      expect(redactPortableActivityText(`keep ${url}`)).toBe(`keep ${url}`);
    }
    for (const [unsafeUrl, expectedUrl] of [
      [
        "https://logs.example/run?file=/Users/example/repo/.env",
        "https://logs.example/run?file=<redacted-path>",
      ],
      [
        "https://logs.example/run?file=%2FUsers%2Fexample%2Frepo%2F.env",
        "https://logs.example/run?file=<redacted-path>",
      ],
      [
        "https://logs.example/run?note=/Users/example/repo/.env",
        "https://logs.example/run?note=<redacted-path>",
      ],
      [
        "https://logs.example/run#/Users/example/repo/.env",
        "https://logs.example/run#<redacted-path>",
      ],
    ]) {
      expect(redactPortableActivityText(`scrub ${unsafeUrl}`)).toBe(
        `scrub ${expectedUrl}`
      );
    }
  });
});
