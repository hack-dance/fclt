---
name: fclt-setup
description: Install, update, inspect, and initialize fclt from Codex.
tags: [fclt, setup, codex, onboarding]
---

# fclt-setup

## When To Use
Use this skill when a user wants Codex to install, update, configure, inspect, or repair fclt.

Use it for:

- checking whether `fclt` is installed and current
- initializing global `~/.ai` or project `<repo>/.ai`
- installing or refreshing the built-in operating-model pack
- checking setup health with `doctor`
- finding canonical, generated, runtime, and review paths

## Workflow

1. Bootstrap the complete loop with one idempotent command:

```bash
fclt setup
```

This initializes or safely updates global capability, initializes the current git repository
when present, prepares writeback/evolution review state, and installs the Codex plugin when Codex
is available.

2. Inspect runtime selection and compatibility with `fclt_runtime` action
   `status`. Report the selected executable, version, source, protocol
   compatibility, and fresh-session state.

If no compatible runtime is available, use the staged lifecycle:

- `check` is read-only
- `stage` requires an explicit version and approval, but does not activate it
- `apply` requires approval plus the staged checksum precondition
- `rollback` verifies and restores the retained prior runtime

Never curl-pipe code, use an unverified mutable URL, or replace an existing
global installation silently.

3. Check current setup state and exact repair actions:

```bash
fclt --version
fclt paths --json
fclt doctor --json
```

Through MCP, call `fclt_setup` with an explicit `global` or
`global_and_project` scope. Project setup also requires the exact `cwd`.
Preview is the default; apply requires both `dryRun: false` and
`approve: true`.

4. For advanced manual recovery, initialize global capability when missing:

```bash
fclt templates init operating-model --global
```

5. If a repo needs local capability, initialize project AI:

```bash
fclt templates init project-ai
```

6. Refresh pack defaults non-destructively:

```bash
fclt templates init operating-model --global --update --dry-run
fclt templates init operating-model --global --update
```

7. Use `--force` only when the user explicitly wants to replace local edits.

## Rules

- Preserve existing `AGENTS.md`, `CLAUDE.md`, and `AGENTS.global.md` guidance.
- First install should seed from existing agent guidance when available.
- Treat `doctor --json` issues as setup facts, not user-facing blame.
- Treat Codex plugin registration as weaker evidence than fresh-session tool discovery.
- Treat external trackers as separate integrations. Core readiness depends only on configured local evidence coverage, not a vendor plugin or token.
- Prefer temp-root smoke tests for install/update behavior.
- Do not enable managed rendering unless the user wants fclt to write tool homes.
- Preview before mutation and state the exact global/project/plugin target.
- Do not report a staged runtime or installed plugin as active until the active
  handshake and fresh-session discovery have been verified.

## Output

- current installed version
- setup health
- paths that matter
- commands run
- what changed
- problem, evidence, reason, target, risk, and expected outcome
- verification performed and its actual result
- assumptions and fresh-session state
- exact undo or rollback path
- what still needs approval
