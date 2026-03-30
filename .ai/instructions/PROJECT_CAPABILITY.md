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

## Promote Carefully

Promote to `~/.ai` only when:

- the same pattern succeeds in more than one repo
- the capability is not coupled to local architecture
- the global version will not create noise for unrelated projects

Use:

```bash
fclt ai evolve promote EV-00001 --to global --project
```

That creates a new global proposal for review. It does not auto-apply the promotion.
