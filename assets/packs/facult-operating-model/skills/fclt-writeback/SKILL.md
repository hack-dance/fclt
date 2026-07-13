---
description: Record and review durable writeback from real agent work.
tags: [facult, writeback, learning, feedback-loop]
---

# fclt-writeback

## When To Use

Use this skill when work reveals durable friction, missing context, weak verification,
stale guidance, repeated success, or a capability gap.

Writeback is for preserving reusable signal. It is not for every preference or one-off
annoyance.

## Workflow

1. Choose project scope when the learning depends on a repo, architecture, test harness,
   or team workflow. Choose global scope for broadly reusable learning.
2. Target the smallest affected instruction, snippet, skill, agent, MCP/tool config, or
   automation.
3. Record concrete evidence:

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
- Capture a concise observation, impact, attempted workaround, desired outcome,
  evidence reference, and sensitivity when those fields add real context.
- Never capture hidden chain-of-thought, raw transcripts, unbounded logs,
  secrets, tokens, or credential-bearing payloads. Reference redacted external
  evidence instead.
- Do not copy private project detail into global writebacks.
- Use task tracking for executable product work; use writeback for reusable operating-layer
  learning.
- Hand repeated, target-specific signal to the capability-evolution workflow.

## Output

- writeback id or no-op rationale
- scope and target asset
- evidence summary
- whether the signal is ready for evolution
