# Development Log

This file tracks all code changes made to the dual-rollup migration project.

## Format
Each entry should include:
- **Date**: When the change was made
- **What changed**: Bullet list of modifications
- **Files/areas affected**: Specific file paths or components
- **How to verify**: Exact commands to run or test the changes

---

## 2025-02-12: Complete Team MCP and Plugin Setup

**What changed:**
- Configured dual MCP servers for comprehensive Aztec access
  - `aztec-docs`: Documentation and examples from cloned git repos (v3.0.0-devnet.6-patch.1)
  - `aztec-local`: Direct filesystem access to npm packages in `node_modules/@aztec/`
- Added workspace-level plugin configuration (`.claude/settings.json`)
  - Enabled Superpowers plugin for all team members
  - Configured secure command permissions (nargo, aztec, forge, yarn test/build)
- Updated devcontainer postCreate script to prepare MCP repos automatically
- Fixed CLAUDE.md documentation paths (all `/aztec-packages/` → `node_modules/@aztec/`)

**Files/areas affected:**
- `.mcp.json` - Added `aztec-local` server + version config for `aztec-docs`
- `.claude/settings.json` - Created workspace plugin and permissions config
- `.devcontainer/development/postCreate.sh` - Added MCP repo sync notification
- `CLAUDE.md` - Fixed 5 path references to match actual package location

**How to verify:**
```bash
# Verify MCP configuration
cat .mcp.json

# Verify workspace plugin config
cat .claude/settings.json

# Check CLAUDE.md paths are correct
grep -n "node_modules/@aztec" CLAUDE.md

# After container rebuild, check MCP repos (first use will sync automatically)
ls -la ~/.aztec-mcp/repos/
```

**Team Impact:**
- All team members get consistent MCP and plugin setup automatically
- Access to both documentation (aztec-docs) and source code (aztec-local)
- Superpowers plugin enabled by default in workspace
- Version-locked to v3.0.0-devnet.6-patch.1 for consistency

---

