# Command reference

This page groups the main `fclt` commands by job. Use `fclt --help` and `fclt <command> --help` for exact flags.

## Discovery

```bash
fclt setup [--global-only] [--no-codex-plugin] [--json]
fclt status [--json]
fclt doctor [--json] [--repair]
fclt paths [--json]
fclt scan [--from <path>] [--json] [--show-duplicates]
fclt inventory [--json] [--tool <name>] [--show-secrets]
fclt list [skills|mcp|agents|snippets|instructions|automations]
fclt show <selector>
fclt find <query>
```

Use `fclt setup` once after installation to bootstrap global capability, the current repository
when present, review state, indexes, and optional Codex integration. It is idempotent and preserves
local edits and WB/EV history. The remaining commands let you inspect tool state without claiming
ownership of rendered files.
`doctor --json` is read-only and reports schema version 2 setup health, loop readiness, optional
integration degradation, and recommended actions. Version 2 removes vendor-specific integration
fields; external work systems participate through configured evidence exports. `paths --json`
reports canonical, generated, runtime, and review paths for agents and integrations.

Use `fclt doctor --repair` as the one-command self-heal path for local state.
It repairs legacy generated state, stale Codex authoring paths, explicit project
sync policy, invalid canonical global guidance, and missing Markdown review
artifacts. Destructive-looking canonical repairs keep a backup under
`.ai/.facult/backups/doctor/`.

`doctor` renders `AGENTS.global.md` in memory before judging it. That file is a
source template, so empty `fclty` blocks and `${refs.work_units}` placeholders
are valid when they render into filled, concrete tool guidance. `doctor` flags
the global docs only when the rendered output still has empty managed sections,
unresolved placeholders, or marker errors. It also checks direct-readable
instruction files for leaked `${refs.*}` placeholders and can repair known refs
there with backups.

## Graph

```bash
fclt graph show <selector>
fclt graph deps <selector>
fclt graph dependents <selector>
```

The graph explains how instructions, snippets, config refs, and rendered targets relate.

## Canonical Store

```bash
fclt templates list
fclt templates init operating-model [--global|--project|--root PATH] [--update] [--force]
fclt templates init project-ai [--update] [--force]
fclt templates init instruction <name>
fclt templates init snippet <marker>
fclt templates init skill <name>
fclt templates init agent <name>
fclt templates init mcp <name>
fclt templates init automation <template-id> --scope global|project|wide
fclt consolidate --auto keep-current --from <path>
fclt index [--force]
```

Use these to create or normalize canonical capability in `~/.ai` or `<repo>/.ai`.

## Managed mode

```bash
fclt setup codex-plugin [--dry-run] [--json] [--no-codex-install]
fclt manage <tool> [--dry-run] [--adopt-existing]
fclt sync [tool] [--dry-run] [--adopt-live]
fclt enable <selector> --for codex,claude
fclt disable <selector> --for codex,claude
fclt managed
fclt unmanage <tool>
```

`setup codex-plugin` is the narrow path for exposing the bundled fclt Codex
plugin without entering managed mode. It writes only `~/plugins/fclt`, the
local marketplace entry, and the Codex plugin install/cache when Codex is
available. Managed mode writes rendered output into tool homes. Read
[Managed mode](./managed-mode.md) before using it on an existing setup.

## Writeback and evolution

```bash
fclt ai writeback add --kind <kind> --summary <text> --asset <selector>
fclt ai writeback list
fclt ai writeback show WB-00001
fclt ai writeback group --by asset
fclt ai writeback summarize --by kind

fclt ai evolve assess --asset <selector> --json
fclt ai evolve propose
fclt ai evolve list
fclt ai evolve show EV-00001
fclt ai evolve draft EV-00001
fclt ai evolve review EV-00001
fclt ai evolve accept EV-00001
fclt ai evolve reject EV-00001 --reason <text>
fclt ai evolve apply EV-00001
fclt ai evolve promote EV-00003 --to global --project

fclt ai review init [--dry-run] [--force] [--json]
fclt ai review status [--json]
fclt ai review reconcile --since <date> [--until <date>] [--source <id>] [--incremental] [--json]

fclt ai loop enable [--rrule <rrule>] [--source <id>] [--dry-run] [--json]
fclt ai loop disable [--dry-run] [--json]
fclt ai loop status [--json]
fclt ai loop run [--since <date>] [--until <date>] [--source <id>] [--dry-run] [--scheduled] [--json]
```

Use these to turn repeated work friction into reviewed capability changes.
Plain list output shows the active root and scope so an empty project queue is
not confused with the global queue. Use `--global`, `--project`, or `--root`
when reviewing a specific scope, and use `--json` for automation.

`review reconcile` is read-only with respect to configured sources and
canonical capability. It persists only machine-local cursors/window state and a
Markdown review mirror. JSON reports `checked`, `changed`, `stale`, or
`unavailable` coverage for every configured source plus extraction decisions,
correlated signals, linked work, exclusions, and mandatory dispositions.
Bounded windows always rescan their complete requested range. Use
`--incremental` only when advancing from the stored per-source watermarks is
intended. A source-filtered run cannot prove an empty review.

`loop enable` is an explicit opt-in that installs an fclt-owned Codex
automation. The loop persists the full current queue, emits a delta for
notifications, retries bounded reconciliation failures, reports scheduler
observation separately from registration, and tracks proposal verification as
pending, due, overdue, improved, unchanged, or regressed. `loop disable`
pauses only the owned automation and preserves history. `loop run --dry-run`
previews the latest completed reconciliation without writing state. Canonical
apply and external tracker mutation are not performed by the loop.

## Sources, Audit, And Updates

```bash
fclt search <query>
fclt install <source:item> [--as <name>] [--strict-source-trust]
fclt update [--apply]
fclt verify-source <name> [--json]
fclt sources list
fclt sources trust <source> [--note <text>]
fclt sources review <source> [--note <text>]
fclt sources block <source> [--note <text>]
fclt sources clear <source>
fclt audit [--non-interactive]
fclt self-update
```

`self-update` detects release-script, npm/Bun, and mise-managed npm installs.
For mise installs it updates the global `npm:facult` pin and verifies the
resolved `fclt` version through mise.

Use `--strict-source-trust` when installing or updating remote capability from catalogs.

## Root Selection

Most commands accept the same root controls:

- `--global`: use `~/.ai`
- `--project`: use the nearest repo-local `.ai`
- `--root /path/to/.ai`: use an explicit canonical root
- `--scope merged|global|project`: choose a discovery view
- `--source builtin|global|project`: filter provenance in list/find/show/graph flows
