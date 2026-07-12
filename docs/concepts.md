# Concepts

`fclt` keeps a durable feedback loop around AI work. It collects reusable signal, reconciles what
was actually checked, evolves the smallest relevant capability unit, and preserves outcome
evidence. A canonical store and optional tool rendering support that loop; they are not the loop's
only purpose.

The important distinction is ownership. A file can be source, generated state, machine runtime state, a rendered output, or a review artifact. Treating those as separate layers prevents sync surprises.

![fclt capability loop: setup, capability, agents, work units, writebacks, evolution, approval, and better future agents](./assets/fclt-capability-loop.png)

The intended operating model is agent-led after setup. Users install and approve broad changes; agents inspect capability, run work units, record durable friction, and use repeated signal to propose small improvements.

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

This applies to ordinary coding, research, docs, operations, setup, and debugging work, not only to skill or instruction updates. Agents should keep this implicit for simple work and make it explicit when the task is ambiguous, risky, stateful, or multi-step. The built-in operating-model pack includes `WORK_UNITS.md` so managed agents and canonical `.ai` roots can share the same framing.

See [Work Units](./work-units.md) for the detailed model.

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

Not every asset must be rendered into every tool. Use inventory and policy first. Broad managed apply is deprecated and contained; only use managed dry-runs to inspect legacy rendering plans while transaction-safe per-asset deployment is built.

For concrete composition patterns, see [Composable Capability](./composable-capability.md).

## Feedback Loop

The durable loop is:

1. Do a bounded work unit and preserve strong reusable signal.
2. Reconcile every configured source for the review window and expose unavailable coverage.
3. Correlate repeated observations across assets, runs, and linked work.
4. Assign a disposition and draft the smallest valid proposal only when evidence justifies it.
5. Review and apply accepted changes to canonical source.
6. Verify the producing loop after the change; resolve, watch, or reopen the same signal family.
7. Re-index and sync only the tool surfaces that should receive an accepted capability change.

## Next

- Read [Project `.ai`](./project-ai.md) before adding repo-local capability.
- Read [Managed mode](./managed-mode.md) before allowing `fclt` to write tool files.
- Read [Composable Capability](./composable-capability.md) to split guidance into instructions, snippets, skills, agents, MCP, and automations.
- Read [Work Units](./work-units.md) to understand the general task frame behind writeback and evolution.
