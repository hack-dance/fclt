# facult

`facult` is a Bun CLI for managing coding-agent skills and MCP configs across tools.

It helps you:
- discover what is installed on your machine
- consolidate everything into one canonical store
- review trust/security before installing remote content
- enable a curated skill set across Codex, Cursor, and Claude

## What facult Is (In Simple Terms)

If your agent setup feels scattered (`~/.codex`, `~/.agents`, tool-specific MCP JSON/TOML), `facult` gives you one place to manage it safely.

Think of it as:
- inventory + auditing for agent assets
- package manager interface for skill/MCP catalogs
- sync layer that applies your chosen setup to each tool

## Recommended 5-Minute Setup

### 1) Install facult locally

```bash
bun install
bun link
facult --help
```

### 2) (Optional, Recommended) Wire all agent tools globally

If you use `hack`, this sets up Codex/Cursor/Claude integrations in one place:

```bash
hack setup codex --global
hack setup cursor --global
hack setup claude --global
hack setup mcp --global --all
```

### 3) Choose your canonical store location

Use one of these modes:

- Global (recommended for daily use across all repos):
```bash
export FACULT_ROOT_DIR="$HOME/agents/.facult"
```
- Project-local (recommended for dogfooding or isolated repo configs):
```bash
export FACULT_ROOT_DIR="$PWD/.codex"
```

### 4) Import existing skills/configs

```bash
facult consolidate --auto keep-current --from ~/.codex/skills --from ~/.agents/skills
facult index
```

Why `keep-current`: it is deterministic and non-interactive for duplicate sources.

### 5) Inspect what you have

```bash
facult list skills
facult list mcp
facult show requesting-code-review
facult show mcp:github
```

### 6) Enable managed mode for your tools

```bash
facult manage codex
facult manage cursor
facult manage claude

facult enable requesting-code-review receiving-code-review brainstorming systematic-debugging --for codex,cursor,claude
facult sync
```

At this point, your selected skills are actively synced to all managed tools.

### 7) Turn on source trust + strict install flow

```bash
facult sources list
facult verify-source skills.sh --json
facult sources trust skills.sh --note "reviewed"

facult install skills.sh:code-review --as code-review-skills-sh --strict-source-trust
```

## Day-to-Day Commands

```bash
# Inventory / audit
facult scan
facult audit --non-interactive --severity high

# Browse and inspect
facult list skills
facult list mcp
facult show <name>
facult show mcp:<name>

# Search/install/update remote assets
facult search review --index skills.sh
facult install skills.sh:code-review --as code-review
facult update --apply --strict-source-trust

# Trust and policy
facult trust <name>
facult untrust <name>
facult sources list
facult sources trust <source>
facult sources review <source>
facult sources block <source>
facult verify-source <source>
```

## Security Model (Practical)

`facult` separates two trust layers:

- Item trust (`facult trust/untrust <name>`): metadata on a specific skill/MCP entry
- Source trust (`facult sources ...`): policy for entire remote sources (`trusted|review|blocked`)

Recommended policy:
1. Verify source (`facult verify-source <source>`) before first install
2. Mark approved sources as `trusted`
3. Use `--strict-source-trust` for install/update in CI and shared environments
4. Run periodic audit:
```bash
facult audit --non-interactive --severity high
```

## Global vs Project Mode

- Global mode (`FACULT_ROOT_DIR=$HOME/agents/.facult`): one canonical store reused everywhere.
- Project mode (`FACULT_ROOT_DIR=$PWD/.codex`): isolated setup per repo.

Both modes support the same commands.

## Command Groups (Top-Level)

- Inventory: `scan`
- Audits: `audit`
- Canonical store: `consolidate`, `index`, `list`, `show`, `migrate`
- Managed mode: `manage`, `unmanage`, `managed`, `enable`, `disable`, `sync`
- Trust/policy: `trust`, `untrust`, `sources`, `verify-source`
- Remote catalogs: `search`, `install`, `update`
- DX scaffolding: `templates`
- Snippets: `snippets`
- Debug info: `adapters`

For full flags and exact usage:
```bash
facult --help
facult <command> --help
```

## State, Paths, and Files

### Root resolution order

1. `FACULT_ROOT_DIR`
2. `~/.facult/config.json` (`rootDir`)
3. default root (`~/agents/.facult`, with legacy detection)

### State directory (`~/.facult/`)

- `sources.json` (last scan)
- `consolidated.json` (consolidation state)
- `managed.json` (managed tools)
- `audit/static-latest.json`
- `audit/agent-latest.json`
- `trust/sources.json` (source trust policy)

### Optional config (`~/.facult/config.json`)

Supported keys:
- `rootDir`
- `scanFrom`
- `scanFromIgnore`
- `scanFromNoDefaultIgnore`
- `scanFromMaxVisits`
- `scanFromMaxResults`

## Remote Sources Available by Default

- `facult` (built-in templates)
- `smithery` (MCP provider alias)
- `glama` (MCP provider alias)
- `skills.sh` (skills catalog alias)
- `clawhub` (skills catalog alias)

You can add custom manifest sources in `~/.facult/indices.json` with optional integrity/signature verification.

## Notes for This Repo

This repository may contain local managed artifacts under `.codex/` during dogfooding.
Some files can contain secrets from local MCP configs. Keep these ignored and out of commits.

## Local Development

```bash
bun run type-check
bun test
bun run check
bun run fix
```

## FAQ

### Does facult run its own MCP server today?

Not as a first-party `facult mcp serve` runtime.

`facult` currently focuses on inventory, trust/audit, install/update, and managed sync of skills/MCP configs.
