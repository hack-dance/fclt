# Writeback and Evolution

This is the core fclt loop. Writeback preserves useful signal from real work. Reconciliation proves
which configured sources were checked. Evolution turns repeated evidence into reviewable changes,
and outcome verification decides whether those changes worked.

Use this when normal work exposes the same problem more than once: shallow tests, missing context, stale guidance, a slow tool path, or a missing skill. Ignore it for one-off preferences and vague complaints.

It is not a ticket generator. Implementation tickets can remain linked evidence, targets, and
outcome proof without becoming one capability proposal per ticket. External work systems are
optional inputs; the loop remains useful with local writebacks, Git, logs, and Markdown alone.

For a new CLI or Codex-plugin install, initialize the whole loop first:

```bash
fclt setup
fclt doctor --json
```

The doctor report's `loop` object is the readiness contract. Optional external
integrations never count as successful source coverage unless their exported
evidence is explicitly configured and checked.

## Scheduled closed loop

Scheduling is explicit opt-in:

```bash
fclt ai loop enable --project
fclt ai loop status --project --json
fclt ai loop run --project --json
```

The controller owns only the Codex automation it creates. It keeps a
machine-local full queue and append-only audit log, while its notification
delta includes only new, changed, and resolved items. A registered scheduler
does not prove execution; status reports whether a successful loop run has
never been observed, is healthy, or is stale. Disable scheduling without
deleting history with `fclt ai loop disable --project`.

Project loop commands and enrollment from a linked Git worktree resolve the
primary checkout through the shared Git common directory. They use its canonical
configuration and durable project store. New stores use repository identity;
existing canonical slug stores remain readable. Execution identities remain in
receipts and coordination locks. If the primary checkout cannot be verified,
the command refuses to proceed. Existing `worktree_*` stores are retained.
If the primary checkout itself has a nonempty execution-keyed store from an
older version, commands stop with a reconciliation message before selecting a
new store. Preserve and reconcile that store's queue, configuration, automation,
and history before re-enabling the loop; this change does not migrate it.

To check when every registered project last ran, without invoking any loop or
changing scheduler state:

```bash
fclt ai loop status --all-projects --stale-after 8d --json
```

The report includes enrolled projects without loop state and existing project
stores. Each row includes `schedulerStatus` (`ACTIVE`, `PAUSED`, `missing`, or
`unknown` when inspection fails), `lastRunAt`, `lastSuccessfulScheduledRunAt`,
and `stale`. The default threshold is eight days; a missing, invalid, future,
or older `lastRunAt` is stale. Exactly eight days old is still within the window.
`stale: false` proves recent execution, not successful scheduled coverage; check
the successful scheduled timestamp separately. Legacy `worktree_*` stores have
`ephemeral: true` and are reported without migration or deletion. This flag marks
the legacy execution-key format, not proof that a checkout was disposable: older
versions also used that format for ordinary primary checkouts. Keep those stores
until their ownership and contents have been reconciled. New primary checkouts
use a stable repository store even though their receipt identity has a
`worktree_` prefix.

The loop can turn complete, correlated source evidence into targeted
writebacks and reviewable proposals. It does not apply canonical changes or
mutate external trackers. Project auto-apply is reported as plan-only until
fclt has hash-bound preconditions, validation, atomic rollback, and a durable
receipt. Global and plugin changes always remain proposal-only.

## Automatic source reconciliation

Manual writeback remains useful, but it is no longer the only source of review
signal. Setup creates `reconciliation.json` in the selected canonical root.
Keep the portable source definition in the project's canonical root and include
it in version control. A missing definition can be restored with `fclt ai review
init --project --dry-run --json`, followed by the same command without `--dry-run`.
Initialization preserves existing valid configuration and does not reset writebacks,
queues, or cursors. Run `fclt ai loop preflight --project --json` afterward: readiness
requires valid source configuration, a valid source selection, and writable state.
Missing or invalid configuration is deterministic and is not retried by the loop.

Machine-specific scheduler identity, queues, cursors, and history belong in fclt's
OS application-data store. Review mirrors live under the global review root with
project identity. Do not move project evidence into the global queue to solve a
missing project configuration. Shared operating instructions and reusable source
recipes may be global; each project's source selection and capability decisions
remain explicit and project-scoped.

The loop reuses source writebacks when creating proposals, preserving their original
context instead of copying them into synthetic capability gaps. A linked pending
proposal does not resolve its signal family. Use an explicit terminal disposition
only after outcome evidence supports it. Successful scans whose observed latest
source timestamp is already covered do not become stale merely because the source
is quiet; newer uncovered activity and unverified old cursors still warn.

Run a bounded review window before deciding that nothing is pending:

```bash
fclt ai review status --json
fclt ai review reconcile \
  --since 2026-07-03T00:00:00Z \
  --until 2026-07-10T23:59:59Z \
  --json
```

The adapter contract supports explicit writebacks, Git commits and canonical
asset changes, vendor-neutral evidence exports, automation memory/log files,
and configured Markdown logs, runbooks, or research. Defaults are read-only:
reconciliation does not edit issue trackers, Git, automation state, canonical assets,
writebacks, or proposals.

A project configuration can opt into additional sources without storing
credentials:

```json
{
  "version": 1,
  "sources": [
    { "id": "writebacks", "type": "writebacks", "scope": "global" },
    {
      "id": "git",
      "type": "git",
      "repository": "project",
      "defaultBranch": "main",
      "freshnessThresholdHours": 168,
      "paths": [".ai", "AGENTS.md", "docs"]
    },
    {
      "id": "external-work",
      "type": "evidence-export",
      "path": "reconciliation/evidence.json"
    },
    {
      "id": "runbooks",
      "type": "markdown",
      "root": "project",
      "paths": ["notes/capability-review-log.md", "research/agent-findings.md"]
    },
    {
      "id": "automation-memory",
      "type": "automation",
      "root": "home",
      "paths": [".codex/automations/**/memory.md"]
    }
  ]
}
```

Evidence exports use a versioned manifest whose coverage window must contain
the requested review window:

```json
{
  "version": 1,
  "producer": "example-tracker-exporter",
  "generatedAt": "2026-07-11T00:05:00Z",
  "coverage": {
    "since": "2026-07-03T00:00:00Z",
    "until": "2026-07-10T23:59:59Z",
    "complete": true
  },
  "events": [
    {
      "id": "event-123",
      "kind": "status-change",
      "observedAt": "2026-07-08T14:30:00Z",
      "body": "Implementation completed",
      "refs": ["EXAMPLE-123"],
      "status": "done"
    }
  ]
}
```

File patterns must stay inside the selected project or home root; symlink and
path traversal escapes are rejected. The evidence adapter reads only a local
file and performs no network or credential access. A separate plugin or
user-owned exporter can produce that file from any external system.
Missing exports, missing logs, stale sources, and adapter failures produce
degraded coverage instead of a false empty result.

Coverage and cursor freshness are separate contracts. `coverageComplete`
means every configured source proved the requested window; it does not mean a
stored source cursor is current. JSON, persisted reports, and readable review
artifacts expose a typed `freshness` state independently for each source and
for the review overall. A cursor becomes stale only when its configured
`freshnessThresholdHours` is exceeded (168 hours by default) or a bounded Git
check finds newer activity on the configured default branch. Newer repository
activity is checked independently of `paths`, so a complete path-filtered scan
cannot mask a frozen Git cursor. An unchanged stale queue item is suppressed
after its first notification.

Terminal evidence-export statuses (`done`, `completed`, `canceled`,
`obsolete`, `duplicate`, and their supported aliases) resolve a linked signal
family when the bounded export proves all linked work terminal. Git evidence
resolves a family only when the exact commit or equivalent patch is contained
on the configured default branch. Both paths preserve source provenance and
remain read-only; they do not close tracker work, edit Git, or apply proposals.

Configure file sources narrowly around append-only logs, dated runbooks, or
research streams that represent review evidence. Date section headings as
`## YYYY-MM-DD ...` so one file can prove which observations belong to the
requested window. For an undated Markdown file, fclt must use the file's
modification time for every section; broad patterns such as `notes/**/*.md`
can therefore surface old material whenever any matched document is edited.
Symlinks that leave the configured root and files above the safety limit
degrade coverage rather than being silently skipped.

Machine-local state stores per-source watermarks/cursors, dedupe history,
extraction decisions, and deterministic review-window JSON. Human-readable
mirrors live under `~/.ai/reconciliation/global/` or
`~/.ai/reconciliation/projects/<slug-hash>/`. Exact reruns reuse the completed
window; overlapping windows resume from source watermarks with a tie overlap.

Every discovered signal is classified as `implementation-only`,
`capability-source`, `capability-implementation`, `outcome-proof`, or `noise`.
Included signals receive exactly one disposition: `propose`, `apply-local`,
`task`, `resolve-watch`, or `defer`. Tickets remain linked evidence and task
targets rather than becoming one capability proposal per ticket.

Use this loop when a task exposes durable friction:

1. record one targeted writeback
2. group or summarize related writebacks
3. propose only when the evidence repeats or a missing capability is obvious
4. draft the smallest valid proposal
5. review, accept, and apply when the change is safe
6. verify whether the producing loop improved before resolving the source signal

## Writeback

Record writeback when the signal is durable and targetable:

```bash
fclt ai writeback add \
  --kind weak_verification \
  --summary "Checks were too shallow" \
  --category friction \
  --details "The source check did not exercise the installed launcher" \
  --impact "Packaging could fail after a source-only green result" \
  --attempted-workaround "Ran the built launcher directly" \
  --desired-outcome "The supported check covers the installed path" \
  --sensitivity internal \
  --evidence test:installed-launcher \
  --asset instruction:VERIFICATION
```

Use the structured fields only for concise, observable context:

- `category`: `friction`, `opportunity`, or `reusable-success`
- `details`: what happened and in what bounded context
- `impact`: why it mattered
- `attempted-workaround`: what was tried, if anything
- `desired-outcome`: what better behavior looks like
- `sensitivity`: `public`, `internal`, or `private`

This is not a reasoning transcript. Never record hidden chain-of-thought, raw
session transcripts, unbounded logs, secrets, tokens, or credential-bearing
payloads. Keep logs in their source system and store a small redacted evidence
reference. Secret-shaped content is redacted at capture regardless of
sensitivity. `private` retains the actionable summary while omitting
supplemental context from portable review surfaces.

Useful kinds:

- `weak_verification`
- `false_positive`
- `missing_context`
- `reusable_pattern`
- `capability_gap`
- `bad_default`

Avoid writeback for one-off preferences, vague complaints, or speculative ideas.

Link implementation work and preserve the review disposition:

```bash
fclt ai writeback link WB-00021 --issue TICKET-791
fclt ai writeback disposition WB-00021 \
  --type task \
  --target TICKET-791 \
  --expected-outcome "The producing loop stops repeating unchanged blocker prose" \
  --next-trigger "Implementation ships and the next review window completes"
```

Issue links are evidence and routing destinations, not capability assets. Group tickets by the
underlying friction or reusable success rather than creating one writeback per ticket.

## Activity

Read the latest completed loop in plain language:

```bash
fclt ai loop activity
fclt ai loop activity --json
fclt ai loop activity --project --json
```

The default versioned JSON is a portable, read-only activity set across Global
and every configured project loop. It includes aggregate counts and scope
health, then keeps the per-scope feeds intact for filtering and origin labels.
Use `--global` or `--project` for a single feed. It contains source coverage,
new/changed/resolved counts, correlated observations, decisions, linked work,
approvals, verification state, and the next action.
The aggregate is contract version 2 and joins each version 1 feed to a stable
opaque scope id. Check its `truncation` object before treating the returned item
list as exhaustive.
Actionable items may include an opaque `actionLocator`. Resolve it with
`fclt ai loop resolve <locator> --json` to obtain a read-only plan for the
verified current scope and resource. Missing locators remain handoff-only;
consumers must never infer roots from scope labels or internal ids.
After resolving a current signal family, record an explicitly approved
decision with `fclt ai loop decide <locator> --decision
<accept|redirect|reject|defer> --expected-revision <n> --actor <id>
(--approval-ref <ref>|--note <text>) --approve --json`. This appends one
revisioned machine-local receipt and does not implement the decision. Accepted
output carries bounded target, evidence, linked-work, expected-outcome,
verification, and next-action fields for an external work-unit orchestrator.
Each item also identifies its global or project context, typed capability
targets such as an instruction, skill, prompt, or automation, the reason for
the decision, and bounded HTTP(S) evidence links when the source supplied one.
Private evidence, credential-bearing or query-bearing URLs, and URL fragments
are omitted. It does not invent tracker links or contain absolute machine
paths. Each
plain-language item keeps the same context visible:

```text
Activity — example-service
- Setup guidance missed the isolated test harness
  friction · approval_needed · propose
  Why: Repeated evidence points to one project setup gap.
  Target: instruction · SETUP (@project/instructions/SETUP.md)
  Source: example.com · https://example.com/reviews/123
  Next: Review the proposed capability direction; approve, redirect, or defer it explicitly.
```

Each activity snapshot is embedded in its loop report, so a later writeback or
proposal transition cannot rewrite an
older run. Unchanged queue items are suppressed from change counts, while stale
or unavailable sources remain visible. A complete empty run means configured
coverage was checked; degraded or failed empty runs never claim that nothing is
pending.

Coverage completeness and source cursor freshness remain independent. A
complete review can still report one or more stale cursors, and each stale
cursor remains visible as its own coverage activity item. Current-source
terminal work or exact default-branch containment resolves a previously open
family; an explicit hold/defer remains unresolved and is never materialized as
implementation.

## Evolution

Review accumulated signal:

```bash
fclt ai writeback list
fclt ai writeback group --by asset
fclt ai writeback summarize --by kind
fclt ai evolve assess --asset instruction:VERIFICATION --json
fclt ai evolve propose
fclt ai evolve list
```

Use `assess` as the read-only gate for agent-led review UI. It returns a
recommendation (`reconcile_sources`, `review_reconciled_signals`,
`no_mutation`, `record_more_writeback`, `propose`, or
`review_existing_proposal`), source writeback ids, reconciliation coverage and
signal ids, active proposal ids, a quality checklist, suggested commands, and
the next agent instruction.

For a single weak or medium-confidence writeback, the right answer is usually more evidence, not a proposal. A useful no-op still explains what recurrence would change the decision and where the next writeback should land.

Draft and review:

```bash
fclt ai evolve draft EV-00001
fclt ai evolve review EV-00001
fclt ai evolve accept EV-00001
fclt ai evolve apply EV-00001
fclt ai evolve verify EV-00001 \
  --effectiveness improved \
  --evidence test:post-apply-regression \
  --note "The producing loop no longer repeats the failure"
```

`evolve show <id> --json` inspects a proposal without changing it. Repeating
`evolve draft <id>` preserves an existing draft, patch, and review state; use
`--append` only for an intentional substantive revision. If a patch is missing,
drafting rebuilds it from the existing authored draft rather than replacing that
draft with generated boilerplate.

Applying a proposal moves its source writebacks into an awaiting-verification state. Verification
then records one of `improved`, `unchanged`, `regressed`, or `inconclusive`. Improved evidence
resolves the writebacks; unchanged or regressed evidence returns them to the pending queue;
inconclusive evidence keeps them under watch.

Apply also records a verification window, baseline, expected criteria, due
date, grace period, and attempt history. The scheduled loop marks verification
as pending, due, or overdue. Unchanged or regressed evidence reopens the same
proposal family and can request that linked implementation work be reopened;
it does not create a duplicate proposal or directly update the task system.

Proposal creation does not promote source writebacks. Rejecting a proposal restores any legacy
promoted source writebacks to pending. Draft revisions for append-style proposals are included in
the actual target patch, not only in review history.

Supported durable proposal kinds include:

- `update_asset`
- `create_asset`
- `extract_snippet`
- `add_skill`
- `promote_asset`

Use the smallest kind that solves the repeated problem.

## Scope

Use project scope for repo-specific tooling, tests, architecture, and workflows.

Use global scope for shared doctrine, reusable skills, shared agents, or cross-project capability gaps.

Promote project proposals to global only after repeated reuse:

```bash
fclt ai evolve promote EV-00003 --to global --project
```

Promotion records the original source scope and linked writeback IDs in the destination's
machine-local journal. Draft, assessment, apply, and source status updates check that receipt
before accessing another scope. Imported proposal JSON cannot grant cross-scope access.
Older promoted proposals without a matching receipt must be promoted again from the original
project proposal.

Link additional writebacks to the original project proposal before promoting it. Linking a
global writeback to a promoted project proposal is refused because writeback IDs are local to
each scope. Canonical `@ai/` and `@project/` references require relative suffixes, even when
temporary paths are explicitly allowed.

Writeback and evolution filesystem operations share a bound directory boundary. On macOS and
Linux, reads, appends, locks, directory creation, and replacements open each component relative
to a directory descriptor without following links. The boundary verifies file and ancestor
identities before and after access; apply retains its target snapshot while reading the draft.
Every operation requires a matching root. Draft references must stay in the proposal draft
directories, and stored record IDs must be numeric writeback or proposal IDs. Temporary-path
overrides change storage eligibility without expanding these boundaries. Legacy queues must
remain within their authorized source scope, and records claiming another scope are excluded.
Generated graph repair reads its sources and writes its outputs through the same boundary.

Windows supports checked reads and appends. Writeback and evolution operations requiring
atomic file replacement refuse before mutation until handle-bound replacement is available;
pathname-based replacement cannot safely prevent a parent-directory swap.

## Review Artifacts

Runtime JSON queues, proposal metadata, draft patches, and journals stay in machine-local `fclt` state.

Human-readable Markdown mirrors live under global `~/.ai`:

```text
~/.ai/writebacks/global/
~/.ai/writebacks/projects/<slug-hash>/
~/.ai/evolution/global/
~/.ai/evolution/projects/<slug-hash>/
~/.ai/reconciliation/global/
~/.ai/reconciliation/projects/<slug-hash>/
```

Project-scoped artifacts include project metadata in frontmatter. They do not get written into repo-local `<repo>/.ai/writebacks` or `<repo>/.ai/evolution`.

### Ids

New writeback and proposal ids look like `WB-20261030-7K2M9QXA` and
`EV-20261030-3HX0PZ4N`: the UTC date, then 40 random bits in Crockford base32
(no `I`, `L`, `O` or `U`). Several machines can share one canonical `~/.ai`
repository without coordinating, because no machine-local counter is involved.
Allocation also skips ids already in the local queue, the pending mirrors, or
the tracked review directories.

Legacy sequential ids such as `WB-00001` and `EV-00001` keep working for list,
show, group, evolve and references. Both forms sort correctly as plain strings:
legacy ids sort first, then dated ids by day.

### Pending mirrors and publish

When `~/.ai` is a git work tree, fclt writes review mirrors to a machine-local
pending tree (`<fclt state>/review/pending/`, same relative layout) instead of
the tracked directories above, so agent work never leaves the shared repository
dirty. `fclt paths --json` reports the pending directories as the review
directories in this mode. Set `FACULT_REVIEW_MIRRORS=canonical` to keep writing
in place, or `pending` to force the pending tree.

Land pending mirrors with a branch and a pull request:

```bash
fclt ai writeback publish --dry-run
fclt ai writeback publish [--branch <name>] [--remote origin] [--base <branch>] [--json]
```

`publish` fetches the remote, creates a temporary `git worktree` from the
machine's review branch (or from the remote default branch the first time),
commits the pending mirrors that differ from the default branch, and pushes with
a plain fast-forward push. It never touches your working tree, index, stash or
current branch, and it refuses to push to the default branch itself. The default
branch name is `fclt/review-<key>`, where `<key>` is a random per-machine value
kept in fclt state; it is not derived from the hostname. For GitHub remotes it
opens or updates one pull request per branch with `gh`; otherwise it prints the
push result. Records are marked published only after the push succeeds.

Pending mirrors that still carry legacy sequential ids are skipped: the same
legacy id can mean different records on different machines.

### Migrating legacy dirty mirrors

Older releases wrote mirrors straight into the tracked tree. To land those:

```bash
fclt ai writeback publish --include-legacy --dry-run
fclt ai writeback publish --include-legacy
fclt ai writeback publish --include-legacy --remove-migrated
```

`--include-legacy` picks up untracked `writebacks/**/WB-NNNNN.md` files and
tracked ones modified in place. Each gets a new dated id; the file keeps its
body byte for byte except the `id:` and heading lines, and gains
`legacyId: "WB-NNNNN"` in frontmatter. It always lands as a new file, so tracked
records on the default branch are never rewritten or deleted. The output lists
`old -> new` with the sha256 of each source file so you can confirm capture.
A dry run allocates fresh ids each time; the real run records the mapping, so
reruns reuse it. Local copies stay in place unless you pass `--remove-migrated`,
which runs only after a successful push and only for files whose sha256 still
matches: untracked copies are deleted and tracked files are restored from
`HEAD`.

Generated `~/.ai/.facult/ai/index.json` and `graph.json` are rebuilt by
`fclt index`. If the canonical repository tracks them, ignore them there
(`.facult/ai/index.json`, `.facult/ai/graph.json`) so a reindex does not make
the tree dirty.

## Approval Rule

Global instructions, skills, plugins, and other high-risk shared surfaces require explicit review before apply. Project-scoped additive markdown changes can be lower risk, but still need evidence and a clear target.

Executable product or tooling work belongs in the task system. Use evolution for the reusable instruction, skill, prompt, or operating-model change that should survive that work.

## Next

- Read [Composable Capability](./composable-capability.md) to choose the smallest target.
- Read [Automations](./automations.md) to schedule recurring review loops.
- Read [Security and trust](./security-trust.md) before applying global changes.
