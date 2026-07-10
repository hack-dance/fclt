---
description: Inspect fclt capability roots, docs, snippets, skills, agents, MCP, and automations.
tags: [fclt, capability, review, inventory]
---

# fclt-capability-review

## When To Use
Use this skill when Codex needs to understand what capability exists before changing it.

Use it for:

- checking global and project `.ai` roots
- finding relevant skills, snippets, instructions, agents, MCP servers, or automations
- deciding whether a change belongs in global or project scope
- checking whether managed rendering is enabled or needed
- reviewing public/private boundaries before publishing docs or pack assets

## Workflow

```bash
fclt status --json
fclt inventory --json
fclt list skills
fclt list instructions
fclt list snippets
fclt graph AGENTS.global.md
```

For project work:

```bash
fclt status --project --json
fclt inventory --project --json
```

## Rules

- Read existing repo guidance before proposing project capability.
- Use project scope for repo-specific commands, tests, architecture, or team workflow.
- Use global scope only for broadly reusable behavior.
- Keep generated state and review artifacts out of repo-local `.ai`.
- Prefer adding or updating the smallest unit: instruction, snippet, skill, agent, MCP config, or automation.
- Treat engineering implementation as task work. Do not force product changes
  through capability evolution merely because evolution tools exist.
- Before recommending mutation, state the observed problem, evidence, why the
  proposed capability is the correct target, risk class, expected outcome,
  verification plan, assumptions, and recovery route.
- Never silently overwrite authored capability or confuse generated/rendered
  output with canonical source.

## Output

- capability roots found
- relevant assets
- scope recommendation
- missing or stale capability
- safe next command
- deliberately withheld operations or missing safer API
- verification and undo path for any proposed mutation
