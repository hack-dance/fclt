# facult

`facult` is a CLI for managing coding-agent skills and MCP configs across tools.

It helps you:
- discover what is installed on your machine
- consolidate everything into one canonical store
- review trust/security before installing remote content
- enable a curated skill set across Codex, Cursor, and Claude

## What facult Is

If your agent setup feels scattered (`~/.codex`, `~/.agents`, tool-specific MCP JSON/TOML), `facult` gives you one place to manage it safely.

Think of it as:
- inventory + auditing for agent assets
- package manager interface for skill/MCP catalogs
- sync layer that applies your chosen setup to each tool

## Quick Start

### 1. Install facult

Recommended global install:

```bash
npm install -g facult
# or
bun add -g facult
facult --help
```

One-off usage without global install:

```bash
npx facult --help
bunx facult --help
```

Direct binary install from GitHub Releases (macOS/Linux):

```bash
curl -fsSL https://github.com/hack-dance/facult/releases/latest/download/facult-install.sh | bash
```

Windows and manual installs can download the correct binary from each release page:
`facult-<version>-<platform>-<arch>`.

Update later with:

```bash
facult self-update
# or
facult update --self
```

Pin to a specific version:

```bash
facult self-update --version 0.0.1
```

### 2. Import existing skills/configs

```bash
facult consolidate --auto keep-current --from ~/.codex/skills --from ~/.agents/skills
facult index
```

Why `keep-current`: it is deterministic and non-interactive for duplicate sources.

Default canonical store: `~/agents/.facult`. You can change it later with `FACULT_ROOT_DIR` or `~/.facult/config.json`.

### 3. Inspect what you have

```bash
facult list skills
facult list mcp
facult show requesting-code-review
facult show mcp:github
```

### 4. Enable managed mode for your tools

```bash
facult manage codex
facult manage cursor
facult manage claude

facult enable requesting-code-review receiving-code-review brainstorming systematic-debugging --for codex,cursor,claude
facult sync
```

At this point, your selected skills are actively synced to all managed tools.

### 5. Turn on source trust and strict install flow

```bash
facult sources list
facult verify-source skills.sh --json
facult sources trust skills.sh --note "reviewed"

facult install skills.sh:code-review --as code-review-skills-sh --strict-source-trust
```

## Use facult from your agents

`facult` is CLI-first. The practical setup is:
1. Install `facult` globally so any agent runtime can execute it.
2. Put allowed `facult` workflows in your agent instructions/skills.
3. Optionally scaffold MCP wrappers if you want an MCP entry that delegates to `facult`.

```bash
# Scaffold reusable templates in the canonical store
facult templates init agents
facult templates init claude
facult templates init skill facult-manager

# Enable that skill for managed tools
facult manage codex
facult manage cursor
facult manage claude
facult enable facult-manager --for codex,cursor,claude
facult sync
```

Optional MCP scaffold:

```bash
facult templates init mcp facult-cli
facult enable mcp:facult-cli --for codex,cursor,claude
facult sync
```

Note: `templates init mcp ...` is a scaffold, not a running server by itself.

## Security and Trust

`facult` has two trust layers:
- Item trust: `facult trust <name>` / `facult untrust <name>`
- Source trust: `facult sources ...` with levels `trusted`, `review`, `blocked`

`facult` also supports two audit modes:

1. Interactive audit workflow:
```bash
facult audit
```
2. Static audit rules (deterministic pattern checks):
```bash
facult audit --non-interactive --severity high
facult audit --non-interactive mcp:github --severity medium --json
```
3. Agent-based audit (Claude/Codex review pass):
```bash
facult audit --non-interactive --with claude --max-items 50
facult audit --non-interactive --with codex --max-items all --json
```

Recommended security flow:
1. `facult verify-source <source>`
2. `facult sources trust <source>` only after review
3. use `--strict-source-trust` for `install`/`update`
4. run both static and agent audits on a schedule

## Comprehensive Reference

### Capability categories

- Inventory: discover local skills, MCP configs, hooks, and instruction files
- Management: consolidate, index, manage/unmanage tools, enable/disable entries
- Security: static audit, agent audit, item trust, source trust, source verification
- Distribution: search/install/update from catalogs and verified manifests
- DX: scaffold templates and sync snippets into instruction/config files

### Command categories

- Inventory and discovery
```bash
facult scan [--from <path>] [--json] [--show-duplicates]
facult list [skills|mcp|agents|snippets] [--enabled-for <tool>] [--untrusted] [--flagged] [--pending]
facult show <name>
facult show mcp:<name> [--show-secrets]
```

- Canonical store and migration
```bash
facult consolidate [--auto keep-current|keep-incoming|keep-newest] [--from <path> ...]
facult index [--force]
facult migrate [--from <path>] [--dry-run] [--move] [--write-config]
```

- Managed mode and rollout
```bash
facult manage <tool>
facult unmanage <tool>
facult managed
facult enable <name> [--for <tool1,tool2,...>]
facult enable mcp:<name> [--for <tool1,tool2,...>]
facult disable <name> [--for <tool1,tool2,...>]
facult sync [tool] [--dry-run]
```

- Remote catalogs and policies
```bash
facult search <query> [--index <name>] [--limit <n>]
facult install <index:item> [--as <name>] [--force] [--strict-source-trust]
facult update [--apply] [--strict-source-trust]
facult verify-source <name> [--json]
facult sources list
facult sources trust <source> [--note <text>]
facult sources review <source> [--note <text>]
facult sources block <source> [--note <text>]
facult sources clear <source>
```

- Templates and snippets
```bash
facult templates list
facult templates init skill <name>
facult templates init mcp <name>
facult templates init snippet <marker>
facult templates init agents
facult templates init claude

facult snippets list
facult snippets show <marker>
facult snippets create <marker>
facult snippets edit <marker>
facult snippets sync [--dry-run] [file...]
```

For full flags and exact usage:
```bash
facult --help
facult <command> --help
```

### Root resolution

`facult` resolves the canonical root in this order:
1. `FACULT_ROOT_DIR`
2. `~/.facult/config.json` (`rootDir`)
3. `~/agents/.facult` (or a detected legacy store under `~/agents/`)

### State and report files

Under `~/.facult/`:
- `sources.json` (latest inventory scan state)
- `consolidated.json` (consolidation state)
- `managed.json` (managed tool state)
- `audit/static-latest.json` (latest static audit report)
- `audit/agent-latest.json` (latest agent audit report)
- `trust/sources.json` (source trust policy state)

### Config reference

`~/.facult/config.json` supports:
- `rootDir`
- `scanFrom`
- `scanFromIgnore`
- `scanFromNoDefaultIgnore`
- `scanFromMaxVisits`
- `scanFromMaxResults`

`scanFrom*` settings are used by `scan`/`audit` unless `--no-config-from` is passed.

Example:
```json
{
  "rootDir": "~/agents/.facult",
  "scanFrom": ["~/dev", "~/work"],
  "scanFromIgnore": ["vendor", ".venv"],
  "scanFromNoDefaultIgnore": false,
  "scanFromMaxVisits": 20000,
  "scanFromMaxResults": 5000
}
```

### Source aliases and custom indices

Default source aliases:
- `facult` (builtin templates)
- `smithery`
- `glama`
- `skills.sh`
- `clawhub`

Custom remote sources can be defined in `~/.facult/indices.json` (manifest URL, optional integrity, optional signature keys/signature verification settings).

## Local Install Modes

For local CLI setup (outside npm global install), use:

```bash
bun run install:dev
bun run install:bin
bun run install:status
```

Default install path is `~/.facult/bin/facult`. You can pass a custom target dir via `--dir=/path`.

## CI and Release Automation

- CI workflow: `.github/workflows/ci.yml`
- Release workflow: `.github/workflows/release.yml`
- Release assets workflow: `.github/workflows/release-assets.yml`
- Semantic-release config: `.releaserc.json`

Release behavior:
1. Every push to `main` runs full checks.
2. `semantic-release` creates the version/tag and GitHub release (npm publish is disabled in this phase).
3. The `release-assets` workflow runs on `release.published`, builds platform binaries, and uploads them to that release.
4. npm publish runs only after binary asset upload succeeds (`publish-npm` depends on `publish-assets`).
5. Published release assets include platform binaries, `facult-install.sh`, and `SHA256SUMS`.
6. The npm package launcher resolves your platform, downloads the matching release binary, caches it under `~/.facult/runtime/<version>/<platform-arch>/`, and runs it.

Current prebuilt binary targets:
- `darwin-x64`
- `darwin-arm64`
- `linux-x64`
- `windows-x64`

Self-update behavior:
1. npm/bun global install: updates via package manager (`npm install -g facult@...` or `bun add -g facult@...`).
2. Direct binary install (release script/local binary path): downloads and replaces the binary in place.
3. Use `facult self-update` (or `facult update --self`).

Required secrets for publish:
- `NPM_TOKEN`

Local semantic-release dry-runs require a supported Node runtime (`>=24.10`).

Recommended one-time bootstrap before first auto release:
```bash
git tag v0.0.0
git push origin v0.0.0
```

This makes the first semantic-release increment land at `0.0.1` for patch-level changes.

## Commit Hygiene

Some MCP config files can contain secrets. Keep local generated artifacts and secret-bearing config files ignored and out of commits.

## Local Development

```bash
bun run install:status
bun run install:dev
bun run install:bin
bun run build
bun run build:verify
bun run type-check
bun run test:ci
bun test
bun run check
bun run fix
bun run pack:dry-run
bun run release:dry-run
```

## FAQ

### Does facult run its own MCP server today?

Not as a first-party `facult mcp serve` runtime.

`facult` currently focuses on inventory, trust/audit, install/update, and managed sync of skills/MCP configs.
