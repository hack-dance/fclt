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
