# Codex Plugin

`fclt` ships a first-party Codex plugin at:

```text
plugins/fclt/
```

The plugin is for agent-led operation. After install, Codex gets focused skills for setup, writeback, evolution, and capability review, plus an MCP server wrapper that exposes common `fclt` CLI actions as tools.

## What It Includes

- `fclt-setup`: install, update, inspect, initialize, and repair fclt setup.
- `fclt-writeback`: record and review durable writebacks from real work.
- `fclt-evolution`: turn repeated writeback into reviewed capability proposals.
- `fclt-capability-review`: inspect global/project capability roots and scope changes.
- `fclt` MCP server: stdio wrapper around the installed `fclt` CLI.

The MCP wrapper intentionally delegates to the local `fclt` binary instead of duplicating core logic. Set `FCLT_BIN` if Codex should call a specific binary.

The runtime discovery, verified bootstrap/update lifecycle, safety tiers, and
release-proof requirements are documented in [Codex Plugin Runtime and Safety
Contract](./codex-plugin-runtime.md). The complete machine-readable CLI
disposition is in
[codex-plugin-capability-matrix.json](./codex-plugin-capability-matrix.json).

## MCP Tools

The plugin exposes:

- `fclt_setup`
- `fclt_runtime`: discover, check, stage, atomically activate, or roll back a verified runtime
- `fclt_capability`: typed capability, provenance, template, snippet, adapter, and managed-state reads
- `fclt_workflow`: typed writeback and evolution read/review/lifecycle operations
- `fclt_sync`: managed-state inspection and dry-run sync preview
- `fclt_registry`: source search/verification and strict-trust install/update preview
- `fclt_audit`: structured, redacted, non-interactive security audit
- `fclt_automation`: read-only autosync service status
- `fclt_status`
- `fclt_doctor`
- `fclt_paths`
- `fclt_init_operating_model`
- `fclt_writeback_add`
- `fclt_writeback_review`
- `fclt_evolve`

The typed routers use closed schemas, reject unknown fields, require explicit
scope and approval for review-producing or reversible workflow changes, and do
not expose arbitrary argv or shell passthrough. Canonical apply, live adoption,
trust-policy mutation, destructive migration, and background-service mutation
remain deliberately withheld until their CLI APIs provide transaction-safe
preview, precondition, verification, and rollback contracts.

## Install In Codex

For a new install, prefer the complete one-command bootstrap:

```bash
fclt setup
```

It prepares global and current-repo capability, review state, indexes, and the plugin. The same
command is available to Codex through `fclt_setup`, so a plugin-led install does not require the
user to know capability roots or state paths.

Use the narrow plugin-only command when the CLI loop is already healthy:

```bash
fclt setup codex-plugin
```

That updates only the local `fclt` plugin payload under `~/plugins/fclt`
and merges an entry into `~/.agents/plugins/marketplace.json`. The default
marketplace name is `hack-local`; if the marketplace file already has a
non-empty `name`, fclt preserves it and installs from that name. The generated
entry uses Codex schema-valid policy values, including
`installation: "AVAILABLE"` and `authentication: "ON_INSTALL"`.

When the `codex` command is available, setup runs
`codex plugin add fclt@<marketplace> --json`. Codex installs the plugin cache
under `~/.codex/plugins/cache/<marketplace>/fclt/` using its own version
directory.

It does not enter managed mode, adopt Codex state, render
`~/.codex/AGENTS.md`, or touch existing Codex skills/rules/config.

Useful flags:

```bash
fclt setup codex-plugin --dry-run --json
fclt setup codex-plugin --no-codex-install
```

Use managed sync only when you intentionally want `fclt` to render broader Codex tool files:

```bash
fclt manage codex --global
fclt sync codex --global
```

For local plugin development, run the lightweight checks that ship with the repository:

```bash
node plugins/fclt/scripts/fclt-mcp.cjs --self-test
bun run bootstrap:verify
bun run check
```

`codex plugin list --json` proves registration, and the MCP self-test proves the packaged server
declares its tools. Neither proves a running task has refreshed its tool registry. After plugin
installation, start a fresh Codex task and confirm `fclt_setup` and `fclt_status` are discoverable;
`doctor --json` reports this boundary as `requires_fresh_session` instead of inferring success.

## Recommended Agent Use

Use the plugin skills as the first interface. Use MCP tools when a Codex workflow benefits from structured calls for status, doctor, paths, writeback, or evolution review.

For proposal triage, call `fclt_evolve` with `action: "assess"` before proposing when a target is known. Assessment is read-only and returns the recommendation, source writebacks, active proposal ids, quality checklist, suggested commands, and the next agent instruction.

Do not create writeback/evolution noise. Record strong signal, group repeated signal, assess readiness, then propose the smallest concrete capability change only when evidence repeats or the missing capability is clear.
