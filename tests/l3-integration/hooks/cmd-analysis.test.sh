#!/usr/bin/env bash
# Unit tests: scripts/hooks/lib/cmd-analysis.sh — tmb_cmd_strip_literals,
# tmb_cmd_write_targets, tmb_path_canonical, tmb_cmd_statements,
# tmb_gh_mutation and the role / harness-turn / quoted-span helpers.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
. "$PLUGIN_ROOT/scripts/hooks/lib/cmd-analysis.sh"

targets() { tmb_cmd_write_targets "$(tmb_cmd_strip_literals "$1")" | tr '\n' ',' ; }

test_case "tmb_cmd_strip_literals drops heredoc bodies and neutralizes quoted operators"
assert_eq "cat <<EOF > out.txt|echo done" \
  "$(tmb_cmd_strip_literals "$(printf '%s\n' "cat <<'EOF' > out.txt" 'x > /tmp/z' 'EOF' 'echo done')" | paste -sd'|' -)" \
  "the heredoc body is gone, the operator line stays"
assert_eq "echo __/tmp/z" "$(tmb_cmd_strip_literals 'echo "> /tmp/z"')" "a quoted redirect is one word"
assert_eq "echo a___b >/tmp/q" "$(tmb_cmd_strip_literals "echo 'a > b' >/tmp/q")" "single quotes too; the real redirect stays"
assert_eq 'mkdir $TMB_MODEL_CACHE_DIR/x' "$(tmb_cmd_strip_literals 'mkdir "$TMB_MODEL_CACHE_DIR"/x')" "quotes removed around a variable"
assert_eq "grep x f " "$(tmb_cmd_strip_literals 'grep x f # > /tmp/c')" "comments dropped"
assert_eq "cat <<END" "$(tmb_cmd_strip_literals "$(printf 'cat <<-END\n\tbody > /tmp/z\n\tEND')")" "<<- strips leading tabs before the delimiter"

test_case "tmb_cmd_write_targets finds every write position"
# shellcheck disable=SC2088 # the unexpanded word is what the scanner must report
TILDE_TARGET='~/.claude/y'
assert_eq "${TILDE_TARGET}," "$(targets "echo hi > ${TILDE_TARGET}")" "redirect"
assert_eq "/dev/null,log.txt," "$(targets 'ls 2>/dev/null >>log.txt')" "fd redirect and append"
assert_eq "" "$(targets 'echo x 2>&1 >&2')" "fd duplications are not paths"
assert_eq "/tmp/both," "$(targets 'cmd &>/tmp/both')" "&> redirect"
assert_eq "/tmp/t1,out," "$(targets 'echo x | tee -a /tmp/t1 out')" "tee arguments"
assert_eq "/tmp/dest,/var/x," "$(targets 'cp a b /tmp/dest && mv -t /var/x f')" "cp destination, mv -t"
assert_eq "/opt/x," "$(targets 'FOO=1 sudo install -d /opt/x')" "assignments and sudo skipped; install -d"
assert_eq "" "$(targets 'rsync -a src/ host:/remote')" "a remote rsync destination is not local"
assert_eq "/tmp/foo*,a_b," "$(targets 'rm -rf /tmp/foo* ; touch "a b"')" "rm and touch arguments"
assert_eq "../wt," "$(targets 'git -C repo worktree add -b feat ../wt base')" "git worktree add path"
assert_eq "/tmp/clone," "$(targets 'git clone --depth 1 https://x/y.git /tmp/clone')" "git clone directory"
assert_eq "" "$(targets 'git clone https://x/y.git')" "git clone into cwd names no path"
assert_eq "" "$(targets 'cat ~/.claude.json; grep -r x /etc')" "reads name no write position"

test_case "tmb_cmd_write_targets treats every link as a write"
assert_eq "root/link,/outside," "$(targets 'ln -s /outside root/link')" "ln -s destination and absolute source"
assert_eq "build/y,build/../x,build/y/../x," "$(targets 'ln -sf ../x build/y')" "a relative ln -s source read against the link's directory"
assert_eq "b,a," "$(targets 'ln a b')" "hard link destination and source"
assert_eq "dir,dir/../a,/b," "$(targets 'ln -s -t dir ../a /b')" "ln -t directory and sources"
assert_eq "p,/etc/passwd," "$(targets 'link /etc/passwd p')" "link destination and source"
assert_eq "/o/f,here," "$(targets 'cp -s /o/f here')" "cp -s source and destination"
assert_eq "/o,d," "$(targets 'cp -al /o d')" "cp -l source and destination"
assert_eq "b," "$(targets 'cp a b')" "a plain cp names only its destination"

test_case "tmb_path_canonical"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
REAL=$(cd -P "$TMP" && pwd -P)
mkdir -p "$TMP/a"
ln -s "$TMP/a" "$TMP/link"
assert_eq "$REAL/a/new/file" "$(tmb_path_canonical "$TMP/link/new/file")" "symlinked ancestor resolved; missing tail kept"
assert_eq "$REAL/a" "$(tmb_path_canonical "$TMP/a/b/../.")" ". and .. resolved"
assert_eq "/" "$(tmb_path_canonical /)" "root"
mkdir -p "$TMP/outside/deep" "$TMP/root/a"
ln -s "$TMP/outside/deep" "$TMP/root/link"
ln -s ../outside/deep "$TMP/root/rel"
assert_eq "$REAL/outside/x" "$(tmb_path_canonical "$TMP/root/link/../x")" "a symlink is followed before .. applies"
assert_eq "$REAL/outside/deep/f" "$(tmb_path_canonical "$TMP/root/rel/f")" "a relative symlink resolves against its directory"
assert_eq "$REAL/root/b" "$(tmb_path_canonical "$TMP/root/a/../b")" "a legitimate .. without a symlink"
assert_eq "$REAL/root/a/new" "$(tmb_path_canonical "$TMP/root/missing/../a/new")" ".. collapses inside the missing tail"
assert_eq "$REAL/outside/y" "$(tmb_path_canonical "$TMP/root/missing/../link/../y")" "a link reached after the tail empties is still followed"

stmts() { tmb_cmd_statements "$1" "${2:-$PLAIN}" | tr '\t' '#' | paste -sd'|' - ; }
PLAIN="$TMP/plain"
mkdir -p "$PLAIN"

test_case "tmb_cmd_statements splits the skeleton into statements"
assert_eq "$PLAIN#git add .|$PLAIN#git commit -m x" "$(stmts 'git add . && git commit -m x')" "&&"
assert_eq "$PLAIN#a|$PLAIN#b|$PLAIN#c|$PLAIN#d" "$(stmts 'a; b || c & d')" "; || &"
assert_eq "$PLAIN#git log|$PLAIN#head -1" "$(stmts 'git log | head -1')" "pipe"
assert_eq "$PLAIN#a|$PLAIN#b" "$(stmts "$(printf 'a\nb')")" "newline"
assert_eq "$PLAIN#echo|$PLAIN#git status|$PLAIN#git log" "$(stmts 'echo $(git status) `git log`')" "\$( ) and backticks"
assert_eq "$PLAIN#true|$PLAIN#git status|$PLAIN#ls 2>&1|$PLAIN#grep x &>/dev/null" "$(stmts 'if true; then git status; fi; ls 2>&1 | grep x &>/dev/null')" "keywords dropped; fd redirects are not separators"
assert_eq "$PLAIN#git commit" "$(stmts 'FOO=1 sudo git commit')" "assignments and wrappers dropped"

test_case "tmb_cmd_statements treats heredoc bodies and quoted text as data"
HEREDOC_CMD=$(printf '%s\n' "cat > notes.md <<'EOF'" 'git commit -m x' 'gh pr merge 1' 'EOF')
assert_eq "$PLAIN#cat > notes.md <<EOF" "$(stmts "$HEREDOC_CMD")" "heredoc body is not a statement"
assert_eq "$PLAIN#python3 -c print_'gh_pr_merge_1'_" "$(stmts "python3 -c \"print('gh pr merge 1')\"")" "a python program is one word"
assert_eq "$PLAIN#echo git_commit_-m_x" "$(stmts 'echo "git commit -m x"')" "a quoted command is one word"
assert_contains "$(stmts 'bash -c "cd /w && git status"; eval "git log"')" "/w#git status" "bash -c body statement carries its cd"
assert_contains "$(stmts 'bash -c "cd /w && git status"; eval "git log"')" "$PLAIN#git log" "eval body statement"

test_case "tmb_cmd_statements effective dir"
assert_eq "/r/wt#git -C /r/wt commit" "$(stmts 'git -C /r/wt commit')" "git -C"
assert_eq "/r/wt#git -C wt commit" "$(stmts 'cd /r && git -C wt commit' | sed 's/^[^|]*|//')" "git -C relative to a cd"
assert_eq "/a#git commit" "$(stmts 'cd /a && git commit' | sed 's/^[^|]*|//')" "leading cd"
assert_eq "$PLAIN#git status|$PLAIN#cd /b|/b#git commit" "$(stmts 'git status; cd /b; git commit')" "mid-chain cd applies to later statements only"
assert_eq "$PLAIN/sub#git commit" "$(stmts 'cd sub && git commit' | sed 's/^[^|]*|//')" "relative cd joins the cwd"
assert_eq "/a#git log" "$(stmts 'cd /a && (cd /b && git x) && git log' | awk -F'|' '{print $NF}')" "a subshell cd does not leak"
assert_eq "-#git commit" "$(stmts 'cd "$WT" && git commit' | sed 's/^[^|]*|//')" "a variable path is unknown"
assert_eq "-#git commit" "$(stmts 'git commit' "$TMP/missing")" "no cwd → unknown"

REPO="$TMP/repo"
git init -q -b main "$REPO"
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
assert_eq "$REPO#git commit" "$(stmts 'git commit' "$REPO")" "cwd in a repo without worktrees is the dir"
git -C "$REPO" worktree add -q -b feat/x "$REPO/.claude/worktrees/x"
assert_eq "?#git commit" "$(stmts 'git commit' "$REPO")" "cwd in a repo with worktrees is ambiguous"
assert_eq "$REPO/.claude/worktrees/x#git commit" "$(stmts "cd $REPO/.claude/worktrees/x && git commit" "$REPO" | sed 's/^[^|]*|//')" "explicit cd resolves the ambiguity"
assert_eq "$(cd -P "$REPO" && pwd)" "$(tmb_stmt_repo_root '?' "$REPO")" "an ambiguous dir still names its repo"
assert_eq "$(cd -P "$REPO" && pwd)" "$(tmb_stmt_repo_root "$REPO/.claude/worktrees/x")" "a worktree's repo is the main checkout"
assert_eq "" "$(tmb_stmt_repo_root -)" "unknown dir names no repo"

test_case "tmb_git_subcommand / tmb_git_commit_message"
assert_eq "push origin main" "$(tmb_git_subcommand 'git -C /x -c a=b --no-pager push origin main')" "global options dropped"
assert_eq "" "$(tmb_git_subcommand 'gh pr create')" "not git"
assert_eq "✨ feat(x): a b" "$(tmb_git_commit_message 'cd /w && git commit -m "✨ feat(x): a b" -m body')" "first -m from argv"
assert_eq "fix: y" "$(tmb_git_commit_message "git commit -am 'fix: y'")" "-am"
assert_eq "" "$(tmb_git_commit_message "$HEREDOC_CMD")" "a heredoc mentioning git commit has no message"
assert_eq "" "$(tmb_git_commit_message 'git commit -m "$(cat <<EOF
feat: x
EOF
)"')" "a \$( ) message is not judged"

test_case "tmb_gh_mutation: gh api implied POST shapes"
ghm() { tmb_gh_mutation "$(tmb_cmd_strip_literals "$1")"; }
assert_eq "POST" "$(ghm "gh api graphql -f query='mutation { addComment(input: {}) { clientMutationId } }'")" "graphql -f query is a POST"
assert_eq "POST" "$(ghm "gh api graphql -f query='query { viewer { login } }'")" "a graphql read travels as a POST too"
assert_eq "POST" "$(ghm 'gh api graphql -F query=@q.graphql -F owner=o')" "graphql -F query=@file"
assert_eq "POST" "$(ghm 'gh api graphql --input body.json')" "graphql --input"
assert_eq "POST" "$(ghm 'gh api graphql --raw-field=query=x')" "graphql --raw-field="
assert_eq "" "$(ghm 'gh api graphql -X GET -f query=x')" "an explicit GET wins"
assert_eq "" "$(ghm 'gh api repos/o/r/pulls')" "a bare api path is a GET"

test_case "tmb_agent_role reads identity only"
assert_eq "swe" "$(tmb_agent_role '{"agent_type":"tmb:swe","cwd":"/r"}')" "prefixed agent_type"
assert_eq "bro" "$(tmb_agent_role '{"cwd":"/r/.claude/worktrees/x"}')" "no agent_type is the main thread, whatever the cwd"

test_case "tmb_is_harness_turn"
for framing in '<task-notification><task-id>1</task-id>' '[SYSTEM NOTIFICATION - NOT USER INPUT]' \
  'Another Claude session sent a message: hi' '[Subagent hand-back] report' \
  '<agent-message from="swe">done</agent-message>' '<cross-session-message from="x">y</cross-session-message>'; do
  if tmb_is_harness_turn "$framing"; then _pass; else _fail "not a harness turn: $framing"; fi
done
if tmb_is_harness_turn "port the parser to Rust"; then _fail "a Human prompt is not a harness turn"; else _pass; fi

test_case "tmb_strip_quoted_spans"
assert_eq "see   and   then" "$(tmb_strip_quoted_spans 'see `git push` and "push it" then')" "backticks and double quotes"
assert_eq "x   y" "$(tmb_strip_quoted_spans "x 'still open' y")" "single quotes"
assert_eq "let's keep users' words" "$(tmb_strip_quoted_spans "let's keep users' words")" "apostrophes are not quotes"
assert_eq 'an "unclosed quote' "$(tmb_strip_quoted_spans 'an "unclosed quote')" "an unclosed quote stays"

summarize
