# facult (hack-dance-facult)

Minimal Bun CLI that scans common local agent configuration locations and prints:
- discovered sources + paths
- MCP configs (and server names when detectable)
- skills folders/files

It also stores the last scan result at `~/.facult/sources.json`.

## Usage

Run directly from the repo:

```bash
bun install
bun run facult scan
# or
bun run scan
```

JSON output:

```bash
bun run facult scan --json
```

Show duplicate skills (same skill name appears in multiple places):

```bash
bun run facult scan --show-duplicates
# shorthand:
bun run facult --show-duplicates
```

Interactive TUI (scrollable list):

```bash
bun run facult scan --tui
```

TUI keys:
- `j`/`k` or arrow keys: move
- `Enter`: copy selected skill name to clipboard (best-effort)
- `d`: show duplicates only
- `a`: show all
- `q`/`Esc`: quit

### Install as a local CLI (optional)

```bash
bun link
facult scan
```

## What it scans (best-effort)

- Cursor (`~/.cursor`, Cursor settings)
- Codex (best-effort)
- Claude (CLI) (best-effort)
- Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`)
- Gemini (best-effort)
- Antigravity (best-effort)
- Clawdbot (`~/.clawdbot`, `~/.config/clawdbot`)
- Project-local `.clawdbot/` and `./skills`

This is intentionally minimal (no syncing, no remote calls).
