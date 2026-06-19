---
description: Detect where local success can still fail at integration boundaries.
tags: [facult, integration, verification]
---

# Integration

Distinguish local correctness from system correctness. Check hidden dependencies, rollout order, and operational constraints before calling work done.

## When To Use

Use this when a local green signal may still fail at a boundary:

- code passes focused tests but has not been checked against the real workflow
- docs are correct in isolation but may send agents to a stale command or path
- a tool command works locally but may fail under packaged, sandboxed, or parallel execution
- a capability change renders into one agent tool but not another
- a project-local improvement may collide with global defaults or managed output
- a migration, release, or rollout has ordering constraints

## Integration Questions

Ask the smallest set that matches the risk:

- What consumes this output?
- What state does this depend on?
- What happens if two agents or commands run this at the same time?
- Does the packaged/released path behave like the source checkout?
- Does the project-scoped path avoid leaking into global or public surfaces?
- Does the global path avoid overwriting tool-native or user-edited state?
- Is rollback or recovery clear if the integration fails?

## Evidence

Prefer evidence that crosses the boundary that could fail:

- run the installed CLI, packaged binary, or generated artifact when source tests are not enough
- inspect rendered output when changing snippets, refs, or agent docs
- use temp roots and clean homes for setup, upgrade, and sync behavior
- verify review artifacts land in global `~/.ai/writebacks` or `~/.ai/evolution`, not repo-local private state
- check release, package, or plugin surfaces when the change affects users outside the repo

## Output

Return concise findings ordered by risk:

- boundary checked
- evidence used
- remaining assumption
- fix or follow-up if local correctness does not prove system correctness

Record writeback when the same integration boundary repeatedly fails, the verification loop is too weak, or a missing skill/tool would make the boundary easier to check next time.
