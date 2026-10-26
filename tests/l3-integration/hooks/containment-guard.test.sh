#!/usr/bin/env bash
# L3 tests: scripts/hooks/containment-guard.sh denies writes outside the run's
# root (the swe row's worktree, else the project), audits every denial, and
# leaves reads, the model cache and un-onboarded projects alone. Through the
# real dispatcher, a "cannot be judged" Bash deny, an unresolved target's
# included, records no boundary-deny path, so the literal-path Edit it
# prescribes is no bypass; a judged deny records one.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/containment-guard.sh"
# TMB_HOOK_TEST_IMPL=ts runs the TypeScript gate in place of the .sh; its uid
# comes from a preload stubbing process.getuid with the id shim's FAKE_UID.
HOOK_IMPL="${TMB_HOOK_TEST_IMPL:-bash}"
hook() {
  if [ "$HOOK_IMPL" = ts ]; then
    NODE_OPTIONS="--import $PLUGIN_ROOT/tests/lib/fake-uid.mjs" node "$PLUGIN_ROOT/mcp/trajectory-server/dist/hooks.js" containment-guard
  else
    bash "$HOOK"
  fi
}

SANDBOX=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-containment-guard.XXXXXX")
trap 'rm -rf "$SANDBOX"' EXIT
cd "$SANDBOX" || exit 1

PROJECT="$SANDBOX/project"
WT="$PROJECT/.claude/worktrees/cg-task"
CACHE="$SANDBOX/model-cache"
DB="$PROJECT/.claude/tmb/trajectory.db"
HOST_TMP="$SANDBOX/host-tmp"
mkdir -p "$WT/src" "$(dirname "$DB")" "$CACHE" "$HOST_TMP"
# The sandbox itself sits under the harness's /tmp/claude-<uid>, which the
# hook allows; a fake uid keeps that allowance from covering the sandbox.
FAKE_UID=4242424
SHIM="$SANDBOX/shim"
mkdir -p "$SHIM"
printf '#!/bin/sh\n[ "$1" = -u ] && { echo %s; exit 0; }\nexec /usr/bin/id "$@"\n' "$FAKE_UID" > "$SHIM/id"
chmod +x "$SHIM/id"
sqlite3 "$DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
NOW="2026-10-11T10:00:00.000Z"
sqlite3 "$DB" "
  INSERT INTO repos (name, path) VALUES ('project', '$PROJECT');
  INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (7, 'containment', 'open', '$NOW', '$NOW');
  INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, repo)
    VALUES (5, 7, 'feat/cg-task', 'd', 'running', '$NOW', '$NOW', 'project');
  INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, root_dir, host)
    VALUES (5, 7, 'swe', '$NOW', '$WT', 'claude');
"
# The swe's spawn transcript: Claude Code puts task_id=<N> in its prompt.
TRANSCRIPT="$SANDBOX/spawn-5.jsonl"
printf '{"message":{"content":[{"type":"text","text":"task_id=5"}]}}\n' > "$TRANSCRIPT"

# run <cwd> <agent_type|''> <tool> <tool_input-json> [<project-dir>]
# A swe payload carries the task-5 spawn transcript unless CG_NO_IDENTITY=1.
run() {
  local payload
  payload=$(jq -nc --arg cwd "$1" --arg at "$2" --arg tool "$3" --argjson ti "$4" \
    --arg tr "$([ -n "${CG_NO_IDENTITY:-}" ] || printf '%s' "$TRANSCRIPT")" \
    '{hook_event_name:"PreToolUse", session_id:"s-1", cwd:$cwd, tool_name:$tool, tool_input:$ti}
     + (if $at == "" then {} else {agent_type:$at} end)
     + (if ($at | test("swe$")) and $tr != "" then {agent_transcript_path:$tr} else {} end)')
  (cd "$1" 2>/dev/null || cd "$SANDBOX" || exit 1
   printf '%s' "$payload" | CLAUDE_PROJECT_DIR="${5:-$PROJECT}" CLAUDE_CONFIG_DIR="" TMB_MODEL_CACHE_DIR="$CACHE" TMPDIR="$HOST_TMP" PATH="$SHIM:$PATH" hook 2>&1)
}
write() { jq -nc --arg p "$1" '{file_path:$p, content:"x"}'; }
bash_cmd() { jq -nc --arg c "$1" '{command:$c}'; }
decision() {
  if [ -z "$1" ]; then echo "allow"; return 0; fi
  printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecision // "allow"' 2>/dev/null || echo "unparseable: $1"
}
# unproven — the decision on an in-root program the .sh allows but the TS gate
# denies as `$(unproven)`: a call outside its closed safe set (GH 1739).
unproven() { if [ "$HOOK_IMPL" = ts ]; then echo deny; else echo allow; fi; }
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

test_case "Bash: a swe's cwd is not its identity; a relative write still joins the cwd"
assert_eq "allow" "$(decision "$(run "$SANDBOX" "swe" Bash "$(bash_cmd 'ls')")")" "a read from outside the worktree"
assert_eq "deny" "$(decision "$(run "$SANDBOX" "swe" Bash "$(bash_cmd 'touch notes.txt')")")" "a relative write from outside lands outside"
assert_eq "allow" "$(decision "$(run "$SANDBOX" "swe" Bash "$(bash_cmd "touch $WT/notes.txt")")")" "an absolute write into the worktree"

test_case "GH 1550: a swe with no spawn transcript fails closed, naming the missing piece"
OUT=$(CG_NO_IDENTITY=1 run "$WT" "swe" Write "$(write "$WT/src/a.ts")")
assert_eq "deny" "$(decision "$OUT")" "a cwd inside the worktree is not identity"
assert_contains "$OUT" "no task_id" "the reason names the missing piece"
assert_eq "allow" "$(decision "$(CG_NO_IDENTITY=1 run "$WT" "swe" Bash "$(bash_cmd 'ls')")")" "Bash with no write runs"
sqlite3 "$DB" "DELETE FROM audit WHERE event_type='containment_denied' AND content_json LIKE '%unbound_caller%';"

test_case "Bash: mkdir \"\$TMB_MODEL_CACHE_DIR\"/x → allow"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd 'mkdir "$TMB_MODEL_CACHE_DIR"/x')")")" "the model cache is sanctioned"

test_case "Bash: write positions outside the root → deny"
for cmd in 'cp a.txt /tmp/b.txt' 'echo x | tee -a /tmp/log' 'rm -rf /tmp/foo*' 'git worktree add /tmp/wt feat/x' \
           'git clone https://example.test/r.git /tmp/clone' 'touch $HOME/f' 'mkdir -p ${HOME}/d' 'mv x ../../outside' \
           'touch "$UNRESOLVED/x"'; do
  assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$cmd")")")" "$cmd"
done

test_case "Bash: write positions inside the root and devices → allow"
for cmd in 'cp a.txt b.txt' 'ls 2>/dev/null >> out.log' 'echo x 2>&1 | tee out' 'rm -rf build/'; do
  assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$cmd")")")" "$cmd"
done

test_case "the host temp dir (\$TMPDIR) is allowed; /tmp outside it is not"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Write "$(write "$HOST_TMP/scratch.txt")")")" "Write under \$TMPDIR"
REAL_HOST_TMP=$(cd -P "$HOST_TMP" && pwd -P)
assert_eq "allow" "$(decision "$(run "$WT" "swe" Write "$(write "$REAL_HOST_TMP/real.txt")")")" "Write under the realpath of \$TMPDIR"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "echo x > $HOST_TMP/out.txt")")")" "Bash redirect into \$TMPDIR"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Write "$(write /tmp/tmb-not-host-tmp/x)")")" "Write under /tmp outside \$TMPDIR"

test_case "bro context: the root is the project"
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Write "$(write "$PROJECT/README.md")")")" "project file"
OUT=$(run "$PROJECT" "" Write "$(write /tmp/x)")
assert_eq "deny" "$(decision "$OUT")" "outside the project"
assert_eq '{"tool":"Write","path":"/tmp/x","root":"'"$PROJECT"'","task_id":null}|-1' \
  "$(sqlite3 "$DB" "SELECT content_json, issue_id FROM audit WHERE event_type='containment_denied' ORDER BY id DESC LIMIT 1;")" \
  "bro denials audit on the system issue with task_id null"

test_case "symlink then .. lands where the link points → deny"
OUTSIDE="$SANDBOX/outside/deep"
mkdir -p "$OUTSIDE"
ln -s "$OUTSIDE" "$WT/link"
OUT=$(run "$WT" "swe" Write "$(write "$WT/link/../x")")
assert_eq "deny" "$(decision "$OUT")" "Write to <root>/link/../x"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "echo hi > $WT/link/../x")")")" "Bash echo hi > <root>/link/../x"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Write "$(write "$WT/src/../b.ts")")")" "Write to <root>/a/../b with no symlink"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "echo hi > $WT/src/../b.txt")")")" "Bash redirect to <root>/a/../b with no symlink"

test_case "planting a link is a write → deny when either end is outside"
for cmd in "ln -s /outside $WT/link2" 'link /etc/hosts h' 'cp -s /etc/hosts h' 'cp -l /etc/hosts h'; do
  assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$cmd")")")" "$cmd"
done
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd 'ln -s a.ts src/alias.ts')")")" "a relative link inside the root"

test_case "Claude Code's own project and plans dirs: main session only"
CC_SLUG=$(printf '%s' "$PROJECT" | sed 's/[^A-Za-z0-9]/-/g')
CC_PROJECT="$HOME/.claude/projects/$CC_SLUG"
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Write "$(write "$CC_PROJECT/memory/MEMORY.md")")")" "bro Write to its auto-memory"
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Write "$(write "$HOME/.claude/plans/x.md")")")" "bro Write to a plan"
assert_eq "allow" "$(decision "$(run "$PROJECT" "bro" Bash "$(bash_cmd 'echo x > ~/.claude/plans/p.md')")")" "bro Bash redirect into plans"
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Write "$(write "$HOME/.claude/settings.json")")")" "bro Write to ~/.claude/settings.json"
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Write "$(write "$HOME/.claude/projects/-Users-someone-else/memory/x.md")")")" "bro Write to another project's slug"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Write "$(write "$CC_PROJECT/memory/x.md")")")" "swe Write to the project's auto-memory"
assert_eq "deny" "$(decision "$(run "$WT" "code-reviewer" Write "$(write "$HOME/.claude/plans/x.md")")")" "code-reviewer Write to a plan"

test_case "GH 1553: a session nested below the project writes the auto-memory Claude Code names after CLAUDE_PROJECT_DIR"
NESTED="$PROJECT/apps/web"
mkdir -p "$NESTED"
CC_NESTED="$HOME/.claude/projects/$(printf '%s' "$NESTED" | sed 's/[^A-Za-z0-9]/-/g')"
assert_eq "allow" "$(decision "$(run "$NESTED" "" Write "$(write "$CC_NESTED/memory/MEMORY.md")" "$NESTED")")" "bro Write to the session's auto-memory"
assert_eq "allow" "$(decision "$(run "$NESTED" "" Write "$(write "$CC_PROJECT/memory/MEMORY.md")" "$NESTED")")" "bro Write to the project root's auto-memory"
assert_eq "allow" "$(decision "$(run "$NESTED" "" Write "$(write "$PROJECT/README.md")" "$NESTED")")" "the root is still the project"
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Write "$(write "$CC_NESTED/memory/MEMORY.md")")")" "a session at the project root does not get a subdir's slug"

test_case "every denial wrote an audit row"
assert_eq "$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='containment_denied';")" "$(denials)" "all rows from hook:containment-guard"
assert_eq "28" "$(denials)" "one row per denial above"

test_case "GH 1279: a program fed to an interpreter through a heredoc is judged"
NODE_OUT=$(printf '%s\n' "node <<'EOF'" "require('fs').writeFileSync('/tmp/tmb-cg-x', 'y')" 'EOF')
OUT=$(run "$PROJECT" "" Bash "$(bash_cmd "$NODE_OUT")")
assert_eq "deny" "$(decision "$OUT")" "bro node heredoc writing /tmp outside the root"
assert_contains "$OUT" "/tmp/tmb-cg-x" "the reason names the program's path"
NODE_IN=$(printf '%s\n' "node <<'EOF'" "require('fs').writeFileSync('src/x.js', 'y')" 'EOF')
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd "$NODE_IN")")")" "bro node heredoc writing inside the root"
PY_OUT=$(printf '%s\n' "python3 - <<'EOF'" "open('/etc/tmb-cg', 'w').write('x')" 'EOF')
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$PY_OUT")")")" "swe python heredoc writing outside its worktree"
SH_OUT=$(printf '%s\n' "sh <<'EOF'" 'echo x > /tmp/tmb-cg-sh' 'EOF')
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$SH_OUT")")")" "swe sh heredoc redirecting outside its worktree"
DATA=$(printf '%s\n' "cat > notes.py <<'EOF'" "open('/etc/passwd', 'w')" 'EOF')
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$DATA")")")" "a data heredoc is never scanned"

test_case "GH 1567: /onboard quoted inside a larger string literal is not a write target"
PROSE=$(printf '%s\n' "p = 'src/x.sh'" "s = open(p).read()" "old = '''x'''" "new = old + '''" 'assert_not_contains "$PREAMBLE" "/onboard" "preamble /onboard token"' 'If you run `/onboard`, answer No' "'''")
PY_PROSE=$(printf '%s\n' "python3 - <<'EOF'" "$PROSE" "open(p, 'w').write(s.replace(old, new))" 'EOF')
assert_eq "$(unproven)" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$PY_PROSE")")")" "swe editing a relative file through a variable path"
PY_PROSE_OUT=$(printf '%s\n' "python3 - <<'EOF'" "$PROSE" "open(p, 'w').write(s.replace(old, new))" "open(\"/onboard/x\", \"w\")" 'EOF')
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$PY_PROSE_OUT")")")" "the same edit with a literal write to /onboard/x"
PY_PROSE_LIT=$(printf '%s\n' "python3 - <<'EOF'" "$PROSE" "q = \"/onboard\"" "open(p, 'w').write(s.replace(old, new))" 'EOF')
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$PY_PROSE_LIT")")")" "the same edit with a standalone /onboard literal"

test_case "GH 1510: a program is judged by its write calls' own path arguments"
py() { printf '%s\n' "python3 - <<'EOF'" "$@" 'EOF'; }
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'import json' "cfg = json.load(open('/etc/tmb-cg/config.json', encoding='utf-8'))" "open('out.txt','w').write(str(cfg))")")")")" "swe reading a config outside, writing out.txt inside"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'import os' "open('out.txt','w').write(str(os.listdir('/usr/share/doc')))")")")")" "swe listing a dir outside"
assert_eq "$(unproven)" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'import sys' "sys.path.insert(0, '/opt/tmb-cg/lib')" "open('out.txt','w').write('x')")")")")" "swe extending sys.path with a dir outside"
assert_eq "$(unproven)" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py "s = open('src/x.sh').read().replace('/^[\\\\/~\$]/', '/x/')" "open('src/x.sh','w').write(s)")")")")" "swe editing a file whose text holds regex slashes"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py "s = open('src/x.sh').read().replace('/^[\\\\/~\$]/', '/x/')" "open('/etc/tmb-cg/x.sh','w').write(s)")")")")" "the same edit written outside"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py "open('/etc/tmb-cg/x', 'w')")")")")" "swe open w outside"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py "p = '/etc/tmb-cg/x'" "open(p, 'w').write('y')")")")")" "swe writing a variable assigned an outside path"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'import shutil' "shutil.copy('in.txt', '/etc/tmb-cg/')")")")")" "swe copying out"

test_case "GH 1279: variable-held write targets"
OUT=$(run "$PROJECT" "" Bash "$(bash_cmd 'cat > "$UNKNOWN/f"')")
assert_eq "deny" "$(decision "$OUT")" "bro \$UNKNOWN/f"
assert_contains "$OUT" 'write target \"$UNKNOWN/f\" cannot be judged: depends on a variable the guard cannot resolve in this command' "the reason names the variable"
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd 'OUT=/etc/tmb-cg; cat > "$OUT"')")")" "a variable set to a path outside the root"
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd "OUT=$PROJECT/notes.txt; cat > \"\$OUT\"")")")" "a variable set to a path inside the root"
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd 'D=build; mkdir -p "$D/out"')")")" "a relative variable resolves against the cwd"
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd 'touch "build/$UNKNOWN"')")")" "the literal dir before an unknown variable is inside the root"
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd 'touch "/tmp/tmb-cg/$UNKNOWN"')")")" "the literal dir before an unknown variable is outside the root"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd 'OUT=$(mktemp "$TMPDIR/f.XXXXXX"); cat > "$OUT"')")")" "a value built by \$( ) is unresolvable"

test_case "GH 1279: \$PWD is the statement's own dir"
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd 'echo x > "$PWD/out"')")")" "bro from inside the root"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd 'echo x > "$PWD/out"')")")" "swe from inside its worktree"
mkdir -p "$PROJECT/x"
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd "cd $PROJECT/x && echo y > \"\$PWD/f\"")")")" "cd <root>/x && echo y > \$PWD/f"
OUT=$(run "$PROJECT" "" Bash "$(bash_cmd 'cd /tmp/tmb-cg-pwd && echo y > "$PWD/f"')")
assert_eq "deny" "$(decision "$OUT")" "\$PWD after a cd outside the root"
assert_contains "$OUT" "/tmp/tmb-cg-pwd/f is outside" "denied as the real path"
OUTSIDE_CWD="$SANDBOX/outside-cwd"
mkdir -p "$OUTSIDE_CWD"
OUT=$(run "$OUTSIDE_CWD" "" Bash "$(bash_cmd 'echo x > "$PWD/out"')")
assert_eq "deny" "$(decision "$OUT")" "from a cwd outside the root"
assert_contains "$OUT" "$OUTSIDE_CWD" "denied as the real path"
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd 'HOME=/inside cat > "$HOME/.bashrc"')")")" "a HOME= prefix: judged on the real ~/.bashrc"

test_case "GH 1324: loop variables bounded by an in-root source"
mkdir -p "$PROJECT/tests" "$PROJECT/a" "$WT/tests"
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd "for f in $PROJECT/tests/*.sh; do sed -i 's/a/b/' \"\$f\"; done")")")" "bro: for f in <root>/tests/*.sh; sed -i"
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd "for f in \$(find $PROJECT -name '*.md'); do printf x >> \"\$f\"; done")")")" "bro: for f in \$(find <root> …); printf >>"
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd "find . -name '*.sh' | while read -r f; do sed -i 's/a/b/' \"\$f\"; done")")")" "bro: find . | while read"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "for f in \$(git ls-files); do sed -i 's/a/b/' \"\$f\"; done")")")" "swe: for f in \$(git ls-files) from its worktree"
OUT=$(run "$PROJECT" "" Bash "$(bash_cmd "for f in \$(find / -name x); do rm \"\$f\"; done")")
assert_eq "deny" "$(decision "$OUT")" "bro: for f in \$(find / …); rm"
assert_contains "$OUT" 'depends on a variable the guard cannot resolve' "an out-of-root source is unresolvable"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "for f in \$(find $PROJECT -name x); do rm \"\$f\"; done")")")" "swe: a source in the project but outside its worktree"
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd "for f in \$(cat list.txt); do rm \"\$f\"; done")")")" "bro: \$(cat list.txt)"

test_case "GH 1324: bro loops over the project above its prompt-surface dirs are allowed"
mkdir -p "$PROJECT/agents" "$PROJECT/skills/x"
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd "for f in \$(find $PROJECT -name '*.md'); do sed -i s/a/b/ \"\$f\"; done")")")" "bro: find <root> -name '*.md'"
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd "for f in \$(git ls-files); do sed -i s/a/b/ \"\$f\"; done")")")" "bro: git ls-files"

test_case "GH 1324: loop shapes that leave the root stay denied"
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd "for f in \$(find -- /etc -name x); do rm \"\$f\"; done")")")" "find -- /etc"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "for f in \$(find -- /etc -name x); do rm \"\$f\"; done")")")" "swe: find -- /etc"
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd "for d in \$(find $PROJECT -type d); do echo x > \"\$d/../f\"; done")")")" "\$d/../f: find lists the root itself"
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd "for f in \$(find $PROJECT -maxdepth 0); do cp x \"\$f.bak\"; done")")")" "\$f.bak of the root"
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd "for f in \$(find $PROJECT -name '*'); do rm -rf \"\$f/..\"; done")")")" "\$f/.. of the root"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "for d in \$(find $WT -type d); do echo x > \"\$d/../f\"; done")")")" "swe: \$d/../f from its worktree"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "for f in \$(find $WT -maxdepth 0); do cp x \"\$f.bak\"; done")")")" "swe: \$f.bak of its worktree"
OUT=$(run "$PROJECT" "" Bash "$(bash_cmd "echo x > $PROJECT/*/../../../etc/f")")
assert_eq "deny" "$(decision "$OUT")" "a literal glob followed by .."
assert_contains "$OUT" "climbs with .. after a glob" "the reason names the shape"
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd "for d in \$(find $PROJECT/a -type d); do echo x > \"\$d/../../../etc/f\"; done")")")" "a bound glob followed by .."
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd 'cd /tmp/tmb-cg-z; echo x > "$OLDPWD/f"')")")" "a cd not chained with && leaves \$OLDPWD unknown"

test_case "GH 1324: \$OLDPWD is the dir before the command's last cd"
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd "cd $PROJECT/a && echo x > \"\$OLDPWD/f\"")")")" "bro: cd <root>/a from inside the root"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "cd $WT/src && echo x > \"\$OLDPWD/f\"")")")" "swe: cd <wt>/src from its worktree"
OUT=$(run "$OUTSIDE_CWD" "" Bash "$(bash_cmd "cd $PROJECT/a && echo x > \"\$OLDPWD/f\"")")
assert_eq "deny" "$(decision "$OUT")" "bro: from a cwd outside the root"
assert_contains "$OUT" "$OUTSIDE_CWD" "the outside dir is named"
OUT=$(run "$PROJECT" "" Bash "$(bash_cmd "cd /tmp/tmb-cg-old && cd $PROJECT/a && echo x > \"\$OLDPWD/f\"")")
assert_eq "deny" "$(decision "$OUT")" "bro: \$OLDPWD left outside the root by an earlier cd"
assert_contains "$OUT" "/tmp/tmb-cg-old/f is outside" "denied as the real path"
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd 'echo x > "$OLDPWD/f"')")")" "no cd: unresolvable"

test_case "GH 1324: the GH 1279 denies hold"
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd 'cat > "$UNKNOWN/f"')")")" "cat > \$UNKNOWN/f"
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd 'cat > "$(mktemp "$TMPDIR/f.XXXXXX")"')")")" "cat > \$(mktemp <template>)"
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd 'OUT=/etc/tmb-cg; cat > "$OUT"')")")" "OUT=/etc/x; cat > \$OUT"
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd "$NODE_OUT")")")" "an interpreter heredoc writing outside the root"

test_case "GH 1338: what find, fd and xargs run is judged on the listed paths"
OUT=$(run "$PROJECT" "" Bash "$(bash_cmd 'find / -exec rm {} \;')")
assert_eq "deny" "$(decision "$OUT")" "bro: find / -exec rm {} \\;"
assert_contains "$OUT" 'depends on a variable the guard cannot resolve' "an out-of-root start path is unresolvable"
for cmd in 'find $HOME -delete' 'find / -print0 | xargs -0 rm' 'cat list | xargs rm' 'fd x /etc -x rm' "find $PROJECT -fprint /tmp/tmb-cg-list"; do
  assert_eq "deny" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd "$cmd")")")" "bro: $cmd"
done
for cmd in "find $PROJECT -name '*.md' -exec sed -i s/a/b/ {} \\;" "find $PROJECT -name '*.sh' -print" "find / -name x -print" \
  "find $PROJECT -name '*.tmp' -delete" "find src -print0 | xargs -0 sed -i s/a/b/" "fd -e md -x sed -i s/a/b/ {}"; do
  assert_eq "allow" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd "$cmd")")")" "bro: $cmd"
done
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "find $PROJECT -exec rm {} \\;")")")" "swe: find <project> -exec rm from its worktree"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "find $WT/src -exec rm {} \\;")")")" "swe: find <wt>/src -exec rm"

test_case "GH 1531: git subcommands, program calls and wrapper options that write outside are denied"
for pair in "git -C $PROJECT bisect start|$PROJECT" "git archive -o /etc/tmb-cg.tar HEAD|/etc/tmb-cg.tar" \
  "sudo -S rm /etc/tmb-cg|/etc/tmb-cg" "sudo -C 5 rm ../tmb-cg-x|$WT/../tmb-cg-x"; do
  OUT=$(run "$WT" "swe" Bash "$(bash_cmd "${pair%%|*}")")
  assert_eq "deny" "$(decision "$OUT")" "swe: ${pair%%|*}"
  assert_contains "$OUT" "${pair#*|}" "the reason names ${pair#*|}"
done
for pair in "import os|os.truncate('/etc/tmb-cg', 0)|/etc/tmb-cg" "import subprocess|subprocess.run(['cp', 'a', '/etc/tmb-cg'])|/etc/tmb-cg" \
  "import zipfile|zipfile.ZipFile('/etc/tmb-cg.zip', 'w')|/etc/tmb-cg.zip"; do
  IFS='|' read -r l1 l2 want <<< "$pair"
  OUT=$(run "$WT" "swe" Bash "$(bash_cmd "$(py "$l1" "$l2")")")
  assert_eq "deny" "$(decision "$OUT")" "swe: $l2"
  assert_contains "$OUT" "$want" "the reason names $want"
done

test_case "GH 1531: a process call is judged as the shell command it runs"
for pair in "import subprocess|subprocess.run(['rm', '-rf', '..'])" "import subprocess|subprocess.run(['rm', '-rf', 'x'], cwd='..')" \
  "import os|os.system('rm -rf ~')" "import os|os.system('cd .. && rm -rf cg-task')" \
  "import subprocess as sp|sp.run(['rm', '-rf', '..'])" "from subprocess import run as r|r(['rm', '-rf', '..'])" \
  "import subprocess|subprocess.run(['rm', '-rf', d])" "import subprocess|f = subprocess.run; f(['touch', 'x'])"; do
  assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py "${pair%%|*}" "${pair#*|}")")")")" "swe: ${pair#*|}"
done
node_prog() { printf '%s\n' "node - <<'EOF'" "$@" 'EOF'; }
for prog in "const {execSync: x} = require('child_process'); x('rm -rf ..')" "const cp = require('child_process'); cp.execSync('rm -rf ..')" \
  "require('child_process').spawnSync('rm', ['-rf', 'x'], { cwd: '..' })"; do
  assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(node_prog "$prog")")")")" "swe: $prog"
done
for pair in "import subprocess|subprocess.run(['rm', '-rf', 'build'])" "import subprocess|subprocess.run(['touch', 'x'], cwd='src')" \
  "import os|os.system('cd src && touch x')" "import subprocess as sp|sp.run(['git', 'status'], check=True)"; do
  assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py "${pair%%|*}" "${pair#*|}")")")")" "swe inside its worktree: ${pair#*|}"
done
OUT=$(run "$WT" "swe" Bash "$(bash_cmd 'cd .. && rm -rf cg-task')")
assert_eq "deny" "$(decision "$OUT")" "swe: cd .. && rm -rf <its own worktree>"
assert_contains "$OUT" "comes back into it" "the reason names the climb"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd 'mkdir -p src && cd src/.. && touch x')")")" "swe: a .. that stays inside its worktree"

test_case "GH 1531: a process call is judged only when every part is a plain literal"
interp_prog() { printf '%s\n' "$1 - <<'EOF'"; shift; printf '%s\n' "$@" 'EOF'; }
for pair in "import os|os.system('rm -rf %s' % '..')" "import subprocess|subprocess.run('rm -rf %s' % '..', shell=True)" \
  "import os|os.system('rm -rf {}'.format('..'))" "import subprocess|subprocess.run(['rm', '-rf', '..'.strip()])" \
  "import subprocess|kw = {'cwd': '..'}; subprocess.run(['rm', '-rf', 'x'], **kw)" \
  "import os|os.chdir('..'); os.system('rm -rf cg-task')" "import os|exec(\"os.system('rm -rf ..')\")"; do
  assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py "${pair%%|*}" "${pair#*|}")")")")" "swe: ${pair#*|}"
done
for prog in "const { execSync } = require('child_process'); const o = { cwd: '..' }; execSync('rm -rf x', o)" \
  "const { execSync } = require('child_process'); execSync('rm -rf x', { ...{ cwd: '..' } })" \
  "process.chdir('..'); require('child_process').execSync('rm -rf cg-task')" \
  "import cp from 'child_process'; cp.execSync('rm -rf ..')" "eval(\"require('child_process').execSync('rm -rf ..')\")"; do
  assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(node_prog "$prog")")")")" "swe: $prog"
done
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(interp_prog perl "chdir '..'; system('rm', '-rf', 'cg-task');")")")")" "swe: perl chdir then system"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(interp_prog ruby "Dir.chdir('..')" "system('rm -rf cg-task')")")")")" "swe: ruby Dir.chdir then system"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(interp_prog perl 'my $o = qx(rm -rf ..);')")")")" "swe: perl qx()"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(interp_prog ruby 'o = %x(rm -rf ..)')")")")" "swe: ruby %x()"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'import subprocess' "subprocess.run(['touch', 'x'], cwd='src', check=True, capture_output=True, text=True)")")")")" "swe: plain literals with ordinary options inside its worktree"
assert_eq "$(unproven)" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(node_prog "import cp from 'child_process'; cp.execSync('touch x', { stdio: 'inherit' })")")")")" "swe: a node default import inside its worktree"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py "print('%s' % 'x'.strip())")")")")" "swe: a program without process calls"

test_case "GH 1531: text a program writes is content, not a target"
CONTENT="const root = '/work/proj'; const branch = 'fix/sess-a';"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py "p = '$WT/a.ts'" "with open(p, 'w') as f:" "    f.write(\"$CONTENT\")")")")")" "swe writing path-like text into its worktree"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'from pathlib import Path' "p = Path('$WT/a.ts')" "p.write_text(\"$CONTENT\")")")")")" "an unknown receiver writing path-like text"
OUT=$(run "$WT" "swe" Bash "$(bash_cmd "$(py "p = '/etc/tmb-cg-a.ts'" "with open(p, 'w') as f:" "    f.write(\"$CONTENT\")")")")
assert_eq "deny" "$(decision "$OUT")" "the same program writing outside"
assert_contains "$OUT" "/etc/tmb-cg-a.ts" "the reason names the written path"
assert_not_contains "$OUT" "/work/proj" "the content is not named"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py "d = '/etc'" "open(d + '/tmb-cg', 'w').write('x')")")")")" "a computed write path fails closed"

test_case "GH 1569: code-string runners and dynamic builtins"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'import cProfile' "p = 'out.txt'" "cProfile.run('p = \"/etc/tmb-cg\"')" "open(p, 'w').write('x')")")")")" "swe: cProfile.run rebinding a variable write path"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "python3 -c \"import cProfile; p = 'out.txt'; cProfile.run('p = %r' % 'x'); open(p, 'w')\"")")")" "swe python -c: cProfile.run with a computed code string"
OUT=$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'import cProfile' "cProfile.run('open(\"/etc/tmb-cg\", \"w\")')" "open('out.txt', 'w').write('x')")")")
assert_eq "deny" "$(decision "$OUT")" "swe: a write inside a cProfile.run code string"
assert_contains "$OUT" "/etc/tmb-cg" "the reason names the code string's path"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'import builtins' "getattr(builtins, 'ex' + 'ec')(\"open('/etc/tmb-cg', 'w')\")")")")")" "swe: getattr(builtins, 'ex' + 'ec')"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "python3 -c \"import builtins; getattr(builtins, 'ex' + 'ec')(s)\"")")")" "swe python -c: getattr(builtins, 'ex' + 'ec')"
assert_eq "$(unproven)" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'import cProfile, timeit' "cProfile.run('sum(range(9))')" "print(timeit.timeit('sum(range(9))', number=10))" "open('out.txt', 'w').write('x')")")")")" "swe: benign cProfile.run and timeit writing inside its worktree"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'import cProfile' 'with cProfile.Profile() as pr:' '    sum(range(9))' "pr.dump_stats('out.prof')")")")")" "swe: with cProfile.Profile() as pr is unresolvable even dumping stats inside its worktree"
assert_eq "$(unproven)" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'import cProfile, timeit' "cProfile.run('main()', 'out.prof')" 'print(timeit.timeit(lambda: 1, number=10))')")")")" "swe: cProfile.run with a filename and a timeit lambda writing inside its worktree"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'import cProfile, sys' "p = 'out.txt'" 'pr = cProfile.Profile()' "getattr(pr, 'run')(sys.argv[1])" "open(p, 'w').write('x')")")")")" "swe: getattr(pr, 'run') rebinding a variable write path"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'import cProfile, inspect, sys' "p = 'out.txt'" 'pr = cProfile.Profile()' "inspect.getattr_static(pr, 'run')(pr, sys.argv[1])" "open(p, 'w').write('x')")")")")" "swe: inspect.getattr_static(pr, 'run') rebinding a variable write path"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'from cProfile import Profile as P' "p = 'out.txt'" "P.runctx(o, sys.argv[1], globals(), None)" "open(p, 'w').write('x')")")")")" "swe: a class-method runctx rebinding a variable write path"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'import cProfile, sys' 'cProfile.Profile().run("pass").run(sys.argv[1])')")")")" "swe: a chained Profile().run returns the profiler"

test_case "GH 1571: python paths that hide a write are unresolvable when referenced at all"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "python3 -m timeit -s \"open('/etc/tmb-cg','w')\" pass")")")" "swe: python -m timeit -s"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd 'python3 -m cProfile -o out.prof x.py')")")" "swe: python -m cProfile"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd 'python3 -m pdb x.py')")")" "swe: python -m pdb"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'import runpy' "open('out.txt','w')")")")")" "swe: a program importing runpy"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'o = open' "o('/etc/tmb-cg', 'w')")")")")" "swe: open held as a value"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd 'python3 -m json.tool x.json')")")" "swe: python -m json.tool"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd 'python3 -m pytest -q')")")" "swe: python -m pytest"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py "import json; open('out.txt','w').write(json.dumps({}))")")")")" "swe: an ordinary program writing inside its worktree"

test_case "GH 1597: the harness's /tmp/claude-<uid> and .claude/tmb/scratch/ are sanctioned scratch"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Write "$(write "/tmp/claude-$FAKE_UID/x")")")" "swe Write under /tmp/claude-<uid> with \$TMPDIR elsewhere"
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd "echo x > /tmp/claude-$FAKE_UID/y")")")" "bro Bash redirect under /tmp/claude-<uid>"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Write "$(write "/tmp/claude-$FAKE_UID-other/x")")")" "a sibling of /tmp/claude-<uid> is not covered"
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Write "$(write "$PROJECT/.claude/tmb/scratch/x.py")")")" "bro Write to <project>/.claude/tmb/scratch/"
OUT=$(run "$PROJECT" "" Write "$(write /etc/tmb-cg)")
assert_contains "$OUT" "$PROJECT/.claude/tmb/scratch/" "the deny names the sanctioned scratch dir"
assert_contains "$OUT" "/tmp/claude-$FAKE_UID" "the deny names the harness temp dir"

test_case "GH 1595: bro's cwd is judged only when the command writes"
OTHER_REPO="$SANDBOX/other-repo"
mkdir -p "$OTHER_REPO"
git -C "$OTHER_REPO" init -q
assert_eq "allow" "$(decision "$(run "$OTHER_REPO" "" Bash "$(bash_cmd "git -C $PROJECT status")")")" "bro: git -C <project> status from another repo"
assert_eq "allow" "$(decision "$(run "$OTHER_REPO" "" Bash "$(bash_cmd "ls $PROJECT")")")" "bro: a read from another repo"
OUT=$(run "$OTHER_REPO" "" Bash "$(bash_cmd 'touch f')")
assert_eq "deny" "$(decision "$OUT")" "bro: a relative write from another repo"
assert_contains "$OUT" "$OTHER_REPO" "the reason names the write's real dir"

test_case "GH 1595: a relative write after cd \$VAR is judged under the variable"
OUT=$(run "$PROJECT" "" Bash "$(bash_cmd 'cd $UNSET && touch f')")
assert_eq "deny" "$(decision "$OUT")" "bro: cd \$UNSET && touch f"
assert_contains "$OUT" '$UNSET' "the reason names the variable"
assert_not_contains "$OUT" "is outside" "never judged as a bare path under the cwd"
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd "D=$PROJECT/src; cd \$D && touch f")")")" "bro: D=<root>/src; cd \$D && touch f"
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd 'D=/etc; cd $D && touch f')")")" "bro: D=/etc; cd \$D && touch f"
OUT=$(run "$PROJECT" "" Bash "$(bash_cmd 'cd - && touch f')")
assert_eq "deny" "$(decision "$OUT")" "bro: cd - && touch f"
assert_contains "$OUT" "cd, pushd or popd" "the reason names the unresolvable cd"

test_case "GH 1602: a non-literal process call in an inline program gets its own reason"
OUT=$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'import subprocess' 'for n in range(3):' "    subprocess.run(['true', str(n)])")")")
assert_eq "deny" "$(decision "$OUT")" "swe: subprocess.run(['true', str(n)])"
assert_not_contains "$OUT" '$()' "not reported as a command substitution"
assert_contains "$OUT" "process call in an inline program" "the reason names the process call"

test_case "GH 1676: a write through an aliased or held write builtin gets its own reason"
ALIAS_WHY="is written through an aliased or stored write builtin the guard can't resolve; call open() (or the write method) directly with a literal path"
OUT=$(run "$WT" "swe" Bash "$(bash_cmd "python3 -c \"o=open; o('/etc/tmb-cg','w')\"")")
assert_eq "deny" "$(decision "$OUT")" "swe: python3 -c \"o=open; o(...)\""
assert_contains "$OUT" "$ALIAS_WHY" "the reason names the aliased write builtin"
assert_not_contains "$OUT" "process call" "not reported as a process call"
OUT=$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'writers = [open]' "writers[0]('/etc/tmb-cg', 'w')")")")
assert_eq "deny" "$(decision "$OUT")" "swe: open held in a list"
assert_contains "$OUT" "$ALIAS_WHY" "the reason names the held write builtin"
OUT=$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'import subprocess' 'f = subprocess.run' "f(['touch', '/etc/tmb-cg'])")")")
assert_eq "deny" "$(decision "$OUT")" "swe: a process function held in a variable"
assert_contains "$OUT" "process call in an inline program" "a process call keeps the process-call reason"
assert_not_contains "$OUT" "write builtin" "a process call is not reported as a write builtin"

test_case "GH 1687: a write through a held or aliased module-qualified write callable is denied as alias-write"
for prog in "import io|f = io.open|f('/etc/tmb-cg', 'w')" "import os|o = os.open|o('/etc/tmb-cg', os.O_WRONLY)" \
  "import shutil|m = shutil.move|m('a', '/etc/tmb-cg')" "import shutil|m = shutil.copy|m('a', '/etc/tmb-cg')" \
  "import shutil as s|m = s.move|m('a', '/etc/tmb-cg')" "from shutil import *|m = move|m('a', '/etc/tmb-cg')" \
  "import shutil|m = shutil . move|m('a', '/etc/tmb-cg')" "import shutil|m = getattr(shutil, 'move')|m('a', '/etc/tmb-cg')" \
  "m = __import__('shutil').move|m('a', '/etc/tmb-cg')" "o = __import__('io').open|o('/etc/tmb-cg', 'w')" \
  "s = __import__('shutil')|m = s.move|m('a', '/etc/tmb-cg')"; do
  IFS='|' read -r -a lines <<< "$prog"
  OUT=$(run "$WT" "swe" Bash "$(bash_cmd "$(py "${lines[@]}")")")
  assert_eq "deny" "$(decision "$OUT")" "swe: $prog"
  assert_contains "$OUT" "$ALIAS_WHY" "the reason names the held writer: $prog"
done
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'import shutil' "shutil.move('a.txt', 'b.txt')")")")")" "swe: a direct shutil.move inside the worktree"
assert_eq "allow" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py 'import shutil' "shutil.copy('a.txt', 'b.txt')")")")")" "swe: a direct shutil.copy inside the worktree"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py "__import__('shutil').move('a', '/etc/tmb-cg')")")")")" "swe: a direct __import__('shutil').move outside the worktree"
assert_eq "$(unproven)" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py "__import__('shutil').move('a.txt', 'b.txt')")")")")" "swe: a direct __import__('shutil').move inside the worktree"
for prog in 'import csv|for row in rows: print(row.open, row.close)' "import feedparser|for e in feedparser.parse('feed.xml').entries: print(e.link)" \
  'import argparse|args = argparse.ArgumentParser().parse_args()|print(args.rm)' "import pandas as pd|df = pd.read_csv('prices.csv')|print(df.open.mean())"; do
  IFS='|' read -r -a lines <<< "$prog"
  expect=allow
  [[ "$prog" == 'import csv'* ]] || expect=$(unproven)
  assert_eq "$expect" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd "$(py "${lines[@]}")")")")" "swe: an attribute read named like a writer: $prog"
done

# dispatched <gate> <tool> <tool_input-json> <tool_use_id> — <gate> through the
# real dispatcher on a swe payload of session s-1, from the worktree.
dispatched() {
  local payload
  payload=$(jq -nc --arg tool "$2" --argjson ti "$3" --arg id "$4" --arg cwd "$WT" --arg tr "$TRANSCRIPT" \
    '{hook_event_name:"PreToolUse", session_id:"s-1", cwd:$cwd, agent_type:"swe", agent_transcript_path:$tr,
      tool_name:$tool, tool_input:$ti, tool_use_id:$id}')
  (cd "$WT" && printf '%s' "$payload" | CLAUDE_PROJECT_DIR="$PROJECT" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_CONFIG_DIR="" \
    TMB_MODEL_CACHE_DIR="$CACHE" TMPDIR="$HOST_TMP" PATH="$SHIM:$PATH" \
    NODE_OPTIONS="--import $PLUGIN_ROOT/tests/lib/fake-uid.mjs" bash "$PLUGIN_ROOT/scripts/hooks/dispatch.sh" "$1" 2>/dev/null)
}
DENIES="$PROJECT/.claude/tmb/locks/boundary-denies"
bypasses() { sqlite3 -cmd ".timeout 5000" "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='hook_block_bypassed';"; }
UJ_FILE="$WT/src/uj.md"
UJ_COMPUTED=$(printf "python3 - <<'EOF'\nimport os\nopen(os.path.join('%s'), 'w').write('x')\nEOF" "$UJ_FILE")
UJ_PARSE=$(printf 'echo hi > %s; echo "unterminated' "$UJ_FILE")
UJ_UNPROVEN=$(printf "python3 -c \"import os; os.chmod('%s', 0o777)\"" "$UJ_FILE")

test_case "GH 1750: a cannot-be-judged Bash deny records no path, so the Edit it prescribes is no bypass"
for kind in computed parse unproven; do
  rm -rf "$DENIES"
  cmd=$UJ_COMPUTED
  [ "$kind" = parse ] && cmd=$UJ_PARSE
  [ "$kind" = unproven ] && cmd=$UJ_UNPROVEN
  before=$(bypasses)
  OUT=$(dispatched containment-guard Bash "$(bash_cmd "$cmd")" "tu-uj-$kind")
  assert_eq "deny" "$(decision "$OUT")" "\$($kind) through the dispatcher"
  assert_contains "$OUT" "cannot be judged: " "\$($kind): the cannot-be-judged reason"
  [ "$kind" = unproven ] && assert_contains "$OUT" "the inline program is unproven" "GH 1739: \$(unproven) names the program as unproven"
  [ ! -e "$DENIES" ] && _pass || _fail "\$($kind): a boundary-denies record was written"
  OUT=$(dispatched swe-boundary Edit "$(jq -nc --arg p "$UJ_FILE" '{file_path:$p, old_string:"a", new_string:"b"}')" "tu-uj-edit-$kind")
  assert_not_contains "$OUT" '"permissionDecision":"deny"' "\$($kind): the literal-path Edit is allowed"
  assert_not_contains "$OUT" "hook_block_bypassed" "\$($kind): no bypass context"
  assert_not_contains "$OUT" "hard stop" "\$($kind): no hard-stop message"
  assert_eq "$before" "$(bypasses)" "\$($kind): no hook_block_bypassed row"
done
rm -rf "$DENIES"
OUT=$(TMB_HOOKS_IMPL=bash dispatched containment-guard Bash "$(bash_cmd "$UJ_COMPUTED")" tu-uj-bash)
assert_eq "allow" "$(decision "$OUT")" "TMB_HOOKS_IMPL=bash: the .sh judges the literal path and allows"
[ ! -e "$DENIES" ] && _pass || _fail "TMB_HOOKS_IMPL=bash: a boundary-denies record was written"

test_case "GH 1750: a judged containment deny of a Bash write still records its path"
rm -rf "$DENIES"
OUT=$(dispatched containment-guard Bash "$(bash_cmd "touch $SANDBOX/judged.txt")" tu-judged)
assert_eq "deny" "$(decision "$OUT")" "outside the worktree"
assert_not_contains "$OUT" "cannot be judged" "a judged reason"
shopt -s nullglob
recs=("$DENIES/s-1/"*)
shopt -u nullglob
assert_eq "1" "${#recs[@]}" "one record for the judged path"
assert_eq "containment-guard" "$(sed -n 1p "${recs[0]:-/dev/null}")" "the record names the gate"
rm -rf "$DENIES"

UJ_EDIT=$(jq -nc --arg p "$UJ_FILE" '{file_path:$p, old_string:"a", new_string:"b"}')
test_case "GH 1772: an unresolved-target Bash deny records no path, so the literal Edit it prescribes is no bypass"
for case in 'deny|$UNKNOWN/f' "allow|$WT/src/\$1.yml"; do
  cg="${case%%|*}" target="${case#*|}"
  rm -rf "$DENIES"
  cmd="echo x > $UJ_FILE; cat > \"$target\" < /dev/null"
  before=$(bypasses)
  OUT=$(dispatched containment-guard Bash "$(bash_cmd "$cmd")" "tu-ur-cg-${#target}")
  assert_eq "$cg" "$(decision "$OUT")" "$target: containment-guard"
  [ "$cg" = allow ] || assert_contains "$OUT" "cannot be judged: " "$target: containment-guard's cannot-be-judged reason"
  OUT=$(dispatched swe-boundary Bash "$(bash_cmd "$cmd")" "tu-ur-sb-${#target}")
  assert_eq "deny" "$(decision "$OUT")" "$target: swe-boundary"
  assert_contains "$OUT" "cannot be judged: " "$target: swe-boundary's cannot-be-judged reason"
  [ ! -e "$DENIES" ] && _pass || _fail "$target: a boundary-denies record was written"
  OUT=$(dispatched swe-boundary Edit "$UJ_EDIT" "tu-ur-edit-${#target}")
  assert_not_contains "$OUT" '"permissionDecision":"deny"' "$target: the literal-path Edit is allowed"
  assert_not_contains "$OUT" "hook_block_bypassed" "$target: no bypass context"
  assert_eq "$before" "$(bypasses)" "$target: no hook_block_bypassed row"
done
rm -rf "$DENIES"
OUT=$(TMB_HOOKS_IMPL=bash dispatched containment-guard Bash "$(bash_cmd "echo x > $UJ_FILE; cat > \"\$UNKNOWN/f\" < /dev/null")" tu-ur-bash)
assert_contains "$OUT" "cannot be judged: " "TMB_HOOKS_IMPL=bash: the .sh's reason is unjudged too"
[ ! -e "$DENIES" ] && _pass || _fail "TMB_HOOKS_IMPL=bash: a boundary-denies record was written"

test_case "GH 1772: a judged deny of a literal target outside still records, and the later Edit is flagged"
rm -rf "$DENIES"
before=$(bypasses)
OUT=$(dispatched containment-guard Bash "$(bash_cmd "echo x > $UJ_FILE; touch $SANDBOX/judged.txt")" tu-ur-judged)
assert_eq "deny" "$(decision "$OUT")" "outside the worktree"
assert_not_contains "$OUT" "cannot be judged" "a judged reason"
OUT=$(dispatched swe-boundary Edit "$UJ_EDIT" tu-ur-judged-edit)
assert_contains "$OUT" "hook_block_bypassed" "the Edit after a judged deny is flagged"
assert_eq "$((before + 1))" "$(bypasses)" "one hook_block_bypassed row"
rm -rf "$DENIES"

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
