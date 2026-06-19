---
description: Turn repeated fclt writebacks into reviewed capability changes.
tags: [fclt, evolution, proposals, capability]
---

# fclt-evolution

## When To Use
Use this skill when repeated writebacks, stale canonical assets, or a clearly missing capability should become a concrete proposal.

Do not use it for a single weak preference or speculative idea.

## Workflow

1. Review signal:

```bash
fclt ai writeback group --by asset
fclt ai writeback summarize --by domain
fclt ai evolve list
```

2. Propose only when evidence is strong enough:

```bash
fclt ai evolve propose
```

3. Draft and inspect:

```bash
fclt ai evolve draft EV-00001
fclt ai evolve review EV-00001
```

4. Accept/apply only when scope, target, and evidence are correct:

```bash
fclt ai evolve accept EV-00001
fclt ai evolve apply EV-00001
```

## Proposal Kinds

- `update_asset`
- `create_asset`
- `extract_snippet`
- `add_skill`
- `promote_asset`

## Rules

- Prefer the smallest valid proposal kind.
- Keep project-specific behavior project-scoped until reuse is proven.
- Ask for approval before applying global instructions, global skills, plugin behavior, or other broad shared surfaces.
- Reject or park proposals that are stale, duplicated, vague, or unsupported.
- Use Linear or another task system for executable implementation work that needs owner, priority, or state.

## Output

- proposals reviewed
- repeated signal
- proposal created or updated
- approvals needed
- apply/reject/no-op rationale
