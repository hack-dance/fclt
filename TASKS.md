# facult — Implementation Tasks

Generated from Council Deliberation (2026-01-29)

---

## Phase 3: Normalize & Index

### T-001: Canonical schema enhancements
**Effort:** 1–2 days  
**Status:** Done

- Add `vendorExtensions` field to MCP server schema for unknown/tool-specific fields
- Add `provenance` field tracking original source, path, import date
- Update `src/scan.ts` to preserve unknown fields during parsing
- Update index builder to include new fields
- Ensure round-trip: canonical → tool format → canonical doesn't lose data

### T-002: Index builder implementation
**Effort:** 2 days  
**Status:** Done

- Create `src/index-builder.ts`
- Scan `~/agents/.facult/` directory structure
- Parse SKILL.md frontmatter/description extraction
- Parse `servers.json` for MCP entries
- Build and write `index.json`
- Add `facult index` and `facult index --force` commands

### T-003: Query engine and list/show commands
**Effort:** 1–2 days  
**Status:** Done

- Create `src/query.ts`
- Filter by type, tags, enabled-for, audit status
- Full-text search in descriptions
- Add `facult list [skills|mcp|agents]` command
- Add `facult show <name>` command
- Support `mcp:` prefix for MCP servers

---

## Phase 4: Managed Mode & Sync

### T-004: Consolidation conflict workflow
**Effort:** 2–3 days  
**Status:** Done

- Implement content normalization (trim, line endings, whitespace)
- Add content hashing for comparison
- Build diff preview UI using clacks
- Auto-merge only when normalized hashes match
- Interactive prompt with options: keep-newest, keep-local, keep-remote, keep-both
- Add `--auto keep-newest` flag for power users

### T-005: Managed mode implementation
**Effort:** 2–3 days  
**Status:** Done

- Create `src/manage.ts`
- Implement backup flow: `skills/` → `skills.bak/`, `mcp.json` → `mcp.json.bak`
- Implement per-skill symlink creation
- Generate tool-specific configs from canonical
- Track managed tools in `~/.facult/managed.json`
- Add `facult manage <tool>`, `unmanage`, `managed` commands

### T-006: Enable/disable and sync commands
**Effort:** 2 days  
**Status:** Done

- Add `facult enable <name> --for <tools>` command
- Add `facult disable <name> --for <tools>` command
- Update `enabledFor` arrays in index
- Regenerate configs for managed tools on enable/disable
- Add `facult sync [tool]` and `--dry-run`

---

## Phase 4.5: Translation Layers

### T-007: Adapter architecture
**Effort:** 2 days  
**Status:** Done

- Create `src/adapters/` directory structure
- Define `ToolAdapter` interface in `src/adapters/types.ts`
- Create adapter registry in `src/adapters/index.ts`
- Implement version detection (explicit version keys only, fallback with warning)

### T-008: Tool adapters (Cursor, Claude, Codex, Clawdbot)
**Effort:** 3–4 days  
**Status:** Done

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
**Status:** Done

- Regex validation for marker names (alphanumeric, slashes for scoping)
- Prevent path traversal (`../`) in marker names
- Clear error messaging for invalid markers
- Update docs/help text

### T-010: Snippet sync implementation
**Effort:** 2 days  
**Status:** Done

- Create `src/snippets.ts`
- Scan files for `<!-- fclty:NAME -->...<!-- /fclty:NAME -->` markers
- Look up snippets (project-level first, then global)
- Replace block content, preserve markers
- Add `facult snippets list|show|create|edit|sync` commands
- Support `--dry-run` for sync

---

## Phase 6: Security Audit

### T-011: Static audit implementation
**Effort:** 2–3 days  
**Status:** Done

- Create `src/audit/static.ts`
- Pattern matching rules for:
  - Data exfiltration instructions
  - Credential/secret access
  - Shell escapes
  - Suspicious network calls
  - Obfuscated content
- Configurable ruleset (`~/.facult/audit-rules.yaml`)
- Risk scoring (low/medium/high/critical)
- Add `facult audit static [name]` command

### T-012: Agent-assisted audit
**Effort:** 2–3 days  
**Status:** Done

- Create `src/audit/agent.ts`
- Format prompt with full content (default) or summary
- Support `--with codex|claude|gemini` flag
- Parse agent response into structured findings
- Track coverage metadata (full vs partial audit)
- Store results in `~/.facult/audit/`
- Support `--full` override when using summaries

### T-013: Trust system
**Effort:** 1–2 days  
**Status:** Done

- Add `trusted` and `auditStatus` fields to index
- Implement `facult trust <name>` and `untrust <name>`
- Add `--untrusted` and `--flagged` filters to list
- Trust annotation in UI (does not skip audit, only annotates)
- Add checksum-verified org trust overlay with local override precedence

---

## Documentation & Polish

### T-014: Update README and help text
**Effort:** 1 day  
**Status:** Done

- Update README.md with full command reference
- Add inline help for all commands
- Document snippet marker format
- Document adapter system for contributors

### T-015: Test fixtures and edge cases
**Effort:** 2 days  
**Status:** Done

- Create test fixtures for each tool format
- Test version detection edge cases
- Test symlink edge cases (loops, permissions)
- Test consolidation conflict scenarios

---

## Post-v0.2 Backlog

The original v0.2 plan is complete. The remaining work is follow-on roadmap/hardening:

### B-001: Remote indices (Phase 7)
**Status:** Done (baseline adapters complete)

- Add `facult search <query>` ✅
- Add `facult install <index:item>` ✅
- Add `facult update [--apply]` ✅
- Track provenance metadata for remotely installed assets ✅
- Expand integrations for hosted/public registries (beyond builtin + configured JSON manifests) ✅ (smithery + glama aliases)
- Add additional provider adapters (skills.sh, clawhub) ✅
- Continue improving provider-native install depth (optional hardening)

### B-002: Trust model extensions
**Status:** Done (extended)

- Add org-level trust lists (signed/checksummed) ✅
- Keep per-user trust annotations as local override ✅
- Add source-level trust policy management (`facult sources ...`) ✅
- Add strict source gating for remote install/update (`--strict-source-trust`) ✅
- Add custom-manifest integrity pinning (`indices.json` checksum/integrity) ✅
- Add custom-manifest Ed25519 signature verification (`indices.json` signature policy) ✅

### B-003: Deeper consolidation coverage
**Status:** Done (expanded coverage)

- Expand automated tests for interactive consolidate conflict flows
- Add additional filesystem edge-case coverage (permissions, symlink edge cases)
- Added non-interactive `--auto` consolidate coverage for `--from` + standalone MCP config copy ✅
- Added conflict-decision unit coverage for non-auto (interactive) resolution paths ✅
- Added filesystem resilience tests for unreadable skill files and symlink-loop inputs ✅

### B-004: Lint-policy hardening
**Status:** In Progress

- Incrementally re-enable stricter lint rules where practical
- Break down high-complexity command modules into smaller units
- Recently re-enabled: `performance/noDelete`
- Added warning-level trial for `performance/useTopLevelRegex` to surface legacy hotspots
- Split org trust logic into dedicated module (`src/trust-list.ts`)
- Cleared current `performance/useTopLevelRegex` hotspots across active modules/tests ✅
- Split consolidation conflict decision flow into `src/consolidate-conflict-action.ts` ✅
- Split remote manifest integrity checks into `src/remote-manifest-integrity.ts` ✅

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
