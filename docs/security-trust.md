# Security and Trust

`fclt` can inspect and install capability that affects agent behavior. Treat that capability like code.

## Source Trust

Remote catalogs can be useful, but they should not become trusted by accident.

```bash
fclt sources list
fclt verify-source skills.sh --json
fclt sources trust skills.sh --note "reviewed"
fclt install skills.sh:code-review --as code-review-skills-sh --strict-source-trust
```

Source trust has three practical states:

- `trusted`: reviewed source, eligible for strict installs and updates
- `review`: visible but not trusted for strict installs
- `blocked`: not eligible for install/update

## Item Trust

Individual skills and MCP servers can also be trusted or untrusted:

```bash
fclt trust <skill-name>
fclt trust mcp:<name>
fclt untrust <skill-name>
fclt untrust mcp:<name>
fclt trust skills --all
fclt untrust mcp --all
```

Use item trust when a source contains mixed-quality skills or MCP servers, or when local review happens item by item.

## Audit

Run an interactive audit:

```bash
fclt audit
```

Run static checks in automation:

```bash
fclt audit --non-interactive --severity high
fclt audit --non-interactive mcp:github --severity medium --json
```

These commands are literally read-only: library evaluation, the interactive
initial scan, the non-interactive CLI, and the typed `fclt_audit` MCP operation
do not write latest-report files or generated index annotations.

Persist a report only to an isolated root that already exists:

```bash
mkdir -p /absolute/isolated/audit-reports
fclt audit --non-interactive --report-root /absolute/isolated/audit-reports --json
```

The report is committed as one content-addressed `static-<sha256>.json` or
`agent-<sha256>.json` authorization envelope. The envelope contains the report
payload and its receipt, so there is no separately committed sidecar or partial
two-file state. Descriptor-relative, exclusive creation retains the validated
output-directory inode through the single atomic link. Report roots must be
owned by the current account and cannot be group- or world-writable. fclt
preflights directory sync support, treats the atomic link as the irrevocable
commit point, and attempts to sync the directory entry before returning. A
post-link sync error is treated as an already committed outcome and cannot
trigger unsafe pathname rollback. The receipt contains the
evaluation-time identities and hashes of the exact files and derived context
used by the report. fclt revalidates that
snapshot after evaluation and again before committing, so a source change
during a long agent call cannot be certified as the bytes that were reviewed.
Discovery also records every probed candidate and traversed directory. Missing
paths are anchored to the nearest existing directory identity, so a late file,
directory, or symlink ancestor invalidates persistence before any artifact is
created.
Registry-declared Claude plugin installations are authoritative inputs, not
optional discovery hints. Each declared installation must remain a real,
non-symlink directory strictly inside Claude's plugin cache. Its entire tree is
captured with stable no-follow reads, exact file bytes and modes, directory
contents and identities, and conservative entry, depth, path, per-file, and
aggregate-byte bounds. The provenance receipt stores each strict tree's exact
limits and canonical membership. Snapshot schema v8 rejects extra, missing,
duplicate, reordered, aliased, overlapping, or conflicting records and binds a
canonical validation-contract digest. It also binds every lexical requested
path to the same physical identity from first observation through final
validation, including every lexical ancestor's type, inode, and raw link target
and absence proofs across ancestor retargets. Requested-path membership is exact:
an extra, stale, missing, or conflicting binding is rejected even if a contract
digest is recomputed. Report revision 10 and receipt schema v5 make detached or
older authorization fail closed. Report loading keeps both the parent directory
and envelope open by descriptor, revalidates their lexical and physical identity
at every read and authorization boundary, and applies overlap checks to that
same bound directory object. Final-name collisions are opened without following
links and accepted only when the private, singly linked regular file has exactly
the canonical envelope bytes;
symlinks, hardlinks, special files, permission ambiguity, and conflicting
content fail closed. Each directory's replay budget is derived from that one tree
contract, and the complete current-directory manifest is reserved against the
single aggregate entry budget before any child is opened or traversed. A missing,
inaccessible, linked, escaped, replaced, or
changed declared tree aborts evaluation or persistence with no report artifact.
Skill support files under `assets/`, `references/`, and `scripts/` are
deterministically enumerated, bounded, hashed, and rejected on symlink or
special-file ambiguity. fclt rejects relative or traversing paths, unresolved or
ambiguous destinations, symlink destinations, and any destination that
equals, contains, or is contained by an evaluated root, skill/plugin tree,
MCP config, hook, or asset path. Generated
`index.json` annotations are also withheld unless `--update-index` is supplied
as a separate explicit mutation.

Verified-envelope loading is descriptor-bound and bounded before allocation.
Oversize, sparse, growing, multiply linked, non-private, or identity-changing
envelopes fail closed before they can authorize `audit safe`, an `audit fix`
mutation, or a zero-write fix preview.

Persistence currently requires native descriptor-relative `openat`/`linkat`
support (macOS or Linux). Other platforms fail closed rather than falling back
to a pathname validate-then-rename sequence; read-only audit remains available.
The compiled release verifier asserts persistence success on macOS/Linux and
the explicit no-artifact failure contract on Windows.

Agent audit subprocesses use temporary HOME, config, state, cache, and working
directories with session persistence disabled. Profile credential files are
never copied: supported environment authentication is passed through, and OS
native credential services remain available without exposing the normal
profile tree. Agent children receive a small operational environment allowlist
and only the selected tool's authentication variables; unrelated service
credentials, proxy variables, Git overrides, and execution hooks are removed.
A file-backed-only profile is rejected as a command-level
precondition; use the tool's supported API-key environment variable or native
authentication. Settings, hooks, sessions, and history are not copied.
Authentication failures are command-level precondition failures, so they
cannot become misleading per-item findings or persisted partial reports.
Raw child stdout, stderr, spawn errors, and parser errors never enter audit
findings or saved reports. Failures use fixed diagnostic codes, while accepted
structured output is schema-checked and redacted against selected credentials
before report construction. Codex last-message reads are descriptor-stable and
bounded; subprocess streams are drained concurrently with bounded capture.

Codex plugin installation verification also treats the installed payload as
untrusted executable input. It uses bounded no-follow descriptor reads and
rejects excess entries, depth, path length, per-file bytes, aggregate bytes,
sparse or growing files, links, special entries, unreadable subtrees, and any
directory identity change.

Compatibility note: older releases refreshed
`.ai/.facult/audit/*-latest.json` and generated index audit annotations during
every audit. Those implicit writes are removed. Legacy saved `*-latest.json`
reports remain inspection artifacts only; they do not authorize `audit safe`
or `audit fix`. `audit safe` mutations require an
exact fresh content-addressed report, its receipt, and explicit `--yes`
approval. `audit fix --dry-run` remains zero-write. Supported `audit fix --yes`
remediation holds the exact report-authorized canonical MCP source and local
destination open with no-follow descriptors, stages owner-only bytes, and
revalidates object identity, permissions, ancestors, source bytes, and the
outside-Git policy at the atomic commit boundary. Drift, replacement, or
cross-root redirection fails closed with rollback and no external artifacts.

Root cause of the old behavior: the static and agent library runners wrote
their latest reports before returning; both non-interactive CLI wrappers then
updated the canonical generated index; the interactive audit called those same
runners; and the typed MCP audit routed to the non-interactive CLI. Read-only
entry points therefore shared persistence code instead of merely evaluating
the scanned source.

Suppress, preview, or remediate reviewed findings:

```bash
fclt audit safe mcp:github --rule static:mcp-env-inline-secret --note "reviewed" \
  --report /absolute/isolated/audit-reports/static-<sha256>.json --yes
fclt audit fix mcp:github \
  --report /absolute/isolated/audit-reports/static-<sha256>.json --dry-run
fclt audit fix mcp:github \
  --report /absolute/isolated/audit-reports/static-<sha256>.json --yes
```

Receipts fail closed when their schema/capability revision, report hash,
finding identities, source path identity or content revision, or 15-minute
freshness window does not match. Supply both exact reports with repeated
`--report` for a combined static/agent safe action or fix selection.

## Secrets

Tracked canonical MCP config should not inline secrets. Put machine-specific values in ignored local overlays:

```text
~/.ai/mcp/servers.local.json
<repo>/.ai/mcp/servers.local.json
```

`inventory --json` redacts MCP secrets by default. Use `--show-secrets` only for local debugging.

## Commit Hygiene

Commit canonical source that should travel:

- instructions
- snippets
- skills
- agents
- MCP definitions without secrets
- project sync policy

Do not commit:

- generated index or graph state
- machine-local writeback queues
- proposal metadata and draft patches
- rendered tool outputs
- local secret overlays

Project-scoped writebacks and evolution proposals are mirrored for review under global `~/.ai/writebacks/projects/<slug-hash>/` and `~/.ai/evolution/projects/<slug-hash>/`, not under repo-local `<repo>/.ai`.
