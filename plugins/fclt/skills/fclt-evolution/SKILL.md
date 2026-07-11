---
name: fclt-evolution
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
fclt ai review reconcile --since <window-start> --until <window-end> --json
fclt ai writeback group --by asset
fclt ai writeback summarize --by domain
fclt ai evolve list
```

For an enabled scheduled loop, inspect its durable queue and observed scheduler
health with `fclt ai loop status --json`. Use `fclt ai loop run --dry-run
--json` for a read-only preview of the latest completed reconciliation. The
full queue is authoritative; the notification delta intentionally suppresses
unchanged items.

2. Assess proposal readiness before mutating state:

```bash
fclt ai evolve assess --asset <selector> --json
```

Use the assessment recommendation as the decision checkpoint:

- `reconcile_sources`: run the bounded read-only source review; writebacks alone cannot prove the window is empty.
- `review_reconciled_signals`: review correlated dispositions and linked work without creating one proposal per ticket.
- `no_mutation`: do not change capability state; ask for a target or evidence.
- `record_more_writeback`: explain what recurrence would justify evolution and record a new writeback only if there is fresh concrete evidence.
- `propose`: ask before running the proposal command, then create the smallest target-specific proposal.
- `review_existing_proposal`: inspect or revise the existing proposal instead of creating a duplicate.

3. Propose only when evidence is strong enough:

```bash
fclt ai evolve propose
```

4. Draft and inspect:

```bash
fclt ai evolve draft EV-00001
fclt ai evolve review EV-00001
```

5. Accept/apply only when scope, target, and evidence are correct:

```bash
fclt ai evolve accept EV-00001
fclt ai evolve apply EV-00001
```

6. Verify the outcome after the producing loop has had a real chance to run:

```bash
fclt ai writeback link WB-00001 --issue TEAM-123
fclt ai writeback disposition WB-00001 --type task --target TEAM-123
fclt ai evolve verify EV-00001 --effectiveness improved --evidence test:post-apply
```

Apply is not completion. Do not resolve source writebacks until post-apply evidence shows the
intended behavior improved. Treat recurrence as unchanged or regressed evidence linked to the same
evolution, not as an unrelated singleton.

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
- Use the operator's task system for executable implementation work that needs owner, priority, or state.
- A no-op answer must still be useful: include the evidence grade, missing signal, next writeback target, and exact approval boundary.
- State the problem, source evidence, reason for the selected target, risk,
  expected outcome, verification plan, assumptions, and undo path before any
  review-producing or mutating action.
- Preview and verify the exact scope. Never overwrite authored capability
  silently or treat generated/rendered output as the canonical target.
- Canonical apply and cross-scope promotion are unavailable through the plugin
  until a transaction-safe API can return tested rollback data. Do not bypass
  that boundary with shell or arbitrary CLI arguments.
- The plugin exposes only closed-schema loop status and preview actions.
  Scheduler enable/disable/run and external tracker mutation remain outside the
  MCP surface.

## Output

- proposals reviewed
- repeated signal
- assessment recommendation
- proposal created or updated
- approvals needed
- apply/reject/no-op rationale
- actual changed records/artifacts, verification result, and recovery route
