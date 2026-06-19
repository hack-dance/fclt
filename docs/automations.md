# Automations

`fclt` can scaffold Codex automations that run the feedback loop on a schedule.

Use automations for review and synthesis, not for bypassing review. They should preserve useful signal, group repeated patterns, and draft proposals only when the target is concrete.

## Templates

Learning review:

```bash
fclt templates init automation learning-review \
  --scope project \
  --project-root /path/to/repo \
  --status PAUSED
```

Evolution review:

```bash
fclt templates init automation evolution-review \
  --scope wide \
  --cwds /path/to/repo-a,/path/to/repo-b \
  --status PAUSED
```

Tool-call audit:

```bash
fclt templates init automation tool-call-audit \
  --scope project \
  --project-root /path/to/repo \
  --status PAUSED
```

## Scopes

- `project`: one repo. Use this for repo-specific writeback, verification, and tool friction.
- `wide`: a small related set of repos. Use this for shared capability review.
- `global`: global capability and shared agent behavior.

Keep wide scopes intentionally small. A good automation should preserve source boundaries instead of mixing unrelated repos into one vague proposal.

## Output

Automation files are written to:

```text
~/.codex/automations/<name>/automation.toml
~/.codex/automations/<name>/memory.md
```

When Codex is managed by `fclt`, canonical automation sources can live under:

```text
~/.ai/automations/<name>/
<repo>/.ai/automations/<name>/
```

Project-scoped automation sources are default-deny for managed sync. Add their names to `[project_sync.codex].automations` before project managed sync can render them into the shared live Codex automation store.

## Suggested Cadence

- daily or per-project `learning-review` for durable signal
- weekly `evolution-review` for proposal triage
- targeted `tool-call-audit` when tool failures, missing skills, or shallow-success patterns repeat

High-risk global changes should still move through proposal review before apply.
