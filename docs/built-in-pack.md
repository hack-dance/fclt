# Built-In Pack

`fclt` ships an operating-model pack:

```text
assets/packs/facult-operating-model/
```

It provides a default feedback loop for agents that use `fclt`.

## Included Assets

Instructions:

- `WORK_UNITS.md`
- `CAPABILITY_COMPOSITION.md`
- `LEARNING_AND_WRITEBACK.md`
- `EVOLUTION.md`
- `PROJECT_CAPABILITY.md`
- `INTEGRATION.md`

Skills:

- `capability-evolution`
- `project-operating-layer-design`

Agents:

- `writeback-curator`
- `evolution-planner`
- `scope-promoter`
- `integration-auditor`

Global doc:

- `AGENTS.global.md`

## When It Becomes Active

The built-in pack is always available as a built-in source:

```text
@builtin/facult-operating-model/...
```

Install a concrete copy into a canonical root without managing any tool:

```bash
fclt templates init operating-model --global
fclt templates init operating-model --project
fclt templates init operating-model --root /path/to/.ai
```

That writes the pack into the selected `.ai` root and rebuilds its index. It does not render files into Codex, Claude, or any other tool home.

Use `project-ai` when the target is the current repo:

```bash
cd /path/to/repo
fclt templates init project-ai
```

Managed mode is only the rendering layer. The pack becomes live tool guidance when you manage a tool and sync:

```bash
fclt manage codex
fclt sync codex
```

Global managed tools receive the built-in writeback/evolution guidance by default. Project-local `.ai` roots do not render the built-in operating model into repo-local tool outputs unless project sync policy explicitly allows it. Installing the pack and rendering it into a tool are separate decisions.

Disable built-in default sync for a canonical root:

```toml
version = 1

[builtin]
sync_defaults = false
```

## Design Rule

The built-in pack should stay small. It should teach:

- work-unit discipline
- composable refs, snippets, instructions, skills, agents, MCP, and automations
- verification
- writeback
- evolution proposal review
- project/global scope decisions
- managed-mode ownership boundaries

It should not become a pile of preferences. Put project-specific behavior in project `.ai`; promote to global only when repeated evidence proves reuse.
