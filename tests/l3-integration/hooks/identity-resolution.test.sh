#!/usr/bin/env bash
# L3 tests (GH 1550): hooks resolve a swe's location from its identity and the
# trajectory DB — task_id=<N> in the spawn transcript → tasks.repo →
# repos.path → <repos.path>/.claude/worktrees/<branch slug> — never from the
# payload cwd or the hook's $PWD, which Claude Code shares across bro and
# every subagent.
#
# Five layouts, each run with cwd/$PWD at the swe's worktree, a sibling
# worktree and the project root:
#   (a) the main checkout is the project and the repo;
#   (b) repos.path lies outside the project dir;
#   (c) the project is itself a git worktree under <host>/.claude/worktrees/<n>;
#   (d) a workspace project with nested repos ws/svc-a and ws/svc-b, both
#       holding a worktree of the same slug;
#   (e) .claude/worktrees appears twice above the project, and repos.path is
#       relative to the project root (the dir holding .claude/<plugin>).
# Plus: an unresolved swe is denied naming the missing piece, bro is
# unchanged, the subagents/ transcript fallback, scan.sh from a session dir
# under .claude/worktrees/<n>, heredoc text vs a redirect target, and the
# no-cwd-identity lint passing on the hooks and failing on an injected $PWD.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
BOUNDARY="$PLUGIN_ROOT/scripts/hooks/swe-boundary.sh"
CONTAIN="$PLUGIN_ROOT/scripts/hooks/containment-guard.sh"
SCHEMA="$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql"
LINT="$PLUGIN_ROOT/tests/l1-lint/no-cwd-identity.sh"

command -v jq >/dev/null 2>&1 || { printf "SKIP jq not found\n"; exit 0; }
command -v sqlite3 >/dev/null 2>&1 || { printf "SKIP sqlite3 not found\n"; exit 0; }

SB=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$SB"' EXIT
CACHE="$SB/model-cache"
HOST_TMP="$SB/host-tmp"
mkdir -p "$CACHE" "$HOST_TMP"
NOW="2026-10-19T10:00:00.000Z"

git_init() {
  mkdir -p "$1"
  git -C "$1" init -q -b main
  git -C "$1" -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m init
}

# new_db <project> — the project's trajectory DB, with issue 1.
new_db() {
  local db="$1/.claude/tmb/trajectory.db"
  mkdir -p "$(dirname "$db")"
  sqlite3 "$db" < "$SCHEMA" >/dev/null
  sqlite3 "$db" "INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'identity', 'open', '$NOW', '$NOW');"
  printf '%s\n' "$db"
}

# add_task <db> <id> <branch> <repo|''>
add_task() {
  sqlite3 "$1" "INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, repo)
    VALUES ($2, 1, '$3', 'd', 'running', '$NOW', '$NOW', NULLIF('$4', ''));"
}

transcript() {
  local f="$SB/spawn-$1.jsonl"
  printf '{"message":{"content":[{"type":"text","text":"task_id=%s worktree: /somewhere/else"}]}}\n' "$1" > "$f"
  printf '%s\n' "$f"
}

# payload <agent_type|''> <transcript|''> <cwd> <tool> <tool_input-json>
payload() {
  jq -nc --arg at "$1" --arg tr "$2" --arg cwd "$3" --arg tool "$4" --argjson ti "$5" \
    '{hook_event_name:"PreToolUse", session_id:"s-1550", cwd:$cwd, tool_name:$tool, tool_input:$ti}
     + (if $at == "" then {} else {agent_type:$at} end)
     + (if $tr == "" then {} else {agent_transcript_path:$tr} end)'
}
edit() { jq -nc --arg p "$1" '{file_path:$p, old_string:"a", new_string:"b"}'; }
bash_cmd() { jq -nc --arg c "$1" '{command:$c}'; }

# hook <hook> <project> <db> <pwd> <payload> — the hook run from <pwd>.
hook() {
  (cd "$4" || exit 1
   printf '%s' "$5" | CLAUDE_PROJECT_DIR="$2" TRAJECTORY_DB_PATH="$3" CLAUDE_CONFIG_DIR="" \
     TMB_MODEL_CACHE_DIR="$CACHE" TMPDIR="$HOST_TMP" bash "$1" 2>&1)
}
decision() {
  if [ -z "$1" ]; then echo "allow"; return 0; fi
  printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecision // "allow"' 2>/dev/null || echo "unparseable: $1"
}
reason() { printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecisionReason // ""' 2>/dev/null; }

# matrix <label> <project> <db> <task> <worktree> <other-worktree>
# For cwd/$PWD at the worktree, the other worktree and the project root, a
# swe bound to <task> may Edit inside <worktree> and nowhere else.
matrix() {
  local label="$1" project="$2" db="$3" task="$4" wt="$5" other="$6" tr dir where out
  tr=$(transcript "$task")
  mkdir -p "$wt/src" "$other" "$project"
  for dir in "$wt" "$other" "$project"; do
    case "$dir" in
      "$wt") where="the swe worktree" ;;
      "$other") where="another worktree" ;;
      *) where="the project root" ;;
    esac
    test_case "($label) cwd and \$PWD at $where"
    out=$(hook "$BOUNDARY" "$project" "$db" "$dir" "$(payload swe "$tr" "$dir" Edit "$(edit "$wt/src/f.txt")")")
    assert_eq "allow" "$(decision "$out")" "swe-boundary: Edit inside the derived worktree"
    out=$(hook "$BOUNDARY" "$project" "$db" "$dir" "$(payload swe "$tr" "$dir" Edit "$(edit "$other/f.txt")")")
    assert_eq "deny" "$(decision "$out")" "swe-boundary: Edit in another worktree"
    assert_contains "$(reason "$out")" "($wt)" "swe-boundary: the reason names the derived worktree"
    out=$(hook "$BOUNDARY" "$project" "$db" "$dir" "$(payload swe "$tr" "$dir" Edit "$(edit "$project/f.txt")")")
    assert_eq "deny" "$(decision "$out")" "swe-boundary: Edit at the project root"

    out=$(hook "$CONTAIN" "$project" "$db" "$dir" "$(payload swe "$tr" "$dir" Edit "$(edit "$wt/src/f.txt")")")
    assert_eq "allow" "$(decision "$out")" "containment: Edit inside the derived worktree"
    out=$(hook "$CONTAIN" "$project" "$db" "$dir" "$(payload swe "$tr" "$dir" Edit "$(edit "$other/f.txt")")")
    assert_eq "deny" "$(decision "$out")" "containment: Edit in another worktree"
    assert_contains "$(reason "$out")" "root $wt." "containment: the reason names the derived worktree"
    out=$(hook "$CONTAIN" "$project" "$db" "$dir" "$(payload swe "$tr" "$dir" Edit "$(edit "$project/f.txt")")")
    assert_eq "deny" "$(decision "$out")" "containment: Edit at the project root"
    out=$(hook "$CONTAIN" "$project" "$db" "$dir" "$(payload swe "$tr" "$dir" Bash "$(bash_cmd "echo x > $wt/src/o.txt")")")
    assert_eq "allow" "$(decision "$out")" "containment: Bash write inside the derived worktree"
    out=$(hook "$CONTAIN" "$project" "$db" "$dir" "$(payload swe "$tr" "$dir" Bash "$(bash_cmd "echo x > $other/o.txt")")")
    assert_eq "deny" "$(decision "$out")" "containment: Bash write in another worktree"
  done

  test_case "($label) a relative Bash target joins the payload cwd"
  out=$(hook "$CONTAIN" "$project" "$db" "$project" "$(payload swe "$tr" "$wt" Bash "$(bash_cmd "echo x > rel.txt")")")
  assert_eq "allow" "$(decision "$out")" "payload cwd at the worktree, \$PWD at the project"
  out=$(hook "$CONTAIN" "$project" "$db" "$wt" "$(payload swe "$tr" "$other" Bash "$(bash_cmd "echo x > rel.txt")")")
  assert_eq "deny" "$(decision "$out")" "payload cwd at another worktree, \$PWD at the worktree"
}

# (a) main checkout
A_PROJ="$SB/a/project"
git_init "$A_PROJ"
A_DB=$(new_db "$A_PROJ")
sqlite3 "$A_DB" "INSERT INTO repos (name, path) VALUES ('project', '$A_PROJ');"
add_task "$A_DB" 1 "feat/id-a" project
add_task "$A_DB" 2 "feat/other-a" project
git -C "$A_PROJ" worktree add -q -b feat/id-a "$A_PROJ/.claude/worktrees/id-a"
git -C "$A_PROJ" worktree add -q -b feat/other-a "$A_PROJ/.claude/worktrees/other-a"
matrix a "$A_PROJ" "$A_DB" 1 "$A_PROJ/.claude/worktrees/id-a" "$A_PROJ/.claude/worktrees/other-a"

# (b) repos.path outside the project dir
B_PROJ="$SB/b/project"
B_REPO="$SB/b/elsewhere/svc"
mkdir -p "$B_PROJ"
git_init "$B_REPO"
B_DB=$(new_db "$B_PROJ")
sqlite3 "$B_DB" "INSERT INTO repos (name, path) VALUES ('svc', '$B_REPO');"
add_task "$B_DB" 1 "fix/id-b" svc
git -C "$B_REPO" worktree add -q -b fix/id-b "$B_REPO/.claude/worktrees/id-b"
git -C "$B_REPO" worktree add -q -b fix/other-b "$B_REPO/.claude/worktrees/other-b"
matrix b "$B_PROJ" "$B_DB" 1 "$B_REPO/.claude/worktrees/id-b" "$B_REPO/.claude/worktrees/other-b"

# (c) the project is a git worktree under <host>/.claude/worktrees/<n>
C_HOST="$SB/c/host"
git_init "$C_HOST"
C_PROJ="$C_HOST/.claude/worktrees/p1"
git -C "$C_HOST" worktree add -q -b feat/p1 "$C_PROJ"
git -C "$C_HOST" worktree add -q -b feat/p2 "$C_HOST/.claude/worktrees/p2"
C_DB=$(new_db "$C_PROJ")
sqlite3 "$C_DB" "INSERT INTO repos (name, path) VALUES ('p1', '$C_PROJ');"
add_task "$C_DB" 1 "feat/id-c" ""
git -C "$C_PROJ" worktree add -q -b feat/id-c "$C_PROJ/.claude/worktrees/id-c"
matrix c "$C_PROJ" "$C_DB" 1 "$C_PROJ/.claude/worktrees/id-c" "$C_HOST/.claude/worktrees/p2"

# (d) nested repos ws/svc-a and ws/svc-b, the same slug in each
D_PROJ="$SB/d/ws"
git_init "$D_PROJ"
git_init "$D_PROJ/svc-a"
git_init "$D_PROJ/svc-b"
D_DB=$(new_db "$D_PROJ")
sqlite3 "$D_DB" "
  INSERT INTO repos (name, path) VALUES ('ws', '$D_PROJ');
  INSERT INTO repos (name, path) VALUES ('svc-a', '$D_PROJ/svc-a');
  INSERT INTO repos (name, path) VALUES ('svc-b', '$D_PROJ/svc-b');"
add_task "$D_DB" 1 "feat/id-d" svc-a
git -C "$D_PROJ/svc-a" worktree add -q -b feat/id-d "$D_PROJ/svc-a/.claude/worktrees/id-d"
git -C "$D_PROJ/svc-b" worktree add -q -b feat/id-d "$D_PROJ/svc-b/.claude/worktrees/id-d"
matrix d "$D_PROJ" "$D_DB" 1 "$D_PROJ/svc-a/.claude/worktrees/id-d" "$D_PROJ/svc-b/.claude/worktrees/id-d"
test_case "(d) the root-level worktree of the same slug is another worktree"
D_TR=$(transcript 1)
mkdir -p "$D_PROJ/.claude/worktrees/id-d"
OUT=$(hook "$BOUNDARY" "$D_PROJ" "$D_DB" "$D_PROJ/.claude/worktrees/id-d" "$(payload swe "$D_TR" "$D_PROJ/.claude/worktrees/id-d" Edit "$(edit "$D_PROJ/.claude/worktrees/id-d/f.txt")")")
assert_eq "deny" "$(decision "$OUT")" "swe-boundary: ws/.claude/worktrees/id-d is not svc-a's"

# (e) .claude/worktrees twice above the project; repos.path relative to the project root
E_PROJ="$SB/e/outer/.claude/worktrees/n1/.claude/worktrees/n2"
git_init "$E_PROJ"
E_DB=$(new_db "$E_PROJ")
sqlite3 "$E_DB" "INSERT INTO repos (name, path) VALUES ('n2', '.');"
add_task "$E_DB" 1 "chore/id-e" n2
git -C "$E_PROJ" worktree add -q -b chore/id-e "$E_PROJ/.claude/worktrees/id-e"
git -C "$E_PROJ" worktree add -q -b chore/other-e "$SB/e/outer/.claude/worktrees/n1/.claude/worktrees/other-e"
matrix e "$E_PROJ" "$E_DB" 1 "$E_PROJ/.claude/worktrees/id-e" "$SB/e/outer/.claude/worktrees/n1/.claude/worktrees/other-e"

# ---------------------------------------------------------------------------
test_case "an unresolvable swe is denied with the missing piece named"
WT_A="$A_PROJ/.claude/worktrees/id-a"
add_task "$A_DB" 3 "feat/ghost" ghost
for H in "$BOUNDARY" "$CONTAIN"; do
  name=$(basename "$H" .sh)
  OUT=$(hook "$H" "$A_PROJ" "$A_DB" "$WT_A" "$(payload swe "" "$WT_A" Edit "$(edit "$WT_A/f.txt")")")
  assert_eq "deny" "$(decision "$OUT")" "$name: no transcript"
  assert_contains "$(reason "$OUT")" "no task_id" "$name: names the missing task_id"
  OUT=$(hook "$H" "$A_PROJ" "$A_DB" "$WT_A" "$(payload swe "$(transcript 99)" "$WT_A" Edit "$(edit "$WT_A/f.txt")")")
  assert_eq "deny" "$(decision "$OUT")" "$name: a task with no row"
  assert_contains "$(reason "$OUT")" "task 99 has no tasks row" "$name: names the missing tasks row"
  OUT=$(hook "$H" "$A_PROJ" "$A_DB" "$WT_A" "$(payload swe "$(transcript 3)" "$WT_A" Edit "$(edit "$WT_A/f.txt")")")
  assert_eq "deny" "$(decision "$OUT")" "$name: a task whose repo has no row"
  assert_contains "$(reason "$OUT")" "repo 'ghost' has no repos row" "$name: names the missing repos row"
done

test_case "tasks.repo empty with several repos rows names the ambiguity"
add_task "$D_DB" 2 "feat/no-repo" ""
OUT=$(hook "$BOUNDARY" "$D_PROJ" "$D_DB" "$D_PROJ" "$(payload swe "$(transcript 2)" "$D_PROJ" Edit "$(edit "$D_PROJ/svc-a/f.txt")")")
assert_eq "deny" "$(decision "$OUT")" "swe-boundary: no repo resolves"
assert_contains "$(reason "$OUT")" "tasks.repo is empty" "names the empty tasks.repo"

test_case "bro is unchanged: the project is its root"
for dir in "$A_PROJ" "$WT_A"; do
  OUT=$(hook "$BOUNDARY" "$A_PROJ" "$A_DB" "$dir" "$(payload "" "" "$dir" Edit "$(edit "$A_PROJ/README.md")")")
  assert_eq "allow" "$(decision "$OUT")" "swe-boundary ignores bro (cwd $dir)"
  OUT=$(hook "$CONTAIN" "$A_PROJ" "$A_DB" "$dir" "$(payload "" "" "$dir" Edit "$(edit "$A_PROJ/README.md")")")
  assert_eq "allow" "$(decision "$OUT")" "containment: bro Edit in the project (cwd $dir)"
  OUT=$(hook "$CONTAIN" "$A_PROJ" "$A_DB" "$dir" "$(payload "" "" "$dir" Edit "$(edit "$B_PROJ/f.txt")")")
  assert_eq "deny" "$(decision "$OUT")" "containment: bro Edit outside the project (cwd $dir)"
  assert_contains "$(reason "$OUT")" "root $A_PROJ." "containment: bro's root is the project"
done

test_case "the spawn transcript falls back to <transcript_path>/subagents/agent-<id>.jsonl"
SESSION="$SB/session-1550"
mkdir -p "$SESSION/subagents"
printf '{"message":{"content":[{"type":"text","text":"task_id=1"}]}}\n' > "$SESSION/subagents/agent-ab12.jsonl"
for H in "$BOUNDARY" "$CONTAIN"; do
  name=$(basename "$H" .sh)
  IN=$(jq -nc --arg t "$SESSION.jsonl" --arg cwd "$A_PROJ" --arg p "$WT_A/f.txt" \
    '{hook_event_name:"PreToolUse", cwd:$cwd, tool_name:"Edit", agent_type:"swe", agent_id:"ab12", transcript_path:$t, tool_input:{file_path:$p, old_string:"a", new_string:"b"}}')
  assert_eq "allow" "$(decision "$(hook "$H" "$A_PROJ" "$A_DB" "$A_PROJ" "$IN")")" "$name: inside the worktree"
  IN=$(jq -c --arg p "$A_PROJ/.claude/worktrees/other-a/f.txt" '.tool_input.file_path = $p' <<<"$IN")
  assert_eq "deny" "$(decision "$(hook "$H" "$A_PROJ" "$A_DB" "$A_PROJ" "$IN")")" "$name: another worktree"
done

test_case "heredoc program text is data; a redirect is a target"
PROG=$(printf '%s\n' "python3 - <<'PY'" "s = open('$WT_A/notes.txt').read()" "s = s.replace('x', '/user/own')" "open('$WT_A/notes.txt', 'w').write(s)" "PY")
OUT=$(hook "$CONTAIN" "$A_PROJ" "$A_DB" "$A_PROJ" "$(payload swe "$(transcript 1)" "$A_PROJ" Bash "$(bash_cmd "$PROG")")")
assert_eq "allow" "$(decision "$OUT")" "a replace() argument naming /user/own is not a write target"
PROGVAR=$(printf '%s\n' "python3 - <<'PY'" "p = '$WT_A/notes.txt'" "s = open(p).read()" "s = s.replace('x', '/user/own')" "open(p, 'w').write(s)" "PY")
OUT=$(hook "$CONTAIN" "$A_PROJ" "$A_DB" "$A_PROJ" "$(payload swe "$(transcript 1)" "$A_PROJ" Bash "$(bash_cmd "$PROGVAR")")")
assert_eq "deny" "$(decision "$OUT")" "a write through a variable counts every literal"
assert_contains "$(reason "$OUT")" "/user/own" "the reason names /user/own"
OUT=$(hook "$CONTAIN" "$A_PROJ" "$A_DB" "$A_PROJ" "$(payload swe "$(transcript 1)" "$A_PROJ" Bash "$(bash_cmd "echo x > /outside/f")")")
assert_eq "deny" "$(decision "$OUT")" "echo x > /outside/f is a write target"
assert_contains "$(reason "$OUT")" "/outside/f" "the reason names /outside/f"

test_case "a path routed through a text call or a rebound variable is still a write target"
# containment denies a write outside the worktree; swe-boundary judges Bash
# writes by the prompt surface (rule e), so its target is the worktree's CLAUDE.md.
for H in "$BOUNDARY" "$CONTAIN"; do
  name=$(basename "$H" .sh)
  if [ "$H" = "$BOUNDARY" ]; then T="$WT_A/CLAUDE.md"; else T="$SB/outside-1550/evil"; fi
  for CMD in \
    "python3 -c \"p='x'.replace('x','$T'); open(p,'w').write('1')\"" \
    "$(printf '%s\n' "python3 - <<'PY'" "p='x'.replace('x','$T'); open(p,'w').write('1')" "PY")" \
    "python3 -c \"open('x'.replace('x','$T'),'w')\"" \
    "node -e \"const p='x'.replace('x','$T'); require('fs').writeFileSync(p,'1')\"" \
    "python3 -c \"import cProfile; p='notes.txt'; cProfile.run('p=%r' % '$T'); open(p,'w').write('1')\"" \
    "$(printf '%s\n' "python3 - <<'PY'" "import cProfile" "p = 'notes.txt'" "cProfile.run('p=%r' % '$T')" "open(p, 'w').write('1')" "PY")" \
    "$(printf '%s\n' "python3 - <<'PY'" "import trace" "p = 'notes.txt'" "trace.Trace(count=0, trace=0).run('p=%r' % '$T')" "open(p, 'w').write('1')" "PY")" \
    "$(printf '%s\n' "python3 - <<'PY'" "import gc" "p = 'notes.txt'" "for o in gc.get_objects():" "    if isinstance(o, dict) and o.get('p') == 'notes.txt': o['p'] = '$T'" "open(p, 'w').write('1')" "PY")"; do
    OUT=$(hook "$H" "$A_PROJ" "$A_DB" "$WT_A" "$(payload swe "$(transcript 1)" "$WT_A" Bash "$(bash_cmd "$CMD")")")
    assert_eq "deny" "$(decision "$OUT")" "$name: ${CMD%%$'\n'*}"
  done
  OUT=$(hook "$H" "$A_PROJ" "$A_DB" "$WT_A" "$(payload swe "$(transcript 1)" "$WT_A" Bash "$(bash_cmd "$PROG")")")
  assert_eq "allow" "$(decision "$OUT")" "$name: the /user/own heredoc stays allowed"
done

test_case "scan.sh from a session dir under .claude/worktrees/<n> finds the repo"
mkdir -p "$SB/stub-bin"
printf '#!/usr/bin/env bash\necho "[]"\n' > "$SB/stub-bin/claude"
chmod +x "$SB/stub-bin/claude"
SCAN_OUT=$(PATH="$SB/stub-bin:$PATH" CLAUDE_PROJECT_DIR="$C_PROJ" TRAJECTORY_DB_PATH="$C_DB" bash "$PLUGIN_ROOT/scripts/scan.sh" "$C_PROJ" 2>/dev/null)
N=$(printf '%s' "$SCAN_OUT" | jq '.repos | length' 2>/dev/null || echo 0)
if [ "${N:-0}" -ge 1 ]; then _pass; else _fail "scan.sh found $N repos under $C_PROJ"; fi
assert_eq "$C_PROJ" "$(printf '%s' "$SCAN_OUT" | jq -r '.repos[0].path' 2>/dev/null)" "the repo is the session dir itself"

test_case "no-cwd-identity lint: passes on the hooks, fails on an injected \$PWD identity read"
ALLOW="$PLUGIN_ROOT/tests/l1-lint/no-cwd-identity.allowlist"
RC=0
bash "$LINT" >/dev/null 2>&1 || RC=$?
assert_exit_code 0 "$RC" "the lint passes on scripts/hooks"
cp -R "$PLUGIN_ROOT/scripts/hooks" "$SB/hooks-copy"
cp -R "$SB/hooks-copy" "$SB/hooks-pristine"
RC=0
bash "$LINT" "$SB/hooks-pristine" "$ALLOW" >/dev/null 2>&1 || RC=$?
assert_exit_code 0 "$RC" "the lint passes on an unmodified copy"
printf '%s\n' 'case "$PWD" in */.claude/worktrees/*) WT="${PWD%%/.claude/worktrees/*}" ;; esac' >> "$SB/hooks-copy/swe-boundary.sh"
RC=0
LINT_OUT=$(bash "$LINT" "$SB/hooks-copy" "$ALLOW" 2>&1) || RC=$?
assert_exit_code 1 "$RC" "the lint fails on an injected \$PWD read"
assert_contains "$LINT_OUT" "swe-boundary.sh" "the failure names the file"
cp "$PLUGIN_ROOT/scripts/hooks/swe-boundary.sh" "$SB/hooks-copy/swe-boundary.sh"
printf '%s\n' 'ROOT=$(jq -r .cwd <<<"$INPUT")' >> "$SB/hooks-copy/containment-guard.sh"
RC=0
bash "$LINT" "$SB/hooks-copy" "$ALLOW" >/dev/null 2>&1 || RC=$?
assert_exit_code 1 "$RC" "the lint fails on the payload .cwd as a root"

summarize
