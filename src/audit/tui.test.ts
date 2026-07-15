import { describe, expect, it } from "bun:test";
import { LEGACY_MANAGED_MUTATION_FLAG } from "../legacy-mutation-policy";
import { parseAuditTuiArgs, promptForAuditTuiAction } from "./tui";

describe("audit TUI arguments", () => {
  it("threads legacy approval alongside scan-root options", () => {
    expect(
      parseAuditTuiArgs([
        "--no-config-from",
        "--from",
        "/tmp/capability",
        LEGACY_MANAGED_MUTATION_FLAG,
      ])
    ).toEqual({
      allowLegacyManagedMutation: true,
      from: ["/tmp/capability"],
      noConfigFrom: true,
    });
  });

  it("does not offer a disabled mutation in the interactive action prompt", async () => {
    let offeredValues: string[] = [];
    const selected = await promptForAuditTuiAction((prompt) => {
      offeredValues = prompt.options.map((option) => option.value);
      return Promise.resolve("exit");
    });

    expect(selected).toBe("exit");
    expect(offeredValues).toContain("mark-safe");
    expect(offeredValues).not.toContain("fix-inline-secrets");
  });
});
