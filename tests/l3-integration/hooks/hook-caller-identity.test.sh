#!/usr/bin/env bash
# L3 tests (GH 1499): the swe fences resolve the caller from the payload
# agent_id (its agent_runs row, spawn_id = agent_id), never from the cwd or the
# target path. Every payload runs through dispatch.sh for each PreToolUse gate
# hooks.json registers for its tool, against a project with two task
# worktrees (A, B) where swe row A is bound to agent_id agA.
#
#   (a) swe agA, cwd = main checkout, Write into worktree B → denied; the
#       containment_denied row has root = worktree A and task_id = A.
#   (b) the same payload writing inside worktree A → allowed by every gate.
#   (c) Bash touch <worktree B>/x from agA, cwd = main checkout → denied; the
#       recorded path is <worktree B>/x.
#   (c2) Bash from agA, cwd = main checkout, judged by its write targets, not
#       its cwd: ls, cd A && git status, cd A && touch src/x.ts → allowed by
#       every gate; a bare touch x and cd B && touch x → denied.
#   (d) swe agZ with no bound row → denied with the task_brief instruction;
#       its row's root is not the project root.
#   (e) the main thread (no agent_type, no agent_id), cwd = worktree A,
#       writing <project>/.claude/tmb/issue-drafts/x.md → allowed by every gate.
#   (f) no containment_denied row has a NULL task_id and the project root.
#   (g) pr-reviewer, cwd = worktree A, writing in the project → allowed (its
#       root is the project, not derived from the cwd).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
DISPATCH="$PLUGIN_ROOT/scripts/hooks/dispatch.sh"

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT
cd "$SANDBOX" || exit 1
assert_not_in_plugin_repo "$PLUGIN_ROOT"

PROJECT="$SANDBOX/project"
WT_A="$PROJECT/.claude/worktrees/a-task"
WT_B="$PROJECT/.claude/worktrees/b-task"
DB="$PROJECT/.claude/tmb/trajectory.db"
HOST_TMP="$SANDBOX/host-tmp"
mkdir -p "$PROJECT" "$HOST_TMP"
git init -q -b dev "$PROJECT"
git -C "$PROJECT" config user.email t@t.io
git -C "$PROJECT" config user.name t
printf '.claude/\n' > "$PROJECT/.gitignore"
echo init > "$PROJECT/README.md"
git -C "$PROJECT" add .
git -C "$PROJECT" commit -qm init
for slug in a-task b-task; do
  git -C "$PROJECT" worktree add -q -b "fix/$slug" "$PROJECT/.claude/worktrees/$slug"
done
mkdir -p "$WT_A/src" "$WT_B/src" "$(dirname "$DB")"

sqlite3 "$DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
NOW="2026-10-18T10:00:00.000Z"
sqlite3 "$DB" "
  INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (9, 'caller identity', 'open', '$NOW', '$NOW');
  INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, spec_body, files, created_at, updated_at) VALUES
    (1, 9, 'fix/a-task', 'dev', 'd', 'running', '## spec', '[\"src/\"]', '$NOW', '$NOW'),
    (2, 9, 'fix/b-task', 'dev', 'd', 'running', '## spec', '[\"src/\"]', '$NOW', '$NOW');
  INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, root_dir, host, spawn_id) VALUES
    (1, 9, 'swe', '$NOW', '$WT_A', 'claude', 'agA'),
    (2, 9, 'swe', '$NOW', '$WT_B', 'claude', 'agB');
  INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES
    (9, 'server', 'swe_brief_fetched', 'brief', '{\"task_id\":1}', '$NOW'),
    (9, 'server', 'swe_brief_fetched', 'brief', '{\"task_id\":2}', '$NOW');
"

export TRAJECTORY_DB_PATH="$DB"
export CLAUDE_PROJECT_DIR="$PROJECT"
export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"
export TMB_INSTALLED_JSON="$SANDBOX/no-installed-plugins.json"

# gates <tool> — every PreToolUse gate hooks.json registers for <tool>.
gates() {
  jq -r --arg t "$1" '.hooks.PreToolUse[] | select(.matcher as $m | $t | test("^(" + $m + ")$"))
                      | .hooks[].command' "$PLUGIN_ROOT/hooks/hooks.json" \
    | sed -nE 's/.*dispatch\.sh"? ([a-z0-9-]+).*/\1/p'
}

SEQ_FILE="$SANDBOX/seq"
echo 0 > "$SEQ_FILE"
# run <cwd> <agent_type|''> <agent_id|''> <tool> <tool_input-json> — every gate
# for <tool> through dispatch.sh; prints one `<gate><TAB><decision><TAB><reason>`
# line per gate.
run() {
  local payload gate out seq
  seq=$(( $(cat "$SEQ_FILE") + 1 ))
  echo "$seq" > "$SEQ_FILE"
  payload=$(jq -nc --arg cwd "$1" --arg at "$2" --arg id "$3" --arg tool "$4" --argjson ti "$5" --arg u "toolu_$seq" \
    '{hook_event_name:"PreToolUse", session_id:"sess-main", tool_use_id:$u, cwd:$cwd, tool_name:$tool, tool_input:$ti}
     + (if $at == "" then {} else {agent_type:$at} end)
     + (if $id == "" then {} else {agent_id:$id} end)')
  for gate in $(gates "$4"); do
    out=$(cd "$1" && printf '%s' "$payload" | CLAUDE_CONFIG_DIR="" TMPDIR="$HOST_TMP" bash "$DISPATCH" "$gate" 2>/dev/null)
    [ -n "$out" ] || out='{}'
    printf '%s\t%s\t%s\n' "$gate" \
      "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // "allow"' 2>/dev/null || echo allow)" \
      "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason // ""' 2>/dev/null || true)"
  done
}
write() { jq -nc --arg p "$1" '{file_path:$p, content:"x\n"}'; }
bash_cmd() { jq -nc --arg c "$1" '{command:$c}'; }
decision_of() { printf '%s\n' "$1" | awk -F'\t' -v g="$2" '$1 == g { print $2 }'; }
denied_by() { printf '%s\n' "$1" | awk -F'\t' '$2 == "deny" { print $1 }' | paste -sd, -; }
last_denial() {
  sqlite3 "$DB" "SELECT json_extract(content_json,'\$.root') || '|' || COALESCE(json_extract(content_json,'\$.task_id'), 'null')
                   FROM audit WHERE event_type='containment_denied' ORDER BY id DESC LIMIT 1;"
}
last_denied_path() {
  sqlite3 "$DB" "SELECT json_extract(content_json,'\$.path') FROM audit WHERE event_type='containment_denied' ORDER BY id DESC LIMIT 1;"
}

test_case "the fixture runs every PreToolUse Write gate"
WRITE_GATES=$(gates Write | paste -sd, -)
assert_contains "$WRITE_GATES" "containment-guard" "containment-guard"
assert_contains "$WRITE_GATES" "swe-boundary" "swe-boundary"
assert_contains "$WRITE_GATES" "swe-scope-fence" "swe-scope-fence"

test_case "(a) swe agA, cwd = main checkout, Write into worktree B → denied"
OUT=$(run "$PROJECT" "tmb:swe" agA Write "$(write "$WT_B/src/x.ts")")
assert_eq "deny" "$(decision_of "$OUT" containment-guard)" "containment-guard denies"
assert_eq "deny" "$(decision_of "$OUT" swe-boundary)" "swe-boundary rule (c) denies"
assert_contains "$(decision_of "$OUT" swe-boundary; printf '%s' "$OUT")" "assigned worktree ($WT_A)" "rule (c) names worktree A"
assert_eq "$WT_A|1" "$(last_denial)" "the containment_denied row: root = worktree A, task_id = A"

test_case "(b) the same caller writing inside worktree A → allowed by every gate"
OUT=$(run "$PROJECT" "tmb:swe" agA Write "$(write "$WT_A/src/a.ts")")
assert_eq "" "$(denied_by "$OUT")" "no gate denies"

test_case "(b) a write in worktree A outside files[] is noted against task A"
OUT=$(run "$PROJECT" "tmb:swe" agA Write "$(write "$WT_A/notes/n.md")")
assert_eq "" "$(denied_by "$OUT")" "no gate denies"
NOTE=$(cd "$PROJECT" && jq -nc --arg p "$WT_A/notes/m.md" \
  '{hook_event_name:"PreToolUse", session_id:"sess-main", tool_use_id:"toolu_note", cwd:"'"$PROJECT"'", tool_name:"Write",
    agent_type:"swe", agent_id:"agA", tool_input:{file_path:$p, content:"x"}}' \
  | bash "$DISPATCH" swe-scope-fence 2>/dev/null)
assert_contains "$NOTE" "notes/m.md is outside this task's files[]" "swe-scope-fence judges task A's files[] with cwd = main checkout"

test_case "(c) Bash touch <worktree B>/x from agA, cwd = main checkout → denied"
OUT=$(run "$PROJECT" "tmb:swe" agA Bash "$(bash_cmd "touch $WT_B/x")")
assert_eq "deny" "$(decision_of "$OUT" containment-guard)" "containment-guard denies"
assert_eq "$WT_A|1" "$(last_denial)" "root = worktree A, task_id = A"
assert_eq "$WT_B/x" "$(last_denied_path)" "the recorded path is worktree B's x, not the cwd"

test_case "(c2) a bound swe's Bash is judged by its write targets, not its cwd (cwd = main checkout)"
OUT=$(run "$PROJECT" "tmb:swe" agA Bash "$(bash_cmd "ls")")
assert_eq "" "$(denied_by "$OUT")" "ls: no gate denies"
OUT=$(run "$PROJECT" "tmb:swe" agA Bash "$(bash_cmd "cd $WT_A && git status")")
assert_eq "" "$(denied_by "$OUT")" "cd A && git status: no gate denies"
OUT=$(run "$PROJECT" "tmb:swe" agA Bash "$(bash_cmd "cd $WT_A && touch src/x.ts")")
assert_eq "" "$(denied_by "$OUT")" "cd A && touch src/x.ts: no gate denies"
OUT=$(run "$PROJECT" "tmb:swe" agA Bash "$(bash_cmd "touch x")")
assert_eq "deny" "$(decision_of "$OUT" containment-guard)" "bare touch x from the main checkout"
assert_eq "$PROJECT/x" "$(last_denied_path)" "the recorded path is the main checkout's x"
OUT=$(run "$PROJECT" "tmb:swe" agA Bash "$(bash_cmd "cd $WT_B && touch x")")
assert_eq "deny" "$(decision_of "$OUT" containment-guard)" "cd B && touch x"
assert_eq "$WT_B/x" "$(last_denied_path)" "the recorded path is worktree B's x"

test_case "(d) swe agZ with no bound row → denied with the task_brief instruction"
OUT=$(run "$PROJECT" "swe" agZ Write "$(write "$WT_A/src/z.ts")")
assert_eq "deny" "$(decision_of "$OUT" containment-guard)" "a write inside a worktree"
assert_contains "$OUT" "task_brief(agent='swe', task_id=<N>) first" "the reason tells it to call task_brief"
ROW=$(sqlite3 "$DB" "SELECT COALESCE(json_extract(content_json,'\$.root'), 'null') || '|' || json_extract(content_json,'\$.reason')
                       FROM audit WHERE event_type='containment_denied' ORDER BY id DESC LIMIT 1;")
assert_contains "$ROW" "null|unbound_caller" "root null, reason names the unbound caller"
assert_contains "$ROW" "agZ" "the reason names its agent_id"
OUT=$(run "$PROJECT" "swe" agZ Write "$(write "$PROJECT/README.md")")
assert_eq "deny" "$(decision_of "$OUT" containment-guard)" "a write in the project root"
OUT=$(run "$PROJECT" "swe" agZ Bash "$(bash_cmd "echo x > $PROJECT/y")")
assert_eq "deny" "$(decision_of "$OUT" containment-guard)" "a Bash write"
OUT=$(run "$PROJECT" "swe" agZ Bash "$(bash_cmd "ls $WT_A 2>/dev/null")")
assert_eq "allow" "$(decision_of "$OUT" containment-guard)" "a Bash read before task_brief"

test_case "(e) main thread, cwd = worktree A, writing the project's issue drafts → allowed by every gate"
mkdir -p "$PROJECT/.claude/tmb/issue-drafts"
OUT=$(run "$WT_A" "" "" Write "$(write "$PROJECT/.claude/tmb/issue-drafts/x.md")")
assert_eq "" "$(denied_by "$OUT")" "no gate denies"
assert_not_contains "$OUT" "SWE may only edit files inside its assigned worktree" "never fenced as a swe"

test_case "(g) pr-reviewer, cwd = worktree A: its root is the project"
OUT=$(run "$WT_A" "tmb:pr-reviewer" agR Write "$(write "$PROJECT/.claude/tmb/issue-drafts/r.md")")
assert_eq "allow" "$(decision_of "$OUT" containment-guard)" "a project write outside worktree A"

test_case "(f) no containment_denied row widens to the project root with a NULL task_id"
assert_eq "0" "$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='containment_denied'
  AND json_extract(content_json,'\$.task_id') IS NULL AND json_extract(content_json,'\$.root') = '$PROJECT';")" "zero rows"

summarize
