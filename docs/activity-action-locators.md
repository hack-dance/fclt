# Activity action locators

Aggregate activity can contain identical proposal, writeback, or signal ids in
more than one scope. An `actionLocator` lets a consumer ask fclt which exact
current target an item refers to without guessing a canonical root.

The CLI/JSON contract is authoritative:

```bash
fclt ai loop activity --json
fclt ai loop resolve <activity-action-locator> --json
```

The Codex plugin exposes the same read-only resolver as `fclt_registry` action
`activity_resolve`. Its input is exactly one `locator` string. It rejects
caller-supplied scope, cwd, root, path, argv, endpoint, token, token-env,
credential, approval, and mutation fields.

## Version 1 contract

`ActivityItem.actionLocator` is optional. Consumers must treat a missing
locator as read-only, handoff-only activity. This preserves compatibility with
older reports and with items for which fclt cannot issue a safe current action.

Version 1 locators use this opaque form:

```text
fclt-act-v1.<identity-digest>.<binding-digest>
```

Consumers must not decode, synthesize, alter, or route on either digest. The
identity digest binds the opaque aggregate scope id plus resource kind and
identity. The binding digest additionally binds the verified machine-local
runtime identity, latest activity run, queue revision, current resource
lifecycle revision, and one allowed action class.

The runtime identity is an opaque UUID persisted in the machine-local loop
configuration. fclt pairs it with a hash of the verified canonical root's
realpath and filesystem instance identity. Replacing a checkout at the same
path, copying runtime state, or redirecting an ancestor through a symlink does
not preserve that binding.

The locator contains no root, path, command arguments, URL, endpoint, token,
token environment variable, credential, or external-system authority.

## Resolution and expiration

Resolution is read-only. fclt searches its preferred machine-local Global and
project runtime registry, verifies the canonical root and runtime-state relationship,
and recomputes the locator from current state. A project state directory cannot
redirect a locator to another clone, worktree, moved root, or project merely by
reusing an internal proposal id.

A locator is state-bound rather than time-bound. It expires when any bound
fact changes, including:

- the latest activity run or queue revision
- proposal or resource lifecycle state
- the allowed action class
- project/runtime identity or canonical-root registration
- locator schema compatibility

Alternate caller-configured Global roots are not discoverable without accepting
caller authority, so their items intentionally omit locators and remain
handoff-only.

Always resolve immediately before presenting an action plan, and resolve again
before any later lifecycle command. Refresh aggregate activity after any
rejection; never repair a locator or guess a root.

## Resolution result

A successful version 1 response returns:

- exact opaque scope id and safe Global/project context
- resource kind and id
- activity run id and queue revision
- the one currently allowed action class
- a plain-language plan
- an explicit statement that no mutation was performed
- an explicit `available: false` mutation state
- the requirements a future separate mutation command must satisfy: explicit
  approval and an atomic expected-binding revision check

The action classes are `review`, `decide`, `apply`, `verify`, and `handoff`.
They describe the safe next workflow class; they do not grant permission to
execute it.

## Fail-closed errors

| Code | Meaning | Recovery |
| --- | --- | --- |
| `invalid_locator` | The locator is malformed. | Refresh activity and use the returned locator unchanged. |
| `incompatible_locator` | The locator version is unsupported. | Update fclt or refresh with a compatible producer. |
| `locator_not_found` | No verified current scope/resource identity matches. This includes removed resources, missing state, moved or renamed roots, and cross-project replay. | Repair registration/state if appropriate, then refresh activity. |
| `stale_revision` | The activity run, queue revision, resource lifecycle, runtime identity, or allowed action class changed. | Refresh activity and resolve the new locator. |
| `duplicate_identity` | More than one verified current target matched. | Repair duplicate registration; fclt will not choose one. |
| `locator_not_issued` | Current state matches, but the current aggregate snapshot did not issue that locator. | Refresh activity and use only the returned locator. |

## Mutation boundary

Resolution never reviews, accepts, rejects, applies, verifies, edits canonical
capability, writes project or tool-home files, changes workflow state, or
mutates an external system. Those operations remain separate closed commands.
Locator-bound mutation is withheld in version 1 because existing lifecycle
commands do not accept an expected locator binding revision. A consumer must
not translate a plan into those commands. A future mutation contract must
atomically require explicit approval and the expected current binding; a
locator alone is never mutation authority.
