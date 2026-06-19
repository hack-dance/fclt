---
description: Decide what belongs in repo-local .ai versus the global store.
tags: [facult, project, scope]
---

# Project Capability

Prefer project scope when the guidance depends on repo architecture, team workflow, or colocated tooling. Promote to global only after repeated cross-project reuse.

## Project First

Default to `<repo>/.ai` when the capability is about:

- local architecture
- repo-specific testing or verification
- team conventions
- project tools and workflows
- product, customer, deployment, or operational context tied to one repo
- examples that would leak private or irrelevant detail if copied globally

Project capability should travel with the repo when it is safe to commit. Generated state, machine-local runtime state, secrets, and review queues should not travel with it.

## Global Scope

Use `~/.ai` when the capability should follow the user across projects:

- general verification standards
- reusable work-unit, feedback-loop, or writeback doctrine
- user-owned language/tool preferences that are safe to share across repos
- cross-project skills or agents
- MCP/tool integration patterns that are not tied to one repo

Global capability should be broadly useful and low-noise. A global rule that only helps one project is usually a project rule.

## Review Artifacts

Project-scoped writebacks and evolution proposals use the project as evidence, but their Markdown review artifacts are mirrored under global `~/.ai/writebacks/projects/<slug-hash>/` and `~/.ai/evolution/projects/<slug-hash>/`.

Do not create repo-local `writebacks/` or `evolution/` review trees inside `<repo>/.ai`. Keep private review state out of the repo while preserving project metadata in the global review artifact frontmatter.

## Promote Carefully

Promote to `~/.ai` only when:

- the same pattern succeeds in more than one repo
- the capability is not coupled to local architecture
- the global version will not create noise for unrelated projects
- private examples can be removed or generalized without losing the rule
- the target global unit is smaller than a broad rewrite

Use:

```bash
fclt ai evolve promote EV-00001 --to global --project
```

That creates a new global proposal for review. It does not auto-apply the promotion.

## Decision Checklist

Choose project when the answer depends on "this repo". Choose global when the answer would still be correct after removing the repo name.

If unsure:

1. keep the asset project-scoped
2. record writeback with the reason it might generalize
3. wait for another project or repeated evidence
4. promote through a reviewable proposal, not by copying files by hand
