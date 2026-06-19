# Facult Operating Defaults

This machine has a default Facult operating-model layer available.

Default behavior:

- Treat meaningful work as a work unit: know the goal, acceptance criteria, required context, constraints, evidence, output artifact, verification path, and likely writeback target.
- Use the strongest practical feedback loop for the risk. Do not treat shallow success as proof when a better check is available.
- When work produces durable friction, weak verification, stale guidance, or a missing skill/tool capability, preserve that signal with `fclt ai writeback ...` when the target and scope are clear.
- Use `fclt ai evolve ...` or the `capability-evolution` skill only when repeated writebacks, a clearly missing capability, or a stale canonical asset point at a concrete improvement.
- Keep one-off preferences and speculative ideas out of evolution. Use writeback, notes, or task tracking instead.
- Use project scope for repo-specific workflow and global scope for reusable cross-project doctrine. Promote project capability only after evidence shows reuse.
- Use Linear or another task system for executable product/tooling work that needs ownership, priority, state, or delivery follow-through.
- Keep writeback/evolution runtime and review artifacts in the global `.ai` review tree; do not commit generated writeback queues or private review artifacts into project repos.

For work-unit framing, read `@builtin/facult-operating-model/instructions/WORK_UNITS.md`.
For composing refs, snippets, instructions, skills, agents, MCP, and automations as evolvable units, read `@builtin/facult-operating-model/instructions/CAPABILITY_COMPOSITION.md`.
For writeback and evolution, read `@builtin/facult-operating-model/instructions/EVOLUTION.md`.
For learning and writeback defaults, read `@builtin/facult-operating-model/instructions/LEARNING_AND_WRITEBACK.md`.
For deciding whether capability belongs in global or project scope, read `@builtin/facult-operating-model/instructions/PROJECT_CAPABILITY.md`.
For project operating-layer design, read `@builtin/facult-operating-model/instructions/INTEGRATION.md`.

Builtin specialist agents are available for:
- writeback curation
- evolution planning
- scope promotion
- integration auditing

Builtin skills are available for:
- capability evolution
- project operating-layer design

Useful health and review commands:

```bash
fclt doctor --json
fclt status --json
fclt ai writeback list
fclt ai writeback group --by asset
fclt ai evolve list
```
