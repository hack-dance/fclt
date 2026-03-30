# fclt

<div align="center">
  <a aria-label="NPM version" href="https://www.npmjs.com/package/facult">
    <img alt="facult npm version" src="https://img.shields.io/npm/v/facult.svg?style=flat-square&logo=npm&labelColor=000000&label=facult">
  </a>
  <a aria-label="Homebrew tap" href="https://github.com/hack-dance/homebrew-tap">
    <img alt="Homebrew tap" src="https://img.shields.io/badge/homebrew-hack--dance%2Ftap%2Ffclt-FBB040.svg?style=flat-square&logo=homebrew&logoColor=white&labelColor=000000">
  </a>
  <a aria-label="CI status" href="https://github.com/hack-dance/fclt/actions/workflows/ci.yml">
    <img alt="CI" src="https://img.shields.io/github/actions/workflow/status/hack-dance/fclt/ci.yml?branch=main&style=flat-square&logo=github&label=ci&labelColor=000000">
  </a>
  <a aria-label="hack.dance" href="https://hack.dance">
    <img alt="Made by hack.dance" src="https://img.shields.io/badge/MADE%20BY%20HACK.DANCE-000000.svg?style=flat-square&labelColor=000000">
  </a>
  <a aria-label="X" href="https://x.com/dimitrikennedy">
    <img alt="Follow on X" src="https://img.shields.io/twitter/follow/dimitrikennedy?style=social">
  </a>
</div>

<p align="center">
  <img alt="fclt demo" src="./Ghostty.gif">
</p>

`fclt` is a CLI for building and evolving AI faculties across tools, users, and projects.

`fclt` manages the reusable parts of your AI setup: instructions, snippets, templates, skills, agents, rules, and the feedback loops that improve them over time.

It helps you:
- keep a canonical store in `~/.ai` or `<repo>/.ai`
- render managed tool files into Codex, Claude, Cursor, and similar tools
- inspect dependencies, provenance, and rendered outputs
- review trust and audit remote or local capability before it spreads
- capture writebacks and evolve canonical assets over time

## Quick Start

### 1. Install fclt

Recommended global install:

```bash
brew tap hack-dance/tap
brew install hack-dance/tap/fclt
fclt --help
```

Package-manager install:

```bash
npm install -g facult
# or
bun add -g facult
fclt --help
```

The npm package name stays `facult` for registry compatibility. The installed command is still `fclt`.

One-off usage without global install:

```bash
npx --yes -p facult fclt --help
```

Direct binary install from GitHub Releases (macOS/Linux):

```bash
curl -fsSL https://github.com/hack-dance/fclt/releases/latest/download/fclt-install.sh | bash
```

Windows and manual installs can download the correct binary from each release page:
`fclt-<version>-<platform>-<arch>`.

Update later with:

```bash
fclt self-update
# or
fclt update --self
```

Pin to a specific version:

```bash
fclt self-update --version 0.0.1
```

### 2. Scan or bootstrap your canonical store

```bash
fclt scan --show-duplicates
```

`scan` is read-only. It inspects local configs and reports what `fclt` found without changing files.

If you want a repo-local `.ai`:

```bash
cd /path/to/repo
fclt templates init project-ai
fclt index
```

### 3. Import existing skills or config

```bash
fclt consolidate --auto keep-current --from ~/.codex/skills --from ~/.agents/skills
fclt index
```

Why `keep-current`: it is deterministic and non-interactive for duplicate sources.

### 4. Manage a tool and sync

```bash
fclt manage codex --dry-run
fclt manage codex --adopt-existing
fclt sync codex --builtin-conflicts overwrite
fclt manage cursor
fclt manage claude

fclt enable requesting-code-review receiving-code-review brainstorming systematic-debugging --for codex,cursor,claude
fclt sync
```

Use `--dry-run` first if the live tool already has local content. If the tool already contains skills, agents, rules, docs, config, or MCP definitions, rerun with `--adopt-existing` and add `--existing-conflicts keep-canonical|keep-existing` if names collide.

Codex path policy:
- skills render to `.agents/skills`
- local plugin marketplaces render to `.agents/plugins/marketplace.json`
- local plugin bundles render to `plugins/`
- Codex runtime config, rules, agents, and automations still render under `.codex/`

If you run these commands inside a repo that has `<repo>/.ai`, `fclt` targets the project-local canonical store and repo-local tool outputs by default.

### 5. Inspect and evolve

```bash
fclt list skills
fclt show instruction:WRITING
fclt show mcp:github
fclt find verification
fclt graph AGENTS.global.md
fclt ai writeback add --kind weak_verification --summary "Checks were too shallow" --asset instruction:VERIFICATION
fclt ai evolve propose
```

Context controls:

```bash
fclt list instructions --global
fclt list instructions --project
fclt find verification --scope merged --source project
fclt list agents --root /path/to/repo/.ai
```

### 6. Optional: autosync, source trust, and audit

```bash
fclt autosync install --git-remote origin --git-branch main --git-interval-minutes 60
fclt autosync status

fclt sources list
fclt verify-source skills.sh --json
fclt sources trust skills.sh --note "reviewed"
fclt install skills.sh:code-review --as code-review-skills-sh --strict-source-trust

fclt audit
fclt audit --non-interactive --severity high
fclt audit safe mcp:github --rule static:mcp-env-inline-secret --note "reviewed"
fclt audit fix mcp:github
```

## Overview

Useful AI behavior is composable. You need small reusable parts, a clean way to combine them, and a safe way to render them into the files your tools actually use.

`fclt` is a canonical store plus a renderer:
- canonical store in `~/.ai` or `<repo>/.ai`
- rendered tool files in places like `~/.codex`, `~/.claude`, or repo-local tool dirs
- discovery and graph views for dependencies, provenance, and rendered targets
- writeback and evolution flows for improving canonical assets over time

## Built-in Defaults

`fclt` includes a built-in layer for writeback and evolution. By default, that layer provides:
- instructions for evolution, integration, and project capability
- agents such as `writeback-curator`, `evolution-planner`, and `scope-promoter`
- skills such as `capability-evolution` and `project-operating-layer-design`

Those built-in defaults become live when you manage a tool. Global tool management renders the bundled docs, agents, and skills into that tool’s live files. Project-local `.ai` roots do not sync the built-in operating-model layer unless you explicitly enable it.

If you want to disable default built-in sync for one canonical root:

```toml
version = 1

[builtin]
sync_defaults = false
```

Put that in `config.toml` or `config.local.toml` under the active canonical root.

## Use fclt from your agents

`fclt` is CLI-first. The practical setup is:
1. Install `fclt` globally so any agent runtime can execute it.
2. Put allowed `fclt` workflows in your agent instructions and skills.
3. Optionally scaffold MCP wrappers if you want an MCP entry that delegates to `fclt`.

```bash
# Scaffold reusable templates in the canonical store
fclt templates init agents
fclt templates init agent review-operator
fclt templates init skill facult-manager

# Enable that skill for managed tools
fclt manage codex
fclt manage cursor
fclt manage claude
fclt enable facult-manager --for codex,cursor,claude
fclt sync
```

Optional MCP scaffold:

```bash
fclt templates init mcp facult-cli
fclt enable mcp:facult-cli --for codex,cursor,claude
fclt sync
```

Note: `templates init mcp ...` is a scaffold, not a running server by itself.

## Mental Model

`fclt` treats both `~/.ai` and `<repo>/.ai` as canonical stores. The global store is for personal reusable capability. The project store is for repo-owned capability that should travel with the codebase.

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
      plugins/
        marketplace.json
      rules/
<repo>/
  .ai/
    config.toml
    instructions/
    snippets/
    agents/
    skills/
    tools/
    .facult/
      ai/
        index.json
        graph.json
  .codex/
  .agents/
  plugins/
  .claude/
```

Important split:
- `.ai/` is canonical source
- `.ai/.facult/ai/` is generated AI state that belongs with the canonical root
- machine-local Facult state such as managed-tool state, autosync runtime/config, install metadata, and launcher caches lives outside `.ai/`
- tool homes such as `.codex/` and `.claude/` are rendered outputs
- the generated capability graph lives at `.ai/.facult/ai/graph.json`

### Asset types

The canonical store can contain several distinct asset classes:

- `instructions/`: reusable doctrine and deeper conceptual guidance
- `snippets/`: small composable blocks that can be inserted into rendered markdown
- `agents/`: role-specific agent manifests
- `skills/`: workflow-specific capability folders
- `mcp/`: canonical MCP server definitions
- `mcp/servers.local.json` or `mcp/mcp.local.json`: ignored machine-local MCP secret overlay
- `tools/<tool>/config.toml`: canonical tool config
- `tools/<tool>/config.local.toml`: machine-local tool config overlay
- `tools/<tool>/rules/*.rules`: canonical tool rules
- global docs such as `AGENTS.global.md` and `AGENTS.override.global.md`

Not every asset syncs directly to a tool. Some exist primarily to support rendered outputs or to be discovered and reused by other canonical assets.

### Canonical conventions

- Use `instructions/` for reusable markdown documents
- Use `snippets/` for composable partial blocks injected into markdown templates
- Use `tools/codex/rules/*.rules` for actual Codex approval-policy rules
- Use logical refs such as `@ai/instructions/WRITING.md` in tracked source
- Use `@builtin/facult-operating-model/...` for packaged built-in defaults
- Use `@project/...` when a tracked ref must resolve inside a repo-local `.ai`
- Use config-backed refs in prompts where you want stable named references such as `${refs.writing_rule}`

### Config and env layering

Canonical render context is layered explicitly:
1. built-ins injected by `fclt`
2. active canonical root `config.toml`
3. active canonical root `config.local.toml`
4. explicit runtime overrides

Built-ins currently include:
- `AI_ROOT`
- `HOME`
- `PROJECT_ROOT`
- `PROJECT_SLUG`
- `TARGET_TOOL`
- `TARGET_PATH`

Recommended split:
- `~/.ai/config.toml` or `<repo>/.ai/config.toml`: tracked, portable, non-secret refs/defaults
- `~/.ai/config.local.toml` or `<repo>/.ai/config.local.toml`: ignored, machine-local paths and secrets
- `~/.ai/mcp/servers.json` or `<repo>/.ai/mcp/servers.json`: tracked canonical MCP definitions
- `~/.ai/mcp/servers.local.json` or `<repo>/.ai/mcp/servers.local.json`: ignored machine-local MCP env overlay for secrets and per-machine auth
- `~/.ai/tools/<tool>/config.toml` or `<repo>/.ai/tools/<tool>/config.toml`: tracked tool defaults
- `~/.ai/tools/<tool>/config.local.toml` or `<repo>/.ai/tools/<tool>/config.local.toml`: ignored, machine-local tool overrides merged after tracked tool config during sync
- `[builtin].sync_defaults = false`: disable builtin default sync/materialization for this root
- `[project_sync.<tool>]`: explicit project-managed allowlist for assets that may render into repo-local tool outputs
- `fclt sync --builtin-conflicts overwrite`: allow packaged builtin defaults to overwrite locally modified generated targets
- `fclt audit fix ...`: move inline MCP secrets from tracked canonical config into the local MCP overlay and re-sync managed tool configs

For project-local `.ai` roots, tool sync is default-deny. Nothing flows into repo-local managed tool outputs unless the repo explicitly opts in. Use `config.toml` or `config.local.toml` under the project root:

```toml
version = 1

[project_sync.codex]
skills = ["hack-cli", "hack-tickets"]
agents = ["review-operator"]
mcp_servers = ["github"]
global_docs = true
tool_rules = true
tool_config = true
```

That policy applies to project-managed tool renders, including assets inherited from the merged global index. If you want a global skill inside a repo-local managed Codex output, name it explicitly here. `fclt doctor --repair` can materialize repo-local project assets into `config.local.toml` for already-managed project roots.

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
fclt snippets list
fclt snippets show global/codex/baseline
fclt snippets sync [--dry-run] [file...]
```

Snippets are already used during global Codex `AGENTS.md` rendering.

### Graph inspection

The generated graph in `.ai/.facult/ai/graph.json` is queryable directly:

```bash
fclt graph show instruction:WRITING
fclt graph deps AGENTS.global.md
fclt graph dependents @project/instructions/TESTING.md
```

This is the explicit dependency layer for:
- snippet markers like `<!-- fclty:... -->`
- config-backed refs like `${refs.*}`
- canonical refs like `@ai/...`
- project refs like `@project/...`
- rendered outputs such as managed agents, docs, MCP configs, tool configs, and tool rules

### Writeback and evolution

`fclt` also has a local writeback and evolution layer built on top of the graph:

```bash
fclt ai writeback add \
  --kind weak_verification \
  --summary "Verification guidance did not distinguish shallow checks from meaningful proof." \
  --asset instruction:VERIFICATION \
  --tag verification \
  --tag false-positive

fclt ai writeback list
fclt ai writeback show WB-00001
fclt ai writeback group --by asset
fclt ai writeback summarize --by kind
fclt ai evolve propose
fclt ai evolve list
fclt ai evolve show EV-00001
fclt ai evolve draft EV-00001
fclt ai evolve review EV-00001
fclt ai evolve accept EV-00001
fclt ai evolve reject EV-00001 --reason "Needs a tighter draft"
fclt ai evolve supersede EV-00001 --by EV-00002
fclt ai evolve apply EV-00001
fclt ai evolve promote EV-00003 --to global --project
```

Runtime state stays generated and local inside the active canonical root:
- global writeback state: `~/.ai/.facult/ai/global/...`
- project writeback state: `<repo>/.ai/.facult/ai/project/...`

That split is intentional:
- canonical source remains in `~/.ai` or `<repo>/.ai`
- writeback queues, journals, proposal records, trust state, autosync state, and other generated runtime/config state stay inside `.ai/.facult/`
- those records let agents inspect what changed, why it changed, and how it was reviewed

Use writeback when:
- a task exposed a weak or misleading verification loop
- an instruction or agent was missing key context
- a pattern proved reusable enough to become doctrine
- a project-local pattern deserves promotion toward global capability

Do not think of writeback as note-taking. Treat it as preserved signal that should improve the system.

Current apply semantics are intentionally policy-bound:
- targets are resolved through the generated graph when possible and fall back to canonical ref resolution for missing assets
- apply is limited to markdown canonical assets
- proposals must be drafted before they can be applied; higher-risk proposals still require explicit acceptance
- supported proposal kinds currently include `create_instruction`, `update_instruction`, `create_agent`, `update_agent`, `update_asset`, `create_asset`, `extract_snippet`, `add_skill`, and `promote_asset`
- low-risk project-scoped additive proposals such as `create_instruction` can be applied directly after drafting, while global and higher-risk proposals still require review/acceptance

Current review/draft semantics:
- `writeback group` and `writeback summarize` expose recurring patterns across `asset`, `kind`, and `domain` without mutating canonical assets
- drafted proposals emit both a human-readable markdown draft and a patch artifact under generated state
- rerunning `evolve draft <id> --append ...` revises the draft and records draft history
- `evolve promote --to global` creates a new high-risk global proposal from a project-scoped proposal; that promoted proposal can then be drafted, reviewed, and applied into `~/.ai`

### Scope and source selection

Most inventory and sync commands support explicit canonical-root selection:

- `--global` to force `~/.ai`
- `--project` to force the nearest repo-local `.ai`
- `--root /path/to/.ai` to point at a specific canonical root
- `--scope merged|global|project` for discovery views
- `--source builtin|global|project` to filter provenance in list/find/show/graph flows

## Security and Trust

`fclt` has two trust layers:
- Item trust: `fclt trust <name>` / `fclt untrust <name>`
- Source trust: `fclt sources ...` with levels `trusted`, `review`, `blocked`

Bulk trust annotations are also supported:

```bash
fclt trust --all
fclt trust skills --all
fclt untrust mcp --all
```

`fclt` also supports interactive and scripted audit flows:

1. Interactive audit workflow:
```bash
fclt audit
```
2. Static audit rules (deterministic pattern checks):
```bash
fclt audit --non-interactive --severity high
fclt audit --non-interactive mcp:github --severity medium --json
```
3. Agent-based audit (Claude/Codex review pass):
```bash
fclt audit --non-interactive --with claude --max-items 50
fclt audit --non-interactive --with codex --max-items all --json
```

4. Suppress or remediate reviewed findings:
```bash
fclt audit safe mcp:github --rule static:mcp-env-inline-secret --note "global managed render only"
fclt audit safe --all --source static --yes
fclt audit fix mcp:github
fclt audit fix --all --source combined --yes
```

Recommended security flow:
1. `fclt verify-source <source>`
2. `fclt sources trust <source>` only after review
3. use `--strict-source-trust` for `install`/`update`
4. keep tracked canonical MCP config secret-free; use `mcp/servers.local.json` for machine-local secrets
5. run both static and agent audits on a schedule

## Comprehensive Reference

### Command categories

- Inventory and discovery
```bash
fclt scan [--from <path>] [--json] [--show-duplicates]
fclt list [skills|mcp|agents|snippets|instructions] [--enabled-for <tool>] [--untrusted] [--flagged] [--pending]
fclt show <name>
fclt show instruction:<name>
fclt show mcp:<name> [--show-secrets]
fclt find <query> [--json]
```

- Canonical store and migration
```bash
fclt consolidate [--auto keep-current|keep-incoming|keep-newest] [--from <path> ...]
fclt index [--force]
fclt migrate [--from <path>] [--dry-run] [--move] [--write-config]
```

- Managed mode and rollout
```bash
fclt manage <tool> [--dry-run] [--adopt-existing] [--existing-conflicts keep-canonical|keep-existing]
fclt unmanage <tool>
fclt managed
fclt enable <name> [--for <tool1,tool2,...>]
fclt enable mcp:<name> [--for <tool1,tool2,...>]
fclt disable <name> [--for <tool1,tool2,...>]
fclt trust --all
fclt trust skills --all
fclt untrust mcp --all
fclt sync [tool] [--dry-run] [--builtin-conflicts overwrite]
fclt autosync install [tool] [--git-remote <name>] [--git-branch <name>] [--git-interval-minutes <n>] [--git-disable]
fclt autosync status [tool]
fclt autosync restart [tool]
fclt autosync uninstall [tool]
```

- Remote catalogs and policies
```bash
fclt search <query> [--index <name>] [--limit <n>]
fclt install <index:item> [--as <name>] [--force] [--strict-source-trust]
fclt update [--apply] [--strict-source-trust]
fclt verify-source <name> [--json]
fclt sources list
fclt sources trust <source> [--note <text>]
fclt sources review <source> [--note <text>]
fclt sources block <source> [--note <text>]
fclt sources clear <source>
```

- Templates and snippets
```bash
fclt templates list
fclt templates init project-ai
fclt templates init skill <name>
fclt templates init mcp <name>
fclt templates init agent <name>
fclt templates init snippet <marker>
fclt templates init agents
fclt templates init automation <template-id> --scope global|project|wide [--name <name>] [--project-root <path>] [--cwds <path1,path2>] [--rrule <RRULE>] [--status PAUSED|ACTIVE]

fclt snippets list
fclt snippets show <marker>
fclt snippets create <marker>
fclt snippets edit <marker>
fclt snippets sync [--dry-run] [file...]
```

### Codex automations

`templates init automation` can scaffold three Codex automation forms:

- `--scope project` (single repo): set `--project-root` (or infer from current working directory)
- `--scope wide|global` (multiple repos): set `--cwds` explicitly; if omitted, created automation has no `cwds` by default.
- If you run it interactively without `--scope`, `fclt` prompts for scope and, where possible, known workspaces (git worktrees, configured scan roots, and existing Codex automation paths).
- Built-in automation templates are opinionated: they reference the global Codex operating model, point at relevant Codex skills, and tell Codex when to use focused subagents for bounded review work.

Recommended topology:

- Use `learning-review --scope project` for repo-local writeback and evolution. This keeps review state, verification, and follow-up scoped to the repo that actually produced the evidence.
- Use `evolution-review` on a slower cadence, usually weekly, to triage open proposals and proposal-worthy clusters and suggest the next operator action (`draft`, `review`, `accept`, `reject`, `promote`, or `apply`).
- Use a separate wide/global automation only for cross-repo or shared-surface review, such as global doctrine, shared skills, or repeated tool/agent patterns across repos.
- If you do use a wide learning review, keep the `cwds` list intentionally small and related. The prompt is designed to partition by cwd first, not to blur unrelated repos together.
- A practical default is daily `learning-review` plus weekly `evolution-review`. The first finds and records durable signal; the second keeps proposal review from stalling.

Files are written to:

- `~/.codex/automations/<name>/automation.toml`
- `~/.codex/automations/<name>/memory.md`

When Codex is in managed mode, canonical automation sources live under:

- `~/.ai/automations/<name>/...` for global automation state
- `<repo>/.ai/automations/<name>/...` for project-scoped canonical state

Managed sync renders those canonical automation directories into the shared live Codex automation store at `~/.codex/automations/` and only removes automation files that were previously rendered by the same canonical root.

Example project automation:

```bash
fclt templates init automation tool-call-audit \
  --scope project \
  --project-root /path/to/repo \
  --name project-tool-audit \
  --status ACTIVE
```

Example global automation:

```bash
fclt templates init automation learning-review \
  --scope wide \
  --cwds /path/to/repo-a,/path/to/repo-b \
  --status PAUSED
```

Example weekly evolution automation:

```bash
fclt templates init automation evolution-review \
  --scope wide \
  --cwds /path/to/repo-a,/path/to/repo-b \
  --name weekly-evolution-review \
  --status PAUSED
```

Interactive prompt example:

```bash
fclt templates init automation learning-review
# prompts for scope, then lets you select known workspaces or add custom paths.
```

For full flags and exact usage:
```bash
fclt --help
fclt <command> --help
```

### Root resolution

`fclt` resolves the canonical root in this order:
1. `FACULT_ROOT_DIR`
2. nearest project `.ai` from the current working directory for CLI-facing commands
3. `~/.ai/.facult/config.json` (`rootDir`)
4. `~/.ai`
5. `~/agents/.facult` (or a detected legacy store under `~/agents/`)

### Runtime env vars

- `FACULT_ROOT_DIR`: override canonical store location
- `FACULT_VERSION`: version selector for `scripts/install.sh` (`latest` by default)
- `FACULT_INSTALL_DIR`: install target dir for `scripts/install.sh` (`~/.ai/.facult/bin` by default)
- `FACULT_INSTALL_PM`: force package manager detection for npm bootstrap launcher (`npm` or `bun`)

### State and report files

Under canonical generated AI state (`~/.ai/.facult/` or `<repo>/.ai/.facult/`):
- `sources.json` (latest inventory scan state)
- `consolidated.json` (consolidation state)
- `ai/index.json` (generated canonical AI inventory)
- `audit/static-latest.json` (latest static audit report)
- `audit/agent-latest.json` (latest agent audit report)
- `trust/sources.json` (source trust policy state)

Under machine-local Facult state:
- `install.json` (machine-local install metadata)
- `global/managed.json` or `projects/<slug-hash>/managed.json` (managed tool state)
- `.../autosync/services/*.json` (autosync service configs)
- `.../autosync/state/*.json` (autosync runtime state)
- `.../autosync/logs/*` (autosync service logs)
- `runtime/<version>/<platform-arch>/...` under the machine-local cache root (npm launcher binary cache)

### Config reference

`~/.ai/.facult/config.json` supports:
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

Custom remote sources can be defined in `~/.ai/.facult/indices.json` (manifest URL, optional integrity, optional signature keys/signature verification settings).

## Autosync

`fclt autosync` is the background propagation layer for managed installs.

Current v1 behavior:
- macOS LaunchAgent-backed
- immediate local managed-tool sync on the configured canonical root
- periodic git autosync for the canonical repo
- automatic autosync commits with source-tagged commit messages such as:
  - `chore(facult-autosync): sync canonical ai changes from <host> [service:all]`

Recommended usage:

```bash
fclt autosync install
fclt autosync status
```

Tool-scoped or project-local usage:

```bash
cd /path/to/repo
fclt autosync install codex
fclt autosync status codex
```

One-shot runner for verification/debugging:

```bash
fclt autosync run --service all --once
```

Remote git policy:
- do not sync on every file event
- mark the canonical repo dirty on local changes
- on the configured timer, fetch, auto-commit local canonical changes if needed, pull `--rebase`, then push
- if rebase conflicts occur, remote autosync is blocked and reported, but local managed-tool sync keeps running

## Commit Hygiene

Some MCP config files can contain secrets. Keep local generated artifacts and secret-bearing config files ignored and out of commits.

Recommended practice:
- tracked canonical MCP definitions in `mcp/servers.json` should not inline secrets
- machine-local secrets belong in `mcp/servers.local.json` or `mcp/mcp.local.json`
- global rendered configs under `~/.codex`, `~/.claude`, or similar can contain merged secret values as machine-local runtime output
- repo-local rendered configs should be gitignored; `fclt audit` now flags inline secrets more aggressively when the destination is git-tracked or repo-local and not ignored

## Contributing

Contributor and release workflow details live in [CONTRIBUTING.md](./CONTRIBUTING.md).

## FAQ

### Does fclt run its own MCP server today?

Not as a first-party `fclt mcp serve` runtime.

`fclt` currently focuses on inventory, trust/audit, install/update, and managed sync of canonical AI capability and tool-native outputs.

### Does fclt now manage global AI config, not just skills and MCP?

Yes. The core model now includes:
- canonical personal AI source in `~/.ai`
- rendered managed outputs in tool homes such as `~/.codex`, `~/.agents`, and `~/plugins`
- global instruction docs such as `AGENTS.global.md`, rendered by default into `~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`, and `~/.cursor/AGENTS.md`
- Codex-authored skills in `~/.agents/skills`
- Codex local plugin marketplaces in `~/.agents/plugins/marketplace.json`
- Codex local plugin bundles in `~/plugins/<plugin-name>`
- tool-native configs such as `~/.codex/config.toml`
- tool-native rule files such as `~/.codex/rules/*.rules`

### Do I still need to run `fclt sync` manually?

If autosync is not installed, yes.

If autosync is installed, local changes under `~/.ai` propagate automatically to managed tools. Manual `fclt sync` is still useful for explicit repair, dry-runs, and non-daemon workflows.
