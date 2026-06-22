# scripts/hooks

The Claude Code lifecycle hook engine — the deterministic enforcement layer that gates, nudges, and reacts to what bro and the subagents do each session. Every script reads a hook JSON payload on stdin and either exits silently, emits `additionalContext`, or returns a `permissionDecision: deny`. The wiring (which script runs on which event) lives in the plugin-root `hooks/hooks.json`; the scripts here are the implementations.

## Grouped by lifecycle

### SessionStart — preflight
`ensure-gitignore.sh`, `mcp-health-check.sh`, `deferred-tools-drift-warn.sh`, `write-active-workspace-sentinel.sh`, `session-start-prescan.sh`, `ensure-kuzu-installed.sh`, `substrate-preflight.sh`, `orphan-scan.sh` — make sure the gitignore, MCP server, kuzu native binary, workspace sentinel, and required host binaries are in place before a session does real work.

#### `orphan-scan.sh` — project-scoped cross-upgrade orphan scan

Detects (and, only when explicitly opted in, cleans) TMB artifacts left behind by version upgrades. Advisory: it emits findings as `additionalContext`, soft-fails, caps itself with a tight internal timeout, and never blocks session start.

**Project-scoping invariant (load-bearing).** A user may run a *different* TMB version in *other* projects — each with its own cache dir, MCP process, and `trajectory.db`. Those are legitimate, not orphans. The hook resolves the current project first (session cwd / `CLAUDE_PROJECT_DIR` → its `.claude/<plugin>/trajectory.db` live path and its `~/.claude/projects/<this-slug>/` history dir) and confines all detection and cleanup to it. It never enumerates, reports, or touches another project's DB, process, or pinned cache version. The single permitted cross-project action is removing a cache version that *no* `installed_plugins.json` entry pins (globally unused).

What it detects, current project only:
1. **Stale old-layout DBs of this project** — `~/.claude/projects/<this-slug>/trajectory.db`, its `memory/trajectory.db`, and a legacy `~/.claude/<plugin>/trajectory.db` only when this project has no live DB yet. A candidate is 0-byte *or* has a `schema_version` older than the live DB. The live `<project>/.claude/<plugin>/trajectory.db` is always kept.
2. **Stale duplicate MCP proc on this project's live DB** — a second `trajectory-server` node proc holding *this* project's live DB (the lowest PID is kept as the live server). A proc holding any other project's DB is never flagged. `lsof` absence degrades gracefully.
3. **Globally-unused cache versions** — a `~/.claude/plugins/cache/<channel>/<plugin>/<version>` dir referenced by no `installed_plugins.json` entry. A version pinned by any project (current or other) is never a candidate.

**Safety gates.** Detection-first: the default mode reports only and deletes nothing. Cleanup is gated behind `TMB_ORPHAN_SCAN_CLEAN=1` (default OFF) and is limited to this project's provably-dead stale DBs, a confirmed stale duplicate proc on this project's live DB (with a `kill -0` liveness check), and globally-unused cache versions. It never removes the live DB, never touches another project's DB / proc / cache, and never removes a pinned version. The scan is idempotent and soft-fails. (Tests set `TMB_ORPHAN_SCAN_HOME` / `TMB_ORPHAN_SCAN_PROJECT_DIR` to sandbox HOME and project-root resolution.)

### UserPromptSubmit — per-turn setup + routing
`activation-routine.sh`, `mcp-health-check.sh`, `session-log-capture.sh`, `prompt-intent-hints.sh`, `roundtable-slash-detect.sh` — inject identity/context, log the turn, and route phrasing hints (onboarding nudges, roundtable detection).

### PreToolUse — gates (deny on violation)
Git: `git-guards.sh`, `git-push-guard.sh`, `no-remote-auth-guard.sh`, `stay-on-base-guard.sh`, `no-source-edit-from-main.sh`, `no-worktree-branch-create.sh`, `branch-up-to-date-with-remote.sh`, `commit-msg-lint.sh`. The git guards are **registration-scoped**: they resolve the command's cwd git-root to a `repos` row (via `lib/resolve-repo.sh`) and only enforce on a registered repo — unregistered sibling trees no-op. `protected_branches` is read per-repo (`repos.protected_branches`) — the `repos` row is the sole source of truth, with no `plugin_config` fallback. See [`docs/architecture/REPO_RESOLUTION.md`](../../docs/architecture/REPO_RESOLUTION.md).
Agent dispatch: `agent-spawn-dispatch.sh`, `swe-brief-gate.sh`, `swe-verification-gate.sh`, `swe-boundary.sh`, `swe-scope-fence.sh`.
AUQ / roundtable / cheatcode: `askuserquestion-length-lint.sh`, `roundtable-auq-shape.sh`, `cheatcode-install-approval.sh`.
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
