---
description: Preserve durable signal and record writeback when the operating layer should learn.
tags: [facult, learning, writeback]
---

# Learning And Writeback

Use this when work produces a durable decision, failure, success pattern, or missing guardrail that should outlive the current task.

This is the capture side of the feedback loop. The goal is to let normal agent work produce reusable signal without requiring a human to manually restate every friction point later.

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
fclt ai writeback add \
  --kind <kind> \
  --category <friction|opportunity|reusable-success> \
  --summary "<one-sentence observation>" \
  --details "<concise context>" \
  --impact "<why it mattered>" \
  --attempted-workaround "<what was tried, if anything>" \
  --desired-outcome "<what better looks like>" \
  --sensitivity <public|internal|private> \
  --evidence <type:ref> \
  --asset <asset-selector>
```

Keep the capture concise and factual. Preserve decision rationale as a short
explanation of the observed evidence and selected disposition. Never record
hidden chain-of-thought, raw transcripts, unbounded logs, secrets, tokens, or
credential-bearing payloads. Store logs in their existing system and reference
the smallest redacted evidence identifier that lets a reviewer retrieve them.

Sensitivity controls supplemental context in portable review surfaces:

- `public`: generic context that is safe to show broadly
- `internal`: context for the exact local/project review surface; this is the default
- `private`: keep the actionable summary, but omit supplemental context from portable artifacts and tools

Sensitivity is not a secret store. Secret-shaped values are redacted at the
writeback boundary regardless of the selected sensitivity.

The writeback queue is runtime state, not canonical source. `fclt` stores JSON
queue state in machine-local `fclt` state so sandboxed agents can record durable
friction without mutating canonical assets unless an evolution proposal is later
reviewed and applied.

Every writeback also refreshes a Markdown review artifact under the global
`~/.ai/writebacks/...` tree. Global signal lands in `~/.ai/writebacks/global/`;
project-scoped signal lands in `~/.ai/writebacks/projects/<slug-hash>/` with
frontmatter for scope, project root, cwd, target asset, status, tags, evidence,
and timestamps. Do not write writeback review artifacts into a repo-local `.ai`;
repo-local state should contribute project metadata and evidence, not bundled
private review files.

Project-scoped writebacks should usually be recorded from the repo that produced
the evidence. Global writebacks should be reserved for shared doctrine, shared
skills, shared agents, tool behavior, or cross-project capability gaps.

Target the smallest composable unit that explains the friction:

- instruction: domain guidance, preferences, verification rules, or review doctrine
- snippet: repeated markdown block used by more than one rendered doc
- skill: workflow execution steps or examples
- agent: delegated role behavior
- MCP/tool config: tool interface, auth shape, or rendered integration
- automation: scheduled review loop, cadence, prompt, or memory

## Record Writeback When

- the same failure or weak loop appears again
- a reusable success pattern shows up
- guidance is clearly stale or missing
- a repo-local behavior probably belongs in project capability
- a cross-project behavior probably belongs in global capability
- a skill, tool, MCP, plugin, automation, or instruction gap repeatedly slows work down
- an agent has to restate the same workaround, verification rule, or review rule
- a repeated preference should become an atomic user-owned instruction or project-specific testing policy

## Do Not Record Writeback For

- one-off annoyance with no durable value
- weak commentary with no target
- speculative ideas without evidence
- duplicate noise with no new signal

## Follow Through

- prefer one strong writeback over many weak ones
- mention the writeback id when summarizing what changed
- escalate to `capability-evolution` or `fclt ai evolve ...` only when the signal is repeated or clearly points at a durable capability change
- use `fclt ai writeback group --by asset` or `fclt ai writeback summarize --by domain` to review accumulated signal before proposing broad changes
- use `fclt ai loop activity --project` (or `--global`) for the readable latest activity snapshot; use `--json` for downstream UI
- use scheduled `learning-review`, `evolution-review`, or `tool-call-audit` automations when the signal should be reviewed in the background
