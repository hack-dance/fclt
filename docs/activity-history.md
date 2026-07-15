# Activity history

`fclt ai loop activity` remains the fast current-state snapshot. Use `fclt ai
loop history` when a consumer needs to explain how an item changed across
runs.

```bash
fclt ai loop history --json
fclt ai loop history --project --since 2026-01-01T00:00:00Z --json
fclt ai loop history --item family:SF-example --limit 50 --json
fclt ai loop history --scope-id project:0123456789abcdef --event verification --json
```

The command defaults to all configured scopes. Use `--global` or `--project`
for one scope. `--since`, `--until`, `--scope-id`, `--item`, and repeatable
`--event` flags narrow the query. Results are newest first. `--limit` accepts
1–200 records; pass `page.nextCursor` back through `--cursor` for the next
page.

## Contract

The JSON response is the version 1 `activity-history` contract. It contains:

- immutable event deltas, not copies of the current activity card
- run records for the events on the current page
- opaque scope, resource, family, and proposal identities
- optional lineage heads when `--item` is present
- per-scope availability, corruption, migration, and retention state
- pagination and separate truncation metadata

Event types are `run`, `discovery`, `observation`, `correlation`,
`disposition`, `proposal`, `review`, `application`, `verification`,
`effectiveness`, `regression`, `supersession`, and `resolution`. The `action`
field carries the concrete transition, such as `repeated`, `task`, `defer`,
`rejected`, `applied`, `verified`, `improved`, `regressed`, `superseded`, or
`resolved`.

Every event references one recorded run. The run record carries scope, trigger,
status, loop revision, config revision, reconciliation window, and coverage
counts. Resource events carry only the changed field and bounded safe context.
Consumers should join on `runId` and `resource.id`; they should not infer
lineage from titles or internal IDs.

When correlation merges or another transition supersedes a prior resource,
`relatedResourceIds` contains the opaque successor identity. This keeps branch
lineage collision-safe without exposing machine or source identity.

An item filter can match a returned resource ID or a safe scope-local item,
family, or proposal ID. The result sets `lineage.ambiguous` when the same local
ID exists in more than one scope. Use the opaque `scopeId` to disambiguate it.

## Storage and retention

History is machine-local runtime state. Each completed, degraded, or failed
non-preview loop run writes one immutable segment. Rewriting the same run is
idempotent and a checksum mismatch is refused. Preview runs do not write
history.

The default retention policy keeps 365 days, at most 10,000 events, and at most
2,000 current lineage heads per scope. Retention removes whole oldest segments
and least-recently observed heads. The manifest records pruned event, segment,
and head counts plus the last pruned event boundary. A query that asks for data
before that boundary reports partial coverage; an item-lineage query also
reports partial coverage after any head pruning.

The first version does not backfill from activity snapshots, technical loop
reports, writeback journals, or proposal files. Existing installations begin
with a truthful `snapshot-only` boundary. A query is complete only when its
explicit `--since` value is inside the retained version 1 window and every
selected scope is readable.

## Privacy and integration

The portable response excludes canonical roots, runtime paths, raw source
payloads, credentials, URL query strings, and local file links. It reports
corrupt, missing, omitted, pruned, and scan-limited history instead of silently
dropping it.

Core history reads and writes do not call external trackers or vendors. Export
is not part of this contract. A future export must be a separate explicit,
redacted, reviewable operation.

Human interfaces should consume this CLI/JSON contract directly. They should
not reconstruct history from runtime files or treat a current activity snapshot
as a timeline.
