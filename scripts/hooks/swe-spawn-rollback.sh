#!/usr/bin/env bash
# PermissionDenied(Agent) — roll back a refused swe spawn.
#
# The PreToolUse(Agent) PREPARE step (record-swe-spawn.sh) already moved the
# task to running and opened a swe agent_runs row with spawn_id
# tool_use:<tool_use_id> when auto mode refuses the spawn. CC then fires
# PermissionDenied with the same tool_use_id. One transaction:
#   - the task moves back to pending (updated_at = now) when it is running
#     and no other swe run of it is open;
#   - that open tool_use:<tool_use_id> row closes: completed_at = now,
#     exit_reason swept_orphan, usage_source unmeasured when unset, duration_ms
#     its window length when unmeasured.
# A row bound to an agent id is never matched. PermissionDenied fires for
# auto-mode refusals only; record-swe-spawn.sh sweeps the rows a manual denial,
# a deny rule or a hook block leaves.
#
# Fail-open: observe-only, it never blocks and a failed write leaves the DB
# unchanged.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=lib/normalize-role.sh
. "$SCRIPT_DIR/lib/normalize-role.sh"
# shellcheck source=lib/db-write.sh
. "$SCRIPT_DIR/lib/db-write.sh"

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0

AGENT_TYPE=$(tmb_normalize_role "$(printf '%s' "$INPUT" | jq -r '.tool_input.subagent_type // empty' 2>/dev/null)")
[ "$AGENT_TYPE" = "swe" ] || exit 0

TOOL_USE_ID=$(printf '%s' "$INPUT" | jq -r '.tool_use_id // empty' 2>/dev/null) || exit 0
[ -n "$TOOL_USE_ID" ] || exit 0

DB=$(tmb_db_path 2>/dev/null || true)
if [ -z "$DB" ] || ! tmb_have_sqlite; then
  exit 0
fi

SAFE_SPAWN_ID=$(tmb_sql_quote "tool_use:${TOOL_USE_ID}")
NOW=$(tmb_now_iso)

tmb_db_write "$DB" "
UPDATE tasks SET status = 'pending', updated_at = '${NOW}'
 WHERE status = 'running'
   AND id = (SELECT task_id FROM agent_runs
              WHERE agent_type = 'swe' AND spawn_id = '${SAFE_SPAWN_ID}' AND completed_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM agent_runs o
                    WHERE o.task_id = tasks.id AND o.agent_type = 'swe' AND o.completed_at IS NULL
                      AND o.spawn_id IS NOT '${SAFE_SPAWN_ID}');
UPDATE agent_runs
   SET completed_at = '${NOW}',
       exit_reason = 'swept_orphan',
       ${TMB_RUN_UNMEASURED_SQL},
       duration_ms = CASE WHEN duration_ms = 0
                          THEN COALESCE(CAST(ROUND((julianday('${NOW}') - julianday(started_at)) * 86400000) AS INTEGER), 0)
                          ELSE duration_ms END
 WHERE agent_type = 'swe' AND spawn_id = '${SAFE_SPAWN_ID}' AND completed_at IS NULL;" >/dev/null 2>&1 || true

exit 0
