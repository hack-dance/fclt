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

`fclt` is a CLI for building and evolving AI faculties across tools, users, and projects.

Most AI tooling manages files. `fclt` manages faculties: the instructions, snippets, templates, skills, agents, rules, and learning loops that should compound, improve, and survive the next session.

It helps you:
- turn repeated friction into reusable capability
- preserve learning through writeback and evolve canonical assets over time
- consolidate AI behavior into one canonical store
- compose prompts, agents, skills, and tool outputs from reusable snippets and templates
- discover what exists, what depends on what, and what should change next
- sync managed outputs into Codex, Cursor, and Claude
- review trust/security before installing remote content
- keep that operating layer in a git-backed store under `~/.ai` and repo-local `.ai/`

## What fclt Is

If your agent setup feels scattered, `fclt` gives it memory, structure, and a way to improve.

A faculty is a reusable piece of AI behavior: an instruction, snippet, template, skill, agent, rule, or learned improvement that you want to keep around and make better.

That matters because a lot of useful AI behavior is compositional. You want small reusable blocks, a clean way to assemble them into bigger prompts and operating layers, and a safe way to render the final tool-native outputs without losing the source structure.

Think of it as:
- a canonical home for your AI faculties
- a composition system for snippets, templates, and rendered AI behavior
- a sync layer for projecting them into real tools
- a discovery graph for seeing what exists and what depends on what
- a writeback/evolution loop for turning repeated friction into durable improvements
- an inventory and trust boundary for the assets you let into the system

## What fclt Does

`fclt` is not a skills folder with a nicer CLI.

It works as five connected layers:

1. Canonical source
   - global capability in `~/.ai`
   - project capability in `<repo>/.ai`
   - optional built-in Facult capability packs for bootstrap and defaults
2. Discovery
   - inventory across skills, agents, snippets, instructions, MCP, and rendered surfaces
   - merged views across builtin, global, and project provenance
   - explicit dependency graph queries
3. Sync
   - managed tool outputs for Codex, Claude, Cursor, and other file-backed surfaces
   - rendered docs, agents, skills, MCP, config, and rules
4. Automation
   - background autosync for local propagation
   - optional git autosync for the canonical store
5. Evolution
   - writeback capture
   - proposal drafting and review
   - controlled apply back into canonical assets

## Default Operating Model

`fclt` ships with a built-in operating model for learning, writeback, and capability evolution. That pack includes default:

- instructions for evolution, integration, and project capability
- specialist agents such as `writeback-curator`, `evolution-planner`, and `scope-promoter`
- skills such as `capability-evolution` and `project-operating-layer-design`

When managed sync is enabled, these built-in assets are available by default even if you never copy them into `~/.ai`.

That means:
- builtin skills sync into managed tool skill directories by default
- builtin agents sync into tool agent directories when the tool supports agents
- if you do not author your own `AGENTS.global.md`, `fclt` renders a builtin global baseline doc into tool-native global docs

This is intentionally virtual at the canonical level:
- builtin defaults remain part of the packaged tool
- your personal `~/.ai` stays clean unless you explicitly vendor or override something
- the live tool output on disk still contains the rendered defaults, so users and agents can read them directly

In practice, this means the system is meant to learn by default. The CLI is there when you want to operate it directly, but the default skills, agents, and global docs are supposed to make writeback and evolution available without ceremony.

If you want to disable the builtin default layer for a specific global or project canonical root:

```toml
version = 1

[builtin]
sync_defaults = false
```

Put that in `config.toml` or `config.local.toml` under the active canonical root.

## Core Concepts

### Canonical vs rendered

`fclt` separates source-of-truth from tool-native output.

- canonical source lives in `~/.ai` or `<repo>/.ai`
- rendered outputs live in tool homes like `~/.codex`, `<repo>/.codex`, `~/.claude`, or `~/.cursor`
- generated Facult-owned state lives in `~/.ai/.facult` or `<repo>/.ai/.facult`

This keeps authored capability portable and reviewable while still producing the exact files each tool expects.

### Global vs project capability

Use global `~/.ai` for reusable personal defaults:
- cross-project instructions
- reusable specialist agents
- shared skills
- default tool config and rules

Use project `.ai/` for repo-owned capability:
- project-specific instructions and snippets
- local architecture/testing doctrine
- project agents and skills that should travel with the codebase
- repo-local rendered outputs for teammates

Project capability is allowed to extend or shadow global capability in merged views, but it does not silently mutate the global source of truth.

### The capability graph

`fclt` builds a generated graph of explicit relationships between canonical assets and rendered outputs.

That graph tracks things like:
- snippet markers
- `@ai/...` and `@project/...` refs
- `${refs.*}` symbolic refs
- rendered-target edges from canonical source to live tool files

This makes it possible to answer:
- what capability do I already have?
- what instructions or snippets does this agent depend on?
- what rendered files change if I update this canonical asset?
- what project asset is shadowing a global asset?

### Writeback and evolution

`fclt` treats repeated failures, weak loops, missing context, and reusable patterns as signal worth preserving.

Writeback is the act of recording that signal in a structured way.
Evolution is the act of grouping that signal into reviewable proposals and applying it back into canonical assets.

This matters because otherwise the same problems repeat in chat without ever improving the actual operating layer. With `fclt`, you can:
- record a weak verification pattern
- group repeated writebacks around an instruction or agent
- draft a proposal to tighten that canonical asset
- review and apply the change in a controlled way

The point is not just better storage. The point is that your AI setup can change shape as it learns.

That is the core idea behind `fclt`: not just syncing skills, but growing faculties.

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

### 2. Start with a read-only inventory (recommended first)

```bash
fclt scan --show-duplicates
# optional machine-readable output
fclt scan --json
```

`scan` is read-only. It inspects local configs and reports what `facult` found without changing files.

### 3. Import existing skills/configs

```bash
fclt consolidate --auto keep-current --from ~/.codex/skills --from ~/.agents/skills
fclt index
```

Why `keep-current`: it is deterministic and non-interactive for duplicate sources.

Canonical source root: `~/.ai` for global work, or `<repo>/.ai` for project-local work. Facult-owned generated/config/runtime state lives inside the active canonical root:
- global: `~/.ai/.facult`
- project: `<repo>/.ai/.facult`

### 3b. Bootstrap a repo-local `.ai`

```bash
cd /path/to/repo
bunx fclt templates init project-ai
bunx fclt index
```

This seeds `<repo>/.ai` from the built-in Facult operating-model pack and writes a merged project index/graph under `<repo>/.ai/.facult/ai/`.

### 4. Inspect what you have

```bash
fclt list skills
fclt list instructions
fclt list mcp
fclt show requesting-code-review
fclt show instruction:WRITING
fclt show mcp:github
fclt find verification
fclt graph show instruction:WRITING
fclt graph deps AGENTS.global.md
fclt graph dependents @ai/instructions/WRITING.md
fclt ai writeback add --kind weak_verification --summary "Checks were too shallow" --asset instruction:VERIFICATION
fclt ai evolve propose
fclt ai evolve draft EV-00001
fclt ai evolve accept EV-00001
fclt ai evolve apply EV-00001
```

Context controls:

```bash
fclt list instructions --global
fclt list instructions --project
fclt find verification --scope merged --source project
fclt sync codex --project
fclt autosync status --global
fclt list agents --root /path/to/repo/.ai
```

### 5. Enable managed mode for your tools

```bash
fclt manage codex --dry-run
fclt manage codex --adopt-existing
fclt sync codex --builtin-conflicts overwrite
fclt manage cursor
fclt manage claude

fclt enable requesting-code-review receiving-code-review brainstorming systematic-debugging --for codex,cursor,claude
fclt sync
```

At this point, your selected skills are actively synced to all managed tools.
If you run these commands from inside a repo that has `<repo>/.ai`, `facult` targets the project-local canonical store and repo-local tool outputs by default.
On first entry to managed mode, use `--dry-run` first if the live tool already has local content. `facult` will show what it would adopt into the active canonical store across skills, agents, docs, rules, config, and MCP, plus any conflicts. Then rerun with `--adopt-existing`; if names or files collide, add `--existing-conflicts keep-canonical` or `--existing-conflicts keep-existing`.
For builtin-backed rendered defaults, `facult` now tracks the last managed render hash. If a user edits the generated target locally, normal sync warns and preserves that local edit instead of silently overwriting it. To replace the local edit with the latest packaged builtin default, rerun sync with `--builtin-conflicts overwrite`.

### 6. Turn on background autosync

```bash
fclt autosync install --git-remote origin --git-branch main --git-interval-minutes 60
fclt autosync status
```

This installs a macOS LaunchAgent that:
- watches the active canonical root (`~/.ai` or `<repo>/.ai`) for local changes and syncs managed tool outputs automatically
- tracks dirty state for the canonical repo
- runs a slower git autosync loop that batches changes, auto-commits them, rebases on the configured remote branch, and pushes on success

If the repo hits a rebase conflict, remote autosync stops and reports the blocked state, but local tool sync continues.

### 7. Turn on source trust and strict install flow

```bash
fclt sources list
fclt verify-source skills.sh --json
fclt sources trust skills.sh --note "reviewed"

fclt install skills.sh:code-review --as code-review-skills-sh --strict-source-trust
```

## Use fclt from your agents

`facult` is CLI-first. The practical setup is:
1. Install `facult` globally so any agent runtime can execute it.
2. Put allowed `facult` workflows in your agent instructions/skills.
3. Optionally scaffold MCP wrappers if you want an MCP entry that delegates to `facult`.

```bash
# Scaffold reusable templates in the canonical store
fclt templates init agents
fclt templates init claude
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

## The `.ai` Model

`facult` treats both `~/.ai` and `<repo>/.ai` as canonical AI stores. The global store is for personal reusable capability; the project store is for repo-owned capability that should travel with the codebase.

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
  .claude/
```

Important split:
- `.ai/` is canonical source
- `.ai/.facult/` is Facult-owned generated state, trust state, managed tool state, autosync state, and caches
- tool homes such as `.codex/` and `.claude/` are rendered outputs
- the generated capability graph lives at `.ai/.facult/ai/graph.json`

### Asset types

The canonical store can contain several distinct asset classes:

- `instructions/`: reusable doctrine and deeper conceptual guidance
- `snippets/`: small composable blocks that can be inserted into rendered markdown
- `agents/`: role-specific agent manifests
- `skills/`: workflow-specific capability folders
- `mcp/`: canonical MCP server definitions
- `tools/<tool>/config.toml`: canonical tool config
- `tools/<tool>/rules/*.rules`: canonical tool rules
- global docs such as `AGENTS.global.md` and `AGENTS.override.global.md`

Not every asset syncs directly to a tool. Some exist primarily to support rendered outputs or to be discovered and reused by other canonical assets.

### Canonical conventions

- Use `instructions/` for reusable markdown documents
- Use `snippets/` for composable partial blocks injected into markdown templates
- Use `tools/codex/rules/*.rules` for actual Codex approval-policy rules
- Use logical refs such as `@ai/instructions/WRITING.md` in tracked source
- Use `@builtin/facult-operating-model/...` for packaged Facult defaults
- Use `@project/...` when a tracked ref must resolve inside a repo-local `.ai`
- Use config-backed refs in prompts where you want stable named references such as `${refs.writing_rule}`

### Config and env layering

Canonical render context is layered explicitly:
1. built-ins injected by `facult`
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
- `[builtin].sync_defaults = false`: disable builtin default sync/materialization for this root
- `fclt sync --builtin-conflicts overwrite`: allow packaged builtin defaults to overwrite locally modified generated targets

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

`facult` also has a local writeback/evolution substrate built on top of the graph:

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
- writeback queues, journals, proposal records, trust state, autosync state, and other Facult-owned runtime/config state stay inside `.ai/.facult/` rather than inside the tool homes

Use writeback when:
- a task exposed a weak or misleading verification loop
- an instruction or agent was missing key context
- a pattern proved reusable enough to become doctrine
- a project-local pattern deserves promotion toward global capability

Do not think of writeback as “taking notes.” Think of it as preserving signal that should change the system, not just the current conversation.

For many users, the normal entrypoint is not the CLI directly. The builtin operating-model layer is designed so synced agents, skills, and global docs can push the system toward writeback and evolution by default, while the `fclt ai ...` commands remain the explicit operator surface when you want direct control.

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

`facult` has two trust layers:
- Item trust: `fclt trust <name>` / `fclt untrust <name>`
- Source trust: `fclt sources ...` with levels `trusted`, `review`, `blocked`

`facult` also supports two audit modes:

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

Recommended security flow:
1. `fclt verify-source <source>`
2. `fclt sources trust <source>` only after review
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
fclt templates init snippet <marker>
fclt templates init agents
fclt templates init claude

fclt snippets list
fclt snippets show <marker>
fclt snippets create <marker>
fclt snippets edit <marker>
fclt snippets sync [--dry-run] [file...]
```

For full flags and exact usage:
```bash
fclt --help
fclt <command> --help
```

### Root resolution

`facult` resolves the canonical root in this order:
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

Under `~/.ai/.facult/`:
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

## Local Install Modes

For local CLI setup (outside npm global install), use:

```bash
bun run install:dev
bun run install:bin
bun run install:status
```

Default install path is `~/.ai/.facult/bin/fclt`. You can pass a custom target dir via `--dir=/path`.

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

Project-local usage:

```bash
cd /path/to/repo
fclt autosync install codex
fclt autosync status codex
```

Tool-scoped service:

```bash
fclt autosync install codex
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

## CI and Release Automation

- CI workflow: `.github/workflows/ci.yml`
- Release workflow: `.github/workflows/release.yml`
- Semantic-release config: `.releaserc.json`

Release behavior:
1. Every push to `main` runs full checks.
2. `semantic-release` creates the version/tag and GitHub release (npm publish is disabled in this phase).
3. The same release workflow then builds platform binaries and uploads them to that GitHub release.
4. npm publish runs only after binary asset upload succeeds (`publish-npm` depends on `publish-assets`).
5. Published release assets include platform binaries, `fclt-install.sh`, `facult-install.sh`, and `SHA256SUMS`.
6. When `HOMEBREW_TAP_TOKEN` is configured, the release workflow also updates the Homebrew tap at `hack-dance/homebrew-tap`.
7. The npm package launcher resolves your platform, downloads the matching release binary, caches it under `~/.ai/.facult/runtime/<version>/<platform-arch>/`, and runs it.

Current prebuilt binary targets:
- `darwin-x64`
- `darwin-arm64`
- `linux-x64`
- `windows-x64`

Self-update behavior:
1. npm/bun global install: updates via package manager (`npm install -g facult@...` or `bun add -g facult@...`).
2. Direct binary install (release script/local binary path): downloads and replaces the binary in place.
3. Use `fclt self-update` (or `fclt update --self`).

Required secrets for publish:
- `NPM_TOKEN`
- `HOMEBREW_TAP_TOKEN` (fine-grained token with contents write access to `hack-dance/homebrew-tap`)

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

### Does fclt run its own MCP server today?

Not as a first-party `fclt mcp serve` runtime.

`facult` currently focuses on inventory, trust/audit, install/update, and managed sync of skills/MCP configs.

### Does fclt now manage global AI config, not just skills and MCP?

Yes. The core model now includes:
- canonical personal AI source in `~/.ai`
- rendered managed outputs in tool homes such as `~/.codex`
- global instruction docs such as `AGENTS.global.md`, rendered by default into `~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`, and `~/.cursor/AGENTS.md`
- tool-native configs such as `~/.codex/config.toml`
- tool-native rule files such as `~/.codex/rules/*.rules`

### Do I still need to run `fclt sync` manually?

If autosync is not installed, yes.

If autosync is installed, local changes under `~/.ai` propagate automatically to managed tools. Manual `fclt sync` is still useful for explicit repair, dry-runs, and non-daemon workflows.
