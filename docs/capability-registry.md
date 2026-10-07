# Versioned capability ownership

`fclt capability` records where a skill, custom plugin, or MCP configuration artifact came from and deploys one explicitly owned copy at a time. A pinned digest detects source drift. An ownership receipt detects live edits before an update. An installer that replaces a skill symlink with a directory therefore produces a conflict instead of silently losing either version.

The commands are separate from the read-only `deploy plan` text-file contract. Broad legacy `sync` and `manage` apply remain deprecated.

## Registry and source snapshots

Keep a registry in version control alongside reviewed source snapshots. This example uses `capabilities.json` under a canonical source root:

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "id": "example-skill",
      "kind": "skill",
      "owner": "fclt",
      "enabled": true,
      "source": {
        "path": "skills/example",
        "origin": "https://example.org/skills",
        "revision": "upstream-commit-or-version",
        "sha256": "sha256:REPLACE_WITH_DIGEST"
      },
      "target": ".agents/skills/example",
      "platforms": ["darwin", "linux"],
      "requires": []
    },
    {
      "id": "example-native-plugin",
      "kind": "plugin",
      "owner": "native",
      "source": {
        "origin": "marketplace:example-plugin",
        "revision": "1.0.0"
      }
    }
  ]
}
```

`kind` is `skill`, `plugin`, or `mcp`. `owner` is `fclt`, `native`, or `external`. A native/external record describes registered intent; it does **not** prove installation, observed version, authentication, or readiness. Use its provider to verify those states. Its target is optional, and several independent entries may identify one shared provider config file. Any target overlap involving an fclt-owned entry is rejected.

An fclt-owned source requires `path`, `origin`, `revision`, and `sha256`; it also requires a target. Source and target paths are relative to the explicit roots. A source can be a directory or one regular file. A skill requires a directory containing `SKILL.md`. An MCP entry deploys a complete standalone configuration artifact; it does not merge servers into shared provider settings. Native plugins retain ownership of their installed files. To distribute a custom plugin's authored package, register a separate fclt-owned staging target outside the native manager's directories, then install or update through that manager.

The digest includes file bytes, paths, empty directories, and executable flags. Ownership, timestamps, and other permission bits are excluded. Copies use private permissions (directories/executables `0700`, other files `0600`). Nested symlinks, hardlinked files, special files, case-colliding paths, and snapshots over 32 MiB or 4096 nodes are rejected. Directories named `.git`, `node_modules`, `__pycache__`, `.local`, and files named `.env` are rejected rather than silently omitted. Prepare a clean snapshot; do not copy machine caches or secrets into canonical source. If a live target gains runtime caches, that entry reports a conflict and inventory continues for other entries. Caches are never silently excluded or deleted. Configure runtime-writing skills to store caches outside their managed directories, or review and archive the divergent target before an explicit redeployment. Compiled assets such as `dist` may be legitimate plugin inputs and require review before pinning.

## Add, import, or update a capability

1. Acquire the upstream version in an isolated staging directory. Keep download credentials in the acquisition tool's authorized runtime; never put values in the registry or source tree.
2. Inspect its files, license, source URL, and immutable revision. For an existing live installation, compare it with canonical source and explicitly choose the intended version. The CLI does not infer which divergent copy is newer or correct.
3. Place the reviewed snapshot under the canonical source root. Run `fclt capability digest --path /path/to/canonical/skills/example` and record the returned `sha256` with its upstream revision in the registry. Commit the source and registry together.
4. Inspect `inventory` and the selected `plan`, then apply its exact `planId`. Verify provider discovery or runtime behavior separately.

Run upstream installers into staging, not into fclt-owned live directories. Replacing a live link or writing through a canonical link is detectable, but detection cannot reconstruct an unrecorded upstream version. Version control and acquisition provenance provide that history. The registry never downloads or executes upstream content.

## Host, platform, and private overlays

An entry may set `hosts`, `platforms`, and `overrides`. A matching platform override is applied first, then a matching host override. Each override has exactly one selector (`host` or `platform`) and may replace `enabled`, `source`, or `target`. `source` replacement must supply the complete pinned source object. Duplicate selectors are rejected. Host/platform allowlists are applied after these embedded overrides.

```json
{
  "overrides": [
    { "platform": "linux", "enabled": false },
    { "host": "build-station", "enabled": true }
  ]
}
```

For machine-owned or private choices, pass repeated `--overlay FILE` arguments. Each overlay has this shape:

```json
{
  "schemaVersion": 1,
  "entries": [
    { "id": "example-skill", "enabled": false }
  ]
}
```

Overlay files apply in CLI order after embedded overrides and selection. They may explicitly enable an excluded entry. Patches may contain only `id`, `enabled`, `source`, `target`, and `requires`; unknown IDs, duplicate IDs, unknown fields, and ownership changes are rejected. Overlay paths stay relative to the same roots. Select which platform/machine/private files to pass in the machine configuration; the library implements their common merge and validation rules. Keep private files out of shared source control. Plan IDs include all manifest and overlay bytes.

`requires` lists explicit **runtime** requirements, for example `env:API_TOKEN` or `op://vault/item/field`. Ordinary downloaded skill documents normally have none. Credentials used only to download or install a package belong to acquisition, not `requires`. An environment reference is available when that variable is nonempty; the command does not output or inject its value. A 1Password reference remains unresolved and blocks owned deployment in v1. Resolution belongs to an authorized provider integration; there is no override flag or secret store in this command.

## Inspect and apply

```sh
fclt capability inventory \
  --manifest /path/to/canonical/capabilities.json \
  --source-root /path/to/canonical \
  --target-root /path/to/tool-home-parent \
  --state-root /path/to/runtime/capabilities \
  --host build-station --platform linux \
  --overlay /path/to/machine/platform.json \
  --overlay /path/to/private/capabilities.json
```

Use the same arguments with `plan --id example-skill`, then `apply --id example-skill --expected-plan sha256:...`. All commands emit JSON; `--json` is accepted. The source root defaults to the manifest's directory; host and platform default to the current machine. Source, target, and runtime state must be separate at the actual asset paths. Runtime state may be elsewhere under the target home. No live home is inferred.

| Status | Meaning and apply behavior |
| --- | --- |
| `create` | Target absent; copy the pinned source and record ownership. |
| `restore` | Previously owned target absent; explicitly restore it. |
| `adopt` | Target has identical bytes, or is an exact link to canonical source; record ownership and convert that link into a copy. |
| `update` | Target still matches its receipt; copy the new pinned source. |
| `current` | Source, target, provenance, and receipt match; apply is a no-op. |
| `conflict` | Source pin or live content diverged, binding changed, or a foreign/broken link exists; preserve it and refuse apply. |
| `blocked` | Source or a required runtime reference is unavailable; refuse apply. |
| `disabled` | Intentional exclusion; retain existing content and refuse apply. |
| `independent` | Native/external ownership; no reads of installed contents and no mutation. |

A missing target never implies intentional disable; use `enabled: false` to express that choice. The `targetPresence` field reports `present`, `absent`, or `uninspected`; disabled fclt-owned entries inspect presence without reading content. Disabling stops management and retains existing files. It does not uninstall a capability or disable a native plugin in its provider.

`plan` and `inventory` do not write state. `apply` rebuilds and compares the plan before writing. Stale plans fail. A per-target lock serializes cooperating applies; unexpected locks are not automatically removed. Updates stage and verify a copy in the runtime state directory, retain the previous target under `recovery-*/previous` there, publish, verify, and write the receipt. Runtime state and the target must share a filesystem; otherwise apply refuses before changing the target. Recovery content stays outside provider discovery. The apply result returns `recoveryPath`; save it with deployment evidence. The old content is never automatically deleted. If publication fails after moving the old target and the destination remains absent, the command restores it. A process kill may leave a transaction directory, lock, or missing target: inspect them, preserve recovery content, and plan recovery before clearing the stale lock.

These checks protect against ordinary drift and cooperating deployments. Stop other installers while applying; the command does not provide an OS-level transaction against unrelated processes racing filesystem changes. A successful apply proves file content and provenance match. It does not prove provider discovery, plugin installation, MCP authentication, or tool execution.
