---
name: tmb_review
description: PR-reviewer's diff-level push-gate review — check this task's diff against its spec, then write the validation_record verdict that gates the push. Loaded by pr-reviewer when reviewing a committed task. Self-contained.
allowed-tools: Bash, mcp__plugin_tmb_trajectory-server__pr_monitor_worktree, mcp__plugin_tmb_trajectory-server__validation_record
---

# PR-reviewer protocol (push gate)

Load context via `task_brief(task_id)` — `spec_body`, `commit_sha`, and the changed dirs' world-model scope.

## Worktree discipline

The parent CC session's main checkout may be on ANY branch. Working-tree-dependent verification reads parent's current state, NOT the commit being reviewed.

For working-tree-dependent verification use `pr_monitor_worktree` with the workspace root — the directory holding `.claude/tmb/trajectory.db`; it creates the worktree, runs your command, and removes it atomically.

Sha-based git ops (`git show <sha>`, `git diff <sha>~1..<sha>`, `git ls-tree <sha>`) work from any branch without a worktree — use those for diff inspection.

## Review the diff against its spec

Diff the commit against its parent and judge the diff itself — cite line numbers for every finding:

- Does the diff do what the spec's `## Description` says, and nothing the typed `files[]` doesn't name?
- Is each `## Success Criteria` bullet visible in the diff (not just claimed)?
- Is the changed code correct — happy path plus any failure mode the spec names?
- Any obvious diff-level defect — broken edge case, an `## Out of Scope` item touched, a doc the change made stale?

## Writing the validation_attempts row — YOU write it yourself

After producing a verdict, YOU (the pr-reviewer subagent) write the `validation_attempts` row directly, using the spawn prompt's `attempt_n`. Which path you take depends on your tool list. If `validation_record` is available, call it — the schema enforces the shape — and open your feedback with `'MCP available: yes'`. If your tools are only Read + Bash, write the row through the fallback script at `${CLAUDE_PLUGIN_ROOT}/skills/tmb_review/scripts/validation-record-fallback.sh` (`--help` shows the argument shape).

<!-- LOAD-BEARING-SAFETY: never delegate writing this row to bro. Bro impersonating pr-reviewer is a content-integrity violation — the server's validation_record tool returns forbidden for bro identity, and the auto-mode classifier blocks raw DB writes from bro as impersonation. The honor-system fallback is for YOU to write directly via the fallback script. -->
