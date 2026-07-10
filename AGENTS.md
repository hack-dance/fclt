# fclt Agent Guide

This repo builds `fclt`, a Bun/TypeScript CLI for managing AI capability: instructions, snippets, skills, agents, MCP config, automations, writebacks, evolution proposals, and rendered tool surfaces.

Treat this repo as both product code and a working example of clean agent setup. Keep repo-local guidance specific to fclt. Do not reintroduce unrelated local-dev tool instructions, generated tool-home content, or user-specific operating defaults.

## Project Shape

- CLI entrypoint: `src/index.ts`
- npm launcher shims: `bin/fclt.cjs`, `bin/facult.cjs`
- Core state/path model: `src/paths.ts`, `src/status.ts`, `src/doctor.ts`
- AI writeback/evolution flow: `src/ai.ts`, `src/ai-cli.test.ts`, `src/ai.test.ts`
- Tool sync and adapters: `src/manage.ts`, `src/project-sync.ts`, `src/adapters/*`
- Inventory, scan, graph, and query: `src/inventory.ts`, `src/scan.ts`, `src/index-builder.ts`, `src/graph.ts`, `src/query.ts`
- Remote templates/providers: `src/remote*.ts`
- Audit surfaces: `src/audit/*`
- Built-in operating-model source: `assets/packs/facult-operating-model/`
- Generated embedded assets: `src/builtin-assets.ts`
- Release/build scripts: `scripts/*`
- Public docs: `README.md`, `docs/*`

## Conceptual Model

fclt exists to make AI capability explicit, inspectable, composable, and improvable over time.

Core objects:

- Capability: any durable unit an agent can use, including instructions, snippets, skills, agents, MCP servers, automations, templates, and tool config.
- Canonical source: user- or project-authored capability stored under a canonical `.ai` root.
- Rendered output: tool-specific files written into `.codex`, `.claude`, Cursor, Claude, Factory, or other tool homes.
- Generated state: rebuildable indexes, graphs, and metadata used by fclt to query and relate capability.
- Runtime state: queues, journals, drafts, caches, managed-state records, and release/runtime install state.
- Review artifacts: human-readable Markdown mirrors for writebacks and evolution proposals.

Root model:

- Global canonical root: usually `~/.ai`
- Project canonical root: `<repo>/.ai`
- Built-in source root: `assets/packs/facult-operating-model/`
- Generated global index/graph: under `~/.ai/.facult/ai/`
- Machine-local global runtime state: under the OS app-data path for fclt
- Machine-local project runtime state: under the OS app-data path for fclt, keyed by project
- Global review mirrors: `~/.ai/writebacks/...` and `~/.ai/evolution/...`
- Tool homes: external rendered targets such as Codex or Claude directories

Layering rules:

- Built-ins provide a starter operating model, not a user's private defaults.
- Global capability applies across projects.
- Project capability narrows or extends global capability for one repo.
- Tool output is a rendered target, not the source of truth unless explicitly adopted.
- Local overlays and machine state may contain secrets or machine-specific paths; never publish them.

Work units:

- Treat meaningful changes as work units with a goal, acceptance criteria, required context, constraints, evidence, output artifact, verification path, and writeback target.
- For fclt itself, the output artifact is often a CLI behavior, JSON contract, built-in asset, doc page, release artifact, or migration/repair path.
- A work unit is not done until the relevant feedback loop has been run and the residual risk is stated.

Feedback loop:

- Agents use fclt-managed capability while doing work.
- Friction, missing guidance, stale templates, weak verification, and tool failures become writebacks when they are reusable.
- Repeated writebacks become evolution proposals.
- Accepted proposals update the smallest durable capability unit.
- Future agents then inherit the improved capability.

## Core Principles

- Keep public defaults generic. Never ship personal operating rules, machine-local paths, private MCP config, or user-specific capability in `assets/`, `docs/`, tests, or examples.
- Preserve the separation between canonical source, generated state, runtime state, review artifacts, and rendered tool output.
- Prefer read-only inspection and explicit dry-runs before mutating real tool homes or global `~/.ai`.
- Managed rendering is optional and ownership-sensitive. Do not make `sync` adopt live tool edits unless the user explicitly asks for `--adopt-live`.
- Project `.ai` state must not create repo-local writeback/evolution review artifacts. Project-scoped review artifacts belong under the global review root with project metadata.
- Keep generated files generated. Edit pack assets first, then regenerate `src/builtin-assets.ts`.
- Avoid broad rewrites. fclt is a CLI with many path and state edge cases; small, testable changes are safer.

## Tooling

Use Bun through the repo scripts. This repo does not use a containerized local-dev stack.

Install:

```bash
bun install
```

Common commands:

```bash
bun run check
bun run type-check
./scripts/test-safe.sh
bun run build
bun run build:verify
bun run pack:dry-run
```

Useful focused checks:

```bash
./scripts/test-safe.sh src/ai.test.ts src/ai-cli.test.ts
./scripts/test-safe.sh src/manage.test.ts src/doctor.test.ts
./scripts/test-safe.sh src/remote.test.ts src/builtin.test.ts
./scripts/test-safe.sh bin/fclt.test.ts
```

Git-writing tests are isolated by `bunfig.toml` and `test/git-fixture.ts`. Keep new fixtures on that
harness and follow `docs/git-test-safety.md` if a fixture escape is suspected.

Regenerate embedded built-ins after changing `assets/packs/facult-operating-model/**`:

```bash
bun run scripts/generate-builtin-assets.ts
./scripts/test-safe.sh src/builtin.test.ts
```

Run the compiled binary verifier before claiming a packaging or release-path change works:

```bash
bun run build
bun run build:verify
```

## Coding Standards

- TypeScript is strict; preserve typed boundaries instead of using `any`.
- Prefer structured parsers and serializers for JSON, JSONC, TOML, YAML, frontmatter, and markdown-like assets. Avoid fragile string edits when a local helper exists.
- Keep path logic platform-aware. Use `node:path` helpers, normalize only at display/assertion boundaries, and test Windows-shaped paths when changing path behavior.
- Keep command outputs stable. JSON command output is an API for agents and automation.
- Redact secrets by default. Preserve safe metadata such as env var names, config paths, and whether inline secrets were detected.
- Prefer small pure helpers around state transitions, then cover them with focused tests.
- Comments should explain non-obvious state, migration, or safety rules. Do not narrate ordinary code.

## Privacy and Public Surface Rules

Before publishing or updating docs/templates, review changed surfaces for private defaults and local-only material without naming or preserving sensitive source identifiers in committed guidance.

Do not commit:

- `~/.ai` contents or personal global instruction refs
- personal instruction snippets or operating preferences
- MCP secrets or inline tokens
- generated `.codex/`, `.cursor/`, `.claude/`, `.agents/`, or tool-home state
- local plans outside ignored `_internal/` or `docs/plans/`

Useful checks include searching changed public surfaces for personal names, machine-local absolute paths, private capability refs, local-only tool names, generated tool-home content, and secret-shaped values. Keep any ad hoc sensitive search terms in local notes or the shell history, not in tracked docs.

## Verification Matrix

- Docs-only changes: `bun run check`, `bun run type-check`, relevant link/reference scan, and `git diff --check`.
- Public docs or bundled docs/assets: also run `bun run pack:dry-run` and a privacy review that does not leave private identifiers in committed files.
- Built-in pack changes: regenerate `src/builtin-assets.ts`, then run `./scripts/test-safe.sh src/builtin.test.ts src/remote.test.ts`, `bun run pack:dry-run`, and `bun run build:verify`.
- CLI parser/output changes: run focused CLI tests plus `bun run type-check`; preserve JSON contracts.
- Path/state/doctor changes: run `./scripts/test-safe.sh src/paths.test.ts src/doctor.test.ts` where applicable, plus an installed or temp-home smoke when behavior depends on real home dirs.
- Writeback/evolution changes: run `./scripts/test-safe.sh src/ai.test.ts src/ai-cli.test.ts` and verify global vs project review artifact placement.
- Managed sync/adapters: run `./scripts/test-safe.sh src/manage.test.ts src/adapters/tool-adapters.test.ts` where applicable, and use `--dry-run` before live sync.
- Release or launcher changes: run full `./scripts/test-safe.sh`, `bun run build`, `bun run build:verify`, `bun run pack:dry-run`, and verify the GitHub release workflow after merge.

## Dogfooding fclt

Use fclt itself for durable repo-local learning, but keep signal disciplined.

- Use `fclt status --project --json` and `fclt doctor --json` to inspect setup health.
- Record a project-scoped writeback only when the learning is reusable and has a clear target:

```bash
fclt ai writeback add --project \
  --kind reusable_pattern \
  --summary "..." \
  --evidence "session:<id>" \
  --asset "AGENTS.md"
```

- Use evolution only for repeated evidence, stale canonical assets, or clearly missing capability.
- Prefer the smallest valid evolution target: update an instruction/doc, create a narrow asset, extract a snippet, add a skill, or promote a proven project capability.
- Do not use evolution to encode one-off preferences.

## Release Notes

The package is published as `facult`; the binary commands are `fclt` and `facult`.

Use Conventional Commits because semantic-release controls versioning:

- `fix:` for runtime, packaging, state, and verifier fixes
- `feat:` for user-visible capabilities
- `docs:` for documentation-only changes
- `chore:` for internal maintenance that should not publish a package

After a release-worthy merge, verify:

```bash
gh run list --workflow Release --limit 5
gh release list --limit 5
npm view facult version dist-tags --json
```

If a release workflow fails after semantic-release creates a tag, inspect the failed job, fix forward, and let the next patch release publish the assets/package. Do not rewrite published tags.

## Session Closeout

Before ending a substantial fclt change:

1. State what changed and which surfaces it affects.
2. Run the strongest relevant checks from the verification matrix.
3. Report what was actually verified and any residual risk.
4. Keep the worktree clean or explain exactly what remains.
