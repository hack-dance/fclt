# facult

<div align="center">
  <a aria-label="NPM version" href="https://www.npmjs.com/package/facult">
    <img alt="facult npm version" src="https://img.shields.io/npm/v/facult.svg?style=flat-square&logo=npm&labelColor=000000&label=facult">
  </a>
  <a aria-label="CI status" href="https://github.com/hack-dance/facult/actions/workflows/ci.yml">
    <img alt="CI" src="https://img.shields.io/github/actions/workflow/status/hack-dance/facult/ci.yml?branch=main&style=flat-square&logo=github&label=ci&labelColor=000000">
  </a>
  <a aria-label="hack.dance" href="https://hack.dance">
    <img alt="Made by hack.dance" src="https://img.shields.io/badge/MADE%20BY%20HACK.DANCE-000000.svg?style=flat-square&labelColor=000000">
  </a>
  <a aria-label="X" href="https://x.com/dimitrikennedy">
    <img alt="Follow on X" src="https://img.shields.io/twitter/follow/dimitrikennedy?style=social">
  </a>
</div>

`facult` is a CLI for managing coding-agent configuration across tools.

It helps you:
- discover what is installed on your machine
- consolidate everything into one canonical store
- review trust/security before installing remote content
- sync managed outputs into Codex, Cursor, and Claude
- manage a git-backed personal AI store under `~/.ai`

## What facult Is

If your agent setup feels scattered (`~/.codex`, `~/.agents`, tool-specific MCP JSON/TOML), `facult` gives you one place to manage it safely.

Think of it as:
- inventory + auditing for agent assets
- package manager interface for skill/MCP catalogs
- sync layer that applies your chosen setup to each tool
- canonical source manager for global AI instructions, agents, snippets, tool configs, and rules

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

### 2. Start with a read-only inventory (recommended first)

```bash
facult scan --show-duplicates
# optional machine-readable output
facult scan --json
```

`scan` is read-only. It inspects local configs and reports what `facult` found without changing files.

### 3. Import existing skills/configs

```bash
facult consolidate --auto keep-current --from ~/.codex/skills --from ~/.agents/skills
facult index
```

Why `keep-current`: it is deterministic and non-interactive for duplicate sources.

Canonical source root: `~/.ai`. Generated state remains under `~/.facult`.

### 4. Inspect what you have

```bash
facult list skills
facult list mcp
facult show requesting-code-review
facult show mcp:github
```

### 5. Enable managed mode for your tools

```bash
facult manage codex
facult manage cursor
facult manage claude

facult enable requesting-code-review receiving-code-review brainstorming systematic-debugging --for codex,cursor,claude
facult sync
```

At this point, your selected skills are actively synced to all managed tools.

### 6. Turn on background autosync

```bash
facult autosync install --git-remote origin --git-branch main --git-interval-minutes 60
facult autosync status
```

This installs a per-user macOS LaunchAgent that:
- watches `~/.ai` for local changes and syncs managed tool outputs automatically
- tracks dirty state for the canonical repo
- runs a slower git autosync loop that batches changes, auto-commits them, rebases on the configured remote branch, and pushes on success

If the repo hits a rebase conflict, remote autosync stops and reports the blocked state, but local tool sync continues.

### 7. Turn on source trust and strict install flow

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

## The `~/.ai` Model

`facult` now treats `~/.ai` as the canonical, git-backed source of truth for personal AI configuration.

Typical layout:

```text
~/.ai/
  AGENTS.global.md
  AGENTS.override.global.md
  config.toml
  config.local.toml
  instructions/
  snippets/
  agents/
  skills/
  mcp/
  templates/
  tools/
    codex/
      config.toml
      rules/
  projects/
    <slug>/
      config.toml
      config.local.toml
      snippets/
      instructions/
```

Important split:
- `~/.ai` is canonical source
- `~/.facult` is generated state, trust state, managed tool state, autosync state, and caches
- tool homes such as `~/.codex` are rendered outputs

### Canonical conventions

- Use `instructions/` for reusable markdown documents
- Use `snippets/` for composable partial blocks injected into markdown templates
- Use `tools/codex/rules/*.rules` for actual Codex approval-policy rules
- Use logical refs such as `@ai/instructions/WRITING.md` in tracked source
- Use config-backed refs in prompts where you want stable named references such as `${refs.writing_rule}`

### Config and env layering

Canonical render context is layered explicitly:
1. built-ins injected by `facult`
2. `~/.ai/config.toml`
3. `~/.ai/config.local.toml`
4. `~/.ai/projects/<slug>/config.toml`
5. `~/.ai/projects/<slug>/config.local.toml`
6. explicit runtime overrides

Built-ins currently include:
- `AI_ROOT`
- `HOME`
- `PROJECT_ROOT`
- `PROJECT_SLUG`
- `TARGET_TOOL`
- `TARGET_PATH`

Recommended split:
- `config.toml`: tracked, portable, non-secret refs/defaults
- `config.local.toml`: ignored, machine-local paths and secrets

### Snippets

Snippets use HTML comment markers:

```md
<!-- fclty:global/codex/baseline -->
<!-- /fclty:global/codex/baseline -->
```

Resolution rules:
- unscoped marker `codingstyle` prefers `snippets/projects/<project>/codingstyle.md`, then falls back to `snippets/global/codingstyle.md`
- explicit marker `global/codex/baseline` resolves directly to `snippets/global/codex/baseline.md`

Commands:

```bash
facult snippets list
facult snippets show global/codex/baseline
facult snippets sync [--dry-run] [file...]
```

Snippets are already used during global Codex `AGENTS.md` rendering.

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
- Management: consolidate, index, manage/unmanage tools, enable/disable entries, manage canonical AI config
- Security: static audit, agent audit, item trust, source trust, source verification
- Distribution: search/install/update from catalogs and verified manifests
- DX: scaffold templates and sync snippets into instruction/config files
- Automation: background autosync for local tool propagation and canonical repo git sync

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
facult autosync install [tool] [--git-remote <name>] [--git-branch <name>] [--git-interval-minutes <n>] [--git-disable]
facult autosync status [tool]
facult autosync restart [tool]
facult autosync uninstall [tool]
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
3. `~/.ai`
4. `~/agents/.facult` (or a detected legacy store under `~/agents/`)

### Runtime env vars

- `FACULT_ROOT_DIR`: override canonical store location
- `FACULT_VERSION`: version selector for `scripts/install.sh` (`latest` by default)
- `FACULT_INSTALL_DIR`: install target dir for `scripts/install.sh` (`~/.facult/bin` by default)
- `FACULT_INSTALL_PM`: force package manager detection for npm bootstrap launcher (`npm` or `bun`)

### State and report files

Under `~/.facult/`:
- `sources.json` (latest inventory scan state)
- `consolidated.json` (consolidation state)
- `managed.json` (managed tool state)
- `ai/index.json` (generated canonical AI inventory)
- `audit/static-latest.json` (latest static audit report)
- `audit/agent-latest.json` (latest agent audit report)
- `trust/sources.json` (source trust policy state)
- `autosync/services/*.json` (autosync service configs)
- `autosync/state/*.json` (autosync runtime state)
- `autosync/logs/*` (autosync service logs)

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
  "rootDir": "~/.ai",
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

## Autosync

`facult autosync` is the background propagation layer for managed installs.

Current v1 behavior:
- macOS LaunchAgent-backed
- immediate local managed-tool sync on `~/.ai` file changes
- periodic git autosync for the canonical repo
- automatic autosync commits with source-tagged commit messages such as:
  - `chore(facult-autosync): sync canonical ai changes from <host> [service:all]`

Recommended usage:

```bash
facult autosync install
facult autosync status
```

Tool-scoped service:

```bash
facult autosync install codex
```

One-shot runner for verification/debugging:

```bash
facult autosync run --service all --once
```

Remote git policy:
- do not sync on every file event
- mark the canonical repo dirty on local changes
- on the configured timer, fetch, auto-commit local canonical changes if needed, pull `--rebase`, then push
- if rebase conflicts occur, remote autosync is blocked and reported, but local managed-tool sync keeps running

## CI and Release Automation

- CI workflow: `.github/workflows/ci.yml`
- Release workflow: `.github/workflows/release.yml`
- Semantic-release config: `.releaserc.json`

Release behavior:
1. Every push to `main` runs full checks.
2. `semantic-release` creates the version/tag and GitHub release (npm publish is disabled in this phase).
3. The same release workflow then builds platform binaries and uploads them to that GitHub release.
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

### Does facult now manage global AI config, not just skills and MCP?

Yes. The core model now includes:
- canonical personal AI source in `~/.ai`
- rendered managed outputs in tool homes such as `~/.codex`
- global instruction docs such as `AGENTS.global.md`
- tool-native configs such as `~/.codex/config.toml`
- tool-native rule files such as `~/.codex/rules/*.rules`

### Do I still need to run `facult sync` manually?

If autosync is not installed, yes.

If autosync is installed, local changes under `~/.ai` propagate automatically to managed tools. Manual `facult sync` is still useful for explicit repair, dry-runs, and non-daemon workflows.
