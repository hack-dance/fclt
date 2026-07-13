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
    expect(feed.items[0]?.context).toMatchObject({
      scope: "project",
      project: { key: "repo", name: "repo" },
      targets: [
        {
          kind: "instruction",
          scope: "project",
          selector: "@project/instructions/SETUP.md",
          label: "SETUP",
        },
      ],
    });
    expect(JSON.stringify(feed)).not.toContain("/Users/");
    expect(renderActivityFeed(feed)).toContain(
      "Target: instruction · SETUP (@project/instructions/SETUP.md)"
    );
    expect(renderActivityFeed(feed)).toContain(
      "Why: Repeated evidence points to one project setup gap."
    );
  });

  it("shows only portable capability targets and source-owned links", () => {
    const linkedReview = review();
    linkedReview.evidence = [
      {
        dedupeKey: "evidence-1",
        sourceIds: ["tracker-export"],
        sourceRecordIds: ["event-1"],
        observedAt: "2026-07-13T00:00:00.000Z",
        title: "Scoped source event",
        body: "Evidence",
        classification: "capability-source",
        assetRefs: ["skill:capability-evolution"],
        issueRefs: [],
        writebackRefs: ["WB-00001"],
        correlationKeys: ["asset:skill:capability-evolution"],
        disposition: "propose",
        isNew: true,
        provenance: [
          {
            sourceUri:
              "https://example.com/work/123?path=/Users/example/private/repo",
          },
          { sourceUri: "https://example.com/work/123" },
          {
            sourceUri:
              "https://logs.example/%2FUsers%2Fexample%2Fprivate%2Frepo",
          },
          {
            sourceUri:
              "https://logs.example/%252FUsers%252Fexample%252Fprivate%252Frepo",
          },
          {
            sourceUri: "https://logs.example/Users/example/private/repo",
          },
          {
            sourceUri: "https://logs.example/C:/Users/example/private/repo",
          },
        ],
      },
      {
        dedupeKey: "evidence-2",
        sourceIds: ["writebacks"],
        sourceRecordIds: ["WB-00002"],
        observedAt: "2026-07-13T00:00:00.000Z",
        title: "Private source event",
        body: "Private evidence",
        classification: "capability-source",
        assetRefs: [],
        issueRefs: [],
        writebackRefs: ["WB-00002"],
        correlationKeys: ["asset:skill:capability-evolution"],
        disposition: "propose",
        isNew: true,
        provenance: [{ sourceUri: "https://example.com/private/source-event" }],
      },
    ];
    linkedReview.signals[0] = {
      ...linkedReview.signals[0]!,
      assetRefs: [
        "skill:capability-evolution",
        "@project/prompts/review.md",
        "@project/instructions/SETUP.md?token=target-secret",
        "@project/%2FUsers%2Fexample%2Fprivate%2Fplan.md",
        "skill:%252FUsers%252Fexample%252Fprivate",
        "/Users/example/private/repo/.ai/skills/private/SKILL.md",
        "TASK-1",
      ],
    };
    const linkedWriteback = writeback("WB-00001", "internal");
    linkedWriteback.evidence = [
      { type: "review", ref: "https://example.com/work/123" },
      { type: "secret", ref: "https://user:pass@example.com/private" },
      { type: "token", ref: "https://example.com/private?token=secret" },
      {
        type: "signed",
        ref: "https://storage.example/object?X-Goog-Signature=credential",
      },
      { type: "local", ref: "file:///Users/example/private/repo/report.md" },
    ];
    const privateWriteback = writeback("WB-00002", "private");
    privateWriteback.evidence = [
      { type: "private", ref: "https://example.com/private/writeback" },
    ];

    const feed = buildActivityFeed({
      report: report(),
      review: linkedReview,
      writebacks: [linkedWriteback, privateWriteback],
      proposals: [],
    });

    expect(feed.items[0]?.context?.targets).toEqual([
      {
        kind: "skill",
        scope: "project",
        selector: "skill:capability-evolution",
        label: "capability evolution",
      },
      {
        kind: "prompt",
        scope: "project",
        selector: "@project/prompts/review.md",
        label: "review",
      },
    ]);
    expect(feed.items[0]?.context?.links).toEqual([
      {
        label: "example.com",
        url: "https://example.com/work/123",
        source: "evidence",
      },
    ]);
    const portable = JSON.stringify(feed);
    expect(portable).not.toContain("/Users/example/private");
    expect(portable).not.toContain("file://");
    expect(portable).not.toContain("user:pass");
    expect(portable).not.toContain("token=secret");
    expect(portable).not.toContain("target-secret");
    expect(portable).not.toContain("%2FUsers");
    expect(portable).not.toContain("%252FUsers");
    expect(portable).not.toContain("X-Goog-Signature");
    expect(portable).not.toContain("private/source-event");
    expect(portable).not.toContain("private/writeback");
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
    const signedUrl =
      "https://storage.example/object?X-Amz-Signature=signed-value&X-Amz-Expires=900";
    const unsafeReview = review();
    unsafeReview.signals[0] = {
      ...unsafeReview.signals[0]!,
      rationale: `Observed at ${unixPath}; Authorization: Basic ${basicCredential}`,
      dispositionTarget: windowsPath,
    };
    const unsafeWriteback = writeback("WB-00001", "internal");
    unsafeWriteback.summary = `Failure at ${unixPath} using ${awsAccessKey}; log ${signedUrl}`;
    unsafeWriteback.capture = {
      ...unsafeWriteback.capture!,
      details: `Compared ${windowsPath} and ${uncPath}; source ${signedUrl}`,
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
          unavailableReason: `Could not read ${windowsPath}; source ${signedUrl}`,
        },
      ],
      coverageComplete: false,
      queue: [
        queueItem({
          title: `Setup failed at ${unixPath}; source ${signedUrl}`,
          sourceIds: [unixPath],
          linkedWork: [uncPath, signedUrl],
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
      "X-Amz-Signature",
      "signed-value",
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
    const encryptedPrivateKey = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "Proc-Type: 4,ENCRYPTED",
      "DEK-Info: AES-256-CBC,0123456789ABCDEF",
      "",
      "c2Vuc2l0aXZlLWVuY3J5cHRlZC1rZXktbWF0ZXJpYWw=",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    expect(
      redactPortableActivityText(`Captured key: ${encryptedPrivateKey}`)
    ).toBe("Captured key: <redacted-private-key>");
    const truncatedEncryptedPrivateKey = encryptedPrivateKey
      .replace("-----END RSA PRIVATE KEY-----", "")
      .concat("\nSafe context");
    expect(
      redactPortableActivityText(
        `Captured key: ${truncatedEncryptedPrivateKey}`
      )
    ).toBe("Captured key: <redacted-private-key>\n\nSafe context");
    const emptyHeaderPrivateKey = [
      "-----BEGIN PRIVATE KEY-----",
      "",
      "c2Vuc2l0aXZlLWtleS1tYXRlcmlhbA==",
      "",
      "Safe context",
    ].join("\n");
    expect(
      redactPortableActivityText(`Captured key: ${emptyHeaderPrivateKey}`)
    ).toBe("Captured key: <redacted-private-key>\n\nSafe context");
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
    for (const url of ["https://example.com/docs"]) {
      expect(redactPortableActivityText(`keep ${url}`)).toBe(`keep ${url}`);
    }
    expect(
      redactPortableActivityText(
        "keep https://example.com:8443/a/b?next=/guides/setup/install#fragment"
      )
    ).toBe("keep https://example.com:8443/a/b");
    for (const [unsafeUrl, expectedUrl] of [
      [
        "https://logs.example/run?file=/Users/example/repo/.env",
        "https://logs.example/run",
      ],
      [
        "https://logs.example/run?file=%2FUsers%2Fexample%2Frepo%2F.env",
        "https://logs.example/run",
      ],
      [
        "https://logs.example/run?note=/Users/example/repo/.env",
        "https://logs.example/run",
      ],
      [
        "https://logs.example/run?note=file:///Users/example/repo/.env",
        "https://logs.example/run",
      ],
      [
        "https://logs.example/run?note=C%3A%5CUsers%5Cexample%5Crepo%5C.env",
        "https://logs.example/run",
      ],
      [
        "https://logs.example/run?note=%5C%5Cserver%5Cshare%5Cprivate.log",
        "https://logs.example/run",
      ],
      [
        "https://logs.example/run?note=~%2Fprivate%2Fconfig",
        "https://logs.example/run",
      ],
      [
        "https://logs.example/run#/Users/example/repo/.env",
        "https://logs.example/run",
      ],
    ]) {
      expect(redactPortableActivityText(`scrub ${unsafeUrl}`)).toBe(
        `scrub ${expectedUrl}`
      );
    }
  });
});
