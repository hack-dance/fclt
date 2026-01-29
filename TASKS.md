# tackle-box — Implementation Tasks

Generated from Council Deliberation (2026-01-29)

---

## Phase 3: Normalize & Index

### T-001: Canonical schema enhancements
**Effort:** 1–2 days  
**Status:** Todo

- Add `vendorExtensions` field to MCP server schema for unknown/tool-specific fields
- Add `provenance` field tracking original source, path, import date
- Update `src/scan.ts` to preserve unknown fields during parsing
- Update index builder to include new fields
- Ensure round-trip: canonical → tool format → canonical doesn't lose data

### T-002: Index builder implementation
**Effort:** 2 days  
**Status:** Todo

- Create `src/index-builder.ts`
- Scan `~/agents/.tb/` directory structure
- Parse SKILL.md frontmatter/description extraction
- Parse `servers.json` for MCP entries
- Build and write `index.json`
- Add `tacklebox index` and `tacklebox index --force` commands

### T-003: Query engine and list/show commands
**Effort:** 1–2 days  
**Status:** Todo

- Create `src/query.ts`
- Filter by type, tags, enabled-for, audit status
- Full-text search in descriptions
- Add `tacklebox list [skills|mcp|agents]` command
- Add `tacklebox show <name>` command
- Support `mcp:` prefix for MCP servers

---

## Phase 4: Managed Mode & Sync

### T-004: Consolidation conflict workflow
**Effort:** 2–3 days  
**Status:** Todo

- Implement content normalization (trim, line endings, whitespace)
- Add content hashing for comparison
- Build diff preview UI using clacks
- Auto-merge only when normalized hashes match
- Interactive prompt with options: keep-newest, keep-local, keep-remote, keep-both
- Add `--auto keep-newest` flag for power users

### T-005: Managed mode implementation
**Effort:** 2–3 days  
**Status:** Todo

- Create `src/manage.ts`
- Implement backup flow: `skills/` → `skills.bak/`, `mcp.json` → `mcp.json.bak`
- Implement per-skill symlink creation
- Generate tool-specific configs from canonical
- Track managed tools in `~/.tacklebox/managed.json`
- Add `tacklebox manage <tool>`, `unmanage`, `managed` commands

### T-006: Enable/disable and sync commands
**Effort:** 2 days  
**Status:** Todo

- Add `tacklebox enable <name> --for <tools>` command
- Add `tacklebox disable <name> --for <tools>` command
- Update `enabledFor` arrays in index
- Regenerate configs for managed tools on enable/disable
- Add `tacklebox sync [tool]` and `--dry-run`

---

## Phase 4.5: Translation Layers

### T-007: Adapter architecture
**Effort:** 2 days  
**Status:** Todo

- Create `src/adapters/` directory structure
- Define `ToolAdapter` interface in `src/adapters/types.ts`
- Create adapter registry in `src/adapters/index.ts`
- Implement version detection (explicit version keys only, fallback with warning)

### T-008: Tool adapters (Cursor, Claude, Codex, Clawdbot)
**Effort:** 3–4 days  
**Status:** Todo

- Cursor adapter (v1, v2 if needed)
- Claude CLI adapter
- Claude Desktop adapter
- Codex adapter
- Clawdbot adapter
- Each: parse → canonical, generate → tool format

---

## Phase 5: Snippets & Templates

### T-009: Snippet marker validation
**Effort:** 1 day  
**Status:** Todo

- Regex validation for marker names (alphanumeric, slashes for scoping)
- Prevent path traversal (`../`) in marker names
- Clear error messaging for invalid markers
- Update docs/help text

### T-010: Snippet sync implementation
**Effort:** 2 days  
**Status:** Todo

- Create `src/snippets.ts`
- Scan files for `<!-- tb:NAME -->...<!-- /tb:NAME -->` markers
- Look up snippets (project-level first, then global)
- Replace block content, preserve markers
- Add `tacklebox snippets list|show|create|edit|sync` commands
- Support `--dry-run` for sync

---

## Phase 6: Security Audit

### T-011: Static audit implementation
**Effort:** 2–3 days  
**Status:** Todo

- Create `src/audit/static.ts`
- Pattern matching rules for:
  - Data exfiltration instructions
  - Credential/secret access
  - Shell escapes
  - Suspicious network calls
  - Obfuscated content
- Configurable ruleset (`~/.tacklebox/audit-rules.yaml`)
- Risk scoring (low/medium/high/critical)
- Add `tacklebox audit static [name]` command

### T-012: Agent-assisted audit
**Effort:** 2–3 days  
**Status:** Todo

- Create `src/audit/agent.ts`
- Format prompt with full content (default) or summary
- Support `--with codex|claude|gemini` flag
- Parse agent response into structured findings
- Track coverage metadata (full vs partial audit)
- Store results in `~/.tacklebox/audit/`
- Support `--full` override when using summaries

### T-013: Trust system
**Effort:** 1–2 days  
**Status:** Todo

- Add `trusted` and `auditStatus` fields to index
- Implement `tacklebox trust <name>` and `untrust <name>`
- Add `--untrusted` and `--flagged` filters to list
- Trust annotation in UI (does not skip audit, only annotates)
- Placeholder for future org trust lists (signed/checksummed)

---

## Documentation & Polish

### T-014: Update README and help text
**Effort:** 1 day  
**Status:** Todo

- Update README.md with full command reference
- Add inline help for all commands
- Document snippet marker format
- Document adapter system for contributors

### T-015: Test fixtures and edge cases
**Effort:** 2 days  
**Status:** Todo

- Create test fixtures for each tool format
- Test version detection edge cases
- Test symlink edge cases (loops, permissions)
- Test consolidation conflict scenarios

---

## Summary

| Phase | Tasks | Total Effort |
|-------|-------|--------------|
| 3: Index | T-001, T-002, T-003 | 4–6 days |
| 4: Managed | T-004, T-005, T-006 | 6–8 days |
| 4.5: Adapters | T-007, T-008 | 5–6 days |
| 5: Snippets | T-009, T-010 | 3 days |
| 6: Audit | T-011, T-012, T-013 | 5–8 days |
| Polish | T-014, T-015 | 3 days |

**Total estimated effort:** ~26–34 days of focused work

---

## Key Decisions (from Council)

1. **Canonical MCP:** Superset with vendorExtensions and provenance
2. **Conflict resolution:** Conservative — auto-merge only identical normalized content
3. **Snippet markers:** HTML comments with strict validation
4. **Agent audits:** Full content by default, summaries optional with coverage tracking
5. **Version detection:** Minimal, fallback to latest with warnings
6. **Trust model:** Per-user, optional signed org lists later
