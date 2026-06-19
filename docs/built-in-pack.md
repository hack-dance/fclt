# Built-in Pack

`fclt` ships an operating-model pack:

```text
assets/packs/facult-operating-model/
```

It provides default guidance for agents that use `fclt`: define the work, verify it, record durable feedback, and turn repeated signal into reviewed changes.

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

The built-in pack should stay small. It teaches:

- work-unit discipline
- composable refs, snippets, instructions, skills, agents, MCP, and automations
- verification
- writeback
- evolution proposal review
- project/global scope decisions
- managed-mode ownership boundaries

Keep project-specific behavior in project `.ai`. Promote it only when repeated evidence shows it is reusable outside that project.

## Next

- Read [Composable Capability](./composable-capability.md) for refs, snippets, and instruction templates.
- Read [Writeback and evolution](./writeback-evolution.md) for the feedback loop.
- Read [Managed mode](./managed-mode.md) before rendering the pack into a tool home.
