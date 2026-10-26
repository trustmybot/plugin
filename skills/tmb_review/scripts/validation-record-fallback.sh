#!/usr/bin/env bash
# validation-record-fallback.sh — honor-system validation_record INSERT for MCP-unavailable pr-reviewer
#
# Usage:
#   validation-record-fallback.sh <task_id> <attempt_n> <verdict> <feedback> <subagent_session_id> [<findings_json>]
#
# verdict: 'pass' or 'fail'
# feedback: plain text — free prose.
# findings_json: the JSON array validation_record takes as findings[] —
#   [{"criterion_id": "SC1", "probe_cmd": "...", "expected": "...", "observed": "..."}].
#   A fail needs a non-empty array (findings_required); a pass takes it omitted
#   or [] (findings_refused otherwise). probe_cmd, expected and observed are
#   non-empty strings, criterion_id a non-empty string, null or absent, and no
#   other key is allowed (invalid_findings). Text is stored trimmed.
#
# This is the honor-system path (MCP unavailable), so the row is written with
# mcp_available = 0 — the typed signal bro reads from the validation row.
# It mirrors validation_record: re-recording an attempt replaces its row and
# that attempt's open review_findings rows; each finding gets id
# F<task_id>-<n>, n continuing after the task's highest, so no id is reused.
# The findings are validated with sqlite3's JSON functions before any write.
#
# The DB is the one the hooks resolve (tmb_db_path in
# scripts/hooks/lib/query-task.sh): TRAJECTORY_DB_PATH, else
# <CLAUDE_PROJECT_DIR>/.claude/<plugin-name>/trajectory.db. Never the cwd's.
# The row is written through tmb_db_write (scripts/hooks/lib/db-write.sh):
# busy timeout, foreign keys on, one BEGIN IMMEDIATE transaction.

set -euo pipefail

# ---------------------------------------------------------------------------
# DB path resolution (scripts/hooks/lib/query-task.sh)
# ---------------------------------------------------------------------------
TMB_LIB="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}/scripts/hooks/lib"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$TMB_LIB/query-task.sh"
# shellcheck source=scripts/hooks/lib/db-write.sh
. "$TMB_LIB/db-write.sh"

# Prints the resolved DB, else where it was expected (empty when nothing names it).
resolve_db_path() {
  tmb_db_path 2>/dev/null && return 0
  if [[ -n "${TRAJECTORY_DB_PATH:-}" ]]; then
    echo "$TRAJECTORY_DB_PATH"
  elif [[ -n "${CLAUDE_PROJECT_DIR:-}" ]]; then
    tmb_db_location "$CLAUDE_PROJECT_DIR"
  fi
}

# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------
if [[ $# -lt 5 || $# -gt 6 ]]; then
  printf '{"error":"usage","message":"validation-record-fallback.sh <task_id> <attempt_n> <verdict> <feedback> <subagent_session_id> [<findings_json>]"}\n'
  exit 1
fi

TASK_ID="$1"
ATTEMPT_N="$2"
VERDICT="$3"
FEEDBACK="$4"
SESSION_ID="$5"
FINDINGS="${6:-}"
[[ -n "$FINDINGS" ]] || FINDINGS='[]'

# Validate numeric IDs
if ! [[ "$TASK_ID" =~ ^[0-9]+$ ]]; then
  printf '{"error":"invalid_task_id","value":"%s"}\n' "$TASK_ID"
  exit 1
fi

if ! [[ "$ATTEMPT_N" =~ ^[0-9]+$ ]]; then
  printf '{"error":"invalid_attempt_n","value":"%s"}\n' "$ATTEMPT_N"
  exit 1
fi

# Validate verdict
if [[ "$VERDICT" != "pass" && "$VERDICT" != "fail" ]]; then
  printf '{"error":"invalid_verdict","value":"%s","allowed":["pass","fail"]}\n' "$VERDICT"
  exit 1
fi

SAFE_FEEDBACK=$(tmb_sql_quote "$FEEDBACK")
SAFE_SESSION=$(tmb_sql_quote "$SESSION_ID")
SAFE_FINDINGS=$(tmb_sql_quote "$FINDINGS")
FINDINGS_ARRAY="CASE json_type('$SAFE_FINDINGS') WHEN 'array' THEN json('$SAFE_FINDINGS') ELSE '[]' END"

# ---------------------------------------------------------------------------
# Findings validation (validation_record's parseFindings)
# ---------------------------------------------------------------------------
# The whitespace String.prototype.trim strips, so text is trimmed as on the server.
WS="char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)"
FINDING_SHAPE='{criterion_id?, probe_cmd, expected, observed}'

bad_text() {
  printf "WHEN json_type(e.value, '\$.%s') IS NOT 'text' OR trim(json_extract(e.value, '\$.%s'), %s) = '' THEN 'findings[' || e.key || '].%s must be a non-empty string'" "$1" "$1" "$WS" "$1"
}

FINDINGS_CHECK=$(sqlite3 -cmd ".timeout ${TMB_DB_WRITE_TIMEOUT_MS:-1500}" :memory: "
WITH f(v) AS (SELECT '$SAFE_FINDINGS'),
bad(k, msg) AS (
  SELECT e.key, CASE
    WHEN e.type <> 'object' THEN 'findings[' || e.key || '] must be an object $FINDING_SHAPE'
    WHEN EXISTS (SELECT 1 FROM json_each(e.value) k WHERE k.key NOT IN ('criterion_id', 'probe_cmd', 'expected', 'observed'))
      THEN 'findings[' || e.key || '] has unknown field(s) ' || (SELECT group_concat(k.key, ', ') FROM json_each(e.value) k WHERE k.key NOT IN ('criterion_id', 'probe_cmd', 'expected', 'observed')) || '; allowed: criterion_id, probe_cmd, expected, observed'
    $(bad_text probe_cmd)
    $(bad_text expected)
    $(bad_text observed)
    WHEN json_type(e.value, '\$.criterion_id') NOT IN ('null', 'text') OR trim(json_extract(e.value, '\$.criterion_id'), $WS) = ''
      THEN 'findings[' || e.key || '].criterion_id must be a non-empty string or null'
  END
  FROM f, json_each(f.v) e
  WHERE json_valid(f.v) AND json_type(f.v) = 'array'
)
SELECT CASE
  WHEN NOT json_valid(v) THEN 'invalid_findings|findings is not valid JSON'
  WHEN json_type(v) NOT IN ('array', 'null') THEN 'invalid_findings|findings must be a JSON array of $FINDING_SHAPE'
  WHEN '$VERDICT' = 'pass' AND COALESCE(json_array_length(v), 0) > 0 THEN 'findings_refused|a pass verdict records no findings; send findings only with verdict fail'
  WHEN '$VERDICT' = 'fail' AND COALESCE(json_array_length(v), 0) = 0 THEN 'findings_required|a fail verdict needs a non-empty findings array, one $FINDING_SHAPE per defect, each probe_cmd a command that exits 0 once the defect is fixed'
  ELSE COALESCE((SELECT 'invalid_findings|' || msg FROM bad WHERE msg IS NOT NULL ORDER BY k LIMIT 1), 'ok')
END
FROM f;" 2>&1) || FINDINGS_CHECK="invalid_findings|sqlite3 could not read the findings: ${FINDINGS_CHECK}"

if [[ "$FINDINGS_CHECK" != "ok" ]]; then
  CODE="${FINDINGS_CHECK%%|*}"
  MESSAGE=$(printf '%s' "${FINDINGS_CHECK#*|}" | tr '\n' ' ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  printf '{"error":"%s","message":"%s"}\n' "$CODE" "$MESSAGE"
  exit 1
fi

# ---------------------------------------------------------------------------
# Resolve DB and insert
# ---------------------------------------------------------------------------
DB_PATH=$(resolve_db_path)

if [[ ! -f "$DB_PATH" ]]; then
  printf '{"error":"db-not-found","path":"%s","hint":"Set CLAUDE_PROJECT_DIR to the project root (or TRAJECTORY_DB_PATH to the DB)."}\n' "${DB_PATH:-unresolved}"
  exit 1
fi

CREATED_AT=$(tmb_now_iso)
RESULT_FILE=$(mktemp "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/validation-record-fallback.XXXXXX")
trap 'rm -f "$RESULT_FILE"' EXIT

if ! tmb_db_write "$DB_PATH" "INSERT INTO validation_attempts
  (task_id, attempt_n, agent, verdict, feedback, mcp_available, subagent_session_id, created_at)
VALUES
  ($TASK_ID, $ATTEMPT_N, 'pr-reviewer', '$VERDICT', '$SAFE_FEEDBACK', 0, '$SAFE_SESSION', '$CREATED_AT')
ON CONFLICT(task_id, attempt_n) DO UPDATE SET
  agent = excluded.agent,
  verdict = excluded.verdict,
  feedback = excluded.feedback,
  mcp_available = excluded.mcp_available,
  subagent_session_id = excluded.subagent_session_id,
  reviewer_agent_id = NULL,
  created_at = excluded.created_at;
CREATE TEMP TABLE fallback_last_finding AS
  SELECT COALESCE(MAX(CAST(substr(id, instr(id, '-') + 1) AS INTEGER)), 0) AS n
  FROM review_findings WHERE task_id = $TASK_ID;
DELETE FROM review_findings WHERE task_id = $TASK_ID AND attempt_n = $ATTEMPT_N AND status = 'open';
INSERT INTO review_findings (id, task_id, attempt_n, criterion_id, probe_cmd, expected, observed, status, created_at)
  SELECT 'F$TASK_ID-' || ((SELECT n FROM fallback_last_finding) + e.key + 1), $TASK_ID, $ATTEMPT_N,
    CASE WHEN json_type(e.value, '\$.criterion_id') = 'text' THEN trim(json_extract(e.value, '\$.criterion_id'), $WS) END,
    trim(json_extract(e.value, '\$.probe_cmd'), $WS),
    trim(json_extract(e.value, '\$.expected'), $WS),
    trim(json_extract(e.value, '\$.observed'), $WS),
    'open', '$CREATED_AT'
  FROM json_each($FINDINGS_ARRAY) e
  ORDER BY e.key;
SELECT json_group_array(id) FROM (
  SELECT 'F$TASK_ID-' || ((SELECT n FROM fallback_last_finding) + e.key + 1) AS id
  FROM json_each($FINDINGS_ARRAY) e
  ORDER BY e.key);
DROP TABLE fallback_last_finding;" >"$RESULT_FILE"; then
  printf '{"error":"db-write-failed","path":"%s","hint":"tmb_db_write reported the cause on stderr."}\n' "$DB_PATH"
  exit 1
fi

FINDING_IDS=$(tail -n 1 "$RESULT_FILE")
printf '{"ok":true,"task_id":%s,"attempt_n":%s,"verdict":"%s","findings":%s}\n' "$TASK_ID" "$ATTEMPT_N" "$VERDICT" "${FINDING_IDS:-[]}"
