#!/usr/bin/env bash
# Unit tests: scripts/hooks/lib/cmd-analysis.sh — tmb_cmd_strip_literals,
# tmb_cmd_write_targets and tmb_path_canonical.
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

summarize
