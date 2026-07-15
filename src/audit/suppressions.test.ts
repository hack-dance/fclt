import { afterEach, describe, expect, it } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
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
  const base = join(tmpdir(), "fclt-audit-suppressions-tests");
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

  it("never follows a suppression-store symlink", async () => {
    tempHome = await makeTempHome();
    const storePath = join(
      tempHome,
      ".ai",
      ".facult",
      "audit",
      "suppressions.json"
    );
    const victimPath = join(tempHome, "victim.txt");
    await mkdir(join(storePath, ".."), { recursive: true });
    await writeFile(victimPath, "untouched\n");
    await symlink(victimPath, storePath);
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

    await expect(
      recordAuditSuppressions({
        homeDir: tempHome,
        selected: [{ result, finding: result.findings[0]! }],
        storePath,
      })
    ).rejects.toThrow("open failed closed");
    expect(await readFile(victimPath, "utf8")).toBe("untouched\n");
  });

  it("does not chmod a preplaced hard-linked transaction lock", async () => {
    tempHome = await makeTempHome();
    const storeDirectory = join(tempHome, ".ai", ".facult", "audit");
    const victimPath = join(tempHome, "victim.txt");
    await mkdir(storeDirectory, { recursive: true });
    await writeFile(victimPath, "untouched\n");
    await chmod(victimPath, 0o640);
    await link(victimPath, join(storeDirectory, ".suppressions.json.lock"));
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

    await expect(
      recordAuditSuppressions({
        homeDir: tempHome,
        selected: [{ result, finding: result.findings[0]! }],
      })
    ).rejects.toThrow("already active");
    expect((await stat(victimPath)).mode % 0o1000).toBe(0o640);
    expect(await readFile(victimPath, "utf8")).toBe("untouched\n");
  });

  it("rejects a replacement of the receipt-recorded ancestor before binding", async () => {
    tempHome = await makeTempHome();
    const ancestorPath = join(tempHome, ".ai", ".facult");
    const movedAncestor = join(tempHome, ".ai", ".facult-moved");
    await mkdir(ancestorPath, { recursive: true });
    const ancestor = await stat(ancestorPath);
    await rename(ancestorPath, movedAncestor);
    await mkdir(ancestorPath);
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

    await expect(
      recordAuditSuppressions({
        directoryBinding: {
          ancestorDev: String(ancestor.dev),
          ancestorIno: String(ancestor.ino),
          ancestorPath,
          directorySegments: ["audit"],
        },
        expectedPriorSha256: null,
        homeDir: tempHome,
        selected: [{ result, finding: result.findings[0]! }],
      })
    ).rejects.toThrow("root is unsafe");
    expect(
      await Bun.file(join(ancestorPath, "audit", "suppressions.json")).exists()
    ).toBe(false);
  });

  it("rejects a parent swap before the descriptor-relative commit", async () => {
    tempHome = await makeTempHome();
    const stateRoot = join(tempHome, ".ai", ".facult");
    const storeDirectory = join(stateRoot, "audit");
    const movedDirectory = join(stateRoot, "audit-moved");
    const replacementDirectory = join(stateRoot, "audit-replacement");
    const storePath = join(storeDirectory, "suppressions.json");
    await mkdir(storeDirectory, { recursive: true });
    await mkdir(replacementDirectory);
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

    await expect(
      recordAuditSuppressions({
        beforeStoreCommit: async () => {
          await rename(storeDirectory, movedDirectory);
          await rename(replacementDirectory, storeDirectory);
        },
        homeDir: tempHome,
        selected: [{ result, finding: result.findings[0]! }],
        storePath,
      })
    ).rejects.toThrow("directory changed");
    expect(
      await Bun.file(join(movedDirectory, "suppressions.json")).exists()
    ).toBe(false);
    expect(await Bun.file(storePath).exists()).toBe(false);
  });

  it("fails a concurrent writer closed and preserves both entries on retry", async () => {
    tempHome = await makeTempHome();
    let releaseFirst: (() => void) | undefined;
    let markFirstLocked: (() => void) | undefined;
    const firstLocked = new Promise<void>((resolve) => {
      markFirstLocked = resolve;
    });
    const firstMayCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const result = (item: string): AuditItemResult => ({
      item,
      type: "skill",
      path: `/tmp/${item}`,
      passed: false,
      findings: [
        {
          severity: "medium",
          ruleId: "non-https-url",
          message: "Safe in local dev",
        },
      ],
    });
    const alpha = result("alpha");
    const beta = result("beta");
    const first = recordAuditSuppressions({
      beforeStoreCommit: async () => {
        markFirstLocked?.();
        await firstMayCommit;
      },
      homeDir: tempHome,
      selected: [{ result: alpha, finding: alpha.findings[0]! }],
    });
    await firstLocked;

    await expect(
      recordAuditSuppressions({
        homeDir: tempHome,
        selected: [{ result: beta, finding: beta.findings[0]! }],
      })
    ).rejects.toThrow("already active");
    releaseFirst?.();
    await first;
    await recordAuditSuppressions({
      homeDir: tempHome,
      selected: [{ result: beta, finding: beta.findings[0]! }],
    });

    const stored = await loadAuditSuppressions(tempHome);
    expect(stored.map((entry) => entry.item).sort()).toEqual(["alpha", "beta"]);
  });
});
