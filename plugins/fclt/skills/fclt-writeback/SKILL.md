---
description: Record and review fclt writebacks from real agent work.
tags: [fclt, writeback, learning, feedback-loop]
---

# fclt-writeback

## When To Use
Use this skill when work reveals durable friction, missing context, weak verification, stale guidance, repeated success, or a capability gap.

Writeback is for preserving signal. It is not for every preference or one-off annoyance.

## Workflow

1. Decide scope:

- `project` when the learning depends on a repo, test harness, architecture, or workflow.
- `global` when the learning applies across projects or shared tool behavior.

2. Choose the smallest target:

- instruction
- snippet
- skill
- agent
- MCP/tool config
- automation

3. Record writeback when the target and evidence are clear:

```bash
fclt ai writeback add --kind missing_context --summary "..." --asset @project/instructions/TESTING.md
```

4. Review current signal:

```bash
fclt ai writeback list
fclt ai writeback group --by asset
fclt ai writeback summarize --by domain
```

## Rules

- Prefer one high-signal writeback over several weak ones.
- Include concrete evidence when possible.
- Do not copy private project detail into global writebacks.
- Use task tracking for executable product/tooling work; use writeback for reusable operating-layer learning.
- If the same signal repeats and the target is clear, hand off to `fclt-evolution`.
- State the observed problem, evidence, target, reason, expected outcome, and
  assumptions before recording.
- Do not capture secrets, private tokens, or raw sensitive payloads as evidence.
- For lifecycle mutations, use an explicit scope and expected prior state.
  Report the journal/review evidence and the available undo transition.

## Output

- writeback id or no-op rationale
- scope
- target asset
- evidence summary
- whether this is ready for evolution
- risk class and approval boundary
- actual changed records/artifacts
- verification result and recovery route
