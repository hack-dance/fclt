---
description: Preserve durable signal and record writeback when the operating layer should learn.
tags: [facult, learning, writeback]
---

# Learning And Writeback

Use this when work produces a durable decision, failure, success pattern, or missing guardrail that should outlive the current task.

## Default Behavior

The normal path should be agent-driven.

If you can clearly answer:

- what was learned
- why it matters
- where it should land
- whether it belongs in `project` or `global`

then record the writeback instead of only suggesting that someone should do it later.

Use:

```bash
fclt ai writeback add --kind <kind> --summary "<summary>" --asset <asset-selector>
```

## Record Writeback When

- the same failure or weak loop appears again
- a reusable success pattern shows up
- guidance is clearly stale or missing
- a repo-local behavior probably belongs in project capability
- a cross-project behavior probably belongs in global capability

## Do Not Record Writeback For

- one-off annoyance with no durable value
- weak commentary with no target
- speculative ideas without evidence
- duplicate noise with no new signal

## Follow Through

- prefer one strong writeback over many weak ones
- mention the writeback id when summarizing what changed
- escalate to `capability-evolution` or `fclt ai evolve ...` only when the signal is repeated or clearly points at a durable capability change
