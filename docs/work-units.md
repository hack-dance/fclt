# Work Units

A work unit is a governed unit of agent work. It gives a task enough shape to be executed, checked, integrated, and learned from.

This is broader than capability evolution. Use work-unit framing for coding, research, docs, operations, setup, debugging, product work, and AI capability updates whenever the task has meaningful ambiguity or risk.

## Minimum Shape

A useful work unit names:

- goal: the outcome needed
- acceptance criteria: what must be true at the end
- context: source files, systems, docs, messages, or decisions needed for correctness
- constraints: privacy, permissions, compatibility, deadlines, ownership, and scope limits
- evidence: checks that confirm progress or falsify assumptions
- artifact: code, docs, issue, note, draft, proposal, report, or rendered output
- verification: command, review surface, manual check, or source-of-truth read
- writeback target: where durable learning belongs if the work teaches something reusable

Keep this implicit for trivial work. Make it explicit when the task is ambiguous, stateful, high-impact, cross-tool, or likely to create reusable learning.

## Why It Matters

Machine execution makes output cheaper. That does not remove the governance problem. It moves pressure into intent, context, review, integration, memory, and feedback.

Work units are the object that keeps those pieces attached. Without them, agents can produce more output while leaving humans to reconstruct what changed, why it changed, what evidence exists, and what should improve next time.

With them:

- the agent knows what done means
- verification is chosen before the final claim
- integration risk is visible
- writeback has evidence and a target
- repeated friction can become evolution instead of folklore

## How It Connects To fclt

`fclt` ships work-unit guidance in the built-in operating-model pack:

```text
@builtin/facult-operating-model/instructions/WORK_UNITS.md
@builtin/facult-operating-model/snippets/global/core/work-units.md
```

Install it into a canonical root:

```bash
fclt templates init operating-model --global
```

Then agents can read the same guidance from `~/.ai/instructions/WORK_UNITS.md`, and rendered global agent files can include the work-unit snippet.

## Examples

Coding work:

```text
Goal: fix a failing checkout test
Acceptance: the focused test and relevant integration path pass
Context: failing output, checkout code, recent commits
Constraints: preserve public API and user data behavior
Evidence: test output plus inspected changed path
Artifact: code diff and summary
Verification: command output and integration check
Writeback: only if the failure exposes reusable stale guidance
```

Research work:

```text
Goal: answer a product or technical question
Acceptance: answer is current, source-backed, and separates facts from inference
Context: user question, relevant docs, date sensitivity
Constraints: use primary sources when accuracy depends on them
Evidence: source links and consistency check
Artifact: concise answer or research note
Verification: source freshness and source agreement
Writeback: durable note if the answer will recur
```

Capability evolution:

```text
Goal: decide whether writebacks justify changing capability
Acceptance: proposal exists only when repeated evidence or a clear gap supports it
Context: grouped writebacks, current target asset, project/global scope
Constraints: avoid proposal noise and private leakage
Evidence: writeback ids and affected work units
Artifact: proposal, applied change, rejection, or no-op note
Verification: target, scope, proposal kind, and rendered/review artifact
Writeback: only for new meta-learning about the evolution loop
```

## Background

The framing is related to the production-model argument in [Governing the Machine](https://www.hack.dance/writing/governing-the-machine): as more work becomes machine-mediated, the hard problem shifts from producing output to governing work, evidence, memory, and improvement.
