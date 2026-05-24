# fclt Operating Model Target State

## Purpose

`fclt` should make AI capability management simpler than hand-maintaining scattered tool files. The target state is a system where users can see the source of truth, understand what will render where, preview changes safely, and repair drift without learning every internal directory or adapter rule.

This spec reviews the current setup and defines the target future state for skills, instructions, agents, snippets, templates, MCP config, tool config, plugins, automations, writeback, generated state, and rendered tool surfaces.

## Work Unit

Goal: design the ideal package-level operating model for how `fclt` manages canonical capability and rendered tool outputs.

Acceptance criteria:

- The source-of-truth model is explicit.
- Every major surface has an owner, lifecycle, and sync direction.
- CLI commands expose the model without requiring users to inspect hidden state files.
- Common drift and conflict cases have an obvious diagnosis and repair path.
- Project-local and global behavior are easy to reason about.
- The system reduces cognitive load compared with maintaining tool files by hand.

Verification path for this review:

- Inspected current repo structure and package source.
- Ran CLI discovery commands against the repo.
- Checked managed state and dry-run sync behavior.
- Confirmed which files are tracked, ignored, canonical, generated, and rendered.

## Current State Summary

The package already has the right broad shape:

- A canonical store model under `~/.ai` or `<repo>/.ai`.
- Built-in operating-model pack assets under `assets/packs/facult-operating-model/`.
- Tool adapters for Codex, Cursor, Claude CLI, Claude Desktop, Factory, Clawdbot, and a reference adapter.
- Index and graph generation under `.ai/.facult/ai/`.
- Managed tool rendering for skills, agents, MCP, docs, rules, config, plugins, and automations.
- Project sync policy via `[project_sync.<tool>]`.
- Remote/template flows through `fclt search`, `install`, `update`, and `templates`.
- Trust and audit flows.
- Writeback and evolution flows under `fclt ai`.

The weak point is not that the package lacks concepts. The weak point is that the concepts are too hard to see and too easy to desynchronize.

## Current Surface Inventory

### Canonical Source

Intended locations:

- Global canonical root: `~/.ai`.
- Project canonical root: `<repo>/.ai`.
- Built-in package root: `assets/packs/facult-operating-model/`.

Current repo observation:

- The repo has a local `.ai/`, but it contains only generated `.ai/.facult/ai/index.json` and `graph.json`.
- It does not contain canonical `skills/`, `agents/`, `instructions/`, `tools/`, `mcp/`, or `config.toml`.
- Because `.ai/.facult/ai` is enough for project-root detection, commands can treat the repo as project-managed even when canonical project assets are gone.

Problem: generated state can make a repo look like it has a project operating layer even when the canonical source no longer exists.

### Rendered Tool Outputs

Observed local repo outputs:

- `.codex/AGENTS.md`
- `.codex/agents/*.toml`
- `.codex/mcp.json`
- `.codex/skills/hack-cli`
- `.codex/skills/hack-tickets`
- `.agents/plugins/marketplace.json`
- `.agents/skills/*` symlinks
- `plugins/autoresearch/**`
- `.cursor/rules/*.mdc`
- `.claude/settings.local.json`

Most of these are ignored local output. Some exceptions are tracked, including the two `.codex/skills` entries and the built-in pack assets.

Problem: users cannot easily tell which rendered outputs are managed, which are checked in intentionally, which are stale, and which are local-only.

### Machine Runtime State

Observed state:

- Global managed state lives under `~/Library/Application Support/fclt/global/managed.json`.
- Project managed state lives under `~/Library/Application Support/fclt/projects/<key>/managed.json`.
- Generated AI index and graph live under the active canonical root’s `.facult/ai/`.
- Scan and audit write state under `~/.ai/.facult/`.

Problem: the runtime state is technically correct but invisible. The CLI should explain it. Users should not need to inspect `Application Support/fclt` or `.ai/.facult` to understand why a sync will remove files.

### Built-In Pack

Current built-in operating-model pack includes:

- Four instructions.
- Four agents.
- Two skills.
- One global `AGENTS.global.md`.

Problem: the pack is useful but thin. It establishes the idea of an operating model, but it does not yet provide a complete onboarding, diagnosis, or stewardship loop.

### Project Sync Policy

Current behavior:

- Project-managed sync is default-deny.
- Named assets require explicit allowlists.
- Tool surfaces such as global docs, tool rules, and tool config require booleans.

This is directionally right. The main problem is discoverability. Users need a command that says:

- this repo has project sync state
- these assets are allowed
- these rendered files are currently managed
- these managed files no longer have source
- this dry-run would remove them

### CLI Feedback Loops

Observed command behavior:

- `fclt templates list --json` returns useful structured data.
- `fclt adapters --json` prints formatted UI, not JSON.
- `fclt list skills --project --json` returned `[]` for this repo.
- `fclt managed --project` showed Codex managed.
- `fclt sync codex --project --dry-run` would remove many repo-local rendered outputs because the previous project canonical sources are missing.
- `fclt show skill:project-operating-layer-design --root .ai` failed, while `fclt graph show skill:project-operating-layer-design --root .ai` resolved the built-in graph node.
- `fclt scan --from . --json --show-duplicates` found relevant repo-local surfaces, but wrote machine state outside the repo.
- `fclt audit --non-interactive --severity high --json` audited broad machine state and mixed this repo with unrelated repos/plugins.

Problems:

- JSON support is inconsistent.
- `show` and `graph show` do not resolve selectors consistently.
- Audit and scan are not naturally scoped enough for package-level review.
- The most important dry-run result is too destructive-looking without an explanation of why.

## Key Findings

### 1. Source-of-Truth Drift Is the Highest-Risk DX Problem

The project managed state references canonical source paths under `<repo>/.ai`, but the repo’s `.ai` currently has no canonical source assets. A project sync dry-run would remove rendered Codex skills, agents, docs, plugin marketplace files, and plugin bundle files.

Target behavior:

- `fclt doctor --project` should flag this as `managed-rendered-output-with-missing-canonical-source`.
- `fclt status` should show it before users run sync.
- `fclt sync --dry-run` should group removals under a reason, not print a long flat removal list.
- `fclt repair project-source` should offer clear choices:
  - restore from managed rendered outputs
  - restore from built-in pack
  - detach/unmanage stale project output
  - keep local rendered output and stop managing it

### 2. Canonical, Generated, Runtime, and Rendered State Need Hard Boundaries

The model should be simple:

- Canonical source: edited by users, versionable, portable.
- Generated state: derived, rebuildable, never hand-authored.
- Machine runtime state: local behavior and managed target records.
- Rendered tool output: what tools consume.
- Remote source cache: fetched, verified, and installable capability.

Current docs describe this, but the CLI does not make it concrete enough.

Target behavior:

- `fclt status` prints these layers for the active context.
- `fclt explain <path>` tells the user which layer a file belongs to.
- `fclt graph` includes rendered targets and missing-source status.
- `fclt doctor` treats generated-only `.ai` roots as suspicious unless explicitly marked.

### 3. Project-Local Sync Needs Better Onboarding

`fclt templates init project-ai` copies the built-in operating model into `<repo>/.ai` and writes `config.toml`. That is a useful start, but the resulting choice model is still too implicit.

Target behavior:

- `fclt init project` should be the primary command.
- It should ask or accept flags for:
  - global-only, project-only, or merged behavior
  - managed tools
  - allowed project surfaces
  - whether to adopt existing tool output
  - whether to track canonical source in git
  - whether generated state should be ignored
- It should produce a clear summary:
  - canonical files created
  - rendered files that will be managed
  - ignored local files
  - next verification command

### 4. The CLI Needs a Product-Level `status`

The package has many useful commands, but no single command answers “what is going on here?”

Target command:

```bash
fclt status [--global|--project|--root <path>] [--json]
```

It should report:

- active canonical root
- detected project root
- whether the root is global, project, or generated-only
- indexed asset counts by kind and source
- managed tools
- rendered target counts
- missing source references
- local edits to managed targets
- project sync allowlist
- stale index/graph status
- scan/audit status
- autosync status
- top recommended next action

This should be the first command in docs after install.

### 5. Sync Needs Human-Readable Plans

Current dry-run output is accurate but too low-level. A user sees dozens of removals but not the causal model.

Target command:

```bash
fclt sync codex --project --plan
```

Plan output should group by:

- create
- update
- remove because disabled
- remove because source missing
- skip because local edits
- skip because project policy denies
- skip because trust/audit status blocks

Each group should include:

- count
- representative files
- source refs
- repair suggestions

`--json` should expose the same model.

### 6. Project Policy Should Be Inspectable and Explainable

Current config:

```toml
[project_sync.codex]
skills = ["hack-cli", "hack-tickets"]
agents = ["review-operator"]
mcp_servers = ["github"]
global_docs = true
tool_rules = true
tool_config = true
```

Target commands:

```bash
fclt policy show codex --project
fclt policy explain skill:hack-cli --for codex --project
fclt policy allow skill:hack-cli --for codex --project
fclt policy deny skill:hack-cli --for codex --project
```

The user should not need to remember TOML key names or whether a surface is named `mcp_servers`, `mcp`, `tool_rules`, or `rules`.

### 7. Asset Selectors Need One Grammar

Current user-facing selectors include:

- `skill:name`
- `skills:name`
- `mcp:name`
- `instruction:name`
- `@ai/...`
- `@project/...`
- `@builtin/...`
- raw file paths
- graph node ids

Problem: different commands accept different subsets.

Target behavior:

- Define one selector grammar.
- Use it across `list`, `show`, `graph`, `enable`, `disable`, `trust`, `audit`, `ai writeback`, and `policy`.
- Always support `--source builtin|global|project`.
- Always return a useful ambiguity error with candidates.

### 8. Built-In Canonical Refs Are Noisy

Generated built-in canonical refs currently look like:

```text
@builtin/facult-operating-model/skills/skills/project-operating-layer-design
@builtin/facult-operating-model/instructions/instructions/PROJECT_CAPABILITY.md
```

Target refs should be:

```text
@builtin/facult-operating-model/skills/project-operating-layer-design
@builtin/facult-operating-model/instructions/PROJECT_CAPABILITY.md
```

This matters because graph output is part of the user-facing mental model.

### 9. JSON Must Be Real JSON Everywhere It Is Advertised

`fclt adapters --json` currently prints formatted UI. That breaks scripting trust.

Target rule:

- Every command that accepts `--json` must print valid JSON and no formatted UI.
- Add CLI contract tests for every advertised `--json` command.
- Add a docs check that command examples with `--json` are executable.

### 10. Scan and Audit Need Scope Discipline

`scan --from .` can find local repo surfaces, but the persisted scan state and later audit can pull in broad machine state. That makes package-level review noisy.

Target behavior:

- `fclt audit --from .` should default to only that scan root for that command.
- `fclt audit --project` should audit only the active project root and project-managed surfaces.
- `fclt audit --global` should audit global canonical and global managed outputs.
- `fclt audit --scope merged` can exist, but it should say it is broad.
- Findings should include `scope`, `source`, and `actionability`.

### 11. Templates Should Be First-Class Assets, Not Only Installers

Templates currently live partly as remote/built-in manifest entries and partly as scaffolding logic.

Target state:

- Canonical templates live under `templates/` in the store or pack.
- `templates list` shows built-in, global, project, and remote templates.
- `templates show <id>` prints inputs, outputs, and files.
- `templates init` can dry-run with a complete file diff.
- Template installs create provenance metadata.
- Project templates can override or extend global templates.

### 12. Plugins Need the Same Lifecycle as Skills

Codex plugin support exists through the marketplace file and local `plugins/` bundles, but it is not exposed with the same clarity as skills/agents/MCP.

Target commands:

```bash
fclt list plugins
fclt show plugin:autoresearch
fclt graph plugin:autoresearch
fclt enable plugin:autoresearch --for codex
fclt sync codex --plan
```

Plugin assets should be visible in:

- index
- graph
- policy
- sync plan
- audit
- doctor

### 13. Automations Need Clear Ownership

Automations render into `~/.codex/automations`, even for project-scoped canonical sources. That can be correct, but it is surprising.

Target behavior:

- `fclt list automations` should exist.
- `fclt status` should show canonical automation owner and live target.
- Project automations should be visibly tied to their cwd/project root.
- Sync should never remove automation runtime memory unless explicitly requested.
- Automation plans should distinguish prompt/config source from runtime memory.

### 14. Writeback Should Feed the Same Status Model

Writeback/evolution is one of the package’s strongest ideas, but it is currently a separate command family.

Target behavior:

- `fclt status` includes writeback queue counts, proposal counts, and overdue review loops.
- `fclt graph` shows writeback/proposal relationships to assets.
- `fclt ai writeback add` should offer suggestions when the asset selector fails.
- `fclt ai evolve propose` should explain whether it found enough repeated signal.

### 15. The Built-In Pack Should Become an Opinionated DX Layer

The pack should include:

- work-unit design
- verification
- writeback
- project/global scope policy
- integration auditing
- sync policy guidance
- tool-surface ownership
- safe adoption workflow
- drift repair workflow
- release/check workflow for the package itself

The pack should not become a dumping ground for every preference. It should teach the minimal operating discipline required to keep capability management from becoming another pile of config files.

## Ideal Mental Model

The user should be able to explain `fclt` in one sentence:

`fclt` keeps AI capabilities in one canonical store, renders only the approved parts into each tool, and gives you a graph, plan, and repair path whenever those surfaces drift.

The product should enforce five invariants:

1. Canonical source is always distinguishable from generated or rendered output.
2. Every rendered file has a known owner, source, and last rendered hash.
3. Every sync action is previewable, explainable, and reversible.
4. Global and project capability merge predictably, with project policy explicit.
5. Feedback from real work can become durable capability through writeback and evolution.

## Target Data Model

### Asset Kinds

First-class asset kinds:

- instruction
- snippet
- skill
- agent
- mcp-server
- tool-config
- tool-rule
- template
- plugin
- automation
- doc
- writeback
- proposal
- rendered-target
- remote-source

Each indexed asset should have:

- id
- kind
- name
- selector
- source kind: builtin, global, project, remote
- scope: global or project
- canonical ref
- source path
- owner root
- trust status
- audit status
- enabled tools
- dependent rendered targets
- provenance
- lifecycle status: active, shadowed, disabled, orphaned, missing-source, local-edited

### Rendered Targets

Each rendered target should have:

- path
- tool
- surface
- source asset ids
- source hash
- rendered hash
- last rendered at
- local edit status
- removal reason, if planned
- reversible backup path, if available

### Sync Plans

The sync plan should be a stable object, not console text assembled directly from operations.

Plan groups:

- write
- update
- remove
- skip
- conflict
- repair

Each item:

- target path
- source refs
- reason
- risk level
- policy decision
- suggested next command

## Target CLI Map

### Top-Level

```bash
fclt status
fclt explain <path-or-selector>
fclt doctor [--repair]
fclt init project
fclt init global
```

### Inventory

```bash
fclt list skills|agents|instructions|snippets|mcp|templates|plugins|automations|rendered
fclt show <selector>
fclt find <query>
fclt graph <selector>
```

### Policy

```bash
fclt policy show [tool]
fclt policy explain <selector> --for <tool>
fclt policy allow <selector> --for <tool>
fclt policy deny <selector> --for <tool>
```

### Managed Tools

```bash
fclt manage <tool> --plan
fclt manage <tool> --adopt-existing
fclt sync [tool] --plan
fclt sync [tool] --apply
fclt unmanage <tool> --plan
```

### Repair

```bash
fclt repair missing-source
fclt repair generated-only-root
fclt repair stale-managed-state
fclt repair local-edits
fclt repair canonical-refs
```

### Templates

```bash
fclt templates list
fclt templates show <template>
fclt templates init <template> --plan
```

### Feedback

```bash
fclt scan --project
fclt audit --project
fclt audit --global
fclt ai writeback add ...
fclt ai evolve ...
```

## Recommended UX Flow

### New User, Global Setup

```bash
fclt init global
fclt status
fclt manage codex --plan
fclt manage codex --adopt-existing
fclt sync codex --plan
fclt sync codex --apply
```

### Existing Repo, Project Setup

```bash
fclt init project
fclt scan --project
fclt manage codex --project --plan
fclt policy show codex --project
fclt sync codex --project --plan
```

### Drift Recovery

```bash
fclt status --project
fclt doctor --project
fclt sync codex --project --plan
fclt repair missing-source --project
```

### Reusable Learning Loop

```bash
fclt ai writeback add --kind weak_verification --summary "..." --asset instruction:VERIFICATION
fclt ai writeback group --by asset
fclt ai evolve propose
fclt ai evolve draft EV-00001
fclt ai evolve review EV-00001
fclt ai evolve apply EV-00001
```

## Features To Add Or Change

### P0: Make Current State Legible

- Add `fclt status`.
- Add sync plan object and `--plan`.
- Add missing-source detection for managed rendered targets.
- Add generated-only `.ai` root detection.
- Fix `adapters --json`.
- Make `show` and `graph show` share selector resolution.
- Fix built-in canonical ref duplication.
- Add command contract tests for all `--json` commands.

### P1: Make Project Sync Easy

- Add `fclt init project`.
- Add `fclt policy` commands.
- Add `doctor --project --repair` flows for missing source and stale managed state.
- Add scoped scan/audit commands with clear defaults.
- Add `list rendered` and `explain <path>`.

### P2: Make Templates And Plugins First-Class

- Move built-in template definitions into canonical template files.
- Add template index/show/graph support.
- Add plugin index/show/graph/list support.
- Add plugin policy and sync-plan visibility.
- Add automation list/show/status support.

### P3: Strengthen Feedback And Evolution

- Connect writeback/proposals into status and graph views.
- Add proposal readiness scoring.
- Add cross-root promotion status.
- Add scheduled self-audit templates that produce bounded project-scoped output.

## Proposed Repo Layout

Tracked package assets:

```text
assets/packs/facult-operating-model/
  AGENTS.global.md
  instructions/
  skills/
  agents/
  templates/
  policies/
  examples/
```

Project canonical source when this repo manages itself:

```text
.ai/
  config.toml
  AGENTS.global.md
  instructions/
  skills/
  agents/
  tools/
    codex/
      plugins/
      rules/
      config.toml
  templates/
  .facult/
    ai/                # generated, ignored
```

Machine runtime state:

```text
~/Library/Application Support/fclt/
  global/
  projects/
```

Rendered outputs:

```text
.codex/
.agents/
plugins/
.claude/
.cursor/
```

The rule: tracked repo-owned canonical assets should live in `.ai` or `assets/packs`. Rendered outputs should be ignored unless there is an explicit reason to commit them for that tool.

## Open Product Questions

1. Should this repo commit a self-managed `.ai` canonical source, or should it only ship the built-in pack under `assets/packs`?
2. Should project-level rendered Codex output ever be committed, or should repo agent instructions be authored directly as normal project files?
3. Should `fclt sync` require `--apply` once `--plan` exists, or keep today’s direct mutation behavior?
4. Should project sync default-deny remain the default for all project roots, or should `init project` create a minimal allowlist automatically?
5. Should remote plugin/cache assets be modeled as `remote` source kind distinct from installed global/project source?
6. Should scan/audit state be per invocation, per root, or only persisted when explicitly requested?

## Initial Implementation Plan

1. Build the status model.
   - Add a shared `inspectContext()` function.
   - Include root classification, asset counts, managed tools, rendered target health, and policy summary.
   - Add `fclt status --json`.

2. Build the sync plan model.
   - Refactor sync code to return structured plan groups.
   - Render the current text output from the plan object.
   - Add missing-source and local-edit reasons.

3. Fix command consistency.
   - Shared selector resolver.
   - Shared JSON output contract.
   - Contract tests for advertised JSON commands.

4. Add project policy commands.
   - Read/write the existing `[project_sync.<tool>]` model.
   - Explain allow/deny decisions.
   - Use command names instead of exposing TOML details first.

5. Add repair flows.
   - Generated-only root.
   - Missing canonical source.
   - Stale managed state.
   - Local edits.

6. Promote templates/plugins/automations into first-class indexed assets.
   - Extend index and graph kinds.
   - Add list/show/graph/policy support.
   - Include them in status and sync plan.

## Success Checks

The improved system is working when these commands are enough to understand and repair the current repo:

```bash
fclt status --project
fclt explain .codex/AGENTS.md
fclt policy show codex --project
fclt sync codex --project --plan
fclt repair missing-source --project --dry-run
```

Expected outcome:

- The user sees that repo-local Codex is managed.
- The user sees that canonical project source is missing or intentionally absent.
- The user sees why sync would remove current rendered files.
- The user gets a recommended repair path.
- No one has to inspect `.ai/.facult/ai`, `Application Support/fclt`, or symlink targets by hand.

## 2026-05-24 Follow-Up Review

This pass rechecked the target state after the managed-sync safety update that
adopts live skill directories into canonical skill state and protects locally
edited managed docs/config from automatic overwrite.

### What Improved

- Global Codex skill sync is now much safer for user-installed skills: live skill
  directories with `SKILL.md` are adopted before replacement with managed
  symlinks.
- Canonical-backed rendered docs/configs and MCP config now skip on detected
  local edits instead of copying rendered output back into source or overwriting
  the live file.
- Rebuilding the global index made `automation:learning-review` graph-resolvable,
  which means the automation graph path mostly works when the generated graph is
  fresh.

### Findings Addressed In The Implementation Pass

1. Project managed sync now refuses generated-only project `.ai` roots.

   Current proof in this repo: `fclt sync codex --project --dry-run` reports a
   skip because the project `.ai` root contains generated state only and no
   canonical source. It no longer lists repo-local rendered output as ordinary
   removals.

2. `doctor --project` now treats generated-only project `.ai` roots as unsafe.

   Current proof in this repo: `.ai/` contains only generated index and graph
   files, and `fclt doctor --project` exits non-zero with a direct warning about
   missing canonical project source.

3. Scoped JSON scans are now ephemeral by default.

   Current proof: `fclt scan --from . --json ...` runs without persisting global
   scan state. Users can opt into persistence with `--persist`.

4. JSON and selector contracts are tighter.

   Current proof: `fclt adapters --json` emits valid JSON, `fclt list
   automations --json` works, and `fclt show
   skill:project-operating-layer-design --root .ai` resolves through the graph.

5. Writeback can target ordinary project files that are not graph-indexed.

   Current proof: writeback asset resolution falls back to existing
   project-relative files when the graph has no matching node, while new
   suggested project instruction destinations still apply into canonical `.ai`
   project state.

6. Codex adapter metadata now advertises the current TOML config path.

   The public Codex adapter now reports `~/.codex/config.toml`, matching the
   current local Codex config surface.

7. The install status command now explains the split between the active shell
   executable and the managed dev shim.

   Current proof: `bun run install:status` prints the repo package version,
   active executable on `PATH`, managed install path, persisted install state,
   and managed install mode.

### Ledger Implementation

Managed sync now writes an append-only JSONL ledger for actual sync apply events
and skipped unsafe project syncs. Dry-runs remain non-mutating.

Ledger entries include:

- timestamp, command, tool, root, scope, and user/process actor
- old and new target hash
- source refs and source hash
- action type: write, remove, skip, adopt, repair, restore
- reason: policy, source missing, local edit, generated repair, builtin update
- backup path or restore recipe when available
- correlation id shared by dry-run plan and apply

The ledger should be queryable by `fclt status`, `fclt explain <path>`, and a
future `fclt history <path-or-selector>` command. This is the practical way to
make managed mode trustworthy: users need to see what happened, why it happened,
and how to roll back or reconstruct state after a bad sync.

### Remaining Product Follow-Ups

- Add first-class `fclt status`, `fclt explain <path>`, `fclt sync --plan`, and
  `fclt history <path-or-selector>` commands on top of the new ledger and graph
  data.
- Expand graph indexing for ordinary project docs instead of relying only on
  writeback fallback path resolution.
- Add a repair flow for generated-only project roots that can intentionally
  restore source, detach management, or archive rendered outputs.
- Continue converging adapter, scanner, graph, and managed renderer surface
  models so each tool has one shared capability map.
