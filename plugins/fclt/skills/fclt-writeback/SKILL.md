---
name: fclt-writeback
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
fclt ai writeback add \
  --kind missing_context \
  --category opportunity \
  --summary "Project verification guidance was not discoverable" \
  --details "The task had to reconstruct the command from CI configuration" \
  --impact "Verification took longer and could have selected the wrong harness" \
  --attempted-workaround "Inspected package scripts and CI" \
  --desired-outcome "The supported verification command is available at task start" \
  --sensitivity internal \
  --evidence session:<id> \
  --asset @project/instructions/TESTING.md
```

4. Review current signal:

```bash
fclt ai writeback list
fclt ai writeback group --by asset
fclt ai writeback summarize --by domain
fclt ai loop activity --project
```

## Rules

- Prefer one high-signal writeback over several weak ones.
- Include concrete evidence when possible.
- Capture concise context, impact, attempted workaround, desired outcome, and
  sensitivity when they improve review quality.
- Never capture hidden chain-of-thought, raw transcripts, unbounded logs,
  secrets, tokens, or credential-bearing payloads. Reference the smallest
  redacted external evidence identifier instead.
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
