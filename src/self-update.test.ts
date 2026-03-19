import { describe, expect, it } from "bun:test";
import {
  detectInstallMethod,
  normalizeVersionTag,
  parseSelfUpdateArgs,
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

  it("falls back to unknown when no signal is present", () => {
    const method = detectInstallMethod(null, {
      homeDir: "/tmp/test-home",
      executablePath: "/usr/local/bin/node",
    });
    expect(method).toBe("unknown");
  });
});
