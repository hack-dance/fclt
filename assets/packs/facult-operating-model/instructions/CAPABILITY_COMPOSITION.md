---
description: "Compose small capability units across global and project roots, then evolve the smallest affected unit."
tags: ["facult", "composition", "refs", "snippets", "instructions"]
---

# Capability Composition

Use `fclt` capability as small units that can be composed, inspected, rendered, and evolved independently.

The main units are:

- instructions: standalone markdown doctrine such as language preferences, verification rules, or review standards
- snippets: small markdown partials inserted into one or more rendered docs
- skills: task-specific workflows with `SKILL.md`
- agents: focused role manifests
- MCP definitions: tool interfaces and their safe auth shape
- automations: scheduled review or maintenance loops
- tool rules/config: tool-specific defaults and policy

## Composition Rules

- Keep reusable doctrine in `instructions/`.
- Keep repeated paragraphs or policy blocks in `snippets/`.
- Keep workflow execution in `skills/`.
- Keep persona or delegation behavior in `agents/`.
- Keep tool wiring in `mcp/` and `tools/<tool>/`.
- Compose broad agent docs from refs and snippets instead of copying text by hand.
- Prefer one narrow reusable unit over one large instruction file that mixes unrelated domains.

Examples:

- `@ai/instructions/BUN.md` for shared Bun preferences.
- `@ai/instructions/RUST.md` for shared Rust preferences.
- `@project/instructions/TESTING.md` for repo-specific test policy.
- `<!-- fclty:global/codex/baseline -->` for a shared rendered block.

## Scope

Use global scope for capability that should follow the user across projects.

Use project scope for capability that belongs to a repo, team workflow, architecture, or local test harness.

Promote project capability to global only when repeated evidence shows reuse across projects. Do not globalize a project quirk just because it worked once.

## Writeback And Evolution

Target the smallest affected unit.

- If a paragraph is reused in several rendered docs, target the snippet.
- If a domain rule is wrong, target the instruction.
- If a workflow is incomplete, target the skill.
- If a delegated role is unclear, target the agent.
- If a tool interface is missing or unsafe, target the MCP or tool config.
- If a scheduled review loop is noisy or missing context, target the automation.

Good writeback targets are graph-backed selectors when possible:

```bash
fclt ai writeback add --kind missing_context --summary "Bun guidance did not cover test runner selection." --asset instruction:BUN
fclt ai writeback add --kind reusable_pattern --summary "Project test policy should become a shared verification snippet." --asset @project/instructions/TESTING.md
fclt ai writeback add --kind bad_default --summary "The review automation escalated one-off preferences." --asset automation:evolution-review
```

Use `fclt ai evolve ...` only after repeated signal, a clearly missing capability, or a stale canonical asset points at a concrete change. Prefer the smallest valid proposal kind: `update_asset`, `create_asset`, `extract_snippet`, `add_skill`, or `promote_asset`.

## Agent Defaults

When an agent sees a repeated preference like "use Bun for JS projects" or "prefer Cargo nextest for Rust tests", it should not bury that in chat. It should identify whether the durable unit is:

- a global instruction
- a project instruction
- a snippet reused by rendered docs
- a skill workflow
- a project-to-global promotion candidate

Then it should record writeback against that unit, or draft a proposal when the evidence is already strong enough.
