import { describe, expect, it } from "bun:test";
import { resolveConflictAction } from "./consolidate-conflict-action";

function baseArgs() {
  return {
    title: "Skill alpha",
    currentLabel: "current",
    incomingLabel: "incoming",
    currentContent: "# current\n",
    incomingContent: "# incoming\n",
    currentHash: "aaa",
    incomingHash: "bbb",
    autoMode: undefined,
    currentMeta: { modified: new Date("2026-01-01T00:00:00.000Z") },
    incomingMeta: { modified: new Date("2026-02-01T00:00:00.000Z") },
    promptConflictResolution: () => Promise.resolve("keep-current" as const),
  };
}

describe("resolveConflictAction", () => {
  it("keeps incoming when current content is missing", async () => {
    const decision = await resolveConflictAction({
      ...baseArgs(),
      currentContent: null,
    });
    expect(decision).toBe("keep-incoming");
  });

  it("keeps current when incoming content is missing", async () => {
    const decision = await resolveConflictAction({
      ...baseArgs(),
      incomingContent: null,
    });
    expect(decision).toBe("keep-current");
  });

  it("keeps current when hashes already match", async () => {
    let promptCalled = false;
    const decision = await resolveConflictAction({
      ...baseArgs(),
      currentHash: "same",
      incomingHash: "same",
      promptConflictResolution: () => {
        promptCalled = true;
        return Promise.resolve("keep-both" as const);
      },
    });
    expect(decision).toBe("keep-current");
    expect(promptCalled).toBe(false);
  });

  it("uses auto mode decisions without prompting", async () => {
    let promptCalled = false;
    const decision = await resolveConflictAction({
      ...baseArgs(),
      autoMode: "keep-newest",
      promptConflictResolution: () => {
        promptCalled = true;
        return Promise.resolve("keep-current" as const);
      },
    });
    expect(decision).toBe("keep-incoming");
    expect(promptCalled).toBe(false);
  });

  it("defers to prompt decision in interactive mode", async () => {
    const decision = await resolveConflictAction({
      ...baseArgs(),
      promptConflictResolution: (prompt) => {
        expect(prompt.title).toBe("Skill alpha");
        expect(prompt.currentLabel).toBe("current");
        expect(prompt.incomingLabel).toBe("incoming");
        return Promise.resolve("keep-both" as const);
      },
    });
    expect(decision).toBe("keep-both");
  });

  it("supports interactive cancel decisions", async () => {
    const decision = await resolveConflictAction({
      ...baseArgs(),
      promptConflictResolution: () => Promise.resolve("skip" as const),
    });
    expect(decision).toBe("skip");
  });
});
