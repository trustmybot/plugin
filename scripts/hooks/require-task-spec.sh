#!/usr/bin/env bash
# Hook: Block SWE agent spawn unless prompt references a valid tasks row.
# Reads task_id=<N> from the spawn prompt, queries the trajectory DB via SQLite.
# A spawn is allowed on a pending task, or on a running task with no open swe
# agent_runs row (rework after task_reopen); a running task whose swe run is
# still open is denied with that run named.
# Spec contract: a task whose files[] touches schema.sql, db.ts or a migrations
# path, or whose spec_body adds a column/tool/field/table (matched case-blind with
# any whitespace, including non-breaking and other Unicode spaces, '-' or '_'
# between the words), needs a Writer: + Populated: line
# pair or a Nullable: line in spec_body, each with a value, unless a
# spec_shape_gate_waived audit row names the task: from_node = 'bro',
# content_json {task_id: <N> (integer or numeric string), gate: 'spec_shape',
# reason: >= 10 chars}. task_create_batch / task_provision write one such row per
# task when called with waive_spec_shape; bro may also write it via audit_append,
# which swe cannot call. This hook only reads.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=lib/normalize-role.sh
. "$SCRIPT_DIR/lib/normalize-role.sh"

INPUT=$(cat)

AGENT_TYPE=$(tmb_normalize_role "$(echo "$INPUT" | jq -r '.tool_input.subagent_type // empty')")
PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // empty')

[ "$AGENT_TYPE" != "swe" ] && exit 0

TASK_ID=$(echo "$PROMPT" | grep -oE 'task_id[=:][[:space:]]*[0-9]+' | head -1 | grep -oE '[0-9]+' || true)

if [ -z "$TASK_ID" ]; then
  jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"BLOCKED: SWE spawn requires task_id=<N> in the prompt pointing at a row in the tasks table. Route through bro (bro plans, then spawns SWE with task_id)."}}'
  exit 0
fi

DB=$(tmb_db_path) || exit 0
tmb_have_sqlite || exit 0

SAFE_TASK_ID=$(tmb_sql_int "$TASK_ID")
ROW=$(tmb_gate_read "$DB" "SELECT status, LENGTH(COALESCE(spec_body, '')) FROM tasks WHERE id = ${SAFE_TASK_ID};")

if [ "$ROW" = "__ERR__" ]; then
  tmb_deny_db_unavailable require-task-spec
  exit 0
fi

if [ -z "$ROW" ]; then
  jq -nc --arg id "$TASK_ID" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":("BLOCKED: task_id="+$id+" does not exist in the tasks table.")}}'
  exit 0
fi

ROW=$(printf '%s' "$ROW" | tr '|' '\n')
STATUS=$(echo "$ROW" | awk 'NR==1')
BODY_LEN=$(echo "$ROW" | awk 'NR==2')

LIVE_RUN=""
if [ "$STATUS" = "running" ]; then
  LIVE_RUN=$(tmb_gate_read "$DB" "SELECT id || ' (started ' || COALESCE(started_at, '?') || ')' FROM agent_runs
    WHERE task_id = ${SAFE_TASK_ID} AND agent_type = 'swe' AND completed_at IS NULL ORDER BY id DESC LIMIT 1;")
  if [ "$LIVE_RUN" = "__ERR__" ]; then
    tmb_deny_db_unavailable require-task-spec
    exit 0
  fi
fi

if [ -n "$LIVE_RUN" ]; then
  jq -nc --arg id "$TASK_ID" --arg run "$LIVE_RUN" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":("BLOCKED: task_id="+$id+" is running with a live swe run: agent_runs "+$run+". Wait for that swe to return; if it is gone, move the task to failed (task_update_status) and task_reopen it.")}}'
  exit 0
fi

if [ "$STATUS" != "pending" ] && [ "$STATUS" != "running" ]; then
  jq -nc --arg id "$TASK_ID" --arg st "$STATUS" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":("BLOCKED: task_id="+$id+" has status="+$st+", expected pending, or running with no live swe run. Reopen finished work with task_reopen.")}}'
  exit 0
fi

if [ "${BODY_LEN:-0}" -eq 0 ]; then
  jq -nc --arg id "$TASK_ID" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":("BLOCKED: task_id="+$id+" has empty spec_body. bro must populate spec_body via task_create_batch before SWE can execute.")}}'
  exit 0
fi

SPEC=$(tmb_gate_read "$DB" "SELECT json_object('body', COALESCE(spec_body, ''),
    'files', CASE WHEN json_valid(COALESCE(files, '')) THEN json(files) ELSE json('[]') END)
  FROM tasks WHERE id = ${SAFE_TASK_ID};")
if [ "$SPEC" = "__ERR__" ]; then
  tmb_deny_db_unavailable require-task-spec
  exit 0
fi
if ! SPEC_BODY=$(printf '%s' "$SPEC" | jq -r '.body // ""') \
  || ! SPEC_FILES=$(printf '%s' "$SPEC" | jq -r '(.files // []) | if type == "array" then .[] | strings else empty end'); then
  tmb_deny_db_unavailable require-task-spec
  exit 0
fi

UNICODE_SPACES=($'\302\240' $'\341\232\200' $'\342\200\200' $'\342\200\201' $'\342\200\202' $'\342\200\203' $'\342\200\204' $'\342\200\205' $'\342\200\206' $'\342\200\207' $'\342\200\210' $'\342\200\211' $'\342\200\212' $'\342\200\213' $'\342\200\250' $'\342\200\251' $'\342\200\257' $'\342\201\237' $'\343\200\200' $'\357\273\277')
FOLD_SPACES=$(printf 's/%s/ /g;' "${UNICODE_SPACES[@]}")

needs_contract() {
  printf '%s\n' "$SPEC_FILES" | grep -iE '(schema\.sql$|(^|/)db\.ts$|(^|/)migrations)' >/dev/null && return 0
  printf '%s' "$SPEC_BODY" | LC_ALL=C sed -e "$FOLD_SPACES" | LC_ALL=C tr '\n\r\t\v\f' '     ' \
    | grep -iE '(add[[:space:]]+column|new[[:space:]_-]+(column|tool|field|table))' >/dev/null
}
needs_contract || exit 0

has_line() {
  printf '%s\n' "$SPEC_BODY" \
    | sed -nE "s/^[[:space:]>*+-]*([0-9]+[.)][[:space:]]+)?[\`*_]*$1:[\`*_]*(.*)\$/\2/p" \
    | grep -E '[^[:space:]`*_]' >/dev/null
}

has_line Nullable && exit 0
MISSING=""
has_line Writer || MISSING="Writer:"
has_line Populated || MISSING="${MISSING:+$MISSING and }Populated:"
[ -z "$MISSING" ] && exit 0

WAIVED=$(tmb_gate_read "$DB" "SELECT count(*) FROM audit
  WHERE event_type = 'spec_shape_gate_waived' AND from_node = 'bro' AND json_valid(content_json)
    AND CAST(json_extract(content_json, '\$.task_id') AS INTEGER) = ${SAFE_TASK_ID}
    AND json_extract(content_json, '\$.gate') = 'spec_shape'
    AND length(trim(COALESCE(json_extract(content_json, '\$.reason'), ''))) >= 10;")
if [ "$WAIVED" = "__ERR__" ]; then
  tmb_deny_db_unavailable require-task-spec
  exit 0
fi
[ "${WAIVED:-0}" -gt 0 ] && exit 0

TASK_REF=$(tmb_gate_read "$DB" "SELECT COALESCE(issue_id, '<issue>') || '|' || COALESCE(branch_id, '<branch>') FROM tasks WHERE id = ${SAFE_TASK_ID};")
case "$TASK_REF" in __ERR__|'') TASK_REF='<issue>|<branch>' ;; esac

jq -nc --arg id "$TASK_ID" --arg missing "$MISSING" --arg issue "${TASK_REF%%|*}" --arg branch "${TASK_REF#*|}" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":("BLOCKED: task_id="+$id+" adds a column, field, tool, table or migration, and its spec_body is missing a "+$missing+" line. Under ## Success Criteria, name each new item with `Writer: <tool/hook/function>` and `Populated: <verification[] command proving a non-null sample or count > 0>`, or `Nullable: <reason>`; fix it with task_update_spec. To waive, bro first records audit_append(event_type=\"spec_shape_gate_waived\", from_node=\"bro\", issue_id="+$issue+", branch_id=\"" + $branch + "\", summary=<why>, content_json={\"task_id\":"+$id+",\"gate\":\"spec_shape\",\"reason\":\"<why, >= 10 chars>\"}) and then respawns.")}}'
exit 0
