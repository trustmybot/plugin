---
name: tmb_project-prescan
description: Deterministic, non-LLM scan of the project at the first code-touching ask of a session. Enumerates git state, top-level layout, stack indicators, agents present, and open MCP issues into a flat inventory block. Skipped on greetings and read-only asks.
agent: bro
allowed-tools: Bash, Glob, Grep, mcp__plugin_tmb_trajectory-server__issue_resume, mcp__plugin_tmb_trajectory-server__config_get, mcp__plugin_tmb_trajectory-server__config_list, mcp__plugin_tmb_trajectory-server__file_registry_list, mcp__plugin_tmb_trajectory-server__audit_log
---

# project-prescan

## When invoked

Bro invokes this skill **only** on:

- The **first code-touching ask** of a session (any request that will result in a task being created — implement, fix, refactor, etc.), OR
- An explicit `/tmb status` (or equivalent status-check) request.

Pure read-only questions, status asks, and conversational clarifications do NOT trigger the pre-scan.

**Ordering note:** On the first code-touching ask, the `lazy-arch-check` skill always runs immediately before this pre-scan. The chain is:

```
lazy-arch-check → project-prescan → inventory block → triage → branch-id-proposal → routing
```

## Pre-scan procedure

This is a NON-LLM descriptive pass — enumerate, do not interpret. Analytic steps belong to downstream agents.

### Hard rule — parallel-batching with fragile commands

CC's parallel-tool-call runtime **cancels the entire batch** if any single sibling exits non-zero. Several pre-scan commands are fragile-by-design — they fail on perfectly valid project states (empty repo, missing `.claude/` dir, no `docs/trustmybot/` yet). Batching them with healthy calls sinks the whole batch and forces serial retry.

**Two safe patterns. Pick one per call:**

1. **Probe-first**: run a cheap state-check serially, then batch only the calls known to succeed. Cleanest for known-fragile fan-outs.
2. **Defang with `|| true`**: append `|| true` (or pipe to a sink) so the command always exits 0. Use when you don't actually need the exit code, just the stdout. Loses error info if the command genuinely breaks; that's the trade-off.

**Never** batch a fragile call with healthy ones unless one of those two patterns is in place.

### Phase 1 — probe state (serial, ≤2s)

These probes determine which downstream calls are safe. Run them serially in one assistant response (CC won't cancel single calls):

```bash
# Probe: does the repo have any commits?
git rev-parse HEAD 2>/dev/null && echo HAS_COMMITS=yes || echo HAS_COMMITS=no

# Probe: does .claude/agents/ exist?
[ -d .claude/agents ] && echo HAS_AGENTS_DIR=yes || echo HAS_AGENTS_DIR=no

# Probe: does docs/trustmybot/ exist?
[ -d docs/trustmybot ] && echo HAS_TRUSTMYBOT_DIR=yes || echo HAS_TRUSTMYBOT_DIR=no
```

### Phase 2 — batched read fan-out (parallel, fragile calls already filtered)

Now batch the calls that are guaranteed safe based on the probe results. Skip any that the probe ruled out.

```bash
# Always safe
git status
ls -1

# Conditional on HAS_COMMITS=yes
git log --oneline -5

# Conditional on HAS_AGENTS_DIR=yes
ls -1 .claude/agents/

# Conditional on HAS_TRUSTMYBOT_DIR=yes
ls -1 docs/trustmybot/
```

If you want to batch unconditionally without the probe, use the `|| true` defang:

```bash
git log --oneline -5 2>/dev/null || true
ls -1 .claude/agents/ 2>/dev/null || true
ls -1 docs/trustmybot/ 2>/dev/null || true
```

Both patterns avoid the cascade-cancellation pathology.

```glob
# Stack detection — Glob is safe to batch (returns empty list, never errors)
**/package.json
**/pyproject.toml
**/go.mod
**/Cargo.toml
**/*.config.*
docs/trustmybot/*.md
.claude/agents/*.md
agents/*.md
```

### Phase 3 — workflow state (MCP queries, always safe to batch)

```bash
# MCP tool calls return null/empty cleanly — safe to batch.
mcp issue_list status=open                     # any open issues?
# For each open issue:
mcp task_first_actionable issue_id=<id>        # any pending/failed task?
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
