---
description: Convert repeated writeback into concrete fclt capability proposals.
tags: [facult, evolution, writeback]
---

# capability-evolution

## When To Use
Use this skill when the same missing guidance, weak loop, or recurring win appears often enough that the AI system itself should probably change.

## Scope Decision

Choose `project` when the behavior depends on repo-local architecture or workflow.

Choose `global` when the behavior is broadly reusable.

If unsure, start at project scope and promote later with evidence.

## Working Flow

1. record the strongest writeback
2. group or summarize repeated signal
3. choose the smallest valid proposal kind
4. draft the proposal
5. accept only after the target and scope are correct
6. apply only when the markdown target is the intended canonical asset

Use:

```bash
fclt ai writeback add ...
fclt ai writeback group --by asset
fclt ai writeback summarize --by domain
fclt ai evolve propose
fclt ai evolve draft EV-00001
fclt ai evolve draft EV-00001 --append "tighten the rule with a concrete verification step"
fclt ai evolve accept EV-00001
fclt ai evolve apply EV-00001
```

## Proposal Kind Selection

- `update_asset` for tightening existing guidance
- `create_asset` for missing instructions or docs
- `extract_snippet` for reusable partial guidance
- `add_skill` for reusable workflow instruction
- `promote_asset` for project-to-global promotion

## Output Contract
- repeated signal
- proposed asset change
- target scope
- evidence
- smallest useful next step
