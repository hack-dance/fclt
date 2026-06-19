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

From this repository, the plugin can be rendered into the Codex plugin marketplace by managed sync:

```bash
fclt manage codex --global
fclt sync codex --global
```

That writes plugin files under the Codex plugin location and updates the personal marketplace entry. Use managed sync only when you want `fclt` to write Codex tool files.

For local plugin development, run the lightweight checks that ship with the repository:

```bash
node plugins/fclt/scripts/fclt-mcp.cjs --self-test
bun run check
```

## Recommended Agent Use

Use the plugin skills as the first interface. Use MCP tools when a Codex workflow benefits from structured calls for status, doctor, paths, writeback, or evolution review.

Do not create writeback/evolution noise. Record strong signal, group repeated signal, then propose the smallest concrete capability change.
