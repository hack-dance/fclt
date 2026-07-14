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

The report is committed as content-addressed `static-<sha256>.json` or
`agent-<sha256>.json` plus a matching `.receipt.json`. Descriptor-relative,
exclusive creation retains the validated output-directory inode across the
commit. fclt rejects relative or traversing paths, unresolved or
ambiguous destinations, symlink destinations, and any destination that
equals, contains, or is contained by an evaluated root, skill/plugin tree,
MCP config, hook, or asset path. Generated
`index.json` annotations are also withheld unless `--update-index` is supplied
as a separate explicit mutation.

Persistence currently requires native descriptor-relative `openat`/`linkat`
support (macOS or Linux). Other platforms fail closed rather than falling back
to a pathname validate-then-rename sequence; read-only audit remains available.

Compatibility note: older releases refreshed
`.ai/.facult/audit/*-latest.json` and generated index audit annotations during
every audit. Those implicit writes are removed. Legacy saved `*-latest.json`
reports remain inspection artifacts only; they do not authorize `audit safe`
or `audit fix`. Those mutations require an exact fresh content-addressed
report, its receipt, and explicit `--yes` approval.

Root cause of the old behavior: the static and agent library runners wrote
their latest reports before returning; both non-interactive CLI wrappers then
updated the canonical generated index; the interactive audit called those same
runners; and the typed MCP audit routed to the non-interactive CLI. Read-only
entry points therefore shared persistence code instead of merely evaluating
the scanned source.

Suppress or fix reviewed findings:

```bash
fclt audit safe mcp:github --rule static:mcp-env-inline-secret --note "reviewed" \
  --report /absolute/isolated/audit-reports/static-<sha256>.json --yes
fclt audit fix mcp:github \
  --report /absolute/isolated/audit-reports/static-<sha256>.json --yes
```

Receipts fail closed when their schema/capability revision, report hash,
finding identities, source path identity or content revision, or 15-minute
freshness window does not match. Supply both exact reports with repeated
`--report` for a combined static/agent action.

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
