# scripts/hooks

The Claude Code lifecycle hook engine — the deterministic enforcement layer that gates, nudges, and reacts to what bro and the subagents do each session. Every script reads a hook JSON payload on stdin and either exits silently, emits `additionalContext`, or returns a `permissionDecision: deny`. The wiring (which script runs on which event) lives in the plugin-root `hooks/hooks.json`; the scripts here are the implementations.

## Grouped by lifecycle

### SessionStart — preflight
`ensure-gitignore.sh`, `mcp-health-check.sh`, `deferred-tools-drift-warn.sh`, `write-active-workspace-sentinel.sh`, `session-start-prescan.sh`, `ensure-kuzu-installed.sh`, `substrate-preflight.sh` — make sure the gitignore, MCP server, kuzu native binary, workspace sentinel, and required host binaries are in place before a session does real work.

### UserPromptSubmit — per-turn setup + routing
`activation-routine.sh`, `mcp-health-check.sh`, `session-log-capture.sh`, `prompt-intent-hints.sh`, `roundtable-slash-detect.sh` — inject identity/context, log the turn, and route phrasing hints (onboarding nudges, roundtable detection).

### PreToolUse — gates (deny on violation)
Git: `git-guards.sh`, `git-push-guard.sh`, `no-remote-auth-guard.sh`, `stay-on-base-guard.sh`, `no-source-edit-from-main.sh`, `no-worktree-branch-create.sh`, `branch-up-to-date-with-remote.sh`, `commit-msg-lint.sh`.
Agent dispatch: `agent-spawn-dispatch.sh`, `swe-brief-gate.sh`, `swe-verification-gate.sh`, `swe-boundary.sh`, `swe-scope-fence.sh`.
AUQ / roundtable / cheatcode: `askuserquestion-length-lint.sh`, `auq-headless-deny.sh`, `roundtable-auq-shape.sh`, `cheatcode-install-approval.sh`.
Lint: `naming-lint.sh`, `code-quality-lint.sh`, `debug-trajectory.sh`.

### PostToolUse — reactions after a tool succeeds
`cleanup-worktree-on-task-close.sh`, `post-task-close-rescan.sh`, `post-atomic-close-readme.sh`, `post-task-create-spawn-hint.sh`, `post-pr-comments-persist.sh`, `roundtable-cleanup-postcheck.sh`, `attribution-footer.sh`.

### Stop / SubagentStop / WorktreeCreate
`bro-turn-usage.sh` (Stop), `swe-atomic-close.sh` + `consultant-persistence-gate.sh` (SubagentStop), `worktree-create.sh` (WorktreeCreate).

### Not wired in hooks.json
`require-task-spec.sh`, `require-feature-branch-active.sh`, `pr-reviewer-after-atomic-close.sh`, `pr-reviewer-no-worktree.sh`, `pr-reviewer-spawn-prompt-shape.sh` — PreToolUse-on-Agent guards (spawn-shape / spec / branch checks) not currently referenced by `hooks.json`.

## Subdirectory

- `lib/` — shared helpers sourced by the hook scripts (`normalize-role.sh`, `query-task.sh`, `resolve-repo.sh`, `resolve-toolchain-path.sh`, `resolve-workspace.sh`).

## How it fits

Hooks are TMB's enforcement substrate: they make the workflow doctrine mechanical instead of advisory. A PreToolUse deny is a hard stop for the agent that tripped it. Hook behavior is covered by L3 (`tests/l3-integration/hooks/`).
