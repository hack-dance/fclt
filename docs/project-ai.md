# Project `.ai`

A project `.ai` root stores repo-owned capability. It is for source that should travel with the codebase, not for generated state, review queues, or private local context.

Create one with:

```bash
cd /path/to/repo
fclt templates init project-ai
fclt index --project
fclt status --project
```

If automation selects a repo-local root through the environment, declare its
scope explicitly:

```bash
FACULT_ROOT_DIR=/path/to/repo/.ai FACULT_ROOT_SCOPE=project fclt status --project
```

An unscoped `FACULT_ROOT_DIR` is treated as global for safety. This prevents a
custom global root that happens to be named `.ai` from becoming project state
during an ancestor search.

Typical layout:

```text
<repo>/.ai/
  config.toml
  instructions/
  snippets/
  agents/
  skills/
  mcp/
  tools/
```

## What Belongs In Project `.ai`

Use project `.ai` for:

- repo-specific instructions
- project review skills
- project MCP definitions without secrets
- project snippets
- project sync policy
- canonical automation prompts that should travel with the repo

Do not put these in project `.ai`:

- writeback queues
- evolution proposal metadata
- generated index/graph state
- local machine paths
- secrets
- private review artifacts

Project-scoped writebacks and evolution proposals are stored in machine-local `fclt` state and mirrored for review under global `~/.ai/writebacks/projects/<slug-hash>/` and `~/.ai/evolution/projects/<slug-hash>/`.

## Migration From Generated-Only Roots

Some repos may contain `<repo>/.ai/.facult/ai/index.json` and `graph.json` without any canonical source. That makes the repo look like it has project AI state even though there is nothing durable to render.

Current behavior:

```bash
fclt status --project
fclt sync --project --dry-run
```

`status` reports `project-generated-only`, and `sync` skips until canonical source is restored or initialized.

## Project Sync Policy

Project sync is default-deny. Nothing from global or project canonical source renders into repo-local managed tool outputs unless the repo opts in.

Example:

```toml
version = 1

[project_sync.codex]
skills = ["project-review"]
agents = ["review-operator"]
mcp_servers = ["github"]
global_docs = true
tool_rules = true
tool_config = true
```

This includes inherited global assets. If a global skill should appear in project-managed Codex output, list it explicitly.

## Next

- Read [Concepts](./concepts.md) for source, generated state, machine-local state, and rendered outputs.
- Read [Managed mode](./managed-mode.md) before syncing project assets into tool outputs.
- Read [Security and trust](./security-trust.md) before committing MCP config.

## Verification

Use these commands after changing project `.ai`:

```bash
fclt status --project
fclt list skills --project
fclt graph AGENTS.global.md --project
fclt sync codex --project --dry-run
```
