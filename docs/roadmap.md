# Roadmap

This roadmap tracks remaining product direction for `fclt`.

## Already Shipped

- `fclt status` with root, managed-tool, generated-state, writeback, and evolution review paths.
- Generated-only project `.ai` detection and sync skip.
- Machine-local project generated state.
- Global Markdown review artifacts for writebacks and evolution proposals.
- Project-scoped writeback/evolution artifacts mirrored under global `~/.ai`.
- Built-in operating-model pack.
- Independent built-in operating-model pack install with `templates init operating-model`.
- Read-only setup discovery with `doctor --json` and `paths --json`.
- Cleaner built-in canonical refs.
- JSON-first `inventory`.
- `sync --adopt-live` for explicit promotion of live tool edits.
- Managed sync local-edit protection for rendered docs, config, MCP, and skills.
- Initial first-party Codex plugin with setup/writeback/evolution/capability-review skills and a CLI-backed MCP wrapper.

## Current Priorities

1. Add agent-first setup APIs.
   - Add `setup plan --json` and safe apply primitives for confirmation-gated setup.
   - Add command/risk metadata so agents can distinguish read-only, dry-run, generated-state writes, mutating actions, and high-risk global changes.

2. Make status more explanatory.
   - Show policy summaries.
   - Surface top recommended next action.
   - Connect sync ledger history to rendered targets.

3. Add a structured sync plan.
   - Group writes, updates, removals, skips, conflicts, and repairs.
   - Expose the same plan as JSON.
   - Explain source refs and policy reasons.

4. Improve project onboarding.
   - Add a primary `fclt init project` flow.
   - Explain default-deny project sync during setup.
   - Offer safe adoption, detach, and restore choices.

5. Make policy inspectable.
   - Add `policy show`.
   - Add `policy explain`.
   - Hide TOML details behind user-facing commands where possible.

6. Make templates, plugins, automations, and rendered targets first-class inventory objects.
   - List and show them consistently.
   - Add graph visibility.
   - Include them in status and sync plans.

7. Expand the first-party Codex plugin and MCP surface.
   - Add richer setup planning tools beyond the initial CLI wrapper.
   - Keep the CLI and canonical `.ai` roots as the source of truth.
   - Gate high-risk global changes behind explicit review.
   - Add more focused agent-facing skills for automation setup, capability search, and upgrade flows.

8. Tighten selector consistency.
   - Use one selector grammar across `list`, `show`, `graph`, `enable`, `disable`, `trust`, `audit`, writeback, and evolution.
   - Return useful ambiguity errors with candidates.

## Non-Goals

- Do not make managed mode the default way to inspect existing AI tool state.
- Do not store project writeback/evolution review artifacts in repo-local `.ai`.
- Do not silently adopt live tool edits during ordinary sync.
- Do not turn the built-in pack into a general preference archive.
- Do not require users to inspect machine-local state files to understand normal CLI behavior.
