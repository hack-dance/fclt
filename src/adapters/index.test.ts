import { beforeEach, describe, expect, it } from "bun:test";
import {
  clearAdapters,
  getAdapter,
  getAllAdapters,
  registerAdapter,
  resolveAdapterVersion,
} from "./index";
import type { ToolAdapter } from "./types";

describe("adapter registry", () => {
  beforeEach(() => {
    clearAdapters();
  });

  it("registers and retrieves adapters", () => {
    const adapter: ToolAdapter = {
      id: "test",
      name: "Test Adapter",
      versions: ["v1"],
    };

    registerAdapter(adapter);

    expect(getAdapter("test")).toEqual(adapter);
    expect(getAllAdapters()).toEqual([adapter]);
  });

  it("resolves version with fallback and warning", async () => {
    const adapter: ToolAdapter = {
      id: "test",
      name: "Test Adapter",
      versions: ["v1", "v2"],
      detectVersion: async () => null,
    };
    const warnings: string[] = [];

    const version = await resolveAdapterVersion(adapter, "/tmp/config.json", {
      warn: (message) => warnings.push(message),
    });

    expect(version).toBe("v2");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("fallback");
  });
});
