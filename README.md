# facult

Bun CLI to inventory and audit local coding-assistant assets across tools.

It focuses on the things that actually affect agent behavior and security posture:
- Skills (directories containing `SKILL.md`)
- MCP server configs (and server names when detectable)
- Hooks/rules configs (Claude Code hooks, Cursor project hooks/rules, git hooks)
- Instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`)
- Claude plugins (installed plugin list, plugin-provided skills, and plugin hook scripts)

It stores the last scan result at `~/.facult/sources.json`.

## Install (local)

```bash
bun install
bun link
facult scan
```

## Quick Start

Get help:

```bash
facult --help
facult scan --help
facult audit --help
```

Inventory common tool locations:

```bash
facult scan
facult scan --json > /tmp/facult-inventory.json
```

Scan broadly across projects (project-level `.claude/`, `.cursor/`, `.husky/`, etc):

```bash
facult scan --from ~
facult scan --from ~/dev --from ~/work
```

By default, scans and audits skip git hooks (`.git/hooks`) and Husky hooks (`.husky/**`) because they can be extremely noisy. Enable them explicitly when needed:

```bash
facult scan --include-git-hooks --from ~
facult audit --non-interactive --include-git-hooks --severity high
```

Run audits:

```bash
facult audit
facult audit --non-interactive --severity high
facult audit --non-interactive --with claude --max-items all
```

## Development

Run local quality checks:

```bash
bun run type-check
bun test
bun run check
```

Auto-fix formatting/safe lint fixes:

```bash
bun run fix
```

## Configuration

facult state lives under `~/.facult/`:
- `~/.facult/sources.json` (last scan)
- `~/.facult/audit/static-latest.json` (last static audit)
- `~/.facult/audit/agent-latest.json` (last agent audit)

Optional config file: `~/.facult/config.json`.

Supported keys:
- `rootDir` (string): override canonical store root.
- `scanFrom` (string[]): default scan roots (equivalent to passing `--from` each run).
- `scanFromIgnore` (string[]): extra ignored directory basenames under `scanFrom`.
- `scanFromNoDefaultIgnore` (boolean): disables the default ignore list under `scanFrom`.
- `scanFromMaxVisits` (number): max directories visited per `scanFrom` root.
- `scanFromMaxResults` (number): max discovered paths per `scanFrom` root.

Example:

```json
{
  "rootDir": "~/agents/.facult",
  "scanFrom": ["~", "~/dev", "~/work"],
  "scanFromIgnore": [".venv", "vendor"]
}
```

Disable config roots on a single run with `--no-config-from` (scan + audits + consolidate).

## Canonical Store Root

Some commands (`consolidate`, `index`, `list`, `show`, `manage`, `sync`) operate on a canonical store directory.

Resolution order:
1. `FACULT_ROOT_DIR`
2. `~/.facult/config.json` with `{ "rootDir": "..." }`
3. default: `~/agents/.facult` (or an existing legacy store if detected)

### Migration (Legacy Store)

If you have an older canonical store from a previous version, migrate it to `~/agents/.facult`:

```bash
facult migrate --dry-run
facult migrate --write-config
```

By default, `facult migrate` auto-detects a legacy store under `~/agents/` (use `--from <path>` to choose a specific directory).

Canonical layout (high-level):

```text
<FACULT_ROOT_DIR>/
  skills/<name>/SKILL.md
  mcp/servers.json (or mcp/mcp.json)
  agents/
  snippets/
    global/*.md
    projects/<project>/*.md
  index.json
```

## Commands

Command groups:
- Inventory: `scan`
- Audits: `audit static`, `audit agent`
- Canonical store: `consolidate`, `index`, `list`, `show`
- Enablement + managed-mode: `trust`, `untrust`, `enable`, `disable`, `manage`, `unmanage`, `managed`, `sync`
- Remote indices: `search`, `install`, `update`
- Source verification: `verify-source`
- DX scaffolding: `templates`
- Snippets: `snippets ...`
- Debug: `adapters`

For full flags/usage: `facult --help` and `facult <cmd> --help`.

## Scan

If you don't pass any `--from` roots and you haven't configured `scanFrom`, `facult scan` defaults to scanning `~` with safety limits.

```bash
facult scan
facult scan --json
facult scan --show-duplicates
facult scan --tui
facult scan --no-config-from

# Additional scan roots (repeatable):
facult scan --from ~
facult scan --from ~/dev --from ~/work
facult scan --from ~ --from-ignore .venv
```

What `--from` looks for (heuristics):
- Repos with `.git/` (repo roots are treated specially to avoid full-tree crawls)
- Tool directories: `.claude/`, `.cursor/`, `.husky/`, `.git/hooks/`, `.codex/`, `.agents/`, `.clawdbot/`
- Skills: any directory containing `SKILL.md`
- MCP configs: `mcp.json`, `mcp.config.json`, `claude_desktop_config.json`, `config.json`, `config.toml`
- Instruction/rules files: `AGENTS.md`, `CLAUDE.md`, `.cursorrules`

## Audit (Static)

Static audit runs over the scan inventory and writes a report to `~/.facult/audit/static-latest.json`.

If you don't pass any `--from` roots and you haven't configured `scanFrom`, it defaults to auditing `~` with safety limits.

```bash
facult audit --non-interactive
facult audit --non-interactive --severity high
facult audit --non-interactive --no-config-from
facult audit --non-interactive --from ~
facult audit --non-interactive my-skill
facult audit --non-interactive mcp:github
facult audit --non-interactive --json
```

## Audit (Agent)

Agent audit shells out to an installed agent CLI (`claude` or `codex`) and writes a report to `~/.facult/audit/agent-latest.json`.

If you don't pass any `--from` roots and you haven't configured `scanFrom`, it defaults to auditing `~` with safety limits.

```bash
facult audit --non-interactive --with claude
facult audit --non-interactive --with codex
facult audit --non-interactive --no-config-from --with codex
facult audit --non-interactive mcp:github --with claude
facult audit --non-interactive --from ~ --max-items 50 --with claude
facult audit --non-interactive --from ~ --max-items all --with claude
facult audit --non-interactive --with claude --json
```

## Audit (Interactive)

Run an interactive audit wizard (TTY) and optionally quarantine flagged items:

```bash
facult audit
```

Quarantine moves/copies selected files into `~/.facult/quarantine/<timestamp>/` and writes a `manifest.json`.

## Consolidate / Index / Inspect

Build a canonical store and index for fast queries and per-tool enablement:

```bash
facult consolidate
facult consolidate --auto keep-newest --no-config-from --from ~/skills
facult index
facult list skills
facult list mcp
facult show my-skill
facult show mcp:github
```

Trust and audit metadata:

```bash
facult trust my-skill mcp:github
facult untrust my-skill
facult list skills --untrusted
facult list skills --flagged
facult list skills --pending
```

Optional org trust list overlay (checksum-verified):

- Path: `~/.facult/trust/org-list.json`
- Behavior: if an entry has no local `trusted` value, org trust marks it as trusted.
- Local override wins: explicit `facult trust` or `facult untrust` in `index.json` takes precedence.

Example:

```json
{
  "version": 1,
  "issuer": "acme-security",
  "generatedAt": "2026-02-21T10:00:00.000Z",
  "skills": ["deploy-skill"],
  "mcp": ["github"],
  "checksum": "sha256:<hash-of-canonical-payload>"
}
```

## Enable/Disable + Managed Mode

These are for when you want facult to actively manage tool configs (optional):

```bash
facult manage cursor
facult enable my-skill --for cursor,claude
facult disable my-skill --for cursor
facult sync --dry-run
facult sync
facult unmanage cursor
facult managed
```

## Snippets

Snippets are reusable markdown blocks stored under `<FACULT_ROOT_DIR>/snippets/`.

Marker format inside config files:

```md
<!-- fclty:codingstyle -->
... content managed by facult ...
<!-- /fclty:codingstyle -->
```

Inheritance:
- `fclty:name` resolves `projects/<current-git-repo>/name.md` first (if detectable), then `global/name.md`
- `fclty:global/name` forces global
- `fclty:<project>/name` forces a specific project

Commands:

```bash
facult snippets list
facult snippets show codingstyle
facult snippets create myboundaries
facult snippets edit codingstyle
facult snippets sync --dry-run
facult snippets sync path/to/CLAUDE.md
```

## Adapters

List built-in tool adapters (useful for debugging path/format support):

```bash
facult adapters
```

## Templates (DX)

Scaffold practical starting points for skills, agent instructions, MCP entries, and snippets:

```bash
facult templates list
facult templates init skill my-skill
facult templates init mcp github
facult templates init agents
facult templates init claude
facult templates init snippet team/codingstyle
```

All template scaffolds support `--dry-run` and `--force`.

## Remote Indices

Search/install/update flows are available via remote indices:

```bash
facult search template
facult install facult:skill-template --as my-skill
facult search github --index smithery
facult install smithery:github
facult search system --index glama
facult install glama:systeminit/si --as system-initiative
facult search deploy --index skills.sh
facult install skills.sh:acme/deploy-skill --as deploy-skill
facult search release --index clawhub
facult install clawhub:release-checklist
facult sources list
facult sources trust smithery --note "reviewed by security"
facult verify-source smithery
facult update
facult update --apply
facult update --apply --strict-source-trust
```

Builtin index:
- `facult` (ships with the CLI; no network required)
- `smithery` (hosted MCP registry alias)
- `glama` (hosted MCP registry alias)
- `skills.sh` (hosted skill catalog alias)
- `clawhub` (hosted skill catalog alias)

Notes:
- `search` without `--index` uses builtin + configured indices.
- Use `--index <alias>` (or direct refs like `smithery:github`) to query hosted aliases.
- Use `facult sources` to set source policy (`trusted|review|blocked`) per index source.
- `install`/`update` always block `blocked` sources; add `--strict-source-trust` to also block `review` sources.
- `glama` installs an MCP scaffold (command/env placeholders) from metadata; you should set command/args before enabling in managed mode.
- `skills.sh` installs a skill from discovered source metadata; GitHub raw fallback is used when needed.
- `clawhub` installs full skill file trees when provider endpoints expose versioned files.

Optional custom indices can be configured in `~/.facult/indices.json`:

```json
{
  "indices": [
    {
      "name": "my-index",
      "url": "/absolute/path/to/index.json",
      "integrity": "sha256:<manifest-sha256-hex>",
      "signature": {
        "algorithm": "ed25519",
        "value": "<base64-signature-over-raw-manifest-bytes>",
        "keyId": "team-2026-q1",
        "publicKeyPath": "~/.facult/trust/keys/index-signing.pub"
      }
    },
    {
      "name": "corp-smithery",
      "provider": "smithery",
      "url": "https://api.smithery.ai"
    },
    {
      "name": "corp-clawhub",
      "provider": "clawhub",
      "url": "https://wry-manatee-359.convex.site/api/v1"
    }
  ]
}
```

For manifest-backed custom indices, `integrity` and `signature` are optional but recommended. If set, facult verifies them before parsing.

- `integrity`: SHA-256 digest pin (`sha256:<hex>` or `sha256-<base64>`) over raw manifest bytes.
- `signature`: Ed25519 detached signature over raw manifest bytes. Provide either `publicKey` (PEM or base64 DER) or `publicKeyPath`.
- `signatureKeys`: Optional keyring for rotation/revocation. Use `signature.keyId` to select a key when multiple are configured.

Keyring example:

```json
{
  "signatureKeys": [
    {
      "id": "team-2026-q1",
      "status": "active",
      "publicKeyPath": "~/.facult/trust/keys/team-2026-q1.pub"
    },
    {
      "id": "team-2025-q4",
      "status": "retired",
      "publicKeyPath": "~/.facult/trust/keys/team-2025-q4.pub"
    }
  ]
}
```

Compute a digest:

```bash
shasum -a 256 /absolute/path/to/index.json
```

## Notes

- Scan state stores file paths and small summaries only; it does not persist raw MCP JSON bodies.
- Static audit output redacts obvious token formats in findings evidence, but you should still treat audit output as potentially sensitive.
- Source trust policy state is stored at `~/.facult/trust/sources.json`.
- Integrity/signature pinning applies to custom `manifest` sources configured in `~/.facult/indices.json`.

## Current Scope

Shipped in the CLI today:
- Local discovery/inventory (`scan`)
- Static + agent-assisted audits (`audit`)
- Canonical store management (`consolidate`, `index`, `list`, `show`, `migrate`)
- Managed mode + enable/disable/sync (`manage`, `enable`, `disable`, `sync`)
- Remote index workflows (`search`, `install`, `update`)
- DX template scaffolding (`templates`)
- Snippet markers + sync (`snippets`)
