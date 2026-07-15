import { describe, expect, it } from "bun:test";
import {
  buildReviewerPrompt,
  parseAuditTuiArgs,
  promptForAuditTuiAction,
} from "./tui";

describe("audit TUI arguments", () => {
  it("threads scan-root options without mutation approval state", () => {
    expect(
      parseAuditTuiArgs(["--no-config-from", "--from", "/tmp/capability"])
    ).toEqual({
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

  it("keeps MCP remediation inspection-only until explicit approval", () => {
    const prompt = buildReviewerPrompt({
      cwd: "/fixture/repo",
      items: [
        {
          findings: [
            {
              message: "Inline MCP secret",
              ruleId: "mcp-env-inline-secret",
              severity: "high",
            },
          ],
          item: "github",
          passed: false,
          path: "/fixture/repo/.ai/mcp/servers.json",
          type: "mcp",
        },
      ],
      reviewMode: "static",
    });

    expect(prompt).toContain("--dry-run` only to inspect exact matches");
    expect(prompt).toContain("then propose the manual remediation");
    expect(prompt).toContain(
      "Do not mutate MCP config or secrets without explicit user approval"
    );
  });
});
