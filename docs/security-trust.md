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

The report is written atomically as `static-latest.json` or
`agent-latest.json`. fclt rejects relative or traversing paths, unresolved or
ambiguous destinations, symlink destinations, and any destination that
equals, contains, or is contained by an audited source root. Generated
`index.json` annotations are also withheld unless `--update-index` is supplied
as a separate explicit mutation.

Compatibility note: older releases refreshed
`.ai/.facult/audit/*-latest.json` and generated index audit annotations during
every audit. Those implicit writes are removed. Existing saved reports remain
available to the explicit `audit safe` and `audit fix` workflows, but a new
read-only audit does not silently replace them.

Root cause of the old behavior: the static and agent library runners wrote
their latest reports before returning; both non-interactive CLI wrappers then
updated the canonical generated index; the interactive audit called those same
runners; and the typed MCP audit routed to the non-interactive CLI. Read-only
entry points therefore shared persistence code instead of merely evaluating
the scanned source.

Suppress or fix reviewed findings:

```bash
fclt audit safe mcp:github --rule static:mcp-env-inline-secret --note "reviewed"
fclt audit fix mcp:github
```

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
