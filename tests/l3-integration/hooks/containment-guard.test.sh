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
HOST_TMP="$SANDBOX/host-tmp"
mkdir -p "$WT/src" "$(dirname "$DB")" "$CACHE" "$HOST_TMP"
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
   printf '%s' "$payload" | CLAUDE_PROJECT_DIR="${5:-$PROJECT}" CLAUDE_CONFIG_DIR="" TMB_MODEL_CACHE_DIR="$CACHE" TMPDIR="$HOST_TMP" bash "$HOOK" 2>&1)
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
assert_eq "deny" "$(decision "$(run "$WT" "pr-reviewer" Write "$(write "$HOME/.claude/plans/x.md")")")" "pr-reviewer Write to a plan"

test_case "every denial wrote an audit row"
assert_eq "$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='containment_denied';")" "$(denials)" "all rows from hook:containment-guard"
assert_eq "27" "$(denials)" "one row per denial above"

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

test_case "GH 1279: variable-held write targets"
OUT=$(run "$PROJECT" "" Bash "$(bash_cmd 'cat > "$UNKNOWN/f"')")
assert_eq "deny" "$(decision "$OUT")" "bro \$UNKNOWN/f"
assert_contains "$OUT" 'write target \"$UNKNOWN/f\" depends on a variable the guard cannot resolve in this command' "the reason names the variable"
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd 'OUT=/etc/tmb-cg; cat > "$OUT"')")")" "a variable set to a path outside the root"
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd "OUT=$PROJECT/notes.txt; cat > \"\$OUT\"")")")" "a variable set to a path inside the root"
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd 'D=build; mkdir -p "$D/out"')")")" "a relative variable resolves against the cwd"
assert_eq "allow" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd 'touch "build/$UNKNOWN"')")")" "the literal dir before an unknown variable is inside the root"
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd 'touch "/tmp/tmb-cg/$UNKNOWN"')")")" "the literal dir before an unknown variable is outside the root"
assert_eq "deny" "$(decision "$(run "$WT" "swe" Bash "$(bash_cmd 'OUT=$(mktemp); cat > "$OUT"')")")" "a value built by \$( ) is unresolvable"

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
assert_eq "deny" "$(decision "$(run "$PROJECT" "" Bash "$(bash_cmd 'cat > "$(mktemp)"')")")" "cat > \$(mktemp)"
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
