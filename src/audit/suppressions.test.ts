import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  applyAuditSuppressionsToResults,
  createAuditSuppressionEntry,
  loadAuditSuppressions,
  recordAuditSuppressions,
} from "./suppressions";
import type { AuditItemResult } from "./types";

const ORIGINAL_HOME = process.env.HOME;
let tempHome: string | null = null;

async function makeTempHome(): Promise<string> {
  const base = join(process.cwd(), ".tmp-tests");
  await mkdir(base, { recursive: true });
  const dir = join(
    base,
    `audit-suppressions-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

afterEach(async () => {
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
  }
  tempHome = null;
  process.env.HOME = ORIGINAL_HOME;
});

describe("audit suppressions", () => {
  it("suppresses prefixed combined-view findings against future raw audit results", () => {
    const result: AuditItemResult = {
      item: "alpha",
      type: "skill",
      path: "/tmp/alpha",
      passed: false,
      findings: [
        {
          severity: "high",
          ruleId: "credential-access",
          message: "Possible credential access instruction",
          location: "SKILL.md:12",
        },
      ],
    };

    const suppression = createAuditSuppressionEntry({
      result: {
        ...result,
        findings: [
          {
            ...result.findings[0]!,
            ruleId: "static:credential-access",
          },
        ],
      },
      finding: {
        ...result.findings[0]!,
        ruleId: "static:credential-access",
      },
    });

    const next = applyAuditSuppressionsToResults({
      results: [result],
      suppressions: [suppression],
    });

    expect(next[0]?.findings).toHaveLength(0);
    expect(next[0]?.passed).toBe(true);
  });

  it("records suppressions once and preserves an optional note", async () => {
    tempHome = await makeTempHome();
    process.env.HOME = tempHome;

    const result: AuditItemResult = {
      item: "alpha",
      type: "skill",
      path: "/tmp/alpha",
      passed: false,
      findings: [
        {
          severity: "medium",
          ruleId: "non-https-url",
          message: "Safe in local dev",
        },
      ],
    };

    const selected = [
      {
        result,
        finding: result.findings[0]!,
      },
    ];

    const first = await recordAuditSuppressions({
      homeDir: tempHome,
      selected,
      note: "Local-only test fixture",
    });
    const second = await recordAuditSuppressions({
      homeDir: tempHome,
      selected,
      note: "Local-only test fixture",
    });

    const stored = await loadAuditSuppressions(tempHome);
    expect(first.added).toBe(1);
    expect(second.added).toBe(0);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.note).toBe("Local-only test fixture");
  });
});
