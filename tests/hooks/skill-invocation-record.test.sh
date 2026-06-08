#!/usr/bin/env bash
# L3 tests: skill-invocation-record.sh PostToolUse hook writes a skill_invocations
# row when bro invokes a Skill. Regression guard for the plugin-prefix mismatch
# that caused zero rows even when the Skill tool was called.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

HOOK="$PLUGIN_ROOT/scripts/hooks/skill-invocation-record.sh"

_invoke() {
  local skill_arg="$1"
  echo "{\"tool_name\":\"Skill\",\"tool_input\":{\"skill\":\"${skill_arg}\"}}" \
    | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>&1 || true
}

TMPDIR_SIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR_SIR"' EXIT
DB="$TMPDIR_SIR/trajectory.db"

sqlite3 "$DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql"

sqlite3 "$DB" "
  INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at)
  VALUES (NULL, NULL, 'bro', datetime('now'));
"

# ---- bare name (e.g. tmb_planning) ----
test_case "bare skill name writes a skill_invocations row"
_invoke "tmb_planning"
count=$(sqlite3 "$DB" "SELECT COUNT(*) FROM skill_invocations WHERE skill_name='tmb_planning';" 2>/dev/null)
assert_eq "1" "$count" "row count for bare name"

# ---- plugin-prefixed name (e.g. tmb:tmb_planning) ----
sqlite3 "$DB" "DELETE FROM skill_invocations;"
test_case "plugin-prefixed skill name (tmb:tmb_planning) strips prefix and writes row"
_invoke "tmb:tmb_planning"
count=$(sqlite3 "$DB" "SELECT COUNT(*) FROM skill_invocations WHERE skill_name='tmb_planning';" 2>/dev/null)
assert_eq "1" "$count" "row count for plugin-prefixed name"

# ---- non-tmb skill is silently skipped ----
test_case "non-tmb_ skill name not in catalog is skipped silently"
_invoke "some-other-skill"
count=$(sqlite3 "$DB" "SELECT COUNT(*) FROM skill_invocations;" 2>/dev/null)
assert_eq "1" "$count" "only the prior row, no new row for unknown skill"

# ---- non-Skill tool is ignored ----
test_case "non-Skill tool_name exits without writing"
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' \
  | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>&1 || true
count=$(sqlite3 "$DB" "SELECT COUNT(*) FROM skill_invocations;" 2>/dev/null)
assert_eq "1" "$count" "Bash tool must not write a row"

# ---- bypass env var ----
test_case "TMB_DISABLE_SKILL_INVOCATION_HOOK=1 skips all processing"
sqlite3 "$DB" "DELETE FROM skill_invocations;"
echo '{"tool_name":"Skill","tool_input":{"skill":"tmb_planning"}}' \
  | TRAJECTORY_DB_PATH="$DB" TMB_DISABLE_SKILL_INVOCATION_HOOK=1 bash "$HOOK" 2>&1 || true
count=$(sqlite3 "$DB" "SELECT COUNT(*) FROM skill_invocations;" 2>/dev/null)
assert_eq "0" "$count" "bypass env must skip the write"

summarize
