import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { auditPathsOverlap, persistAuditReport } from "./report-persistence";
import { evaluateStaticAudit, runStaticAudit } from "./static";

const JSON_SUFFIX_RE = /\.json$/;

async function writeFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, contents);
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name);
      const relative = prefix ? join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
        snapshot[relative] = "directory";
        await visit(absolute, relative);
      } else if (entry.isSymbolicLink()) {
        snapshot[relative] = `symlink:${await readlink(absolute)}`;
      } else {
        snapshot[relative] = `file:${createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex")}`;
      }
    }
  }
  await visit(root, "");
  return snapshot;
}

async function fixture(): Promise<{ base: string; home: string }> {
  const base = await mkdtemp(join(tmpdir(), "fclt-audit-read-only-"));
  const home = join(base, "home");
  await writeFile(
    join(home, ".ai", "skills", "review", "SKILL.md"),
    "Review safely.\n"
  );
  await writeFile(
    join(home, ".ai", ".facult", "audit", "static-latest.json"),
    "protected report bytes\n"
  );
  await writeFile(
    join(home, ".ai", ".facult", "ai", "index.json"),
    `${JSON.stringify({ version: 1, updatedAt: "protected", skills: {} })}\n`
  );
  return { base, home };
}

async function runAuditCli(args: string[], home: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "..", "index.ts"), ...args],
    cwd: home,
    env: {
      ...process.env,
      FACULT_ROOT_DIR: join(home, ".ai"),
      HOME: home,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr, stdout };
}

async function exactReportPath(
  reportRoot: string,
  mode: "agent" | "static" = "static"
): Promise<string> {
  const fileName = (await readdir(reportRoot)).find(
    (name) => name.startsWith(`${mode}-`) && !name.endsWith(".receipt.json")
  );
  if (!fileName) {
    throw new Error(`No exact ${mode} report found`);
  }
  return join(reportRoot, fileName);
}

describe("read-only audit boundary", () => {
  it("classifies Windows-shaped overlap without prefix false positives", () => {
    expect(
      auditPathsOverlap("C:\\capability", "C:\\capability\\reports", win32)
    ).toBe(true);
    expect(
      auditPathsOverlap("C:\\capability", "C:\\capability-other", win32)
    ).toBe(false);
    expect(auditPathsOverlap("C:\\capability", "D:\\reports", win32)).toBe(
      false
    );
    expect(
      auditPathsOverlap(
        "\\\\server-a\\capability",
        "\\\\server-b\\reports",
        win32
      )
    ).toBe(false);
  });

  it("keeps library and default CLI audits byte-for-byte read-only", async () => {
    const { home } = await fixture();
    const before = await snapshotTree(home);

    await runStaticAudit({
      argv: [],
      cwd: home,
      from: [home],
      homeDir: home,
      includeConfigFrom: false,
    });
    expect(await snapshotTree(home)).toEqual(before);

    const cli = await runAuditCli(
      [
        "audit",
        "--non-interactive",
        "--no-config-from",
        "--from",
        home,
        "--json",
      ],
      home
    );
    expect(cli.exitCode).toBe(0);
    expect(cli.stderr).toBe("");
    expect(JSON.parse(cli.stdout).mode).toBe("static");
    expect(await snapshotTree(home)).toEqual(before);
  });

  it("persists deterministic JSON only to an explicit isolated report root", async () => {
    const { home } = await fixture();
    const reportRoot = await mkdtemp(join(tmpdir(), "fclt-audit-reports-"));
    const before = await snapshotTree(home);

    const cli = await runAuditCli(
      [
        "audit",
        "--non-interactive",
        "--no-config-from",
        "--from",
        home,
        "--report-root",
        reportRoot,
        "--json",
      ],
      home
    );
    expect(cli.exitCode).toBe(0);
    const report = JSON.parse(cli.stdout);
    const reportPath = await exactReportPath(reportRoot);
    expect(await readFile(reportPath, "utf8")).toBe(
      `${JSON.stringify(report, null, 2)}\n`
    );
    expect(
      await Bun.file(
        reportPath.replace(JSON_SUFFIX_RE, ".receipt.json")
      ).exists()
    ).toBe(true);
    expect(await snapshotTree(home)).toEqual(before);
  });

  it("updates generated audit annotations only in explicit mutation mode", async () => {
    const { home } = await fixture();
    const skillPath = join(home, ".ai", "skills", "review");
    const indexPath = join(home, ".ai", ".facult", "ai", "index.json");
    await writeFile(
      indexPath,
      `${JSON.stringify({
        version: 1,
        updatedAt: "protected",
        skills: {
          review: { path: skillPath, auditStatus: "pending" },
        },
        mcp: { servers: {} },
        agents: {},
        automations: {},
        snippets: {},
        instructions: {},
      })}\n`
    );

    const cli = await runAuditCli(
      [
        "audit",
        "--non-interactive",
        "--no-config-from",
        "--from",
        home,
        "--update-index",
        "--json",
      ],
      home
    );
    expect(cli.exitCode).toBe(0);
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    expect(index.skills.review.auditStatus).toBe("passed");
    expect(index.skills.review.lastAuditAt).toBe(
      JSON.parse(cli.stdout).timestamp
    );
  });

  it("rejects overlap, traversal, symlink aliases, and unresolved roots", async () => {
    const { base, home } = await fixture();
    const evaluation = await evaluateStaticAudit({
      argv: [],
      cwd: home,
      from: [home],
      homeDir: home,
      includeConfigFrom: false,
    });
    const nested = join(home, "reports");
    await mkdir(nested);

    for (const reportRoot of [home, nested, base]) {
      await expect(
        persistAuditReport({
          ...evaluation,
          mode: "static",
          reportRoot,
        })
      ).rejects.toThrow("overlaps audited source");
    }

    const outside = await mkdtemp(join(tmpdir(), "fclt-audit-outside-"));
    await expect(
      persistAuditReport({
        ...evaluation,
        mode: "static",
        reportRoot: `${outside}/child/..`,
      })
    ).rejects.toThrow("without traversal segments");

    const alias = join(base, "source-alias");
    await symlink(home, alias);
    await expect(
      persistAuditReport({
        ...evaluation,
        mode: "static",
        reportRoot: alias,
      })
    ).rejects.toThrow("must not be a symlink");

    await expect(
      persistAuditReport({
        ...evaluation,
        mode: "static",
        reportRoot: join(outside, "missing"),
      })
    ).rejects.toThrow("not fully resolvable");
  });

  it("atomically handles concurrent persistence without partial files", async () => {
    const { home } = await fixture();
    const reportRoot = await mkdtemp(join(tmpdir(), "fclt-audit-concurrent-"));
    const evaluation = await evaluateStaticAudit({
      argv: [],
      cwd: home,
      from: [home],
      homeDir: home,
      includeConfigFrom: false,
    });

    await Promise.all(
      Array.from({ length: 8 }, () =>
        persistAuditReport({
          ...evaluation,
          mode: "static",
          reportRoot,
        })
      )
    );

    expect(
      JSON.parse(await readFile(await exactReportPath(reportRoot), "utf8"))
    ).toEqual(evaluation.report);
    expect(await readdir(reportRoot)).toHaveLength(2);
  });

  it("protects external discovered Claude plugin trees", async () => {
    const { base, home } = await fixture();
    const pluginRoot = join(base, "external-plugin");
    await writeFile(
      join(pluginRoot, "skills", "review", "SKILL.md"),
      "# Review\n"
    );
    await writeFile(join(pluginRoot, "hooks", "hooks.json"), "{}\n");
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      `${JSON.stringify({ plugins: { review: [{ installPath: pluginRoot }] } })}\n`
    );
    const reportRoot = join(pluginRoot, "reports");
    await mkdir(reportRoot);
    const evaluation = await evaluateStaticAudit({
      argv: [],
      cwd: home,
      from: [home],
      homeDir: home,
      includeConfigFrom: false,
    });

    await expect(
      persistAuditReport({ ...evaluation, mode: "static", reportRoot })
    ).rejects.toThrow("overlaps audited source");
  });

  it("anchors commits to the opened directory inode during ancestor swaps", async () => {
    const { home } = await fixture();
    const parent = await mkdtemp(join(tmpdir(), "fclt-audit-race-"));
    const reportRoot = join(parent, "reports");
    const movedRoot = join(parent, "reports-moved");
    await mkdir(reportRoot);
    const evaluation = await evaluateStaticAudit({
      argv: [],
      cwd: home,
      from: [home],
      homeDir: home,
      includeConfigFrom: false,
    });

    await expect(
      persistAuditReport({
        ...evaluation,
        beforeDescriptorCommit: async () => {
          await rename(reportRoot, movedRoot);
          await mkdir(reportRoot);
        },
        mode: "static",
        reportRoot,
      })
    ).rejects.toThrow("changed during descriptor-relative commit");
    expect(await readdir(reportRoot)).toEqual([]);
    expect(await readdir(movedRoot)).toHaveLength(2);
  });

  it("leaves no report artifacts when persistence is interrupted before commit", async () => {
    const { home } = await fixture();
    const reportRoot = await mkdtemp(join(tmpdir(), "fclt-audit-interrupted-"));
    const evaluation = await evaluateStaticAudit({
      argv: [],
      cwd: home,
      from: [home],
      homeDir: home,
      includeConfigFrom: false,
    });
    await expect(
      persistAuditReport({
        ...evaluation,
        beforeDescriptorCommit: () => Promise.reject(new Error("interrupted")),
        mode: "static",
        reportRoot,
      })
    ).rejects.toThrow("interrupted");
    expect(await readdir(reportRoot)).toEqual([]);
  });

  it("does not persist a report when evaluation fails", async () => {
    const { home } = await fixture();
    const reportRoot = await mkdtemp(join(tmpdir(), "fclt-audit-failed-"));
    const rulesPath = join(home, "invalid-rules.yaml");
    await writeFile(rulesPath, "rules: [\n");

    const cli = await runAuditCli(
      [
        "audit",
        "--non-interactive",
        "--no-config-from",
        "--from",
        home,
        "--rules",
        rulesPath,
        "--report-root",
        reportRoot,
        "--json",
      ],
      home
    );
    expect(cli.exitCode).not.toBe(0);
    expect(await readdir(reportRoot)).toEqual([]);
  });
});
