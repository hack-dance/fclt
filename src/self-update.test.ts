import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixtureGit } from "../test/git-fixture";
import {
  assessSelfUpdateDoctorPostflight,
  buildCommandLookupFallback,
  buildPackageManagerUpdateCommand,
  buildSelfUpdateDoctorCommand,
  detectInstallMethod,
  formatSelfUpdateCommand,
  formatSelfUpdateLegacyRecovery,
  looksLikeMiseNpmFacultExecutableForVersion,
  looksLikeMiseShim,
  normalizeVersionTag,
  parseSelfUpdateArgs,
  parseSelfUpdateLegacyRecovery,
  runSelfUpdateDoctorPostflight,
  stripTagPrefix,
} from "./self-update";

describe("parseSelfUpdateArgs", () => {
  it("parses dry-run and explicit version", () => {
    const parsed = parseSelfUpdateArgs(["--dry-run", "--version", "1.2.3"]);
    expect(parsed).toEqual({ dryRun: true, requestedVersion: "1.2.3" });
  });

  it("parses inline --version value", () => {
    const parsed = parseSelfUpdateArgs(["--version=v2.0.0"]);
    expect(parsed).toEqual({ dryRun: false, requestedVersion: "v2.0.0" });
  });

  it("rejects unknown args", () => {
    expect(() => parseSelfUpdateArgs(["--wat"])).toThrow(
      "Unknown option: --wat"
    );
  });
});

describe("version helpers", () => {
  it("normalizes version tags", () => {
    expect(normalizeVersionTag("latest")).toBeNull();
    expect(normalizeVersionTag("1.0.0")).toBe("v1.0.0");
    expect(normalizeVersionTag("v1.0.0")).toBe("v1.0.0");
  });

  it("strips leading v from tags", () => {
    expect(stripTagPrefix("v3.4.5")).toBe("3.4.5");
    expect(stripTagPrefix("3.4.5")).toBe("3.4.5");
  });
});

describe("detectInstallMethod", () => {
  it("uses env override when set", () => {
    const method = detectInstallMethod(null, {
      envInstallMethod: "script-bin",
    });
    expect(method).toBe("script-bin");
  });

  it("uses persisted install state method", () => {
    const method = detectInstallMethod({
      version: 1,
      method: "release-script",
    });
    expect(method).toBe("release-script");
  });

  it("infers release-script from ~/.ai/.facult/bin executable path", () => {
    const method = detectInstallMethod(null, {
      homeDir: "/tmp/test-home",
      executablePath: "/tmp/test-home/.ai/.facult/bin/fclt",
    });
    expect(method).toBe("release-script");
  });

  it("infers mise npm install from active npm-facult executable before stale state", () => {
    const method = detectInstallMethod(
      {
        version: 1,
        method: "npm-binary-cache",
      },
      {
        homeDir: "/tmp/test-home",
        executablePath:
          "/tmp/test-home/.local/share/mise/installs/npm-facult/2.13.1/bin/fclt",
      }
    );
    expect(method).toBe("mise-npm");
  });

  it("falls back to unknown when no signal is present", () => {
    const method = detectInstallMethod(null, {
      homeDir: "/tmp/test-home",
      executablePath: "/usr/local/bin/node",
    });
    expect(method).toBe("unknown");
  });
});

describe("buildPackageManagerUpdateCommand", () => {
  it("pins npm-facult through mise for mise-managed installs", () => {
    expect(
      buildPackageManagerUpdateCommand({
        packageManager: "mise",
        version: "2.13.2",
      })
    ).toEqual(["mise", "use", "-g", "--pin", "npm:facult@2.13.2"]);
  });
});

describe("looksLikeMiseShim", () => {
  it("recognizes a mise fclt shim path", () => {
    expect(looksLikeMiseShim("/Users/test/.local/share/mise/shims/fclt")).toBe(
      true
    );
    expect(looksLikeMiseShim("/usr/local/bin/fclt")).toBe(false);
  });
});

describe("command lookup fallback", () => {
  it("uses a portable Windows lookup command", () => {
    expect(buildCommandLookupFallback("fclt", "win32")).toEqual([
      "where.exe",
      "fclt",
    ]);
  });

  it("uses command -v on POSIX platforms", () => {
    expect(buildCommandLookupFallback("fclt", "darwin")).toEqual([
      "sh",
      "-lc",
      "command -v 'fclt'",
    ]);
  });
});

describe("mise version helpers", () => {
  it("matches a concrete npm-facult mise install version", () => {
    expect(
      looksLikeMiseNpmFacultExecutableForVersion(
        "/Users/test/.local/share/mise/installs/npm-facult/2.17.4/bin/fclt",
        "2.17.4"
      )
    ).toBe(true);
    expect(
      looksLikeMiseNpmFacultExecutableForVersion(
        "/Users/test/.local/share/mise/installs/npm-facult/2.17.3/bin/fclt",
        "2.17.4"
      )
    ).toBe(false);
  });
});

describe("self-update doctor postflight", () => {
  it("treats an older report without legacy recovery metadata as clear and unsupported", () => {
    expect(parseSelfUpdateLegacyRecovery('{"health":{"ok":true}}')).toEqual({
      state: "clear",
      supported: false,
    });
  });

  it("extracts every closed-schema cleanup action from legacy recovery", () => {
    const recovery = parseSelfUpdateLegacyRecovery(
      JSON.stringify({
        health: { ok: false, privateDetail: "ignored" },
        legacyRecovery: {
          state: "cleanup_required",
          recovery: {
            actions: [
              {
                id: "cleanup-autosync",
                service: "codex",
                planId: "aaaaaaaaaaaaaaaaaaaaaaaa",
                argv: [
                  "fclt",
                  "autosync",
                  "cleanup",
                  "--service",
                  "codex",
                  "--expected-plan",
                  "aaaaaaaaaaaaaaaaaaaaaaaa",
                  "--global",
                  "--root",
                  "/tmp/global/.ai",
                  "--allow-legacy-managed-mutation",
                  "--json",
                ],
              },
              {
                id: "cleanup-autosync",
                service: "cursor",
                planId: "bbbbbbbbbbbbbbbbbbbbbbbb",
                argv: [
                  "fclt",
                  "autosync",
                  "cleanup",
                  "--service",
                  "cursor",
                  "--expected-plan",
                  "bbbbbbbbbbbbbbbbbbbbbbbb",
                  "--project",
                  "--root",
                  "/tmp/project/.ai",
                  "--allow-legacy-managed-mutation",
                  "--json",
                ],
              },
            ],
          },
        },
      })
    );

    expect(recovery).toEqual({
      state: "cleanup_required",
      supported: true,
      cleanupActions: expect.arrayContaining([
        expect.objectContaining({ service: "codex" }),
        expect.objectContaining({ service: "cursor" }),
      ]),
    });
  });

  it("distinguishes doctor invocation failure from invalid JSON", () => {
    expect(
      assessSelfUpdateDoctorPostflight({ stdout: "not json", exitCode: 9 })
    ).toEqual({ kind: "invocation_warning", exitCode: 9 });
    expect(
      assessSelfUpdateDoctorPostflight({ stdout: "not json", exitCode: 0 })
    ).toEqual({ kind: "parse_warning" });
  });

  it("prints the approval-gated cleanup argv with shell quoting", () => {
    expect(
      formatSelfUpdateLegacyRecovery({
        executablePath: "/opt/fclt current/bin/fclt",
        recovery: {
          state: "cleanup_required",
          supported: true,
          cleanupActions: [
            {
              id: "cleanup-autosync",
              service: "codex",
              planId: "aaaaaaaaaaaaaaaaaaaaaaaa",
              argv: [
                "fclt",
                "autosync",
                "cleanup",
                "--service",
                "codex",
                "--expected-plan",
                "aaaaaaaaaaaaaaaaaaaaaaaa",
                "--global",
                "--root",
                "/tmp/user's root",
                "--allow-legacy-managed-mutation",
                "--json",
              ],
            },
          ],
        },
      })
    ).toEqual([
      "Self-update compatibility: legacy autosync cleanup requires explicit approval.",
      "Approval-gated cleanup: '/opt/fclt current/bin/fclt' 'autosync' 'cleanup' '--service' 'codex' '--expected-plan' 'aaaaaaaaaaaaaaaaaaaaaaaa' '--global' '--root' '/tmp/user'\\''s root' '--allow-legacy-managed-mutation' '--json'",
    ]);
  });

  it("uses the exact verified executable for blocked manual inspection", () => {
    expect(buildSelfUpdateDoctorCommand("/opt/fclt current/bin/fclt")).toEqual([
      "/opt/fclt current/bin/fclt",
      "doctor",
      "--global",
      "--json",
    ]);
    expect(
      buildSelfUpdateDoctorCommand("/opt/fclt current/bin/fclt", "project")
    ).toEqual(["/opt/fclt current/bin/fclt", "doctor", "--project", "--json"]);
    expect(
      formatSelfUpdateLegacyRecovery({
        executablePath: "/opt/fclt current/bin/fclt",
        recovery: { state: "blocked", supported: true },
      })
    ).toEqual([
      "Self-update compatibility: legacy recovery is blocked and needs manual review.",
      "Inspect: '/opt/fclt current/bin/fclt' 'doctor' '--global' '--json'",
    ]);
    expect(formatSelfUpdateCommand(["fclt", "doctor", "--global"])).toBe(
      "'fclt' 'doctor' '--global'"
    );
    expect(
      formatSelfUpdateLegacyRecovery({
        executablePath: "/opt/fclt current/bin/fclt",
        scope: "project",
        recovery: { state: "blocked", supported: true },
      })[1]
    ).toContain("'--project'");
  });

  it("runs global and detected-project postflight through the exact executable", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "facult-self-update-postflight-")
    );
    const project = join(root, "repo");
    const executable = join(root, "verified", "fclt");
    const calls: Array<{
      executablePath: string;
      scope: "global" | "project";
      cwd: string;
    }> = [];
    const logs: string[] = [];
    const warnings: string[] = [];
    try {
      await runFixtureGit({
        argv: ["init", "--quiet", project],
        repoDir: project,
        homeDir: join(root, "git-home"),
      });
      await mkdir(join(project, ".ai"), { recursive: true });
      await runSelfUpdateDoctorPostflight(executable, {
        cwd: project,
        projectRoot: project,
        invoke: (executablePath, scope, cwd) => {
          calls.push({ executablePath, scope, cwd });
          return Promise.resolve({
            exitCode: 0,
            stdout: JSON.stringify({
              legacyRecovery: {
                state: scope === "global" ? "clear" : "contained",
                recovery: { actions: [] },
              },
            }),
          });
        },
        log: (line) => logs.push(line),
        warn: (line) => warnings.push(line),
      });
      expect(calls).toEqual([
        { executablePath: executable, scope: "global", cwd: project },
        { executablePath: executable, scope: "project", cwd: project },
      ]);
      expect(logs).toContain("Self-update project compatibility:");
      expect(warnings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
