# Roadmap

This replaces the older operating-model target-state notes. That file mixed current documentation, past investigation output, and future design ideas. The current docs now describe shipped behavior; this file tracks remaining product direction.

## Already Shipped

- `fclt status` with root, managed-tool, generated-state, writeback, and evolution review paths.
- Generated-only project `.ai` detection and sync skip.
- Machine-local project generated state.
- Global Markdown review artifacts for writebacks and evolution proposals.
- Project-scoped writeback/evolution artifacts mirrored under global `~/.ai`.
- Built-in operating-model pack.
- Cleaner built-in canonical refs.
- JSON-first `inventory`.
- `sync --adopt-live` for explicit promotion of live tool edits.
- Managed sync local-edit protection for rendered docs, config, MCP, and skills.

## Current Priorities

1. Make status more explanatory.
   - Show policy summaries.
   - Surface top recommended next action.
   - Connect sync ledger history to rendered targets.

2. Add a structured sync plan.
   - Group writes, updates, removals, skips, conflicts, and repairs.
   - Expose the same plan as JSON.
   - Explain source refs and policy reasons.

3. Improve project onboarding.
   - Add a primary `fclt init project` flow.
   - Explain default-deny project sync during setup.
   - Offer safe adoption, detach, and restore choices.

4. Make policy inspectable.
   - Add `policy show`.
   - Add `policy explain`.
   - Hide TOML details behind user-facing commands where possible.

5. Make templates, plugins, automations, and rendered targets first-class inventory objects.
   - List and show them consistently.
   - Add graph visibility.
   - Include them in status and sync plans.

6. Tighten selector consistency.
   - Use one selector grammar across `list`, `show`, `graph`, `enable`, `disable`, `trust`, `audit`, writeback, and evolution.
   - Return useful ambiguity errors with candidates.

## Non-Goals

- Do not make managed mode the default way to inspect existing AI tool state.
- Do not store project writeback/evolution review artifacts in repo-local `.ai`.
- Do not silently adopt live tool edits during ordinary sync.
- Do not turn the built-in pack into a general preference archive.
- Do not require users to inspect machine-local state files to understand normal CLI behavior.
