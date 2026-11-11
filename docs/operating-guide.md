# Everyday evolution with fclt

Set up once, let agents preserve useful observations during work, and review the evidence
before changing shared guidance. Add project scope only for repositories you choose to maintain.

## The loop in one minute

1. **Notice:** record recurring friction, missing context, weak proof, or a reusable success.
2. **Correlate:** check the configured sources and group observations about the same cause.
3. **Decide:** choose a small capability change, implementation work, or a reason to wait.
4. **Propose, task, or watch:** draft a reviewable proposal, hand off authorized work, or keep
   the signal open with a next trigger. A linked ticket is evidence, not a proposal by itself.
5. **Verify:** rerun the workflow that produced the signal. Applying a change is not proof that
   it helped. Record improved, unchanged, regressed, or inconclusive results.

![Notice, review, change and verify](./diagrams/everyday-evolution.svg)

## Ten-minute global setup

[Install fclt](../README.md#install), then preview and apply CLI-only setup:

```bash
fclt --version
fclt setup --no-codex-plugin --dry-run --json
fclt setup --no-codex-plugin --json
fclt paths --json
fclt doctor --global --json
fclt ai review status --global --json
fclt ai loop run --global --dry-run --json
```

Setup installs the global operating-model guidance in `~/.ai`, prepares state and review
locations, and configures explicit writebacks as the default source. It does **not** collect
every repository's Git history or documents. Those need a selected project and source configuration.
Existing agent tools still need to load or reference the relevant guidance; installation alone
does not prove that an agent follows it.

Read doctor's `health`, `loop.capabilities`, and `loop.integrations` separately. The final command previews
source review without saving a loop report or advancing cursors.

The [Codex plugin](./codex-plugin.md) is optional. Preview its separate installation with:

```bash
fclt setup codex-plugin --dry-run --json
```

If you choose to install it, follow that guide and prove discovery with a fresh task that can
discover `fclt_setup` and successfully call `fclt_status`. CLI health, plugin registration, and
fresh-session callability are separate checks. CLI capture and reconciliation work without the
plugin or a scheduler.

## What agents should preserve

The built-in guidance asks for concrete observations with an evidence reference and a small
target: an instruction, skill, snippet, agent, tool interface, or automation. Useful signal includes:

- **Friction:** the same setup workaround keeps interrupting work.
- **Missing context:** agents repeatedly lack the repository's supported test command.
- **Weak proof:** source tests pass while the installed launcher fails.
- **Reusable success:** one verification method catches a failure other workflows miss.

Record one strong observation; reuse it when unchanged. One-off preferences, task completion,
raw logs, and speculative improvements do not warrant a writeback after every task.
For an actual observed launcher gap, for example:

```bash
fclt ai writeback add --global --kind weak_verification \
  --category friction --summary "Source checks missed the installed launcher" \
  --evidence test:installed-launcher --asset instruction:WORK_UNITS
fclt ai evolve assess --global --asset instruction:WORK_UNITS --json
```

Assessment may recommend more evidence or no change. Recording signal does not authorize
applying a proposal. See [writeback and evolution](./writeback-evolution.md) for targeted
drafting, review, application, and outcome verification.

## Choose global or project scope

| Observation or capability | Scope | Example |
| --- | --- | --- |
| Shared agent practice | Global | Check the installed executable when changing packaging. |
| A repository's workflow | Project | Run this service's integration harness before updating its API. |
| A repository's domain context | Project | Explain its migration order or fixture ownership. |
| A pattern proven useful across repositories | Project first, then reviewed promotion | A release-check skill repeatedly works in several projects. |

Project `.ai` is opt-in, repo-owned canonical capability. Runtime queues and receipts stay
machine-local; project review mirrors live under the global review root with project metadata.
When that root is Git-managed, mirrors wait in machine-local pending state for explicit
[publish](./writeback-evolution.md#pending-mirrors-and-publish). Keep secrets, personal defaults,
generated state, and private review material out of the repository.

### Select projects individually

Discover only a bounded workspace you intend to review:

```bash
fclt projects discover --root /path/to/workspace --since 30d \
  --max-visits 200 --max-results 20 --json
fclt project init --project-root /path/to/repo --json
```

Inspect truncation, duplicate locations, dirty state, proposed writes, and the entire plan.
Discovery never enrolls its results. Select active repositories individually; do not bulk-apply
every discovered checkout. Replace the placeholder below with the returned `planSha256`:

```bash
fclt project init --project-root /path/to/repo \
  --apply --plan-sha <planSha256-from-preview> --json
fclt projects status --root /path/to/repo --json
```

Minimal enrollment does not install a full operating pack, copy repository guidance, render
tool files, or enable a schedule. For an explicit guidance reference, add `--guidance AGENTS.md`
to both preview and apply. The file must be tracked, clean, and portable; fclt previews its
content and hash and keeps the original rulebook authoritative. See [project onboarding](./project-ai.md).
Enrollment mutation currently supports Linux and macOS; Windows supports inspection and preview.

### Keep sources narrow

From the selected repository, preview and create its source configuration:

```bash
fclt ai review init --project --dry-run --json
fclt ai review init --project --json
fclt ai review status --project --json
```

Project defaults check its writebacks and Git changes under `.ai`, `AGENTS.md`, and `docs`.
Review `reconciliation.json` in the chosen canonical root before expanding that selection.
Prefer one dated evidence log such as `notes/capability-log.md` over a workspace-wide Markdown
glob. An undated document's modification time can make old text appear current.
Use a local, bounded evidence export for optional external systems; fclt needs no tracker account.
The [source and export schemas](./writeback-evolution.md#automatic-source-reconciliation)
define coverage windows, freshness, path containment, and supported adapters.

For a CLI-only manual review, substitute your intended ISO timestamps:

```bash
fclt ai review reconcile --global \
  --since <window-start-ISO> --until <window-end-ISO> --json
```

Use `--project` from an enrolled repository for its sources. This records review artifacts and
cursors, but does not create a saved loop activity snapshot. A source-filtered or degraded review
cannot prove that nothing is pending.

## Opt into a cadence

These are starting recipes, not schedules created by setup:

| When | Recipe | Boundary |
| --- | --- | --- |
| During real work | Targeted writebacks at the event | Preserve evidence; avoid unchanged duplicates. |
| Daily | One global plan-only loop | Review shared signal; automatic canonical apply stays withheld. |
| Weekly | Loops for selected high-activity projects | Keep each project's sources and decisions separate. |
| Later, after those runs | A portfolio review of saved results | Read activity, history, and status; do not reconcile again. |

Preview the optional Codex scheduler recipes; run the project command from its selected repository:

```bash
fclt ai loop enable --global \
  --rrule 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0' --dry-run --json
fclt ai loop enable --project \
  --rrule 'RRULE:FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0' --dry-run --json
```

Only after authorizing that schedule, repeat its exact command without `--dry-run`.
This writes an owned Codex automation; an installed, running scheduler is needed for unattended
execution. The plugin is not required. `plan-only` means no automatic canonical application:
a real run can still record writebacks, draft proposals, and update runtime/review state.

For an enabled loop, one manual run can verify the reporting path:

```bash
fclt ai loop preflight --global --json
fclt ai loop run --global --json
fclt ai loop status --global --json
```

Preflight requires an enabled loop; before opt-in, `loop-disabled` is expected. Use `--project`
for an enabled project loop. Preflight checks configuration and writable paths; it enables nothing.
A successful manual run does not prove the timer fired. Check scheduler observation and the
successful scheduled-run timestamp after an actual scheduled execution. Native registration,
preflight, and an `ACTIVE` label alone do not prove success. See [automations](./automations.md).

## Read results and follow the evidence

After a saved loop run, start with the human activity view:

```bash
fclt ai loop activity
fclt ai loop activity --project
fclt ai loop activity --json
fclt ai loop history --project --limit 20 --json
fclt ai loop status --all-projects --stale-after 8d --json
```

Read what was captured, which sources were checked, why observations were grouped, the
disposition, linked work, verification state, and the next action. Complete empty coverage is
useful; failed, stale, unavailable, or truncated coverage needs attention.

The aggregate JSON is the version 2 `activity-set` contract with per-scope feeds and
`truncation`; single-scope feeds remain version 1. History is a separate version 1 timeline,
with coverage/retention limits and `page.nextCursor` for pagination. See the
[activity reference](./reference.md#writeback-and-evolution) and [history guide](./activity-history.md).
Consumers should use these commands rather than reconstructing state from raw queue files.

For a returned ID, choose its reported scope and drill down:

```bash
fclt ai writeback show <writeback-id> --global --json
fclt ai evolve show <proposal-id> --global --json
fclt ai loop report --project --json
```

Use `--project` for project IDs. The technical report can contain local paths; keep it local.
Follow the bounded evidence references in activity. If an item supplies an `actionLocator`,
use the [read-only resolver](./activity-action-locators.md) before presenting a decision; never
guess a root or synthesize a locator. Items without one remain handoff-only.

## Approval and privacy boundaries

Read-only inspection, runtime recording, canonical edits, scheduler activation, publishing,
cross-scope promotion, and external actions have separate authority. Respect the scope already
authorized by the user. A decision receipt does not execute work or grant new access.
The loop withholds canonical apply; manual proposal application still requires its review and
acceptance workflow plus authorization for the target. There is no automatic global apply.

Store concise facts and redacted evidence references. Never store credentials, raw transcripts,
or unbounded logs. `private` sensitivity limits supplemental portable context; it is not a
secret store. Optional exporters and external work orchestrators need their own explicit
authorization. fclt's core loop does not create, reopen, or close tracker work itself.

## Troubleshoot and undo safely

| Symptom or decision | Action |
| --- | --- |
| Missing or invalid source configuration | Inspect `review status`; preview `review init` in the correct scope. For invalid existing config, inspect it and the documented backup behavior before using `--force`. |
| No activity yet | A preview saves no report. Read manual reconciliation output, or run an explicitly enabled loop. |
| Incomplete coverage | Repair the named missing export, stale cursor, or source error; rerun the intended bounded review. Do not treat it as empty evidence. |
| Linked-worktree preflight refuses | Use the enrolled primary checkout and follow preflight's recovery; do not initialize a new review store in the generated worktree. |
| Plugin registered but tools absent | Start a genuinely fresh task and prove a typed call; registration alone is insufficient. |
| Old plan or receipt rejected | Inspect drift and preview again; do not substitute an old hash or delete edited files. |

Pause only the owned schedules, preserving queues, reports, and history:

```bash
fclt ai loop disable --global --json
fclt ai loop disable --project --json
```

Check the returned scheduler pause result; a failed pause needs attention even if configuration
is disabled. To stop selecting a repository, pause its loop first, then record the non-destructive
project decision:

```bash
fclt project disable --project-root /path/to/repo --json
```

To undo enrollment itself, use the `receiptId` from the matching active apply result:

```bash
fclt project rollback --receipt <receiptId-from-apply> --json
fclt project rollback --receipt <receiptId-from-apply> --apply --json
```

Rollback refuses changed files or an inactive receipt and preserves review history and unrelated
content. For mistaken signal, `fclt ai writeback dismiss <writeback-id> --global` retains its
lifecycle history; a proposal can be rejected with `fclt ai evolve reject <proposal-id> --global
--reason "No longer supported by the evidence"`. Use the originating project scope when needed.
For an already applied change, review a new correction and verify it; rejecting a proposal is
not a filesystem undo. Global setup has no single rollback command: inspect its recorded changed
paths and backups, then restore only reviewed files from your own version history or backup.
Do not delete the canonical root or runtime history as a repair shortcut.
