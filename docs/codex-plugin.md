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

## MCP Tools

The plugin exposes:

- `fclt_status`
- `fclt_doctor`
- `fclt_paths`
- `fclt_init_operating_model`
- `fclt_writeback_add`
- `fclt_writeback_review`
- `fclt_evolve`

These tools are thin wrappers around CLI commands and return command output. Mutating tools still rely on the normal fclt safety model: dry-run first when available, review broad changes before apply, and preserve existing user guidance.

## Install In Codex

Use the narrow setup command for normal installs:

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
`codex plugin add fclt@<marketplace> --json`. The installed Codex cache is
under `~/.codex/plugins/cache/<marketplace>/fclt/0.1.0`.

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
bun run check
```

## Recommended Agent Use

Use the plugin skills as the first interface. Use MCP tools when a Codex workflow benefits from structured calls for status, doctor, paths, writeback, or evolution review.

For proposal triage, call `fclt_evolve` with `action: "assess"` before proposing when a target is known. Assessment is read-only and returns the recommendation, source writebacks, active proposal ids, quality checklist, suggested commands, and the next agent instruction.

Do not create writeback/evolution noise. Record strong signal, group repeated signal, assess readiness, then propose the smallest concrete capability change only when evidence repeats or the missing capability is clear.
