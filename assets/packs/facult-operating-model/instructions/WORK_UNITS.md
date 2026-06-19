---
description: "Define work units so agent tasks have a clear goal, evidence path, artifact, and writeback target."
tags: ["work-units", "planning", "verification", "writeback"]
---

# Work Units

A work unit is the smallest coherent unit of agent work that can be understood, verified, and preserved.

It is not just the user's latest sentence. It is the operational shape around that sentence: what is being changed, why it matters, what evidence is needed, what artifact should remain, and how future agents should benefit from the result.

Use work units for ordinary work, not only for capability updates. Coding changes, research answers, documentation edits, operational triage, setup repair, design reviews, and capability evolution all benefit from the same shape when the task has real uncertainty or risk.

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

For low-risk one-step work, keep the contract implicit. For ambiguous, high-impact, cross-tool, stateful, or multi-step work, make the contract explicit before executing.

## Why It Exists

Work-unit framing prevents shallow completion. It helps agents avoid:

- changing files before understanding the target
- treating a weak green signal as proof
- losing reusable learning in chat
- creating duplicate tasks or proposals
- turning one-off preferences into global rules
- pushing project-specific details into global capability
- producing output faster than the system can review, integrate, or learn from it

The point is not paperwork. The point is to attach machine work to intent, context, evidence, and memory so that useful learning can change future work instead of disappearing into chat history.

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

## Examples

Coding:

```text
Goal: fix the failing login test
Acceptance: test passes and no auth regression is introduced
Context: failing test output, auth middleware, recent commits
Constraints: preserve public API
Evidence: focused test, relevant integration test
Artifact: code diff and concise summary
Verification: command output and changed behavior
Writeback: only if the failure exposes stale test or auth guidance
```

Research:

```text
Goal: answer a source-backed product question
Acceptance: answer cites current primary sources
Context: user question, relevant docs, dates
Constraints: distinguish verified facts from inference
Evidence: source links and quotes within fair-use limits
Artifact: answer or research note
Verification: source freshness and consistency check
Writeback: durable note if the finding will recur
```

Capability evolution:

```text
Goal: decide whether repeated writebacks justify a proposal
Acceptance: proposal exists only if evidence repeats or a capability is clearly missing
Context: grouped writebacks, target asset, current canonical guidance
Constraints: avoid global noise and private leakage
Evidence: writeback IDs and affected work units
Artifact: accepted proposal, rejected proposal, or no-op note
Verification: proposal kind, scope, target, and review artifact
Writeback: only for new meta-learning about the evolution process
```

## Writeback

When the work reveals durable friction, missing capability, stale guidance, or a repeatable workflow, prefer one strong writeback over many weak ones.

Use `fclt ai writeback add ...` when the target asset, scope, and evidence are clear. Use `fclt ai evolve ...` only when repeated signal supports a concrete proposal.
