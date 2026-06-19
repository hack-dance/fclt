# Writeback and Evolution

Writeback preserves useful signal from real work. Evolution turns repeated signal into reviewable changes.

Use this when normal work exposes the same problem more than once: shallow tests, missing context, stale guidance, a slow tool path, or a missing skill. Ignore it for one-off preferences and vague complaints.

Use this loop when a task exposes durable friction:

1. record one targeted writeback
2. group or summarize related writebacks
3. propose only when the evidence repeats or a missing capability is obvious
4. draft the smallest valid proposal
5. review, accept, and apply when the change is safe

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

## Evolution

Review accumulated signal:

```bash
fclt ai writeback list
fclt ai writeback group --by asset
fclt ai writeback summarize --by kind
fclt ai evolve propose
fclt ai evolve list
```

Draft and review:

```bash
fclt ai evolve draft EV-00001
fclt ai evolve review EV-00001
fclt ai evolve accept EV-00001
fclt ai evolve apply EV-00001
```

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
