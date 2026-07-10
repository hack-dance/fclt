# Codex Plugin Runtime and Safety Contract

The fclt Codex plugin is a safe entry point even when `fclt` is not already on
`PATH`. The plugin owns runtime discovery and a verified plugin-local runtime;
the CLI remains the source of truth for capability behavior.

## Trust Boundaries

The plugin distinguishes four kinds of state:

- authored capability under an explicit global or project canonical root
- generated index, graph, and rendered tool output
- machine-local workflow, audit, update, and recovery state
- the plugin-local fclt runtime selected by an atomic active manifest

The plugin never treats a tool home, generated file, staged download, or
machine-local cache as authored canonical capability. It does not return inline
secrets or local secret overlays through MCP.

## Runtime Discovery

Discovery is deterministic. Candidates are considered in this order:

1. explicit `FCLT_BIN`
2. the plugin-local active runtime manifest
3. fclt install metadata
4. active `PATH`, including npm, mise, or Homebrew shims
5. the canonical fclt bin directory and platform-specific Homebrew locations

Every candidate must implement `fclt protocol --json`. The handshake reports
the CLI version, protocol compatibility range, executable, platform, and
architecture. A candidate without a compatible handshake may be reported but
is never selected for mutation.

Runtime status reports the selected executable, version, source, compatibility,
plugin version, and whether a fresh Codex session is still required. Installed
plugin metadata is not accepted as proof that a fresh session exposes its MCP
tools.

## Bootstrap and Update

Automatic update checks are read-only. Bootstrap and update use the same staged
lifecycle:

1. resolve an explicit semantic version or read the latest GitHub release
2. download the immutable tagged platform asset and `SHA256SUMS`
3. require an exact checksum entry and verify the downloaded bytes
4. execute the staged binary's protocol handshake without activating it
5. write a staged manifest containing repository, tag, URLs, checksum, version,
   platform, architecture, and protocol evidence
6. require explicit approval plus version and checksum preconditions to apply
7. copy into a versioned plugin-runtime directory and atomically replace only
   the active manifest
8. verify the active binary again and retain the prior active version

Rollback verifies the retained binary and checksum before atomically switching
the active manifest. Corrupt recovery data is refused. A mutation lock prevents
concurrent stage, apply, and rollback operations. Temporary files and incomplete
stages never become active.

Runtime policy supports an explicit semantic-version pin and an update-check
opt-out. Policy changes require approval. A pin prevents staging any other
version, and disabling checks avoids network access while leaving explicit
status and rollback available.

The plugin does not curl-pipe scripts, execute a mutable unverified URL, replace
an existing global installation, or claim that a staged update is active.

## MCP Safety Classes

Every exposed operation is assigned one risk class:

- `read_only`: structured inspection with provenance and freshness
- `review_producing`: drafts, plans, diffs, writebacks, proposals, or staged
  downloads that do not change canonical assets or tool homes
- `reversible_mutation`: explicit scope and target, preview by default,
  preconditions, lock, bounded snapshot or journal, outcome verification, and
  tested recovery data
- `high_risk_destructive`: global/shared policy, trust, removal, cross-scope
  promotion, credential-affecting configuration, or runtime/plugin replacement;
  these require stronger approval or remain withheld

MCP arguments are schema validated. Unknown actions and fields are rejected.
There is no arbitrary argv or shell passthrough. Mutating responses state the
problem, evidence, reason, target, risk, expected outcome, assumptions, actual
changes, verification result, and undo path.

The complete CLI-to-MCP disposition is published in
`codex-plugin-capability-matrix.json`. A command being present in the CLI does
not by itself make it safe to expose through MCP.

## Recovery and Fresh-Session Proof

Source tests prove parsers and state transitions. Release acceptance also needs:

- an isolated HOME and PATH with the packaged plugin and no preinstalled fclt
- checksum-failure and protocol-skew refusal
- staged update, activation, and rollback to a working prior runtime
- representative project-local preview, apply, verification, and recovery
- package-content verification
- a genuinely fresh Codex task that discovers and calls the published tools

Registration, cache contents, and MCP self-test output are useful diagnostics,
but they do not replace fresh-task discovery.
