import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  AUDIT_REPORT_MAX_ENVELOPE_BYTES,
  auditReportRootPermissionsAreSafe,
  loadVerifiedAuditReport,
  persistAuditReport,
} from "./report-persistence";
import { AuditSourceTracker } from "./source-provenance";

const PERSISTENCE_COLLISION_RE =
  /collision|commit failed closed|symlink|unsafe/i;
const READ_DRIFT_RE = /grew|changed while reading/;
const TIMESTAMP_SCHEMA_RE = /timestamp|provenance|schema/i;
const DIRECTORY_CHANGED_RE = /directory changed/i;
const ENVELOPE_OR_DIRECTORY_CHANGED_RE =
  /(?:envelope(?: name)?|audit report directory) changed/i;
const PERMISSION_AMBIGUOUS_RE = /permission-ambiguous/i;
const REPORT_DIRECTORY_UNSAFE_RE = /report directory is unsafe/i;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function fixture() {
  const sourceRoot = await mkdtemp(
    join(tmpdir(), "fclt-report-adversarial-source-")
  );
  const tracker = new AuditSourceTracker();
  await tracker.protect([sourceRoot]);
  const timestamp = new Date(
    Math.floor(Date.now() / 1000) * 1000
  ).toISOString();
  const report = { mode: "static" as const, results: [], timestamp };
  const reportContents = `${JSON.stringify(report, null, 2)}\n`;
  const reportFileName = `static-${createHash("sha256")
    .update(reportContents)
    .digest("hex")}.json`;
  return {
    evaluation: {
      auditedRoots: [sourceRoot],
      report,
      sourceSnapshot: tracker.snapshot(),
    },
    reportFileName,
    sourceRoot,
    timestamp,
  };
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  await chmod(path, 0o600);
}

describe("adversarial audit report persistence", () => {
  test("final-name symlinks, directories, and fifos fail closed", async () => {
    const { evaluation, reportFileName } = await fixture();
    const seedRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-seed-")
    );
    const seedReport = await persistAuditReport({
      ...evaluation,
      mode: "static",
      reportRoot: seedRoot,
    });
    const envelopeBytes = await readFile(seedReport);

    const symlinkRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-symlink-")
    );
    const externalRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-external-")
    );
    const external = join(externalRoot, "matching-bytes");
    await writeFile(external, envelopeBytes);
    await symlink(external, join(symlinkRoot, reportFileName));
    await expect(
      persistAuditReport({
        ...evaluation,
        mode: "static",
        reportRoot: symlinkRoot,
      })
    ).rejects.toThrow(PERSISTENCE_COLLISION_RE);
    expect(
      (await lstat(join(symlinkRoot, reportFileName))).isSymbolicLink()
    ).toBe(true);
    expect(await readFile(external)).toEqual(envelopeBytes);

    const directoryRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-directory-")
    );
    await mkdir(join(directoryRoot, reportFileName));
    await expect(
      persistAuditReport({
        ...evaluation,
        mode: "static",
        reportRoot: directoryRoot,
      })
    ).rejects.toThrow(PERSISTENCE_COLLISION_RE);
    expect(
      (await lstat(join(directoryRoot, reportFileName))).isDirectory()
    ).toBe(true);

    const fifoRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-fifo-")
    );
    const fifoPath = join(fifoRoot, reportFileName);
    const proc = Bun.spawn(["mkfifo", fifoPath], {
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(await proc.exited).toBe(0);
    await expect(
      persistAuditReport({
        ...evaluation,
        mode: "static",
        reportRoot: fifoRoot,
      })
    ).rejects.toThrow(PERSISTENCE_COLLISION_RE);
    expect((await lstat(fifoPath)).isFIFO()).toBe(true);
  });

  test("matching hardlinks and permission-ambiguous files never authorize reuse", async () => {
    const { evaluation, reportFileName } = await fixture();
    const seedRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-hardlink-seed-")
    );
    const seedPath = await persistAuditReport({
      ...evaluation,
      mode: "static",
      reportRoot: seedRoot,
    });
    const envelopeBytes = await readFile(seedPath);

    for (const mode of [0o600, 0o644]) {
      const reportRoot = await mkdtemp(
        join(tmpdir(), "fclt-report-adversarial-hardlink-")
      );
      const external = join(
        await mkdtemp(
          join(tmpdir(), "fclt-report-adversarial-hardlink-external-")
        ),
        "envelope"
      );
      await writeFile(external, envelopeBytes);
      await chmod(external, mode);
      await link(external, join(reportRoot, reportFileName));
      await expect(
        persistAuditReport({
          ...evaluation,
          mode: "static",
          reportRoot,
        })
      ).rejects.toThrow(PERSISTENCE_COLLISION_RE);
      expect((await lstat(external)).nlink).toBe(2);
    }

    const modeRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-mode-")
    );
    const modePath = join(modeRoot, reportFileName);
    await writeFile(modePath, envelopeBytes);
    await chmod(modePath, 0o644);
    await expect(
      persistAuditReport({
        ...evaluation,
        mode: "static",
        reportRoot: modeRoot,
      })
    ).rejects.toThrow(PERSISTENCE_COLLISION_RE);
    expect((await lstat(modePath)).mode % 0o1000).toBe(0o644);
  });

  test("permission-ambiguous report roots fail before artifact creation", async () => {
    const { evaluation } = await fixture();
    for (const mode of [0o770, 0o777]) {
      const reportRoot = await mkdtemp(
        join(tmpdir(), "fclt-report-adversarial-root-mode-")
      );
      await chmod(reportRoot, mode);
      await expect(
        persistAuditReport({
          ...evaluation,
          mode: "static",
          reportRoot,
        })
      ).rejects.toThrow("ownership or permissions are ambiguous");
      expect(await readdir(reportRoot)).toEqual([]);
    }
    expect(
      auditReportRootPermissionsAreSafe({ mode: 0o700, uid: 42 }, 41)
    ).toBe(false);
    expect(
      auditReportRootPermissionsAreSafe({ mode: 0o755, uid: 42 }, 42)
    ).toBe(true);
  });

  test("report-root open cannot follow or block on a pathname swap", async () => {
    const { evaluation } = await fixture();
    const fifoParent = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-root-open-fifo-")
    );
    const fifoRoot = join(fifoParent, "reports");
    const movedFifoRoot = join(fifoParent, "reports-moved");
    await mkdir(fifoRoot);

    const fifoAttempt = persistAuditReport({
      ...evaluation,
      beforeReportRootOpen: async () => {
        await rename(fifoRoot, movedFifoRoot);
        const proc = Bun.spawn(["mkfifo", fifoRoot], {
          stderr: "pipe",
          stdout: "pipe",
        });
        expect(await proc.exited).toBe(0);
      },
      mode: "static",
      reportRoot: fifoRoot,
    });
    await expect(
      Promise.race([
        fifoAttempt,
        Bun.sleep(1000).then(() => {
          throw new Error("report-root open blocked on a FIFO");
        }),
      ])
    ).rejects.toThrow(REPORT_DIRECTORY_UNSAFE_RE);
    expect((await lstat(fifoRoot)).isFIFO()).toBe(true);
    expect(await readdir(movedFifoRoot)).toEqual([]);

    const symlinkParent = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-root-open-symlink-")
    );
    const symlinkRoot = join(symlinkParent, "reports");
    const movedSymlinkRoot = join(symlinkParent, "reports-moved");
    const externalRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-root-open-external-")
    );
    await mkdir(symlinkRoot);
    await expect(
      persistAuditReport({
        ...evaluation,
        beforeReportRootOpen: async () => {
          await rename(symlinkRoot, movedSymlinkRoot);
          await symlink(externalRoot, symlinkRoot);
        },
        mode: "static",
        reportRoot: symlinkRoot,
      })
    ).rejects.toThrow(REPORT_DIRECTORY_UNSAFE_RE);
    expect((await lstat(symlinkRoot)).isSymbolicLink()).toBe(true);
    expect(await readdir(movedSymlinkRoot)).toEqual([]);
    expect(await readdir(externalRoot)).toEqual([]);
  });

  test("report-root rebinding and pre-commit faults create no artifact", async () => {
    const { evaluation } = await fixture();
    const parent = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-root-swap-")
    );
    const reportRoot = join(parent, "reports");
    const movedRoot = join(parent, "reports-moved");
    await mkdir(reportRoot);

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
    ).rejects.toThrow("changed before descriptor-relative commit");
    expect(await readdir(reportRoot)).toEqual([]);
    expect(await readdir(movedRoot)).toEqual([]);

    const faultRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-precommit-fault-")
    );
    await expect(
      persistAuditReport({
        ...evaluation,
        beforeDescriptorCommit: () =>
          Promise.reject(new Error("pre-commit fault")),
        mode: "static",
        reportRoot: faultRoot,
      })
    ).rejects.toThrow("pre-commit fault");
    expect(await readdir(faultRoot)).toEqual([]);
  });

  test("concurrent adoption cannot be invalidated by a faulting creator", async () => {
    const { evaluation } = await fixture();
    const reportRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-concurrent-")
    );
    let releaseFault!: () => void;
    let announceHook!: () => void;
    const hookReached = new Promise<void>((resolve) => {
      announceHook = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFault = resolve;
    });
    const faulting = persistAuditReport({
      ...evaluation,
      beforeDescriptorCommit: async () => {
        announceHook();
        await release;
        throw new Error("creator fault");
      },
      mode: "static",
      reportRoot,
    });
    await hookReached;
    const adoptedPath = await persistAuditReport({
      ...evaluation,
      mode: "static",
      reportRoot,
    });
    releaseFault();
    await expect(faulting).rejects.toThrow("creator fault");
    expect(await readdir(reportRoot)).toEqual([adoptedPath.split("/").at(-1)!]);
    await expect(
      loadVerifiedAuditReport({ reportPath: adoptedPath })
    ).resolves.toEqual(evaluation.report);
  });

  test("same-content concurrency is idempotent and source conflicts preserve the winner", async () => {
    const { evaluation } = await fixture();
    const reportRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-idempotent-")
    );
    const paths = await Promise.all(
      Array.from({ length: 8 }, () =>
        persistAuditReport({
          ...evaluation,
          mode: "static",
          reportRoot,
        })
      )
    );
    expect(new Set(paths).size).toBe(1);
    expect(await readdir(reportRoot)).toHaveLength(1);

    const other = await fixture();
    await expect(
      persistAuditReport({
        ...other.evaluation,
        mode: "static",
        report: evaluation.report,
        reportRoot,
      })
    ).rejects.toThrow("collision");
    await expect(
      loadVerifiedAuditReport({ reportPath: paths[0]! })
    ).resolves.toEqual(evaluation.report);
  });

  test("envelope validation rejects non-exact receipt contracts", async () => {
    const { evaluation } = await fixture();
    const reportRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-receipt-schema-")
    );
    const reportPath = await persistAuditReport({
      ...evaluation,
      mode: "static",
      reportRoot,
    });
    const validEnvelope = JSON.parse(
      await readFile(reportPath, "utf8")
    ) as Record<string, unknown>;
    const validReceipt = validEnvelope.receipt as Record<string, unknown>;
    const validSnapshot = validReceipt.sourceSnapshot as Record<
      string,
      unknown
    >;
    const protectedRoots = validSnapshot.protectedRoots as Record<
      string,
      unknown
    >[];
    const missingEnvelopeReport = { ...validEnvelope };
    Reflect.deleteProperty(missingEnvelopeReport, "report");
    const missingReceiptHash = { ...validReceipt };
    Reflect.deleteProperty(missingReceiptHash, "reportSha256");

    const mutations: Record<string, unknown>[] = [
      { ...validEnvelope, unexpected: true },
      missingEnvelopeReport,
      { ...validEnvelope, schemaVersion: 0 },
      { ...validEnvelope, receipt: { ...validReceipt, unexpected: true } },
      { ...validEnvelope, receipt: missingReceiptHash },
      {
        ...validEnvelope,
        receipt: {
          ...validReceipt,
          reportRevision: Number(validReceipt.reportRevision) - 1,
        },
      },
      {
        ...validEnvelope,
        receipt: {
          ...validReceipt,
          schemaVersion: Number(validReceipt.schemaVersion) - 1,
        },
      },
      {
        ...validEnvelope,
        receipt: Object.fromEntries(Object.entries(validReceipt).reverse()),
      },
      {
        ...validEnvelope,
        receipt: {
          ...validReceipt,
          sourceSnapshot: Object.fromEntries(
            Object.entries(validSnapshot).reverse()
          ),
        },
      },
      {
        ...validEnvelope,
        receipt: {
          ...validReceipt,
          sourceSnapshot: {
            ...validSnapshot,
            protectedRoots: [
              Object.fromEntries(Object.entries(protectedRoots[0]!).reverse()),
            ],
          },
        },
      },
    ];

    for (const mutation of mutations) {
      await writePrivateJson(reportPath, mutation);
      await expect(loadVerifiedAuditReport({ reportPath })).rejects.toThrow(
        "schema or revision is unsupported"
      );
    }

    const duplicateReceiptKey = `${JSON.stringify(
      validEnvelope,
      null,
      2
    ).replace(
      '"receipt": {\n    "schemaVersion": 5,',
      '"receipt": {\n    "schemaVersion": 0,\n    "schemaVersion": 5,'
    )}\n`;
    await writeFile(reportPath, duplicateReceiptKey);
    await chmod(reportPath, 0o600);
    await expect(loadVerifiedAuditReport({ reportPath })).rejects.toThrow(
      "schema or revision is unsupported"
    );
  });

  test("envelope loading rejects oversize, sparse, and growing files with bounded reads", async () => {
    const first = await fixture();
    const oversizeRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-envelope-oversize-")
    );
    const oversizePath = await persistAuditReport({
      ...first.evaluation,
      mode: "static",
      reportRoot: oversizeRoot,
    });
    await truncate(oversizePath, AUDIT_REPORT_MAX_ENVELOPE_BYTES + 1);
    await expect(
      loadVerifiedAuditReport({ reportPath: oversizePath })
    ).rejects.toThrow("private, singly linked regular file");

    const sparse = await fixture();
    const sparseRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-envelope-sparse-")
    );
    const sparsePath = await persistAuditReport({
      ...sparse.evaluation,
      mode: "static",
      reportRoot: sparseRoot,
    });
    await truncate(sparsePath, 1024 * 1024);
    await expect(
      loadVerifiedAuditReport({ reportPath: sparsePath })
    ).rejects.toThrow("private, singly linked regular file");

    const growing = await fixture();
    const growingRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-envelope-growing-")
    );
    const growingPath = await persistAuditReport({
      ...growing.evaluation,
      mode: "static",
      reportRoot: growingRoot,
    });
    let appended = false;
    await expect(
      loadVerifiedAuditReport({
        beforeEnvelopeReadChunk: async () => {
          if (!appended) {
            appended = true;
            await appendFile(growingPath, " ");
          }
        },
        reportPath: growingPath,
      })
    ).rejects.toThrow(READ_DRIFT_RE);
  });

  test("persistence and loading share the exact envelope byte boundary", async () => {
    const { evaluation } = await fixture();
    const seedRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-envelope-boundary-seed-")
    );
    const seedPath = await persistAuditReport({
      ...evaluation,
      mode: "static",
      reportRoot: seedRoot,
    });
    const seedEnvelope = JSON.parse(await readFile(seedPath, "utf8")) as {
      receipt: Record<string, unknown>;
      report: typeof evaluation.report & { padding?: string };
      schemaVersion: number;
    };
    const envelopeForPadding = (padding: string) => {
      const report = { ...seedEnvelope.report, padding };
      const reportContents = `${JSON.stringify(report, null, 2)}\n`;
      return {
        contents: `${JSON.stringify(
          {
            schemaVersion: seedEnvelope.schemaVersion,
            receipt: {
              ...seedEnvelope.receipt,
              reportSha256: createHash("sha256")
                .update(reportContents)
                .digest("hex"),
            },
            report,
          },
          null,
          2
        )}\n`,
        report,
      };
    };
    const empty = envelopeForPadding("");
    const paddingLength =
      AUDIT_REPORT_MAX_ENVELOPE_BYTES - Buffer.byteLength(empty.contents);
    expect(paddingLength).toBeGreaterThan(0);
    const exact = envelopeForPadding("x".repeat(paddingLength));
    expect(Buffer.byteLength(exact.contents)).toBe(
      AUDIT_REPORT_MAX_ENVELOPE_BYTES
    );

    const exactRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-envelope-boundary-exact-")
    );
    const exactPath = await persistAuditReport({
      ...evaluation,
      mode: "static",
      report: exact.report,
      reportRoot: exactRoot,
    });
    expect((await lstat(exactPath)).size).toBe(AUDIT_REPORT_MAX_ENVELOPE_BYTES);
    await expect(
      loadVerifiedAuditReport({ reportPath: exactPath })
    ).resolves.toEqual(exact.report);

    const overRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-envelope-boundary-over-")
    );
    await expect(
      persistAuditReport({
        ...evaluation,
        mode: "static",
        report: envelopeForPadding("x".repeat(paddingLength + 1)).report,
        reportRoot: overRoot,
      })
    ).rejects.toThrow("envelope exceeds");
    expect(await readdir(overRoot)).toEqual([]);
  });

  test("persistence rejects a parseable but noncanonical report timestamp", async () => {
    const { evaluation, timestamp } = await fixture();
    const reportRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-adversarial-report-timestamp-")
    );

    await expect(
      persistAuditReport({
        ...evaluation,
        mode: "static",
        report: {
          ...evaluation.report,
          timestamp: new Date(timestamp).toUTCString(),
        },
        reportRoot,
      })
    ).rejects.toThrow(TIMESTAMP_SCHEMA_RE);
    expect(await readdir(reportRoot)).toEqual([]);
  });

  test("writer and loader reject report placement in a derived context", async () => {
    const reportRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-derived-overlap-writer-")
    );
    const tracker = new AuditSourceTracker();
    await tracker.recordGitPathExposure(reportRoot);
    const timestamp = new Date(
      Math.floor(Date.now() / 1000) * 1000
    ).toISOString();
    await expect(
      persistAuditReport({
        auditedRoots: [],
        mode: "static",
        report: { mode: "static", results: [], timestamp },
        reportRoot,
        sourceSnapshot: tracker.snapshot(),
      })
    ).rejects.toThrow("overlaps audited source");
    expect(await readdir(reportRoot)).toEqual([]);

    const current = await fixture();
    const placedRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-derived-overlap-loader-")
    );
    const reportPath = await persistAuditReport({
      ...current.evaluation,
      mode: "static",
      reportRoot: placedRoot,
    });
    const placedTracker = new AuditSourceTracker();
    await placedTracker.recordGitPathExposure(placedRoot);
    const sourceSnapshot = placedTracker.snapshot();
    const envelope = JSON.parse(await readFile(reportPath, "utf8")) as {
      receipt: {
        sourceIdentitySha256: string;
        sourceSnapshot: unknown;
      };
    };
    envelope.receipt.sourceSnapshot = sourceSnapshot;
    envelope.receipt.sourceIdentitySha256 = createHash("sha256")
      .update(stableJson(sourceSnapshot))
      .digest("hex");
    await writePrivateJson(reportPath, envelope);

    await expect(loadVerifiedAuditReport({ reportPath })).rejects.toThrow(
      "overlaps an audited source"
    );
  });

  test("loader binds the exact parent descriptor, permissions, and final child name", async () => {
    const moved = await fixture();
    const movedRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-loader-parent-move-")
    );
    const movedPath = await persistAuditReport({
      ...moved.evaluation,
      mode: "static",
      reportRoot: movedRoot,
    });
    const movedDestination = join(moved.sourceRoot, "moved-reports");
    await expect(
      loadVerifiedAuditReport({
        beforeEnvelopeReadChunk: async () => {
          await rename(movedRoot, movedDestination);
          await mkdir(movedRoot);
        },
        reportPath: movedPath,
      })
    ).rejects.toThrow(DIRECTORY_CHANGED_RE);
    expect(await readdir(movedRoot)).toEqual([]);
    expect(await readdir(movedDestination)).toEqual([moved.reportFileName]);

    const unsafe = await fixture();
    const unsafeRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-loader-root-mode-")
    );
    const unsafePath = await persistAuditReport({
      ...unsafe.evaluation,
      mode: "static",
      reportRoot: unsafeRoot,
    });
    await chmod(unsafeRoot, 0o777);
    await expect(
      loadVerifiedAuditReport({ reportPath: unsafePath })
    ).rejects.toThrow(PERMISSION_AMBIGUOUS_RE);

    const drift = await fixture();
    const driftRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-loader-root-drift-")
    );
    const driftPath = await persistAuditReport({
      ...drift.evaluation,
      mode: "static",
      reportRoot: driftRoot,
    });
    await chmod(driftRoot, 0o755);
    await expect(
      loadVerifiedAuditReport({
        beforeEnvelopeReadChunk: async () => {
          await chmod(driftRoot, 0o700);
        },
        reportPath: driftPath,
      })
    ).rejects.toThrow(DIRECTORY_CHANGED_RE);

    const replaced = await fixture();
    const replacedRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-loader-child-replacement-")
    );
    const replacedPath = await persistAuditReport({
      ...replaced.evaluation,
      mode: "static",
      reportRoot: replacedRoot,
    });
    const originalPath = `${replacedPath}.original`;
    const exactBytes = await readFile(replacedPath);
    await expect(
      loadVerifiedAuditReport({
        beforeEnvelopeReadChunk: async () => {
          await rename(replacedPath, originalPath);
          await writeFile(replacedPath, exactBytes);
          await chmod(replacedPath, 0o600);
        },
        reportPath: replacedPath,
      })
    ).rejects.toThrow(ENVELOPE_OR_DIRECTORY_CHANGED_RE);
    expect(await readFile(originalPath)).toEqual(exactBytes);
    expect(await readFile(replacedPath)).toEqual(exactBytes);

    const linked = await fixture();
    const linkedTarget = await mkdtemp(
      join(tmpdir(), "fclt-report-loader-linked-target-")
    );
    const linkedRoot = join(linkedTarget, "reports");
    await mkdir(linkedRoot);
    const linkedBase = await mkdtemp(
      join(tmpdir(), "fclt-report-loader-linked-base-")
    );
    const linkedAlias = join(linkedBase, "alias");
    await symlink(linkedTarget, linkedAlias, "dir");
    const linkedPath = await persistAuditReport({
      ...linked.evaluation,
      mode: "static",
      reportRoot: linkedRoot,
    });
    const lexicalLinkedPath = join(
      linkedAlias,
      "reports",
      basename(linkedPath)
    );
    await expect(
      loadVerifiedAuditReport({
        beforeEnvelopeReadChunk: async () => {
          await rename(linkedAlias, `${linkedAlias}.original`);
          await symlink(linkedTarget, linkedAlias, "dir");
        },
        reportPath: lexicalLinkedPath,
      })
    ).rejects.toThrow(DIRECTORY_CHANGED_RE);

    const late = await fixture();
    const lateRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-loader-late-chunk-")
    );
    const latePath = await persistAuditReport({
      ...late.evaluation,
      mode: "static",
      report: {
        ...late.evaluation.report,
        padding: "x".repeat(128 * 1024),
      },
      reportRoot: lateRoot,
    });
    const lateMoved = join(late.sourceRoot, "late-moved-reports");
    let lateSwap = false;
    await expect(
      loadVerifiedAuditReport({
        beforeEnvelopeReadChunk: async (bytesRead) => {
          if (!lateSwap && bytesRead >= 64 * 1024) {
            lateSwap = true;
            await rename(lateRoot, lateMoved);
            await mkdir(lateRoot);
          }
        },
        reportPath: latePath,
      })
    ).rejects.toThrow(DIRECTORY_CHANGED_RE);
    expect(lateSwap).toBe(true);
  });

  test("loader revalidates the bound directory at source-validation and return hooks", async () => {
    for (const hook of ["source", "return"] as const) {
      const current = await fixture();
      const reportRoot = await mkdtemp(
        join(tmpdir(), `fclt-report-loader-${hook}-hook-`)
      );
      const reportPath = await persistAuditReport({
        ...current.evaluation,
        mode: "static",
        reportRoot,
      });
      const movedRoot = join(current.sourceRoot, `${hook}-moved-reports`);
      const mutate = async () => {
        await rename(reportRoot, movedRoot);
        await mkdir(reportRoot);
      };
      await expect(
        loadVerifiedAuditReport({
          beforeEnvelopeReturn: hook === "return" ? mutate : undefined,
          beforeSourceValidation: hook === "source" ? mutate : undefined,
          reportPath,
        })
      ).rejects.toThrow(DIRECTORY_CHANGED_RE);
      expect(await readdir(reportRoot)).toEqual([]);
      expect(await readdir(movedRoot)).toEqual([current.reportFileName]);
    }
  });

  test("writer and loader share one duplicate-finding identity rule", async () => {
    const current = await fixture();
    const finding = {
      message: "duplicate",
      ruleId: "duplicate-rule",
      severity: "high" as const,
    };
    const result = {
      findings: [finding, { ...finding }],
      item: "duplicate-item",
      passed: false,
      path: current.sourceRoot,
      type: "skill" as const,
    };
    const missingRoot = join(current.sourceRoot, "missing-report-root");
    await expect(
      persistAuditReport({
        ...current.evaluation,
        mode: "static",
        report: { ...current.evaluation.report, results: [result] },
        reportRoot: missingRoot,
      })
    ).rejects.toThrow("duplicate finding identities");

    const crossResult = {
      ...current.evaluation.report,
      results: [
        { ...result, findings: [finding] },
        { ...result, findings: [{ ...finding }] },
      ],
    };
    await expect(
      persistAuditReport({
        ...current.evaluation,
        mode: "static",
        report: crossResult,
        reportRoot: missingRoot,
      })
    ).rejects.toThrow("duplicate finding identities");

    const reordered = {
      ...current.evaluation.report,
      results: [
        {
          ...result,
          findings: [
            finding,
            { ...finding, message: "near-duplicate" },
            { ...finding },
          ],
        },
      ],
    };
    await expect(
      persistAuditReport({
        ...current.evaluation,
        mode: "static",
        report: reordered,
        reportRoot: missingRoot,
      })
    ).rejects.toThrow("duplicate finding identities");

    const nearDuplicateRoot = await mkdtemp(
      join(tmpdir(), "fclt-report-near-duplicate-")
    );
    const nearDuplicate = {
      ...current.evaluation.report,
      results: [
        {
          ...result,
          findings: [finding, { ...finding, message: "near-duplicate" }],
        },
      ],
    };
    const reportPath = await persistAuditReport({
      ...current.evaluation,
      mode: "static",
      report: nearDuplicate,
      reportRoot: nearDuplicateRoot,
    });
    await expect(loadVerifiedAuditReport({ reportPath })).resolves.toEqual(
      nearDuplicate
    );
  });
});
