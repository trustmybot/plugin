#!/usr/bin/env bash
# PreToolUse hook on Agent. Denies pr-reviewer spawn when isolation is
# 'worktree'.
#
# Workflow contract: pr-reviewer is the **push gate**. It reviews the
# FEATURE branch as it would land in origin — i.e. from the main
# checkout, not from SWE's per-task worktree. Running pr-reviewer
# inside a worktree (`.claude/worktrees/<slug>/`) examines the wrong
# scope: SWE may have uncommitted edits, branch-ref divergence, or
# lingering state that won't actually land upstream.
#
# Bro works on the worktree branch as the **task close gate** (V1/V2/V3
# verification + bro_atomic_close). Bro orchestrates from the main
# checkout. pr-reviewer is spawned later, also from the main checkout,
# to validate the bare branch ref before push.
#
# Captures: a workflow-violation bug class — pr-reviewer running with
# `isolation: 'worktree'` examines the wrong code surface.
#
# Bypass: TMB_ALLOW_PR_REVIEWER_WORKTREE=1.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/normalize-role.sh
. "$SCRIPT_DIR/lib/normalize-role.sh"

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0

if [ "${TMB_ALLOW_PR_REVIEWER_WORKTREE:-0}" = "1" ]; then
  exit 0
fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
[ "$TOOL_NAME" = "Agent" ] || exit 0

SUBAGENT=$(tmb_normalize_role "$(echo "$INPUT" | jq -r '.tool_input.subagent_type // ""' 2>/dev/null)")
[ "$SUBAGENT" = "pr-reviewer" ] || exit 0

ISOLATION=$(echo "$INPUT" | jq -r '.tool_input.isolation // ""' 2>/dev/null)
[ "$ISOLATION" = "worktree" ] || exit 0

REASON='pr-reviewer must NOT run with isolation="worktree". The push gate reviews the FEATURE branch as it would land in origin — from the main checkout, not from SWE'"'"'s per-task worktree. Bro works on the worktree branch as the task-close gate (V1/V2/V3 + bro_atomic_close); pr-reviewer reviews afterward, on the bare branch ref before push.

Spawn pr-reviewer without isolation (defaults to none) or with an explicit non-worktree isolation. For exceptional override, set TMB_ALLOW_PR_REVIEWER_WORKTREE=1.'

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'

exit 0
