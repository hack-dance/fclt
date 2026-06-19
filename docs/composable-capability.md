# Composable Capability

`fclt` treats AI behavior as small capability units that can be composed into larger agent instructions and evolved independently.

This prevents one giant agent file from becoming the only place to put every preference, workflow, and exception. A language preference can live in one instruction. A repeated rendered block can live in one snippet. A workflow can live in one skill. Each unit can receive targeted writeback and targeted evolution.

This is the core model:

- write domain guidance once
- compose it with refs and snippets
- render it only where a tool should receive it
- target writeback at the smallest unit that needs to change

## Units

Use `instructions/` for reusable markdown doctrine.

Examples:

```text
~/.ai/instructions/BUN.md
~/.ai/instructions/RUST.md
<repo>/.ai/instructions/TESTING.md
```

Use `snippets/` for partial blocks inserted into rendered docs.

Examples:

```text
~/.ai/snippets/global/codex/baseline.md
~/.ai/snippets/global/lang/bun.md
<repo>/.ai/snippets/global/project/testing.md
```

Use `skills/` for executable workflows, `agents/` for delegated roles, `mcp/` for tool interfaces, and `automations/` for scheduled loops.

## Refs

Canonical refs let a markdown asset point at another asset without hard-coding machine paths:

```text
@ai/instructions/BUN.md
@project/instructions/TESTING.md
@builtin/facult-operating-model/instructions/WORK_UNITS.md
```

Use global refs for reusable user-owned capability. Use project refs for repo-owned capability. Use built-in refs for packaged defaults.

Config-backed refs are useful when the concrete path should be named in `config.toml`:

```toml
version = 1

[refs]
language_defaults = "@ai/instructions/BUN.md"
project_testing = "@project/instructions/TESTING.md"
```

Rendered markdown can use those refs through the render context when a tool adapter supports that target.

## Snippets

Snippets use paired HTML markers:

```md
<!-- fclty:global/lang/bun -->
<!-- /fclty:global/lang/bun -->
```

The marker above resolves to:

```text
snippets/global/lang/bun.md
```

Create and inspect snippets with:

```bash
fclt templates init snippet global/lang/bun
fclt snippets list
fclt snippets show global/lang/bun
fclt snippets sync --dry-run AGENTS.global.md
```

Use snippets when the same block appears in more than one rendered doc, or when a stable block should be independently targetable by writeback and evolution.

## Instruction Templates

Create a new instruction scaffold with:

```bash
fclt templates init instruction BUN
fclt templates init instruction lang/RUST
```

That writes:

```text
instructions/BUN.md
instructions/lang/RUST.md
```

An instruction can include refs, snippet markers, examples, and writeback targeting guidance. Keep one instruction focused on one reusable domain. For example:

- `BUN.md`: JavaScript runtime/package/test preferences.
- `RUST.md`: Rust formatting, linting, and test preferences.
- `WRITING.md`: voice and editorial rules.
- `VERIFICATION.md`: proof standards.

## Composition Pattern

A global `AGENTS.global.md` can stay short and compose units:

```md
# Global Agent Instructions

For work-unit framing, read `@ai/instructions/WORK_UNITS.md`.
For JS/Bun projects, read `@ai/instructions/BUN.md`.
For Rust projects, read `@ai/instructions/RUST.md`.

<!-- fclty:global/codex/baseline -->
<!-- /fclty:global/codex/baseline -->
```

A project can add narrower guidance:

```md
# Project Agent Instructions

For project test policy, read `@project/instructions/TESTING.md`.
For local deployment rules, read `@project/instructions/DEPLOYMENT.md`.
```

This keeps global defaults reusable and lets projects override or extend them without rewriting the whole global file.

## Evolution

Target the smallest unit that actually needs to change:

- bad or stale domain guidance: update the instruction
- repeated block copied in several docs: extract a snippet
- missing workflow: add or update a skill
- unclear delegation behavior: update an agent
- tool integration gap: update MCP/tool config or create a tooling task
- project-local pattern that proved reusable: promote the asset

Examples:

```bash
fclt ai writeback add --kind missing_context --summary "Bun guidance did not cover test runner selection." --asset instruction:BUN
fclt ai writeback add --kind reusable_pattern --summary "Project testing policy should become a shared verification snippet." --asset @project/instructions/TESTING.md
fclt ai evolve propose
```

Do not create a global proposal for one-off taste. Use writeback to preserve evidence, then evolve when the signal repeats or the missing capability is already clear.

## Review

Use these surfaces:

```bash
fclt list instructions --global
fclt list snippets --global
fclt show instruction:BUN
fclt graph deps AGENTS.global.md
fclt graph dependents @ai/instructions/BUN.md
fclt ai writeback group --by asset
fclt ai evolve list
```

Open `~/.ai/writebacks/` and `~/.ai/evolution/` in a markdown editor to inspect review artifacts with frontmatter status, scope, targets, project metadata, evidence, and proposal state.

## Next

- Read [Writeback and evolution](./writeback-evolution.md) for proposal flow.
- Read [Built-in Pack](./built-in-pack.md) for packaged defaults.
- Use [Command reference](./reference.md) for template and graph commands.
