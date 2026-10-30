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

1. Choose project scope when the learning depends on a repo, architecture, test harness,
   or team workflow. Choose global scope for broadly reusable learning.
2. Target the smallest affected instruction, snippet, skill, agent, MCP/tool config, or
   automation.
3. Record concrete evidence when state mutation is authorized:

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

Verify the producing workflow before resolving source writebacks; applying a change alone does not prove effectiveness.
