# Global Agent Instructions

This template materializes as `AGENTS.global.md` when the operating-model pack is
installed. It should stay small and composed from snippets. Put detailed
doctrine in instructions, workflow execution in skills, and local/private
preferences in user-owned or project-owned assets outside the public pack.

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

Read only task-relevant references that are not already available in context. These references provide
workflow detail, not additional approval gates or reasons to expand the requested scope.

- For work-unit definition and scope clarification, read ${refs.work_units}.
- For identifying, improving, and validating feedback loops, read ${refs.feedback_loops}.
- For verification and anti-false-positive checks, read ${refs.verification}.
- For checking integration boundaries, read ${refs.integration}.
- For learning, decisions, and writeback, read ${refs.learning_writeback}.
- For capability evolution, proposal kinds, and `facult ai` workflow, read ${refs.evolution}.
- For deciding whether something belongs in global or project scope, read ${refs.project_capability}.
- Add private language, coding, or writing refs in local config only when they belong to the user's own operating layer.

## Layering

- Treat this file as the global baseline.
- Treat repo-level `AGENTS.md` files as more specific additions layered after this file.
- Follow the provider's instruction hierarchy. More specific project instructions may refine global workflow defaults; explicit user scope and higher-priority safety requirements remain binding.
- Where the provider supports `AGENTS.override.md`, use its documented precedence. A scoped workflow exception does not waive credential protections, native authorization, or applicable external-action and production gates.
