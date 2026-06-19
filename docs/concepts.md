# Concepts

`fclt` keeps AI capability in a canonical store, lets you inspect it, and optionally renders approved pieces into tool-native files.

The important distinction is ownership. A file can be source, generated state, machine runtime state, a rendered output, or a review artifact. Treating those as separate layers prevents sync surprises.

## Roots And Scopes

Global root:

```text
~/.ai/
```

Use this for user-owned reusable capability: shared instructions, snippets, skills, agents, MCP definitions, and writeback/evolution review artifacts.

Project root:

```text
<repo>/.ai/
```

Use this for repo-owned capability that should travel with the codebase: project instructions, project skills, project MCP definitions, and project sync policy.

Built-in root:

```text
@builtin/facult-operating-model/...
```

Use this for packaged defaults shipped with `fclt`.

Remote sources:

```text
skills.sh:<name>
smithery:<name>
glama:<name>
```

Use these as installable catalog sources. Review and trust source policy before installing remote capability broadly.

## Work Units

A work unit is a scoped agent task with a goal, acceptance criteria, required context, constraints, evidence, output artifact, verification path, and writeback target.

Agents should keep this implicit for simple work and make it explicit when the task is ambiguous, risky, or multi-step. The built-in operating-model pack includes `WORK_UNITS.md` so managed agents and canonical `.ai` roots can share the same framing.

## State Layers

Canonical source is edited by humans or accepted proposals.

Examples:

```text
~/.ai/instructions/VERIFICATION.md
<repo>/.ai/skills/project-review/SKILL.md
```

Generated state is rebuildable.

Examples:

```text
~/.ai/.facult/ai/index.json
~/.ai/.facult/ai/graph.json
```

Project generated state lives in machine-local `fclt` state, not in the repo.

Machine runtime state records local behavior and history.

Examples:

```text
~/Library/Application Support/fclt/global/managed.json
~/Library/Application Support/fclt/projects/<slug-hash>/managed.json
```

Rendered outputs are files consumed by tools.

Examples:

```text
~/.codex/AGENTS.md
~/.agents/skills/<name>
<repo>/.codex/agents/<name>.toml
```

Review artifacts are Markdown mirrors for human review.

Examples:

```text
~/.ai/writebacks/global/WB-00001.md
~/.ai/evolution/projects/<slug-hash>/EV-00001.md
```

## Asset Types

Common canonical asset types:

- instructions: reusable markdown guidance
- snippets: composable markdown partials
- skills: workflow-specific folders with `SKILL.md`
- agents: role manifests
- MCP servers: canonical MCP definitions
- tool config and rules: tool-specific defaults
- automations: scheduled review or maintenance prompts
- plugins: local tool plugin bundles and marketplaces

Not every asset must be rendered into every tool. Use inventory and policy first, then managed sync only where `fclt` should own the rendered output.

For concrete composition patterns, see [Composable Capability](./composable-capability.md).

## Feedback Loop

The durable loop is:

1. Inspect live tool and project state.
2. Record strong writebacks when real work exposes reusable friction or missing capability.
3. Group repeated writebacks.
4. Draft the smallest valid proposal.
5. Review and apply accepted changes to canonical source.
6. Re-index and sync only the surfaces that should receive the change.

## Next

- Read [Project `.ai`](./project-ai.md) before adding repo-local capability.
- Read [Managed mode](./managed-mode.md) before allowing `fclt` to write tool files.
- Read [Composable Capability](./composable-capability.md) to split guidance into instructions, snippets, skills, agents, MCP, and automations.
