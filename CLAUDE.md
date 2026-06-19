# fclt Claude Guide

Follow `AGENTS.md` as the primary repository guide. This file exists so Claude sessions land on the same fclt-specific rules without inheriting stale generated instructions.

## What Matters Here

- This is a Bun/TypeScript CLI package published to npm as `facult`.
- The commands users run are `fclt` and `facult`.
- The highest-risk surfaces are path/state handling, managed tool sync, writeback/evolution state, built-in asset packaging, and release verification.
- Public defaults must stay generic. Do not commit personal operating rules, generated tool-home state, or local MCP secrets.
- The core model is capability -> work unit -> evidence -> writeback -> evolution proposal -> accepted capability update. Keep changes aligned with that loop.
- Source roots, generated state, runtime state, review mirrors, and rendered tool output are separate. Do not blur ownership between them.

## Daily Commands

```bash
bun install
bun run check
bun run type-check
bun test
bun run build
bun run build:verify
bun run pack:dry-run
```

Use focused tests while iterating, then run the broader gate before final handoff.

## fclt-Specific Rules

- Edit `assets/packs/facult-operating-model/**` as the built-in source, then regenerate `src/builtin-assets.ts`.
- Keep `doctor --json`, `paths --json`, `status --json`, and `inventory --json` stable; agents depend on those contracts.
- Use dry-runs before mutating live tool homes: `fclt manage ... --dry-run`, `fclt sync ... --dry-run`.
- Do not make global or managed changes without explicit user approval.
- If a release workflow fails after a tag exists, fix forward with a new conventional commit.

## Verification

Use the matrix in `AGENTS.md`. At minimum for code changes:

```bash
bun run check
bun run type-check
bun test
```

For build, launcher, binary, or package changes:

```bash
bun run build
bun run build:verify
bun run pack:dry-run
```

For public docs/templates, do a privacy review before finishing. Look for personal names, machine-local absolute paths, private capability refs, generated tool-home content, and secret-shaped values, but do not write sensitive search terms into tracked guidance.
