---
name: fclt-writeback
description: Record and review fclt writebacks from real agent work.
tags: [fclt, writeback, learning, feedback-loop]
---

# fclt-writeback

## When To Use
Use this skill when work reveals durable friction, missing context, weak verification, stale guidance, repeated success, or a capability gap.

Writeback is for preserving signal. It is not for every preference or one-off annoyance.

## Authorization

Proceed with recording or drafting when the current request authorizes that action and scope;
do not request the same approval again. For read-only or proposal-only work, return findings or a
proposed writeback without changing state. Strong evidence alone does not grant write authority.

Recording or drafting does not authorize canonical application, cross-scope promotion, external
messages, tracker changes, publishing, or scheduler activation. Preserve those separate gates and
native authorization. Keep unchanged, non-actionable scheduled results quiet unless periodic
reports were requested.

## Workflow

Writeback commands resolve linked Git worktrees to the canonical enrolled checkout.
Scratch clones also use that checkout when their normalized `origin` remote matches.
Without active enrollment, a Git repo uses the global store and adds a
`project:<remote-or-repo-name-and-path-hash>` tag; it does not create a project store.
An explicit `--project` fallback warns with the destination and tag. Bare-repo
worktrees and worktrees without a usable main checkout also use this fallback.
Fallback `--asset` selectors must resolve in the global graph; unindexed repository
files are rejected. Omit `--asset` to record a tagged observation without a target.
Global evolution never treats `@project/` references as global files.
Keep sensitive project details out of global records. Explicit `--global`, `--root`,
and applicable environment root selections retain precedence. If several enrolled
checkouts match an origin, writes require an explicit `--root`; reads use the global
store with a warning. Writeback, evolve, and review commands share this resolution.
Historical queues remain accessible with `--root <old-checkout>/.ai`; they are not
automatically merged or removed. An unenrolled submodule stays separate from its
enrolled superproject.

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

3. Record writeback when the target, evidence, and authorization are clear:

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


Verify the producing workflow before resolving source writebacks; applying a change alone does not prove effectiveness.
