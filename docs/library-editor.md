# Library editing RPC

Use `fclt library rpc --global` to read or edit one canonical Markdown asset or a stdio MCP server's command and arguments. The CLI reads one JSON request from stdin and returns one JSON response. Check `fclt protocol --json` for `library-editor-v1` before using this API.

For an isolated source directory, pass `--root PATH --local-root PATH --machine NAME`. The local state directory must be outside the canonical source tree. Omit these flags to use the configured global source, machine state directory, and hostname.

Read an asset:

```json
{"schemaVersion":1,"operation":"read","asset":{"path":"skills/example/SKILL.md"}}
```

A successful response is `{"ok":true,"value":...}`. It includes a revision, shared, machine, local and effective field values, field provenance, and fields whose lower layer changed. Errors return `{"ok":false,"error":{"reason":...}}` and exit with status 1. Raw diagnostics and environment values are excluded.

Save with the revision from the last read:

```json
{"schemaVersion":1,"operation":"save","asset":{"path":"skills/example/SKILL.md"},"revision":"<last-read-revision>","layer":"machine","values":{"content":"# Example\n"}}
```

The shared layer updates canonical source. Machine overrides live under `profiles/<machine>/library/` in that source tree. Local overrides live outside the source tree. Saving never commits, pushes, pulls, or deploys. Callers must not describe a shared save as synchronization.

For `mcp/servers.json` or `mcp/mcp.json`, include `asset.name` and save `command` or `args`. Environment bindings, transport and unrelated servers are preserved. Credential-shaped command arguments are refused. JSON saves use two-space indentation.

Reset selected machine or local fields with `operation:"reset"`, `layer`, `revision` and `fields:["content"]` (or `command` / `args`). Reset reveals the next lower layer. Saving an existing override again acknowledges the current lower-layer value. Changes retain recovery copies in local runtime state. Stale revisions and concurrent writers are rejected.

## Apply overlays to an owned target

When `library-capability-overlays-v1` is advertised, pass `--library-state-root PATH` to capability plan and apply. The capability host selects the machine overlay. This opt-in consumes effective skill Markdown and MCP command/argument values while preserving source pins, target ownership, and plan revision checks. A changed overlay invalidates the previous plan, even if its effective content is unchanged. Without the flag, existing capability behavior is unchanged.

Run plan first, review it, then apply its exact plan ID to an explicitly managed target. This API does not enable broad sync or take ownership of unmanaged provider files.
