# Global Agent Instructions

## Working mode

<!-- fclty:global/baseline -->
<!-- /fclty:global/baseline -->

<!-- fclty:global/core/work-units -->
<!-- /fclty:global/core/work-units -->

<!-- fclty:global/core/feedback-loops -->
<!-- /fclty:global/core/feedback-loops -->

<!-- fclty:global/core/verification -->
<!-- /fclty:global/core/verification -->

<!-- fclty:global/core/writeback -->
<!-- /fclty:global/core/writeback -->

## Shared instruction sources

- For coding work, first read ${refs.coding_general}.
- For Bun-based projects or Bun commands, read ${refs.bun_rule}.
- For substantive writing and editorial work, read ${refs.writing_rule}.
- For work-unit definition and scope clarification, read ${refs.work_units}.
- For identifying, improving, and validating feedback loops, read ${refs.feedback_loops}.
- For verification and anti-false-positive checks, read ${refs.verification}.
- For learning, decisions, and writeback, read ${refs.learning_writeback}.
- For capability evolution, proposal kinds, and `facult ai` workflow, read ${refs.evolution}.
- For deciding whether something belongs in global or project scope, read ${refs.project_capability}.

## Layering

- Treat this file as the global baseline.
- Treat repo-level `AGENTS.md` files as more specific additions layered after this file.
- Repo-level files may add or refine project-specific behavior, but they should not weaken global defaults for rigor, verification, or writeback discipline.
- If a closer `AGENTS.override.md` exists, follow it as the most specific instructions file in that directory while still preserving the global baseline unless the closer file explicitly tightens it.
