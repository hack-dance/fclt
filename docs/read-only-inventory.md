# Read-only capability queries

`fclt list`, `show`, `find`, `graph`, `status`, and scoped `inventory` do not write caches or canonical global or project roots. Queries and `inventory --global` / `--project` read a prebuilt snapshot. A missing or stale snapshot never triggers discovery, repair, or an in-memory rebuild.

Run `fclt index` for the selected scope to publish a snapshot explicitly. Successful managed rendering (`manage` or `sync`) and project render apply/rollback for project `.ai` roots also publish it. Planning, check mode, and dry runs do not. A publication error after a completed render produces a stderr warning without changing the render result. Publication captures index, graph, and inventory together in one private file under `<machineStateDir>/cache/reads/`, keyed by canonical root. Replacement is atomic. Source metadata is checked before publication to reject mixed snapshots during concurrent edits. Storage relocation of the generated index/graph is independent of this cache.

Queries check only index/graph inputs: resolved canonical and builtin roots, fclt config, managed state, and generated metadata. Inventory separately checks its recorded discovery inputs. Checks bind the package version and root identity and compare missing paths, sizes, identities, mtimes, and ctimes. No read performs recursive discovery. If a recorded MCP config changes, inventory compares a digest of its parsed MCP portion; unrelated settings do not invalidate it. Changed project-directory metadata triggers a nonrecursive comparison of recorded discovery names, so ordinary file additions do not invalidate the inventory. Directories consumed by recursive asset enumeration record every entry name, including arbitrary rule and instruction filenames; high-level discovery keeps its restricted name set. Additions, removals, equal-mtime edits, plugin changes, and symlink retargets invalidate the snapshot. Freshness is checked on every call; there is no process-local time-to-live hiding changes.

Successful JSON shapes stay unchanged: lists and searches remain arrays, and inventory keeps its existing object fields. `generatedAt` identifies the published inventory; `cache.hit` is true when read. Unavailable or malformed snapshots produce `snapshot-unavailable` on stderr and exit 1 with no stdout. A changed source or package version produces `snapshot-stale` with the same exit behavior. Neither case is an empty search result. `status --json` remains available and reports the corresponding code in its existing `issues` array. Consumers can distinguish failed reads from an empty library; displaying stale separately in a UI requires consumer integration.

The low-level TypeScript `loadIndex` / `loadGraph` builders retain their in-memory compatibility mode for existing callers. CLI query handlers always select `cachedOnly`; they cannot enter that fallback. `fclt doctor --repair` can repair generated indexes, but use `index` or `sync` to publish the scoped read snapshot afterward.

Pass `--no-write` anywhere in a command, or set `FCLT_NO_WRITE=1`, to forbid writes explicitly. Write commands fail before their handlers run. This mode also disables optional discovery-cache writes; an existing valid snapshot can still be read. The guard fails closed for commands that are not identified as read-only. Other non-empty environment values also enable it; `0`, `false`, and `no` disable it. A help flag does not authorize a write command in this mode.

## Scoped inventory and explicit discovery

```sh
fclt index --global
fclt inventory --global --no-config-from --json
fclt inventory --global --json --no-write
FCLT_NO_WRITE=1 fclt list skills --global --json
fclt index --project
fclt inventory --project --no-config-from --json
```

Global publication scans only known canonical and tool sources, including declared skill directories and installed Claude plugin paths. It skips project sources and `scanFrom` discovery roots. Global JSON retains `scanFrom: []`. Project publication uses project discovery with configured extra roots disabled. `--no-config-from` remains accepted for both scoped reads. A cached `--tool` filter applies to the published inventory without scanning.

Use `inventory` without a scope flag, or `scan`, for explicit discovery. Broad discovery may traverse home and configured roots; it is not the library read path. Scoped `--show-secrets`, `--from`, and `--include-git-hooks` are rejected with a discovery hint rather than silently ignored or served from a redacted snapshot.

The low-level global discovery builder retains its optional cache under `<machineStateDir>/cache/inventory/`. Inaccessible or corrupt discovery caches fall back to explicit scanning; CLI scoped reads never enter that builder. `--show-secrets` results are never cached. Cache destinations resolving inside canonical roots are rejected or skipped. All read snapshots and inventory-cache files are private and replaced atomically.

`status --json` reports `machineStateDir`. The default global runtime location is `$XDG_STATE_HOME/fclt/global` (or `~/.local/state/fclt/global`) on Linux and `~/Library/Application Support/fclt/global` on macOS. The `FACULT_LOCAL_STATE_DIR` override also applies. Cache keys bind to the canonical root; output `cwd` always reflects the current caller. Routine tool-home auth/session activity does not invalidate queries or inventory. A capability change in a tool config invalidates inventory without blocking canonical queries.

![Read path](assets/read-path.svg)

![Inventory requests](assets/inventory-sequence.svg)

Snapshot writers use independent temporary files and validate both dependency sets before atomic replacement. Concurrent publishers can complete without blocking a successful render. Interrupted publication cannot leave a permanent lock; readers ignore abandoned temporary files and never remove or repair them.

Only the inventory portion is redacted. The index portion preserves raw MCP definitions, including possible inline environment values, just as the generated index does. The entire file is private (0600) outside canonical roots.

An install or version upgrade invalidates existing snapshots. Rollout must explicitly run index or sync for each required scope before library/search reads resume; reads never perform this migration.

Project scoped reads without --no-config-from warn on stderr when configured scanFrom roots are excluded. Successful JSON on stdout remains unchanged.
