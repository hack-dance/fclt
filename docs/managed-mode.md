# Legacy managed mode

Broad managed mode is deprecated and contained by default. Its whole-tool ownership and backup
restore model is not transaction-safe enough for new installations. Inventory, status, and dry-run
planning remain available while exact per-asset deployment replaces it.

If you only want the first-party fclt Codex plugin, use the narrow setup path instead:

```bash
fclt setup codex-plugin
```

That installs/exposes the bundled plugin without adopting or rendering the rest of Codex state.

Prefer this default workflow:

```bash
fclt status
fclt inventory --json
fclt list skills
fclt consolidate --auto keep-current --from ~/.codex/skills --from ~/.agents/skills
```

Inspect a legacy plan without applying it:

```bash
fclt manage codex --dry-run
fclt sync codex --dry-run
fclt unmanage codex --dry-run
```

An existing installation can use `--allow-legacy-managed-mutation` (or
`FCLT_ALLOW_LEGACY_MANAGED_MUTATION=1`) only for an explicitly reviewed migration. The escape hatch
does not make broad management transactional or safe for routine use.

## Upgrade recovery

Upgrades diagnose old managed records and background autosync state without changing them:

```bash
fclt doctor --global --json
```

The `legacyRecovery` object reports source coverage plus one of `clear`, `contained`,
`cleanup_required`, or `blocked`. A retained managed record or inactive autosync config is
`contained`; it is useful ownership evidence and is not deleted. Incomplete, malformed, foreign,
or orphaned state is `blocked` and produces no cleanup command.

Released managed-state and autosync schemas did not persist the broad-mutation approval flag.
Recovery therefore does not guess at or delete approval-like keys; tool-native settings such as
`approval_policy` remain authored configuration outside this cleanup boundary.

When an exact root-owned background service remains, doctor emits a closed cleanup argv containing
the selected service, root, scope, and snapshot-derived plan id. Run that exact command only after
reviewing it. Cleanup is CLI-only, requires the explicit command-line approval flag, revalidates
ownership under a machine-local autosync lifecycle boundary shared across roots, unloads first when
launchd is applicable, and otherwise removes only a freshly verified inert owned plist. It preserves
config and tool state and leaves a retry/idempotency receipt. It does not accept ambient environment
approval and it is not exposed as an MCP mutation.

## Adoption Commands

`manage --adopt-existing` is a legacy import-and-own path. It is blocked unless the containment
escape hatch is present.

`sync --adopt-live` is for intentional later promotion. It imports live tool edits into canonical state before rendering.

Dry-run sync does not adopt live edits. Legacy apply and `--adopt-live` require the containment
escape hatch and should be reserved for migration work.

## Conflict Behavior

When live content differs from canonical content:

- default `sync` preserves the live file and tells you to rerun with `--adopt-live` if you want promotion
- `sync --adopt-live` imports the live content into canonical source where supported
- rendered docs/config with local edits are skipped unless an explicit conflict option allows overwrite
- built-in rendered defaults require `--builtin-conflicts overwrite` before replacing local edits

This preserves deterministic inspection, but broad apply is not transaction-safe or sufficiently
reversible to use as a routine deployment path.

## Legacy project managed mode

Project sync is default-deny. A project `.ai` root can exist without rendering anything into repo-local tool outputs.

Allow project assets explicitly:

```toml
version = 1

[project_sync.codex]
skills = ["project-review"]
agents = ["review-operator"]
automations = ["project-check"]
mcp_servers = ["github"]
global_docs = true
tool_rules = true
tool_config = true
```

If a repo-local `.ai` contains only generated state and no canonical assets, `fclt status --project` reports a generated-only warning and `fclt sync --project` skips. Initialize or restore canonical source before syncing managed project output.

## Do not use managed mutation when

Do not use managed mode when:

- you only need discovery or inventory
- another tool should remain the owner of its files
- a repo has no clear project sync policy
- the canonical source is missing
- you are debugging and need read-only evidence first
- you are considering background autosync, backup restoration, managed MCP/plugin rendering, or forced remote updates

Use `fclt inventory`, `scan`, `list`, `show`, `graph`, `status`, `audit`, and managed dry-runs
instead. Use native installers for plugins and MCP servers where available.

## Next

- Read [Project `.ai`](./project-ai.md) for repo-local sync policy.
- Read [Security and trust](./security-trust.md) for MCP secrets and audit.
- Use [Command reference](./reference.md) for common managed-mode commands.
