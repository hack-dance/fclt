---
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

2. Check current state and exact repair actions:

```bash
fclt --version
fclt paths --json
fclt doctor --json
```

3. For advanced manual recovery, initialize only global capability:

```bash
fclt templates init operating-model --global
```

4. If a repo needs local capability only:

```bash
fclt templates init project-ai
```

5. Refresh pack defaults non-destructively:

```bash
fclt templates init operating-model --global --update --dry-run
fclt templates init operating-model --global --update
```

6. Use `--force` only when the user explicitly wants to replace local edits.

## Rules

- Preserve existing `AGENTS.md`, `CLAUDE.md`, and `AGENTS.global.md` guidance.
- First install should seed from existing agent guidance when available.
- Treat `doctor --json` issues as setup facts, not user-facing blame.
- Treat Codex plugin registration as weaker evidence than fresh-session tool discovery.
- Treat Linear as optional: report it as degraded when absent or unverified without blocking the core loop.
- Prefer temp-root smoke tests for install/update behavior.
- Do not enable managed rendering unless the user wants fclt to write tool homes.

## Output

- current installed version
- setup health
- paths that matter
- commands run
- what changed
- what still needs approval
