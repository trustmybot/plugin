#!/usr/bin/env bash
# L3 tests: scripts/hooks/containment-guard.sh denies writes outside the run's
# root (the swe row's worktree, else the project), audits every denial, and
# leaves reads, the model cache and un-onboarded projects alone.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/containment-guard.sh"

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT
cd "$SANDBOX" || exit 1

PROJECT="$SANDBOX/project"
WT="$PROJECT/.claude/worktrees/cg-task"
CACHE="$SANDBOX/model-cache"
DB="$PROJECT/.claude/tmb/trajectory.db"
mkdir -p "$WT/src" "$(dirname "$DB")" "$CACHE"
sqlite3 "$DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
NOW="2026-10-11T10:00:00.000Z"
sqlite3 "$DB" "
  INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (7, 'containment', 'open', '$NOW', '$NOW');
  INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at)
    VALUES (5, 7, 'feat/cg-task', 'd', 'running', '$NOW', '$NOW');
  INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, root_dir, host)
    VALUES (5, 7, 'swe', '$NOW', '$WT', 'claude');
"

# run <cwd> <agent_type|''> <tool> <tool_input-json> [<project-dir>]
run() {
  local payload
  payload=$(jq -nc --arg cwd "$1" --arg at "$2" --arg tool "$3" --argjson ti "$4" \
    '{hook_event_name:"PreToolUse", session_id:"s-1", cwd:$cwd, tool_name:$tool, tool_input:$ti}
     + (if $at == "" then {} else {agent_type:$at} end)')
  (cd "$1" 2>/dev/null || cd "$SANDBOX" || exit 1
   printf '%s' "$payload" | CLAUDE_PROJECT_DIR="${5:-$PROJECT}" TMB_MODEL_CACHE_DIR="$CACHE" bash "$HOOK" 2>&1)
}
write() { jq -nc --arg p "$1" '{file_path:$p, content:"x"}'; }
bash_cmd() { jq -nc --arg c "$1" '{command:$c}'; }
decision() {
  if [ -z "$1" ]; then echo "allow"; return 0; fi
  printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecision // "allow"' 2>/dev/null || echo "unparseable: $1"
}
denials() { sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='containment_denied' AND from_node='hook:containment-guard';"; }

test_case "swe Write to /tmp/x → deny + audit row"
OUT=$(run "$WT" "tmb:swe" Write "$(write /tmp/x)")
assert_eq "deny" "$(decision "$OUT")" "outside the worktree"
assert_contains "$OUT" "$WT" "the reason names the root"
assert_contains "$OUT" "/tmp/x" "the reason names the path"
assert_eq "1" "$(denials)" "one containment_denied row"
assert_eq '{"tool":"Write","path":"/tmp/x","root":"'"$WT"'","task_id":5}|7' \
  "$(sqlite3 "$DB" "SELECT content_json, issue_id FROM audit WHERE event_type='containment_denied' ORDER BY id DESC LIMIT 1;")" \
  "content {tool, path, root, task_id} on the task's issue"

test_case "swe Write to \$HOME/.claude/x → deny + audit row"
OUT=$(run "$WT" "swe" Write "$(write "$HOME/.claude/x")")
assert_eq "deny" "$(decision "$OUT")" "home is outside the worktree"
assert_eq "2" "$(denials)" "second containment_denied row"

test_case "swe Write inside the worktree → allow"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Write "$(write "$WT/src/a.ts")")")" "worktree file"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Edit "$(write "src/b.ts")")")" "relative path resolves against cwd"

test_case "swe Write to the project outside its worktree → deny"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Write "$(write "$PROJECT/README.md")")")" "the swe root is the worktree, not the project"

test_case "symlinked spelling of a path inside the root → allow"
ALIAS="$SANDBOX/alias"
ln -s "$WT" "$ALIAS"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Write "$(write "$ALIAS/src/c.ts")")")" "symlink resolved into the root"
ln -s /tmp "$WT/escape"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Write "$(write "$WT/escape/d")")")" "a symlink inside the root pointing out is outside"

test_case "Bash: echo hi > ~/.claude/y → deny"
OUT=$(run "$WT" "swe" Bash "$(bash_cmd 'echo hi > ~/.claude/y')")
assert_eq "deny" "$(decision "$OUT")" "redirect into home"
assert_contains "$OUT" "$HOME/.claude/y" "the reason names the expanded path"

test_case "Bash: cat ~/.claude.json → allow (reads are not judged)"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd 'cat ~/.claude.json')")")" "read"

test_case "Bash: a heredoc and quotes mentioning > /tmp/z → allow"
HEREDOC=$(printf '%s\n' "cat <<'EOF' > notes.txt" 'echo "> /tmp/z"' 'write > /tmp/z' 'EOF' 'echo "see > /tmp/z"')
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$HEREDOC")")")" "data, not redirects"

test_case "Bash: cwd outside the root → deny"
assert_eq "deny" "$(decision "$(run "$SANDBOX" "swe" Bash "$(bash_cmd 'ls')")")" "cwd outside the worktree"

test_case "Bash: mkdir \"\$TMB_MODEL_CACHE_DIR\"/x → allow"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd 'mkdir "$TMB_MODEL_CACHE_DIR"/x')")")" "the model cache is sanctioned"

test_case "Bash: write positions outside the root → deny"
for cmd in 'cp a.txt /tmp/b.txt' 'echo x | tee -a /tmp/log' 'rm -rf /tmp/foo*' 'git worktree add /tmp/wt feat/x' \
           'git clone https://example.test/r.git /tmp/clone' 'touch $HOME/f' 'mkdir -p ${HOME}/d' 'mv x ../../outside'; do
  assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$cmd")")")" "$cmd"
done

test_case "Bash: write positions inside the root and devices → allow"
for cmd in 'cp a.txt b.txt' 'ls 2>/dev/null >> out.log' 'echo x 2>&1 | tee out' 'rm -rf build/' 'touch "$UNRESOLVED/x"'; do
  assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$cmd")")")" "$cmd"
done

test_case "bro context: the root is the project"
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Write "$(write "$PROJECT/README.md")")")" "project file"
OUT=$(run "$PROJECT" "" Write "$(write /tmp/x)")
assert_eq "deny" "$(decision "$OUT")" "outside the project"
assert_eq '{"tool":"Write","path":"/tmp/x","root":"'"$PROJECT"'","task_id":null}|-1' \
  "$(sqlite3 "$DB" "SELECT content_json, issue_id FROM audit WHERE event_type='containment_denied' ORDER BY id DESC LIMIT 1;")" \
  "bro denials audit on the system issue with task_id null"

test_case "every denial wrote an audit row"
assert_eq "$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='containment_denied';")" "$(denials)" "all rows from hook:containment-guard"
assert_eq "15" "$(denials)" "one row per denial above"

test_case "un-onboarded project → allow"
BARE="$SANDBOX/bare"
mkdir -p "$BARE"
assert_eq "allow" "$(decision "$(run "$BARE" "" Write "$(write /tmp/x)" "$BARE")")" "no trajectory DB"

test_case "a DB that resolves but cannot be read → deny"
BROKEN="$SANDBOX/broken"
mkdir -p "$BROKEN/.claude/tmb"
printf 'not a database' > "$BROKEN/.claude/tmb/trajectory.db"
OUT=$(run "$BROKEN" "" Write "$(write "$BROKEN/a")" "$BROKEN")
assert_eq "deny" "$(decision "$OUT")" "fail closed"
assert_contains "$OUT" "trajectory DB unavailable" "the db-unavailable reason"

test_case "other tools pass through"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Read "$(write /etc/hosts)")")" "Read is not judged"

summarize
