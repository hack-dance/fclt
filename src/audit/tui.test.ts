import { describe, expect, it } from "bun:test";
import { LEGACY_MANAGED_MUTATION_FLAG } from "../legacy-mutation-policy";
import { parseAuditTuiArgs } from "./tui";

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
});
