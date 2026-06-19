# Managed mode

Managed mode is optional. Use it when you want `fclt` to write rendered files into a tool home. Do not use it just to inspect or normalize existing tool-native state.

If you only want the first-party fclt Codex plugin, use the narrow setup path instead:

```bash
fclt setup codex-plugin
```

That installs/exposes the bundled plugin without adopting or rendering the rest of Codex state.

Prefer this default workflow:

```bash
fclt status
fclt inventory --json
fclt list skills
fclt consolidate --auto keep-current --from ~/.codex/skills --from ~/.agents/skills
```

Use managed mode only after that:

```bash
fclt manage codex --dry-run
fclt manage codex --adopt-existing
fclt sync codex --dry-run
fclt sync codex
```

## Adoption Commands

`manage --adopt-existing` is for entering managed mode. It imports existing tool-native content into the canonical store before `fclt` starts writing that tool surface.

`sync --adopt-live` is for intentional later promotion. It imports live tool edits into canonical state before rendering.

Ordinary `fclt sync` does not adopt live tool edits. This lets Codex, Claude, Cursor, or another tool keep local edits without `fclt` silently claiming ownership.

## Conflict Behavior

When live content differs from canonical content:

- default `sync` preserves the live file and tells you to rerun with `--adopt-live` if you want promotion
- `sync --adopt-live` imports the live content into canonical source where supported
- rendered docs/config with local edits are skipped unless an explicit conflict option allows overwrite
- built-in rendered defaults require `--builtin-conflicts overwrite` before replacing local edits

This is deliberate. Managed mode should be predictable and reversible.

## Project managed mode

Project sync is default-deny. A project `.ai` root can exist without rendering anything into repo-local tool outputs.

Allow project assets explicitly:

```toml
version = 1

[project_sync.codex]
skills = ["project-review"]
agents = ["review-operator"]
automations = ["project-check"]
mcp_servers = ["github"]
global_docs = true
tool_rules = true
tool_config = true
```

If a repo-local `.ai` contains only generated state and no canonical assets, `fclt status --project` reports a generated-only warning and `fclt sync --project` skips. Initialize or restore canonical source before syncing managed project output.

## When not to use managed mode

Do not use managed mode when:

- you only need discovery or inventory
- another tool should remain the owner of its files
- a repo has no clear project sync policy
- the canonical source is missing
- you are debugging and need read-only evidence first

Use `fclt inventory`, `scan`, `list`, `show`, `graph`, `status`, and `audit` instead.

## Next

- Read [Project `.ai`](./project-ai.md) for repo-local sync policy.
- Read [Security and trust](./security-trust.md) for MCP secrets and audit.
- Use [Command reference](./reference.md) for common managed-mode commands.
