# facult — Full Specification

**Version:** 0.2.0-draft  
**Date:** 2026-01-29  
**Status:** Mixed (implemented + roadmap)  
**Authors:** Dimitri Kennedy-Kavouras, Hacksworth

---

> [!NOTE]
> This file includes both shipped behavior and forward-looking design.
> For the currently implemented CLI surface, use `README.md` and `facult --help` as the source of truth.

---

## Executive Summary

**facult** is a unified CLI for managing agent configurations across tools. It provides a single source of truth for skills, MCP servers, and agent configs that syncs bidirectionally with tool-specific formats.

**Core value proposition:**
- Scan and discover all agent configs across your machine
- Consolidate into a clean, canonical structure
- Enable/disable per tool with simple commands
- Audit for security issues (static + AI-assisted)
- Keep everything in sync with managed mode

---

## Current State

### Implemented Baseline (v0.2)
- **Scanning:** Discovers agent configs from Cursor, Claude Desktop, Claude CLI, Clawdbot, Codex, Gemini, Windsurf, VS Code
- **Discovery:** Finds skills (by SKILL.md) and MCP configs (JSON)
- **Consolidation:** Interactive clacks-based flow to copy items to `~/agents/.facult/`
- **Deduplication:** Shows duplicates with last-modified dates, inline preview
- **State tracking:** `~/.facult/sources.json`, `consolidated.json`
- **Audits:** Static + agent-assisted audit flows with optional interactive wizard + quarantine
- **Managed mode:** Per-tool manage/unmanage/sync + enable/disable by `enabledFor`
- **Snippets:** Marker-based snippet sync (`fclty:name`) with project/global resolution

### Commands Available
```bash
facult scan                       # Discover local sources
facult audit                      # Interactive audit wizard
facult audit --non-interactive    # Static/agent audits for CI/scripts
facult consolidate                # Interactive consolidation
facult index                      # Build canonical index
facult list / facult show         # Query canonical index
facult manage / unmanage / sync   # Managed-mode workflows
facult enable / disable           # Per-tool entry enablement
facult search / install / update  # Remote catalog workflows
facult sources / verify-source    # Source trust + verification
facult templates                  # DX scaffolding templates
facult snippets ...               # Marker snippet workflows
```

---

## Architecture

### Directory Structure

```
~/agents/.facult/                # Central facult home
├── skills/                      # Consolidated skills (each is a directory with SKILL.md)
│   ├── github/
│   │   └── SKILL.md
│   ├── weather/
│   │   └── SKILL.md
│   └── .../
├── mcp/
│   ├── servers.json             # Merged MCP server registry (canonical)
│   └── configs/                 # Raw config backups by source
│       ├── cursor.mcp.json.bak
│       └── claude-desktop.json.bak
├── agents/                      # Agent profile templates
│   ├── AGENTS.md
│   └── CLAUDE.md
├── snippets/                    # Reusable config blocks
│   ├── global/
│   │   ├── codingstyle.md
│   │   └── boundaries.md
│   └── projects/
│       └── <project>/
├── adapters/                    # Tool format adapters (internal)
└── index.json                   # Master index of everything

~/.facult/                    # State directory
├── sources.json                 # Last scan results
├── consolidated.json            # Consolidation state
├── managed.json                 # Which tools are in managed mode
└── audit/                       # Audit results
    ├── static-latest.json
    └── agent-latest.json
```

### Canonical Index Schema

```typescript
interface FacultIndex {
  version: number;
  updatedAt: string;
  
  skills: {
    [name: string]: {
      name: string;
      path: string;                    // ~/agents/.facult/skills/<name>
      description?: string;            // Extracted from SKILL.md
      source: string;                  // Original source (clawdbot, cursor, etc.)
      sourceVersion?: string;
      consolidatedAt: string;
      lastModified: string;
      tags?: string[];
      enabledFor: string[];            // ['cursor', 'claude', 'codex']
      trusted: boolean;
      auditStatus?: 'pending' | 'passed' | 'flagged';
    };
  };
  
  mcp: {
    servers: {
      [name: string]: {
        name: string;
        transport: 'stdio' | 'http' | 'sse';
        command?: string;
        args?: string[];
        url?: string;
        env?: Record<string, string>;
        source: string;
        enabledFor: string[];
        trusted: boolean;
        auditStatus?: 'pending' | 'passed' | 'flagged';
      };
    };
  };
  
  agents: {
    [name: string]: {
      name: string;
      type: 'AGENTS.md' | 'CLAUDE.md' | 'custom';
      path: string;
      snippetsUsed: string[];
      linkedTools: string[];
    };
  };
  
  snippets: {
    [name: string]: {
      name: string;
      scope: 'global' | 'project';
      project?: string;
      path: string;
      usedIn: string[];                // Files using this snippet
    };
  };
}
```

---

## Phase 3: Normalize & Index

### Goal
Establish canonical structure and queryable index.

### Commands

```bash
facult index                  # Rebuild index from consolidated state
facult index --force          # Full reindex

facult list                   # List all (skills, mcp, agents)
facult list skills            # List skills
facult list mcp               # List MCP servers  
facult list agents            # List agent profiles

facult show <name>            # Show details + contents
facult show github            # Show github skill
facult show mcp:filesystem    # Show MCP server
```

### Implementation

1. **Index builder** (`src/index-builder.ts`):
   - Scan `~/agents/.facult/` directory structure
   - Parse SKILL.md for description extraction
   - Parse servers.json for MCP entries
   - Build and write index.json

2. **Query engine** (`src/query.ts`):
   - Filter by type, tags, enabled-for, audit status
   - Full-text search in descriptions

---

## Phase 4: Managed Mode & Sync

### Goal
Let facult take control of tool-specific configs with backup + symlink pattern.

### Managed Mode Flow

```bash
facult manage cursor          # Enable managed mode for Cursor

# What happens:
# 1. Backup: ~/.cursor/skills → ~/.cursor/skills.bak/
# 2. Backup: ~/.cursor/mcp.json → ~/.cursor/mcp.json.bak
# 3. Create per-skill symlinks based on enabledFor
# 4. Generate tool-specific mcp.json from servers.json
# 5. Record in ~/.facult/managed.json

facult unmanage cursor        # Restore from backup, remove symlinks
facult managed                # List managed tools
```

### Enable/Disable Commands

```bash
facult enable github --for cursor,claude
facult disable weather --for codex
facult enable mcp:filesystem --for cursor

# Updates index.json enabledFor arrays
# If tool is managed, regenerates its config
```

### Sync Commands

```bash
facult sync                   # Sync all managed tools
facult sync cursor            # Sync specific tool
facult sync --dry-run         # Show what would change
```

### Per-Skill Symlinks

For granular enable/disable, use per-skill symlinks:

```bash
# ~/.cursor/skills/github → ~/agents/.facult/skills/github
# ~/.cursor/skills/weather → ~/agents/.facult/skills/weather
# (no symlink for disabled skills)
```

This allows:
- Enable: create symlink
- Disable: remove symlink
- No duplication of skill files

---

## Phase 4.5: Translation Layers (Adapters)

### Goal
Bidirectional format translation between tool-specific configs and canonical format.

### Adapter Interface

```typescript
interface ToolAdapter {
  id: string;                          // 'cursor', 'claude', etc.
  name: string;
  versions: string[];                  // Supported versions
  
  // Detection
  detectVersion(configPath: string): Promise<string | null>;
  
  // Parse tool format → canonical
  parseMcp(config: unknown, version?: string): CanonicalMcpConfig;
  parseSkills(skillsDir: string): Promise<CanonicalSkill[]>;
  
  // Generate canonical → tool format  
  generateMcp(canonical: CanonicalMcpConfig, version?: string): unknown;
  generateSkillsDir(skills: CanonicalSkill[]): Promise<void>;
  
  // Paths
  getDefaultPaths(): { mcp?: string; skills?: string; config?: string };
}
```

### Adapter Registry

```
src/adapters/
├── index.ts              # Registry + dispatch
├── types.ts              # Shared types
├── cursor/
│   ├── index.ts
│   ├── v1.ts             # Pre-2025 format
│   └── v2.ts             # Current format
├── claude/
│   ├── index.ts
│   ├── cli.ts            # Claude CLI (~/.claude.json)
│   └── desktop.ts        # Claude Desktop (Application Support)
├── codex/
│   └── index.ts
├── clawdbot/
│   └── index.ts
└── vscode/
    └── index.ts
```

### Version Detection

Each adapter attempts to detect config version:
- File structure differences
- Version keys in JSON
- Heuristics (date modified, known fields)

Falls back to latest version if undetectable.

---

## Phase 5: Snippets & Templates

### Goal
Reusable config blocks that sync across files.

### Snippet Format

Snippets are markdown files in `~/agents/.facult/snippets/`:

```markdown
<!-- ~/agents/.facult/snippets/global/codingstyle.md -->
## Coding Style

- Use TypeScript strict mode
- Prefer functional patterns
- Keep functions small and focused
- Write tests for business logic
```

### Usage in Config Files

Reference snippets with HTML comment markers:

```markdown
# CLAUDE.md

<!-- fclty:codingstyle -->
## Coding Style

- Use TypeScript strict mode
... (content managed by facult)
<!-- /fclty:codingstyle -->

## Project-Specific

...custom content...
```

### Commands

```bash
facult snippets list                    # List all snippets
facult snippets show codingstyle        # View snippet content
facult snippets create myboundaries     # Create new snippet (opens editor)
facult snippets edit codingstyle        # Edit existing

facult snippets sync                    # Update all files using snippets
facult snippets sync --dry-run          # Preview changes
facult snippets sync CLAUDE.md          # Sync specific file
```

### Sync Algorithm

1. Find all files with `<!-- fclty:NAME -->` markers
2. For each marker:
   - Look up snippet (project-level first, then global)
   - Replace content between markers with snippet content
   - Preserve marker comments
3. Report changes

### Inheritance

- `<!-- fclty:codingstyle -->` → looks for `projects/<current>/codingstyle.md`, falls back to `global/codingstyle.md`
- `<!-- fclty:global/codingstyle -->` → explicitly use global
- `<!-- fclty:myproject/context -->` → explicitly use project-specific

---

## Phase 6: Security Audit

### Goal
Detect suspicious patterns in skills and MCP configs.

### Two Audit Modes

#### Static Analysis

```bash
facult audit static                     # Full static scan
facult audit static github              # Single skill
facult audit static --severity high     # Filter by severity
```

**What it checks:**

Skills (SKILL.md):
- Instructions to exfiltrate data
- Credential/secret access patterns
- Shell escape instructions
- Network calls to unknown domains
- Obfuscated content

MCP Servers:
- Sketchy binary paths
- Suspicious command arguments
- Environment variable exposure
- Unknown/unsigned binaries

**Implementation:**
- Pattern matching (regex rules)
- Optional: semgrep integration
- Configurable ruleset (`~/.facult/audit-rules.yaml`)

#### Agent-Assisted Audit

```bash
facult audit --with codex               # Use Codex to review
facult audit --with claude              # Use Claude
facult audit --with gemini              # Use Gemini
facult audit github --with claude       # Single item
```

**Flow:**
1. Collect all items (or specified item)
2. Format as structured prompt with full content
3. Send to chosen coding agent
4. Agent reviews each item for security issues
5. Parse agent response into structured findings
6. Store results in `~/.facult/audit/`

**Agent prompt includes:**
- Full SKILL.md content
- MCP server config
- Known-good patterns to compare against
- Specific security concerns to check

### Trust System

```bash
facult trust github                     # Mark as trusted
facult trust mcp:filesystem             # Trust MCP server
facult untrust github                   # Remove trust

facult list --untrusted                 # Show untrusted items
facult list --flagged                   # Show items with audit findings
```

Org trust list overlay (checksum-verified, optional):
- File: `~/.facult/trust/org-list.json`
- Expected keys: `version`, `issuer`, `generatedAt`, `skills[]`, `mcp[]`, `checksum`
- `checksum` is SHA-256 over canonical payload (`version`, `issuer?`, `generatedAt?`, `skills`, `mcp`)
- Local explicit trust/untrust in canonical `index.json` takes precedence over org overlay

### Audit Results

```typescript
interface AuditResult {
  item: string;
  type: 'skill' | 'mcp';
  mode: 'static' | 'agent';
  agent?: string;
  timestamp: string;
  findings: {
    severity: 'low' | 'medium' | 'high' | 'critical';
    category: string;
    description: string;
    location?: string;
    recommendation?: string;
  }[];
  passed: boolean;
}
```

---

## Phase 7: Remote Indices (Implemented Baseline + Expansion)

### Goal
Pull skills and MCP servers from indices, with a builtin index for offline DX.

### Supported Indices

| Index | Type | Status | Auth |
|-------|------|--------|------|
| facult | Templates (skill/agent/mcp/snippet) | Implemented | None |
| smithery | MCP | Implemented (builtin alias) | None |
| glama | MCP | Implemented (builtin alias) | None |
| skills.sh | Skills | Implemented (builtin alias, source fallback) | None |
| clawhub | Skills | Implemented (builtin alias, versioned file fetch) | API key (optional) |

### Commands (Shipped)

```bash
facult search weather                    # Search all indices
facult search github --index smithery    # Specific index

facult install facult:skill-template     # Install template item
facult install smithery:github           # Install MCP from provider alias
facult install glama:systeminit/si       # Install MCP scaffold from metadata
facult install skills.sh:acme/deploy-skill
facult install clawhub:release-checklist
facult install smithery:github --strict-source-trust

facult update                            # Check for updates
facult update --apply                    # Apply updates
facult update --apply --strict-source-trust

facult sources list                      # List source trust policy
facult sources trust smithery            # Mark source trusted
facult sources block skills.sh           # Block source installs/updates
```

Current implementation includes:
- Builtin `facult` index with production-ready templates (skills, agent instructions, MCP, snippets)
- Builtin provider aliases for `smithery`, `glama`, `skills.sh`, and `clawhub`
- Optional custom index config via `~/.facult/indices.json`
- Install provenance tracking under `<FACULT_ROOT_DIR>/remote/installed.json`
- Source trust policy state at `~/.facult/trust/sources.json` (`facult=trusted`, others default `review`)

### Provenance

Track where each item came from:

```json
{
  "name": "github",
  "source": "smithery",
  "sourceUrl": "https://smithery.ai/servers/github",
  "version": "1.2.3",
  "installedAt": "2026-01-29T...",
  "pinned": false
}
```

---

## CLI Design

### Command Structure

```
facult <command> [subcommand] [args] [flags]
```

### Global Flags

```
--help, -h       Show help
--version, -v    Show version
--json           Output as JSON
--verbose        Verbose output
--dry-run        Preview changes without applying
--force          Override safety checks
```

### Full Command Tree

```
facult
├── scan                      # Discovery
│   ├── --json
│   ├── --tui
│   └── --show-duplicates
├── consolidate               # Interactive consolidation
│   └── --force
├── index                     # Rebuild index
│   └── --force
├── list                      # Query index
│   ├── skills
│   ├── mcp
│   ├── agents
│   ├── snippets
│   ├── --enabled-for <tool>
│   ├── --untrusted
│   └── --flagged
├── show <name>               # Show details
├── enable <name>             # Enable for tools
│   └── --for <tools>
├── disable <name>            # Disable for tools
│   └── --for <tools>
├── manage <tool>             # Enter managed mode
├── unmanage <tool>           # Exit managed mode
├── managed                   # List managed tools
├── sync                      # Sync to managed tools
│   ├── <tool>
│   └── --dry-run
├── snippets
│   ├── list
│   ├── show <name>
│   ├── create <name>
│   ├── edit <name>
│   └── sync [file]
├── audit
│   ├── static [name]
│   ├── --with <agent>
│   ├── --severity <level>
│   └── [name]
├── trust <name>
├── untrust <name>
├── search <query>            # Remote index search
├── install <ref>             # Install from index (--strict-source-trust)
├── update                    # Check/apply index updates (--strict-source-trust)
├── sources                   # Source trust policy management
└── templates                 # DX scaffolding templates
```

---

## DX Principles

1. **Progressive disclosure:** Simple commands for common tasks, flags for power users
2. **Safe by default:** Backup before modify, dry-run available, confirm destructive actions
3. **Fast feedback:** Quick scans, incremental operations, cached state
4. **Transparent:** Show what's happening, explain decisions
5. **Recoverable:** Backups, unmanage, restore operations

---

## Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime | Bun | Fast, TypeScript-native, minimal deps |
| CLI framework | clacks | Clean prompts, good UX |
| State format | JSON | Human-readable, easy to debug |
| Symlinks | Per-skill | Granular enable/disable |
| MCP merge | Default | Single source of truth |
| Adapters | Versioned | Future-proof for format changes |
| Audit | Static + Agent | Complementary approaches |

---

## Open Questions for Council

1. **Canonical MCP format:** Should we use a superset schema or stick close to Claude's format (most common)?

2. **Conflict resolution during consolidate:** When same skill exists with different content, how aggressive should auto-merge be?

3. **Snippet marker format:** HTML comments (`<!-- fclty:x -->`) vs custom (`<fclty.x>`) vs frontmatter-style?

4. **Agent audit prompt design:** How much context to include? Full content vs summaries?

5. **Adapter complexity:** Is version detection worth the complexity, or assume latest?

6. **Trust model:** Per-user trust only, or support organizational trust lists?

---

## Success Metrics

- **Adoption:** Used daily for skill/MCP management
- **Time saved:** < 30s to enable/disable a skill across tools
- **Confidence:** Audit catches issues before they cause problems
- **Maintenance:** Easy to add new tools/adapters

---

## Appendix: Supported Tools

| Tool | MCP Config | Skills Dir | Notes |
|------|------------|------------|-------|
| Cursor | `~/.cursor/mcp.json` | `~/.cursor/skills/` | Also checks settings.json |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | N/A | MCP only |
| Claude CLI | `~/.claude.json` | `~/.claude/skills/` | |
| Codex | `~/.codex/mcp.json` | `~/.codex/skills/` | |
| Clawdbot | `~/.clawdbot/mcp.json` | `~/.clawdbot/skills/`, `~/clawd/skills/` | Multi-agent |
| Gemini | `~/.gemini/mcp.json` | `~/.gemini/skills/` | |
| Windsurf | Settings.json | N/A | VS Code-like |
| VS Code | Settings.json | N/A | Extension-dependent |

---

## Appendix: Example Workflows

### New machine setup

```bash
# On old machine
facult scan --json > ~/Desktop/facult-export.json

# On new machine
facult import ~/Desktop/facult-export.json
facult manage cursor
facult manage claude
facult sync
```

### Adding a new skill

```bash
# Install from remote
facult install clawdhub:new-skill

# Or manually copy, then consolidate
facult consolidate

# Enable for tools
facult enable new-skill --for cursor,claude

# Audit before use
facult audit new-skill --with claude
facult trust new-skill
```

### Security review

```bash
# Full audit
facult audit static
facult audit --with codex

# Review findings
facult list --flagged
facult show flagged-skill

# Trust or remove
facult trust flagged-skill
# or
rm ~/agents/.facult/skills/flagged-skill
facult index
```
