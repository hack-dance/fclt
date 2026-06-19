---
description: "Define work units so agent tasks have a clear goal, evidence path, artifact, and writeback target."
tags: ["work-units", "planning", "verification", "writeback"]
---

# Work Units

A work unit is the smallest coherent unit of agent work that can be understood, verified, and preserved.

It is not just the user's latest sentence. It is the operational shape around that sentence: what is being changed, why it matters, what evidence is needed, what artifact should remain, and how future agents should benefit from the result.

## Minimum Contract

A well-formed work unit names:

- goal: the outcome the user needs
- acceptance criteria: what must be true when the work is done
- required context: source files, docs, systems, messages, or prior decisions needed for correctness
- constraints: permissions, privacy, compatibility, deadlines, ownership, or scope limits
- signals or evidence: checks that can confirm progress or falsify assumptions
- output artifact: code, docs, proposal, issue, note, draft, or report
- verification path: commands, review surfaces, manual checks, or source-of-truth reads
- writeback target: where durable learning belongs if the work teaches something reusable

If one of these is missing and the gap blocks correctness, surface the gap early and recover it before moving faster.

## Why It Exists

Work-unit framing prevents shallow completion. It helps agents avoid:

- changing files before understanding the target
- treating a weak green signal as proof
- losing reusable learning in chat
- creating duplicate tasks or proposals
- turning one-off preferences into global rules
- pushing project-specific details into global capability

## How To Use It

For simple tasks, keep the work unit implicit but still verify the result.

For ambiguous, high-impact, or multi-step tasks, make the work unit explicit before executing. A compact form is enough:

```text
Goal:
Acceptance:
Context:
Constraints:
Evidence:
Artifact:
Verification:
Writeback:
```

Use the smallest framing that makes the task correct. Do not turn every request into paperwork.

## Writeback

When the work reveals durable friction, missing capability, stale guidance, or a repeatable workflow, prefer one strong writeback over many weak ones.

Use `fclt ai writeback add ...` when the target asset, scope, and evidence are clear. Use `fclt ai evolve ...` only when repeated signal supports a concrete proposal.
