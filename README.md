# fclt

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/fclt-mark-dark.svg">
    <img alt="fclt" src="./docs/assets/fclt-mark.svg" width="144">
  </picture>
</p>

<div align="center">
  <a aria-label="NPM version" href="https://www.npmjs.com/package/facult">
    <img alt="facult npm version" src="https://img.shields.io/npm/v/facult.svg?style=flat-square&logo=npm&labelColor=000000&label=facult">
  </a>
  <a aria-label="Homebrew tap" href="https://github.com/hack-dance/homebrew-tap">
    <img alt="Homebrew tap" src="https://img.shields.io/badge/homebrew-hack--dance%2Ftap%2Ffclt-FBB040.svg?style=flat-square&logo=homebrew&logoColor=white&labelColor=000000">
  </a>
  <a aria-label="Release workflow" href="https://github.com/hack-dance/fclt/actions/workflows/release.yml">
    <img alt="Release" src="https://img.shields.io/github/actions/workflow/status/hack-dance/fclt/release.yml?branch=main&style=flat-square&logo=github&label=release&labelColor=000000">
  </a>
  <a aria-label="hack.dance" href="https://hack.dance">
    <img alt="Made by hack.dance" src="https://img.shields.io/badge/MADE%20BY%20HACK.DANCE-000000.svg?style=flat-square&labelColor=000000">
  </a>
</div>

`fclt` is a CLI for managing AI capability across tools and projects.

It gives instructions, snippets, skills, agents, MCP definitions, automations, and tool config a shared home. It can inspect what already exists, consolidate duplicates, render selected capability into tools like Codex and Claude, and preserve real-work friction as writeback that can later become reviewed improvements.

Use it when AI setup has become scattered across dotfiles, tool homes, repos, prompts, skills, and one-off notes.

<p align="center">
  <img alt="fclt capability loop: setup, capability, agents, work units, writebacks, evolution, approval, and better future agents" src="./docs/assets/fclt-capability-loop.png">
</p>

Most usage should be agent-led after setup. Humans install, inspect, audit, and approve broad changes. Agents use `fclt` to find the right capability, preserve friction as writeback, and turn repeated signal into reviewed improvements.

The basic operating unit is the work unit: a piece of agent work with a goal, context, constraints, evidence, an output artifact, verification, and a writeback target when the work teaches something reusable. That frame applies to normal coding, research, docs, setup, operations, and debugging work, not only to skill updates.

## What it does

`fclt` helps you:

- keep reusable AI capability in a canonical `~/.ai` root
- keep repo-specific capability in `<repo>/.ai`
- inspect skills, instructions, MCP servers, agents, automations, and rendered outputs
- compose guidance from smaller units with refs and snippets
- give agents a reusable work-unit frame for normal work
- optionally render approved capability into Codex, Claude, Cursor, and similar tools
- record writebacks when an agent finds missing context, weak verification, stale guidance, or tool friction
- turn repeated writeback into reviewable evolution proposals
- audit local and remote capability before it spreads

The default posture is read-first. Managed rendering is available, but it is not required for inventory, review, writeback, or evolution. The goal is a background feedback loop, not another CLI users must babysit.

## Install

Homebrew:

```bash
brew tap hack-dance/tap
brew install hack-dance/tap/fclt
fclt --version
```

npm or Bun:

```bash
npm install -g facult
# or
bun add -g facult
fclt --version
```

The npm package is named `facult` for registry compatibility. The command is `fclt`.

One-off usage:

```bash
npx --yes -p facult fclt --help
```

Direct binary install for macOS or Linux:

```bash
curl -fsSL https://github.com/hack-dance/fclt/releases/latest/download/fclt-install.sh | bash
```

Windows and manual installs can download binaries from the [latest release](https://github.com/hack-dance/fclt/releases/latest).

Check and repair local setup:

```bash
fclt doctor --json
fclt doctor --repair
```

`doctor --json` is read-only. `doctor --repair` is the self-heal path for legacy
state, broken rendered global guidance, missing review artifacts, and stale
local integration layout. It validates the rendered form of `AGENTS.global.md`
while preserving that file as a composable source template, and it repairs
leaked `${refs.*}` placeholders in direct-readable instruction files. Canonical
repairs keep a backup under `.ai/.facult/backups/doctor/`.

Update an installed binary:

```bash
fclt self-update
fclt self-update --version 2.12.0
```

`self-update` follows the active install mode. It updates release-script binaries
directly, npm/Bun global installs through their package manager, and
mise-managed npm installs with `mise use -g --pin npm:facult@<version>`, then
verifies the active `fclt --version`.

## Quick start

### 1. Inspect existing AI state

Start read-only:

```bash
fclt status
fclt scan --show-duplicates
fclt inventory --json
fclt list skills
fclt find verification
```

Useful flags:

```bash
fclt inventory --json --global
fclt inventory --json --project
fclt inventory --json --tool codex
```

`inventory` is the stable JSON surface for agents and automation. It redacts MCP secrets by default while preserving safe metadata such as env references and whether inline secrets were detected.

### 2. Create a canonical store

Install the built-in operating-model pack into the global root:

```bash
fclt templates init operating-model --global
fclt index --global
```

On first install, `fclt` seeds `AGENTS.global.md` from existing global agent docs such as `~/.codex/AGENTS.md` or `~/.claude/CLAUDE.md` when they exist, then appends the Facult operating-model frame. The packaged template is only the fallback.

Refresh an existing operating-model pack without overwriting local edits:

```bash
fclt templates init operating-model --global --update --dry-run
fclt templates init operating-model --global --update
```

Create a repo-local `.ai` root:

```bash
cd /path/to/repo
fclt templates init project-ai
fclt status --project
```

Create individual capability units:

```bash
fclt templates init instruction LANGUAGE
fclt templates init snippet global/policy/review
fclt templates init skill project-review
fclt templates init agent review-operator
```

### 3. Consolidate existing skills or config

Bring existing tool-native assets into a canonical root deliberately:

```bash
fclt consolidate --auto keep-current --from ~/.codex/skills --from ~/.agents/skills
fclt index
```

`keep-current` is deterministic and non-interactive. Use other conflict modes only when you have reviewed the sources.

### 4. Optional: manage a tool

Managed mode writes rendered files into a tool home. Use it only when `fclt` should own that rendered surface.

```bash
fclt setup codex-plugin
fclt manage codex --dry-run
fclt manage codex --adopt-existing
fclt sync codex --dry-run
fclt sync codex
```

Ordinary `fclt sync` does not import live tool edits into canonical state. If a live tool file was edited intentionally and should be promoted, run:

```bash
fclt sync --adopt-live
```

Project-managed sync is default-deny. Repo-local tool outputs only receive assets that the project explicitly allows.

## Core model

`fclt` separates source, generated state, runtime state, review artifacts, and rendered output.

```text
~/.ai/                    global canonical capability
<repo>/.ai/               project canonical capability
~/.ai/writebacks/         markdown review artifacts
~/.ai/evolution/          markdown proposal artifacts
tool homes                rendered output for Codex, Claude, Cursor, etc.
machine-local fclt state  queues, drafts, indexes, managed state, runtime cache
```

Canonical capability can include:

- `instructions/`: reusable markdown doctrine
- `snippets/`: composable blocks inserted into rendered markdown
- `skills/`: workflow-specific capability folders
- `agents/`: delegated roles
- `mcp/`: MCP server definitions and overlays
- `automations/`: scheduled review loops
- `tools/<tool>/`: tool config and rules
- `snippets/templates/agents-global.md`: source template materialized as `AGENTS.global.md`

Refs let markdown point at canonical assets without hard-coding paths:

```text
@ai/instructions/LANGUAGE.md
@project/instructions/TESTING.md
@builtin/facult-operating-model/instructions/WORK_UNITS.md
```

Snippet markers let repeated blocks stay independently editable:

```md
<!-- fclty:global/policy/review -->
<!-- /fclty:global/policy/review -->
```

The rule is simple: target the smallest unit that needs to change. Use instructions for doctrine, snippets for repeated blocks, skills for workflows, agents for roles, MCP/tool config for interfaces, and automations for scheduled loops.

Work units give those assets a practical operating frame. They keep intent, evidence, verification, output, and learning attached to a task so repeated friction can become writeback and evolution instead of disappearing into chat history.

## Writeback and evolution

Writeback is preserved signal from real work. Evolution turns repeated signal into reviewed changes.

Record one targeted writeback when the signal is durable:

```bash
fclt ai writeback add \
  --kind weak_verification \
  --summary "Checks were too shallow" \
  --asset instruction:VERIFICATION
```

Review accumulated signal:

```bash
fclt ai writeback list
fclt ai writeback group --by asset
fclt ai writeback summarize --by kind
```

Draft a proposal only when the evidence repeats, a capability is clearly missing, or a canonical asset is stale:

```bash
fclt ai evolve assess --asset instruction:VERIFICATION --json
fclt ai evolve propose
fclt ai evolve list
fclt ai evolve draft EV-00001
fclt ai evolve review EV-00001
fclt ai writeback link WB-00001 --issue TEAM-123
fclt ai writeback disposition WB-00001 --type task --target TEAM-123
fclt ai evolve verify EV-00001 --effectiveness improved --evidence test:post-apply
```

Evolution is complete only after outcome verification. Applying a proposal preserves its source
signal until evidence grades the result as improved, unchanged, regressed, or inconclusive.

Project-scoped additive markdown changes can be lower risk. Global instructions, shared skills, plugins, and other broad surfaces require review before apply.

## Built-in pack

`fclt` ships an operating-model pack that teaches agents how to work in loops instead of one-off prompts:

- define work units
- verify meaningfully
- compose capability units
- record writebacks
- synthesize repeated signal into proposals
- decide project vs global scope
- respect managed-mode ownership boundaries

Install it without managing any tool:

```bash
fclt templates init operating-model --global
fclt templates init operating-model --project
fclt templates init operating-model --root /path/to/.ai
fclt templates init operating-model --global --update
```

The pack is also available as built-in refs under:

```text
@builtin/facult-operating-model/...
```

## Automation

`fclt` can scaffold Codex automations for recurring review loops:

```bash
fclt templates init automation learning-review \
  --scope project \
  --project-root /path/to/repo \
  --status PAUSED

fclt templates init automation evolution-review \
  --scope wide \
  --cwds /path/to/repo-a,/path/to/repo-b \
  --status PAUSED

fclt templates init automation tool-call-audit \
  --scope project \
  --project-root /path/to/repo \
  --status PAUSED
```

Use `learning-review` to preserve signal, `evolution-review` to triage proposals, and `tool-call-audit` to find repeated tool friction.

## Security and trust

Remote capability should be reviewed before broad use.

```bash
fclt sources list
fclt verify-source skills.sh --json
fclt sources trust skills.sh --note "reviewed"
fclt install skills.sh:code-review --as code-review-skills-sh --strict-source-trust
```

Audit local capability:

```bash
fclt audit
fclt audit --non-interactive --severity high
fclt audit fix mcp:github
```

Keep tracked MCP config secret-free. Use local overlays such as `mcp/servers.local.json` for machine-specific secrets.

## Command Map

Discovery:

```bash
fclt status [--json]
fclt doctor [--json] [--repair]
fclt paths [--json]
fclt scan [--from <path>] [--json] [--show-duplicates]
fclt inventory [--json] [--tool <name>] [--show-secrets]
fclt list [skills|mcp|agents|snippets|instructions|automations]
fclt show <selector>
fclt find <query>
fclt graph show <selector>
fclt graph deps <selector>
fclt graph dependents <selector>
```

Canonical store:

```bash
fclt templates list
fclt templates init operating-model [--global|--project|--root PATH] [--update]
fclt templates init project-ai [--update]
fclt templates init instruction <name>
fclt templates init snippet <marker>
fclt templates init skill <name>
fclt templates init agent <name>
fclt consolidate --auto keep-current --from <path>
fclt index [--force]
```

Managed mode:

```bash
fclt setup codex-plugin [--dry-run] [--json]
fclt manage <tool> [--dry-run] [--adopt-existing]
fclt sync [tool] [--dry-run] [--adopt-live]
fclt enable <selector> --for codex,claude
fclt disable <selector> --for codex,claude
fclt managed
fclt unmanage <tool>
```

Writeback and evolution:

```bash
fclt ai writeback add --kind <kind> --summary <text> --asset <selector>
fclt ai writeback list|show|group|summarize
fclt ai evolve assess|propose|list|show|draft|review|accept|reject|apply|promote
```

Sources, audit, and updates:

```bash
fclt search <query>
fclt install <source:item> [--as <name>] [--strict-source-trust]
fclt update [--apply]
fclt sources list|trust|review|block|clear
fclt verify-source <name>
fclt audit [--non-interactive]
fclt self-update
```

Use `fclt --help` and `fclt <command> --help` for exact flags.

## Documentation

Start with:

- [Concepts](./docs/concepts.md): roots, scopes, state layers, and asset types
- [Work Units](./docs/work-units.md): general-purpose agent work framing
- [Composable Capability](./docs/composable-capability.md): refs, snippets, instruction templates, and evolvable units
- [Project `.ai`](./docs/project-ai.md): repo-owned capability and project sync policy
- [Built-in pack](./docs/built-in-pack.md): packaged work-unit, writeback, and evolution defaults
- [Built-in pack upgrades](./docs/pack-upgrades.md): non-destructive refresh behavior for existing `.ai` roots
- [Codex plugin](./docs/codex-plugin.md): installable Codex skills and MCP tools for fclt workflows
- [Writeback and evolution](./docs/writeback-evolution.md): the feedback-loop workflow and review surfaces
- [Managed mode](./docs/managed-mode.md): when to let `fclt` write tool files
- [Roadmap](./docs/roadmap.md): current gaps and planned work

## Brand assets

The fclt mark represents composable capability moving through a continuous improvement loop. Use the [SVG master](./docs/assets/fclt-mark.svg) for scalable applications or the [transparent 1024 px PNG](./docs/assets/fclt-mark.png) for raster surfaces. A [white SVG variant](./docs/assets/fclt-mark-dark.svg) is available for dark backgrounds.

## FAQ

### Does fclt run an MCP server?

The core product is still CLI-first. `fclt setup codex-plugin` installs the first-party Codex plugin without putting all of Codex under managed mode. The plugin includes a small stdio MCP wrapper that delegates to the installed `fclt` binary for status, doctor, paths, setup, writeback, and evolution workflows. See [Codex plugin](./docs/codex-plugin.md).

### Does fclt have to manage Codex or Claude files?

No. You can use `status`, `scan`, `inventory`, `list`, `show`, `graph`, `writeback`, and `evolve` without managed rendering. Use `manage` and `sync` only when `fclt` should write rendered output into a tool home.

### Where do project writebacks go?

Runtime JSON state stays machine-local. Human-readable review artifacts are mirrored under global `~/.ai/writebacks/projects/<slug-hash>/` and `~/.ai/evolution/projects/<slug-hash>/`, not inside repo-local `<repo>/.ai`.

### What should be committed?

Commit canonical project assets that belong to the repo: instructions, snippets, skills, agents, MCP definitions without secrets, and project sync policy. Do not commit generated state, machine-local review queues, rendered tool outputs, or secrets.

## Contributing

Contributor and release workflow details live in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Background

The operating model behind `fclt` is related to the argument in [Governing the Machine](https://www.hack.dance/writing/governing-the-machine): as machine execution gets cheaper, the hard problem becomes governing work, evidence, memory, integration, and improvement.
