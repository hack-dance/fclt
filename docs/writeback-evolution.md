# Writeback and Evolution

Writeback preserves useful signal from real work. Evolution turns repeated signal into reviewable changes.

Use this when normal work exposes the same problem more than once: shallow tests, missing context, stale guidance, a slow tool path, or a missing skill. Ignore it for one-off preferences and vague complaints.

For a new CLI or Codex-plugin install, initialize the whole loop first:

```bash
fclt setup
fclt doctor --json
```

The doctor report's `loop` object is the readiness contract. Core setup can be ready while optional
Linear issue lookup is `not_configured` or `configured_unverified`; that integration state is never
silently treated as successful.

Use this loop when a task exposes durable friction:

1. record one targeted writeback
2. group or summarize related writebacks
3. propose only when the evidence repeats or a missing capability is obvious
4. draft the smallest valid proposal
5. review, accept, and apply when the change is safe
6. verify whether the producing loop improved before resolving the source signal

## Writeback

Record writeback when the signal is durable and targetable:

```bash
fclt ai writeback add \
  --kind weak_verification \
  --summary "Checks were too shallow" \
  --asset instruction:VERIFICATION
```

Useful kinds:

- `weak_verification`
- `false_positive`
- `missing_context`
- `reusable_pattern`
- `capability_gap`
- `bad_default`

Avoid writeback for one-off preferences, vague complaints, or speculative ideas.

Link implementation work and preserve the review disposition:

```bash
fclt ai writeback link WB-00021 --issue HACK-791
fclt ai writeback disposition WB-00021 \
  --type task \
  --target HACK-791 \
  --expected-outcome "The producing loop stops repeating unchanged blocker prose" \
  --next-trigger "Implementation ships and the next review window completes"
```

Issue links are evidence and routing destinations, not capability assets. Group tickets by the
underlying friction or reusable success rather than creating one writeback per ticket.

## Evolution

Review accumulated signal:

```bash
fclt ai writeback list
fclt ai writeback group --by asset
fclt ai writeback summarize --by kind
fclt ai evolve assess --asset instruction:VERIFICATION --json
fclt ai evolve propose
fclt ai evolve list
```

Use `assess` as the read-only gate for agent-led review UI. It returns a recommendation (`no_mutation`, `record_more_writeback`, `propose`, or `review_existing_proposal`), source writeback ids, active proposal ids, a quality checklist, suggested commands, and the next agent instruction.

For a single weak or medium-confidence writeback, the right answer is usually more evidence, not a proposal. A useful no-op still explains what recurrence would change the decision and where the next writeback should land.

Draft and review:

```bash
fclt ai evolve draft EV-00001
fclt ai evolve review EV-00001
fclt ai evolve accept EV-00001
fclt ai evolve apply EV-00001
fclt ai evolve verify EV-00001 \
  --effectiveness improved \
  --evidence test:post-apply-regression \
  --note "The producing loop no longer repeats the failure"
```

Applying a proposal moves its source writebacks into an awaiting-verification state. Verification
then records one of `improved`, `unchanged`, `regressed`, or `inconclusive`. Improved evidence
resolves the writebacks; unchanged or regressed evidence returns them to the pending queue;
inconclusive evidence keeps them under watch.

Proposal creation does not promote source writebacks. Rejecting a proposal restores any legacy
promoted source writebacks to pending. Draft revisions for append-style proposals are included in
the actual target patch, not only in review history.

Supported durable proposal kinds include:

- `update_asset`
- `create_asset`
- `extract_snippet`
- `add_skill`
- `promote_asset`

Use the smallest kind that solves the repeated problem.

## Scope

Use project scope for repo-specific tooling, tests, architecture, and workflows.

Use global scope for shared doctrine, reusable skills, shared agents, or cross-project capability gaps.

Promote project proposals to global only after repeated reuse:

```bash
fclt ai evolve promote EV-00003 --to global --project
```

## Review Artifacts

Runtime JSON queues, proposal metadata, draft patches, and journals stay in machine-local `fclt` state.

Human-readable Markdown mirrors live under global `~/.ai`:

```text
~/.ai/writebacks/global/
~/.ai/writebacks/projects/<slug-hash>/
~/.ai/evolution/global/
~/.ai/evolution/projects/<slug-hash>/
```

Project-scoped artifacts include project metadata in frontmatter. They do not get written into repo-local `<repo>/.ai/writebacks` or `<repo>/.ai/evolution`.

## Approval Rule

Global instructions, skills, plugins, and other high-risk shared surfaces require explicit review before apply. Project-scoped additive markdown changes can be lower risk, but still need evidence and a clear target.

Executable product or tooling work belongs in the task system. Use evolution for the reusable instruction, skill, prompt, or operating-model change that should survive that work.

## Next

- Read [Composable Capability](./composable-capability.md) to choose the smallest target.
- Read [Automations](./automations.md) to schedule recurring review loops.
- Read [Security and trust](./security-trust.md) before applying global changes.
