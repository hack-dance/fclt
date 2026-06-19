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

1. Check current state:

```bash
fclt --version
fclt paths --json
fclt doctor --json
```

2. If global capability is missing, initialize it:

```bash
fclt templates init operating-model --global
```

3. If a repo needs local capability, initialize project AI:

```bash
fclt templates init project-ai
```

4. Refresh pack defaults non-destructively:

```bash
fclt templates init operating-model --global --update --dry-run
fclt templates init operating-model --global --update
```

5. Use `--force` only when the user explicitly wants to replace local edits.

## Rules

- Preserve existing `AGENTS.md`, `CLAUDE.md`, and `AGENTS.global.md` guidance.
- First install should seed from existing agent guidance when available.
- Treat `doctor --json` issues as setup facts, not user-facing blame.
- Prefer temp-root smoke tests for install/update behavior.
- Do not enable managed rendering unless the user wants fclt to write tool homes.

## Output

- current installed version
- setup health
- paths that matter
- commands run
- what changed
- what still needs approval
