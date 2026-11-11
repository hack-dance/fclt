# Read-only capability queries

`fclt list`, `show`, `find`, `graph`, `status`, and `inventory` do not write to canonical global or project roots. A missing or stale index needed by a query is rebuilt in memory. Reads also rebuild when an asset and its index have equal mtimes, because an edit within one filesystem clock tick cannot safely be treated as fresh. Legacy indexes can be read without copying them. Use `fclt index` or `fclt doctor --repair` to persist or repair generated indexes explicitly.

Pass `--no-write` anywhere in a command, or set `FCLT_NO_WRITE=1`, to forbid writes explicitly. Write commands fail before their handlers run. This mode also disables optional inventory cache writes; an existing valid cache can still be read. The guard fails closed for commands that are not identified as read-only. Other non-empty environment values also enable it; `0`, `false`, and `no` disable it. A help flag does not authorize a write command in this mode.

## Global inventory cache

```sh
fclt inventory --global --no-config-from --json
fclt inventory --global --json --no-write
FCLT_NO_WRITE=1 fclt list skills --global --json
```

Global inventory scans only the scanner's known canonical and tool sources, including their declared skill directories and installed Claude plugin paths. It skips project sources and all `scanFrom` / `--from` discovery roots before scanning. Use machine inventory without `--global` for broad discovery, or `--project` for project discovery. `--no-config-from` remains accepted with `--global`. In global JSON, `scanFrom` is now `[]`, project-only `dot-clawdbot` and `git-hooks` sources are omitted, and `canonicalRoot` selects the global root even in a project-scoped shell. These values describe the roots actually scanned; the field names and types stay the same.

Redacted global results are cached under `<machineStateDir>/cache/inventory/`, outside canonical roots. `fclt status --json` reports `machineStateDir`. The default global location is `$XDG_STATE_HOME/fclt/global` (or `~/.local/state/fclt/global`) on Linux and `~/Library/Application Support/fclt/global` on macOS. The existing `FACULT_LOCAL_STATE_DIR` override also applies. A cache destination resolving inside the canonical root is skipped.

The cache checks the fclt package version, effective canonical root, command options, and filesystem metadata for discovery dependencies. It records directory and file mtimes, sizes and identities, including missing paths. Nested additions, edits, removals, and symlink target changes invalidate the cache. Only known discovery trees are traversed; unrelated home directories, tool session histories, and inactive plugin caches are not walked. Cache writes are atomic and optional: inaccessible or corrupt caches fall back to scanning. `--show-secrets` results are never cached.

Inventory retains its JSON contract and adds `cache: { hit, generatedAt, key }` for cached global queries. `generatedAt` identifies the scanned snapshot, so it is stable on a cache hit. The cache is shared across working directories; the returned `cwd` always reflects the current caller. Cache hit rates depend on source activity: a tool rewriting a scanned MCP config invalidates its snapshot even if its MCP entries happen to be unchanged. `fclt --version` and `status --json`'s `packageVersion` identify the installed release. Package release notes are generated from Conventional Commits; this change does not publish a release.

![Read path](assets/read-path.svg)

![Inventory requests](assets/inventory-sequence.svg)
