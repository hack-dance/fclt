# Generated state

Global capability indexes and graphs live outside the canonical source tree:

```text
<fclt-local-state>/global/roots/<canonical-root-hash>/ai/index.json
<fclt-local-state>/global/roots/<canonical-root-hash>/ai/graph.json
```

The local state root is `~/Library/Application Support/fclt` on macOS,
`$XDG_STATE_HOME/fclt` when configured on other platforms, or `~/.local/state/fclt`.
`FACULT_LOCAL_STATE_DIR` overrides it. An override that places global generated
state inside its canonical root is rejected. `fclt paths --global --json` reports
the exact paths.

Each global canonical root has a separate snapshot directory, keyed by its
physical path. Symlink aliases share that identity. Project generated snapshots
keep their existing machine-local project paths. Runtime queues, journals,
managed state and review mirrors retain their existing locations.

## Migration

Run `fclt index` or `fclt doctor --repair` to create the new snapshots. Neither
command deletes legacy files, removes tracked files, edits `.gitignore`, nor
changes the canonical Git index.

When rebuilding without `--force`, fclt reads metadata from the current index,
then legacy generated locations, then the oldest canonical-root `index.json`.
Matching entries retain enablement, trust and audit metadata. Matching includes
source identity, so the same name in another root or source layer does not
inherit that metadata. `--force` intentionally resets metadata.

Legacy locations include `<canonical-root>/.facult/ai`, the older global
`~/.ai/.facult/ai` location for legacy global roots, and historical project state.
The shared `~/.facult/ai` fallback applies to the default global store, not an
unrelated custom global root. Such roots can use their own legacy generated
files or rebuild from their canonical assets.

Read-only queries can use legacy files without moving them. Relocation always
rebuilds snapshots from canonical source while preserving matching metadata,
even when a legacy file looks fresh: its absolute paths may belong to another
checkout. Existing user files and legacy snapshots remain in place for independent review.

## Writers and readers

Index builds and repairs share an exclusive `writer.lock` directory in the
snapshot directory. An overlapping writer fails with a retry message instead
of racing another build. Locks are not reclaimed automatically. After a crash,
confirm that no writer is running before removing the abandoned lock directory.

Each generated file is written to a unique temporary file and renamed into
place. `--force` leaves the old snapshot available until its replacement is
ready. A build publishes the graph before the index. Replacement is atomic per
file; the two files are not a cross-file transaction, so a reader spanning both
replacements can observe different generations. Read-only consumers do not
acquire writer locks. Non-regular destination files are refused and preserved.

![Index rebuild flow](./generated-state-flow.svg)

[Mermaid source](https://github.com/hack-dance/fclt/blob/main/docs/generated-state-flow.mmd)
