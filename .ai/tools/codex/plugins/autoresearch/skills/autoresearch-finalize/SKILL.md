---
name: autoresearch-finalize
description: Finalize an autoresearch branch into clean reviewable branches. Use when an autoresearch session has accumulated multiple kept improvements and the user wants those changes grouped into independent branches or PR-sized chunks.
---

# Autoresearch Finalize

Split a noisy autoresearch branch into clean, independent branches while preserving the experiment history.

This skill is the Codex port of `pi-autoresearch` finalization. It expects the session files created by the `autoresearch` skill, especially `autoresearch.jsonl` and `autoresearch.md`.

## When To Use It

Use this skill when:

- an autoresearch branch contains several kept commits
- the user wants reviewable branches instead of one long experimental branch
- you need a proposal for grouping improvements by file and dependency boundaries

Do not use this skill before the experiment loop has produced durable kept results.

## Workflow

1. Read `autoresearch.jsonl`.
   Focus on kept runs and the commits they correspond to.
2. Read `autoresearch.md`.
   Use it to understand intent, dead ends, and file scope.
3. Resolve commit hashes and merge-base.
   Expand short SHAs with `git rev-parse <short>`.
4. Propose groups before writing anything.
   Preserve order, avoid overlapping files across groups, and merge tightly coupled changes.
5. After approval, write a `groups.json` file and run the bundled script:

```bash
bash "$CODEX_HOME/skills/autoresearch-finalize/scripts/finalize.sh" /tmp/groups.json
```

6. Report the resulting branches, the overall metric change, and any cleanup commands printed by the script.

## Grouping Rules

- Each branch starts from the merge-base, not from the previous group.
- No two groups may touch the same file.
- If one group depends on another to compile or work, merge them unless the dependency is truly loose.
- Keep groups small and legible.
- Skip unrelated non-experiment commits.

## Expected groups.json Shape

```json
{
  "base": "<full merge-base hash>",
  "trunk": "main",
  "final_tree": "<full HEAD hash of the autoresearch branch>",
  "goal": "short-slug",
  "groups": [
    {
      "title": "Improve benchmark setup caching",
      "body": "Why this change matters.\n\nExperiments: #3, #5\nMetric: total_s 12.4 -> 10.8 (-12.9%)",
      "last_commit": "<full hash>",
      "slug": "cache-setup"
    }
  ]
}
```

`last_commit` must be a full hash.

## Compatibility Notes

This skill preserves the Pi finalizer script because that part maps cleanly to Codex.

What still does not exist in Codex:

- no custom dashboard for grouping
- no special slash command
- no dedicated finalize tool

That is fine. The shell script provides the high-value deterministic part.
