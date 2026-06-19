---
description: Turn repeated signal into concrete capability changes.
tags: [facult, evolution, writeback]
---

# Evolution

Use writeback and evolution to improve the AI operating layer itself.

Evolution is the synthesis and change side of the feedback loop. It turns accumulated writebacks, repeated tool friction, stale canonical assets, or clearly missing capability into small reviewable changes to instructions, skills, snippets, agents, or other markdown canonical assets.

## When To Record Writeback

Record writeback when one of these is true:

- the same failure repeats
- the same success pattern repeats
- guidance is stale or missing
- a prompt or loop has to be restated often
- a project-specific pattern looks reusable

Do not record low-signal noise:

- one-off annoyance with no reuse value
- generic "could be better" commentary
- duplicate observations with no new evidence

The intended default is that agents record strong writebacks themselves when the signal is clear enough, rather than only recommending that a user do it manually later.

Do not wait for a weekly review to preserve high-signal evidence. Do wait for repeated evidence or a clearly missing capability before drafting a proposal.

## Scope

Choose `project` scope when the learning depends on:

- repo architecture
- team workflow
- project tooling
- local testing or verification behavior

Choose `global` scope when the learning is reusable across projects.

Promote from project to global only after repeated reuse or strong evidence.

## Writeback Kinds

Common kinds:

- `weak_verification`
- `false_positive`
- `missing_context`
- `reusable_pattern`
- `capability_gap`
- `bad_default`

Every good writeback should try to include:

- a concrete summary
- the best target asset if known
- the right scope
- domain or tags when useful

## Operator Flow

Typical workflow:

```bash
fclt ai writeback add --kind weak_verification --summary "Checks were too shallow" --asset instruction:VERIFICATION
fclt ai writeback group --by asset
fclt ai writeback summarize --by domain
fclt ai evolve propose
fclt ai evolve draft EV-00001
fclt ai evolve accept EV-00001
fclt ai evolve apply EV-00001
```

Use `fclt ai evolve draft <id> --append "..."` to revise a draft while preserving draft history.

Review surfaces:

- open `~/.ai/writebacks/` and `~/.ai/evolution/` in a Markdown editor for frontmatter-rich global and project-scoped review artifacts
- `fclt status --json` for queue/proposal paths, review artifact paths, counts, and active scope
- `fclt ai writeback list|show|group|summarize` for raw and clustered signal
- `fclt ai evolve list|show|review` for proposal state without applying changes
- `fclt templates init automation learning-review` for recurring capture/review
- `fclt templates init automation evolution-review` for recurring proposal review
- `fclt templates init automation tool-call-audit` for repeated tool-friction review

Evolution proposal metadata, markdown drafts, patch artifacts, writeback queues,
and journals are runtime state. `fclt` stores JSON queues, proposal records,
draft refs, patches, and journals in machine-local Facult state. It mirrors
human-readable review artifacts into global `~/.ai/writebacks/...` and
`~/.ai/evolution/...`, including project-scoped artifacts under
`projects/<slug-hash>/` with cwd/project metadata in frontmatter. Canonical
assets in `~/.ai` or `<repo>/.ai` should only change when a proposal is applied.

## Default Agent Behavior

Use the smallest action that fits the signal:

1. record one strong writeback when there is a clear durable learning
2. use `writeback-curator` when the target, kind, or scope is ambiguous
3. use `capability-evolution` or `evolution-planner` when repeated signal should become a proposal
4. do not draft or apply proposals just because a writeback exists; require repeated evidence or a clearly missing capability

Avoid creating writeback/evolution noise for one-off nits, vague preferences, or speculative ideas without evidence.

When the friction is executable product/tooling work that needs ownership,
priority, state, or implementation follow-through, create or update a real task
system item instead of forcing it into capability evolution. Use evolution for
the reusable operating-layer change.

## Proposal Kinds

Current supported proposal kinds:

- `update_asset`
- `create_asset`
- `extract_snippet`
- `add_skill`
- `promote_asset`

Use the smallest durable change that fits the evidence.

## Review And Apply Rules

- draft before apply
- accept before apply
- prefer the smallest safe change
- keep reviewable evidence tied to source writebacks
- do not globalize project behavior too early
- do not apply high-risk global instruction, skill, plugin, or shared-tool changes without explicit review/approval

Apply is for markdown canonical assets only. If the target is wrong, revise the proposal rather than forcing it through.
