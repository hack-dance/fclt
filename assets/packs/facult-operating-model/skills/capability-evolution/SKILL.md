---
description: Convert repeated writeback into concrete fclt capability proposals.
tags: [facult, evolution, writeback]
---

# capability-evolution

## When To Use
Use this skill when the same missing guidance, weak loop, or recurring win appears often enough that the AI system itself should probably change.

Do not wait for a human operator by default if the signal is already clear and the environment permits local AI runtime state to be updated.

Use writeback first when the signal is useful but not yet repeated. Use evolution when accumulated writebacks, repeated tool friction, or a clearly missing capability point at a specific target asset or new capability.

The goal is a governed feedback loop: work creates evidence, evidence produces writeback, repeated writeback becomes a small reviewed proposal, and accepted proposals change future agent behavior.

## Scope Decision

Choose `project` when the behavior depends on repo-local architecture or workflow.

Choose `global` when the behavior is broadly reusable.

If unsure, start at project scope and promote later with evidence.

Reject global scope when the proposal depends on private examples, one repo's architecture, a single user's temporary preference, or a workflow that has not repeated.

## Working Flow

1. Read current writebacks and existing proposals.
2. Group or summarize repeated signal by asset, kind, and scope.
3. Check the current target asset before proposing a change.
4. Choose the smallest valid proposal kind.
5. Draft the proposal with evidence and intended target.
6. Accept only after the target and scope are correct.
7. Apply only when the markdown target is the intended canonical asset.

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

For background review loops, use:

```bash
fclt templates init automation learning-review
fclt templates init automation evolution-review
fclt templates init automation tool-call-audit
```

If there is not yet enough repeated signal for evolution, record the writeback and stop there.

Do not create a proposal only to preserve an idea. Preserve the idea as writeback, notes, or task tracking unless it has enough evidence to change capability.

## Proposal Kind Selection

- `update_asset` for tightening existing guidance
- `create_asset` for missing instructions or docs
- `extract_snippet` for reusable partial guidance
- `add_skill` for reusable workflow instruction
- `promote_asset` for project-to-global promotion

Use task tracking instead of evolution when the main work is an executable tool or product fix that needs an owner, priority, state, or delivery plan. Use evolution for the reusable instruction, skill, or operating-model change that should survive that fix.

## Review Criteria

Before accept/apply, verify:

- evidence is repeated or the missing capability is obvious
- the proposal targets the smallest affected unit
- project/global scope is correct
- private or project-specific examples are not leaking into global assets
- the patch changes canonical markdown assets, not generated runtime state
- the resulting behavior can be verified by reading, rendering, indexing, or running the relevant command

## Output Contract
- repeated signal
- proposed asset change
- target scope
- evidence
- smallest useful next step
- approval or no-op rationale
