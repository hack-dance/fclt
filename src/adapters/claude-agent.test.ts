import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { claudeCliAdapter } from "./claude-cli";

test("Claude discovers Markdown agents with resolved instructions and inherited permissions/model", async () => {
  const root = await mkdtemp(join(tmpdir(), "fclt-claude-agent-"));
  try {
    const rendered = await claudeCliAdapter.renderAgent?.({
      raw: 'name = "reviewer"\ndescription = "Review: evidence and \\"scope\\""\nmodel = "provider-specific-model"\ndeveloper_instructions = "Read @ai/instructions/WORK_UNITS.md. Keep review-only work read-only."\n',
      rootDir: root,
      homeDir: root,
      tool: "claude",
      targetPath: join(root, "reviewer.md"),
    });
    expect(claudeCliAdapter.agentFileExtension).toBe(".md");
    expect(claudeCliAdapter.getDefaultPaths?.().agents).toContain(
      "~/.claude/agents"
    );
    const parts = rendered?.split("---\n") ?? [];
    const metadata = parse(parts[1] ?? "") as Record<string, unknown>;
    expect(metadata.name).toBe("reviewer");
    expect(metadata.description).toBe('Review: evidence and "scope"');
    expect(metadata.model).toBe("inherit");
    expect(metadata.permissionMode).toBeUndefined();
    expect(metadata.tools).toBeUndefined();
    expect(rendered).toContain(join(root, "instructions/WORK_UNITS.md"));
    expect(rendered).toContain("Keep review-only work read-only");
    expect(rendered).not.toContain("provider-specific-model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude rendering refuses unmapped permission restrictions", async () => {
  await expect(
    claudeCliAdapter.renderAgent?.({
      raw: 'name = "reviewer"\nsandbox_mode = "read-only"\n',
      rootDir: "/isolated",
      tool: "claude",
      targetPath: "/isolated/reviewer.md",
    })
  ).rejects.toThrow("cannot silently drop canonical permission field");
});
