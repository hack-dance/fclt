# fclt Documentation

These docs explain how `fclt` stores, inspects, composes, renders, and improves AI capability.

Start with the root [README](../README.md) for installation and first workflows. Use these guides when you need the model, safety rules, or command details.

The concepts guide includes the [feedback-loop diagram](./assets/fclt-capability-loop.png) that explains why `fclt` exists: setup once, let agents preserve friction, then review the changes that should improve future work.

## Guides

- [Concepts](./concepts.md): canonical roots, generated state, rendered outputs, scopes, and asset types.
- [Work Units](./work-units.md): a general frame for agent work, evidence, verification, and writeback.
- [Composable Capability](./composable-capability.md): refs, snippets, instruction templates, and evolvable units.
- [Project `.ai`](./project-ai.md): how repo-local capability works without leaking project review state into the repo.
- [Built-in pack](./built-in-pack.md): the packaged operating-model layer for writeback and evolution.
- [Built-in pack upgrades](./pack-upgrades.md): non-destructive refresh behavior for existing `.ai` roots.
- [Codex plugin](./codex-plugin.md): installable Codex skills and MCP tools for fclt workflows.
- [Writeback and evolution](./writeback-evolution.md): how real-work friction becomes reviewable capability changes.
- [Managed mode](./managed-mode.md): when to let `fclt` write tool files, and how adoption works.
- [Security and trust](./security-trust.md): source trust, audit, secrets, and commit hygiene.
- [Automations](./automations.md): recurring Codex loops for learning review, evolution review, and tool-call audit.
- [Command reference](./reference.md): command groups and common flags.
- [Roadmap](./roadmap.md): current product gaps and planned work.

## Reading Order

New users should read:

- [Concepts](./concepts.md)
- [Work Units](./work-units.md)
- [Project `.ai`](./project-ai.md) if working in a repo
- [Managed mode](./managed-mode.md) only before allowing `fclt` to write tool files
- [Writeback and evolution](./writeback-evolution.md) before setting up feedback loops
