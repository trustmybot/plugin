---
name: project-prescan
description: Deterministic, non-LLM scan of the project at the first code-touching ask of a session. Enumerates git state, top-level layout, stack indicators, agents present, and open MCP issues into a flat inventory block. Skipped on greetings and read-only asks.
agent: gatekeeper
allowed-tools: Bash, Glob, Grep
---

# project-prescan

## When invoked

Gatekeeper invokes this skill **only** on:

- The **first code-touching ask** of a session (any request that will result in a task being created — implement, fix, refactor, etc.), OR
- An explicit `/tmb status` (or equivalent status-check) request.

Pure read-only questions, status asks, and conversational clarifications do NOT trigger the pre-scan.

**Ordering note:** On the first code-touching ask, the `lazy-regen-check` skill always runs immediately before this pre-scan. The chain is:

```
lazy-regen-check → project-prescan → inventory block → triage → branch-id-proposal → routing
```

## Pre-scan procedure

This is a NON-LLM descriptive pass — enumerate, do not interpret. Analytic steps belong to downstream agents.

```bash
# Git state
git status
git log --oneline -5

# Top-level layout
ls -1
```

```glob
# Stack detection
**/package.json
**/pyproject.toml
**/go.mod
**/Cargo.toml
**/*.config.*
docs/trustmybot/*.md
.claude/agents/*.md
agents/*.md
```

```bash
# Workflow state — MCP queries
mcp issue_list status=open                     # any open issues?
# For each open issue:
mcp task_first_actionable issue_id=<id>        # any pending/failed task?
ls docs/trustmybot/snapshots/*.md 2>/dev/null  # last review snapshots
```

If `issue_list` is unavailable, scan `docs/trustmybot/snapshots/` for recent issue IDs and call `issue_get_with_discussions` per ID to reconstruct state.

## Inventory block format

Emit exactly this format as the user-visible output:

```
=== Project Inventory ===
Git branch:       <branch>
Git status:       <clean|N modified|untracked>
Last 5 commits:   <oneliner list>
Top-level dirs:   <list>
Stacks detected:  <Node/Python/Go/Rust/none>
Config files:     <list>
docs/trustmybot/ files:       <list>
Agents present:   <list>
Open issues:      <count from MCP, or "none">
Pending tasks:    <count from MCP, or "none">
Proposed branch_id: <e.g. feat/foo-bar — only when request is a code change>
=========================
```

## Failure handling

If any Bash command fails (e.g. not a git repo), record the failure in the inventory entry and continue. Do NOT abort the pre-scan.
