# Reconciliation source setup and diagnostics

Use `fclt ai review sources` to prepare narrow source entries and inspect their local inputs.
These commands do not write configuration, scan source content, refresh cursors, create reviews,
contact vendors, or change scheduling. Project context resolution may run bounded, read-only Git
metadata commands to verify canonical checkout and state ownership. If that ownership cannot be
verified, the command fails closed; it does not guess another root. Run these tools in the same
scope as the intended review.

## Generate an entry

Initialize the selected scope's configuration with `fclt ai review init` if needed. Then generate
one entry, inspect it, and add it to the existing `sources` array in the reported `configPath`:

```bash
fclt ai review sources init --project --id selected-git --type git \
  --path AGENTS.md --path docs --default-branch main --json

fclt ai review sources init --project --id runbooks --type markdown \
  --file-root project --path 'notes/reviews/*.md' --json

fclt ai review sources init --global --id weekly-memory --type automation \
  --file-root home --path '.codex/automations/weekly-review/memory.md' --json

fclt ai review sources init --global --id external-work --type evidence-export \
  --path reconciliation/evidence.json --json
```

`init` prints a recipe; it does not append or replace anything. Its version 1 JSON contains
`configPath`, one validated `source`, and an empty `writes` array. Preserve existing sources and
choose a unique ID when adding the entry. Vendor exports use the existing
[evidence-export contract](writeback-evolution.md#automatic-source-reconciliation); no vendor
credentials or SDKs are required.

Every recipe requires explicit relative paths. Root-wide patterns (`**/*.md`, `*.log`, or `.`),
absolute paths, parent traversal, and Git pathspec magic are rejected. File sources require an
explicit `--file-root project|home`; patterns may start below a named directory. Git recipes use
literal paths and the configured or auto-detected default branch, with `allBranches: false`.
Evidence exports require exactly one literal path. Existing hand-authored configurations retain
their existing parser rules; generating a recipe does not tighten or rewrite them.

## Preview read targets

```bash
fclt ai review sources preview --project --json
fclt ai review sources preview --global --source external-work --json
```

The version 1 result has `configPath`, `contentScanned: false`, and `inputs`. Each input names its
source and target metadata:

- Markdown and automation sources list the exact candidate files selected by the adapter's
  glob rules and 500-file cap. `truncated: true` means the preview is incomplete. Files outside
  the physical root or above the adapter's 1,000,000-byte limit are excluded.
- Evidence exports show their exact file. Project exports resolve from the repository root;
  global exports resolve from the selected canonical root, including custom global roots.
- Writebacks list current and legacy queue paths for the selected source scope. Missing queues
  are listed too; an empty writeback source can be valid.
- Git sources show the local repository, path filters, revision selection, and default-branch
  policy. These describe the history query, not a list of working-tree files. Preview does not
  run the source's history query or fetch. Scope resolution still uses local Git metadata, so a
  project checkout with missing Git or invalid metadata fails before preview. Git sources without
  a project root are unavailable.
- Disabled sources have no read targets.

`available` means file metadata is accessible, not that content can be read or parsed or that a
review window is covered. A binary file or invalid export may still be listed as available.
Files and refs can change after preview; this is not a hash-bound execution plan.

Both preview and doctor accept repeated `--source <id>` and an optional `--config <path>`.
Unknown IDs and flags fail rather than silently widening the selection. `--root <path> --global`
selects a custom global canonical root; file-source `home` still means the actual home directory.

## Diagnose recorded source checks

```bash
fclt ai review sources doctor --project --json
fclt ai review sources doctor --global
```

Doctor includes the metadata preview plus `statePath`, `sources`, and `removedSources`. It reads
existing state without saving it. The human output explains each status:

| Status | Meaning |
| --- | --- |
| `not_checked` | This ID has no recorded check. |
| `checked` | The recorded check matches the current source and adapter. This is historical evidence. |
| `configuration_changed` | The source or adapter changed; the previous check no longer proves coverage. |
| `unavailable` | The last matching check could not prove coverage. Current input availability is separate. |
| `stale` | The last matching check reported stale coverage or freshness. |
| `disabled` | Configuration disables this source. |
| `retired_or_renamed` | A recorded ID is absent from configuration. Its history is preserved. |

Renames are not inferred. A new ID starts without a cursor, and removing an ID does not erase its
history or transfer it. `removedSources` lists all absent IDs even when `--source` narrows the
current configured sources. Invalid configuration or corrupt state fails with a diagnostic and
preserves the file. Doctor does not recompute freshness from a new scan or from wall-clock age.

After reviewing configuration and inputs, run a bounded reconciliation window as described in
[Writeback and Evolution](writeback-evolution.md#automatic-source-reconciliation). Only that
review can establish new coverage. CLI readiness, source coverage, and scheduler execution remain
separate evidence.
