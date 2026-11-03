# Layered harness inventory

```sh
fclt inventory --harness codex --harness claude
fclt inventory --harness codex --json
fclt inventory --harness claude --home /path/to/account --json
fclt inventory --harness codex --context-tokens 200000 --json
```

This report observes configuration. It does not select, filter, enable, disable,
render, or sync resources. It writes no state, starts no MCP servers, and makes no
network or authentication requests. Run it from the project to inspect.

Every resource has `name`, `kind` (`skill`, `mcp`, `plugin`, `app`), `layer`
(`project`, `global`, `account`), `definedAt`, `harness`, and `account`. Account is
the harness configuration directory, not a login identity. Resource entries also
include `use`, `reason`, duplicate definition paths, and estimated always-loaded
and deferred token counts. Null counts mean **not measured**, never zero.

## Discovery and resolution

The report discovers directories matching `~/.codex*` and `~/.claude*`, harness
subdirectories under `~/.local/share/agent-accounts/*/`, and the current
`CODEX_HOME` or `CLAUDE_CONFIG_DIR`. `--home` replaces discovery and requires one
harness. Account sessions are reported separately; their configurations are not
merged with one another.

Profiles or home names ending in `-ln` are isolated by default, including explicit
`--home` paths and aliases that point into an isolated home. The report does not
read beneath them and emits one `skipped: ln-isolated` warning, with no account
contents. **`--include-ln` explicitly reads LN homes** and includes their contents
in the report. Use it only when that inspection is intended; report files can
contain private account and capability metadata.

Sources include canonical `~/.ai/skills` and `~/.ai/mcp/servers*.json`, native
account skills/configuration, Codex global `~/.agents/skills`, and project native
configuration and skills. Project discovery walks ancestors to the nearest Git
root (or only the current directory when outside Git). Project `.ai` sources are
shown as canonical-only.
Markdown links to `SKILL.md` in project `AGENTS.md` files are also reported as
unknown instruction references, rather than assumed native catalog entries.
Canonical resources are not assumed to load without a native reference. Symlinked
skill content is counted once per session, while all definition locations remain
visible. Broken or invalid skill metadata produces a warning.

Codex retains same-name skill candidates. Legacy `$CODEX_HOME/skills` and project
`.codex/skills` candidates are shown as unknown because loading varies by harness
version; documented `~/.agents/skills` and project `.agents/skills` remain native
candidates. Admin `/etc/codex/skills` and managed enterprise sources are not
inspected. Codex `skills.config` name/path selectors apply in order, with the last
matching entry winning. Native MCP definitions use the nearest project definition
over the account definition. Claude local MCP entries take
precedence over project `.mcp.json`, then user entries. Claude personal skills take
precedence over project skills.
Project MCP approval lists and per-project disabled-server toggles are honored;
unapproved project servers are unknown and excluded from measured totals.
Disabled definitions remain visible. Runtime project trust and approval can still prevent a candidate
from loading. `effective` describes the offline configuration candidate, not a
successful connection or a verified session prompt.

Enabled installed plugins are inspected only inside the selected account's
plugin cache. Codex cache resolution requires a single version when no install
registry is available. Plugin skill and MCP names include their plugin namespace.
Claude install entries are resolved for the current project and scope, excluding
other projects. All plugin enablement declarations remain visible across layers.
Ambiguous or unavailable installations are marked unknown. Plugin/connector MCP
endpoint deduplication is not resolved offline: two declarations reaching the same
endpoint can appear and be counted twice. Remote apps/connectors, dynamically discovered tools, managed policy, command-line
session overrides, and provider-bundled resources cannot be fully enumerated from
these files. Apps enabled in Codex are shown as an unknown remote catalog. An
absent offline entry does not prove a capability is unavailable to a live session.

## Token estimates

Counts use `ceil(chars / 4)`, not a tokenizer. Skill listing estimates include
name and description, plus the file path for Codex; skill body estimates count
the full file separately. Claude can use the first non-empty body line when a
description is absent.
Claude's combined description and `when_to_use` is capped at 1,536 characters per
skill. Its estimated listing budget is approximately 1% of context. Configured
Codex `skills.max_context_tokens` is clamped at 10,000. This report
models the default as 2% of context capped at 10,000; that ceiling is a conservative
report assumption. The current Codex docs specify a 2% default and a 10,000 maximum
for the explicit setting, without an explicit default ceiling.
`--context-tokens` supplies the context size; the default 200,000
is an assumption, not detection of the active model.

The aggregate listing is capped at the modeled budget. This does not reconstruct
which descriptions the harness shortens or drops: runtime history, settings, and
prompt formatting affect that result. Per-resource counts are before the shared
budget. Totals exclude canonical-only, disabled, shadowed, and unknown entries.

MCP names, instructions, and deferred schemas are counted only when supplied as
inline offline `tools` and `instructions` metadata in a definition. Most native
configs contain only connection details, so their catalogs are **not measured**.
No connection commands, environment values, URLs, schema contents, or skill bodies
are returned. `alwaysMeasured` and `deferredMeasured` are partial estimates;
`unmeasuredMcpServers` exposes missing catalogs. Native tools, system prompts,
instruction files, and live tool-call payloads are outside these totals. Harness
versions or models without deferred tool loading can have different costs.

Reference behavior:

- [Codex skill locations and same-name skills](https://developers.openai.com/codex/skills/)
- [Claude skill listing budgets](https://code.claude.com/docs/en/skills)
- [Claude MCP scopes](https://code.claude.com/docs/en/mcp)
