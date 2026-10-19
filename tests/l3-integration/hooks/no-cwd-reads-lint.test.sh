#!/usr/bin/env bash
# Self-test for tests/l1-lint/no-cwd-reads.sh (GH 1553).
#
# On planted fixture roots, the lint fails on a process.cwd(), a $PWD, a bare
# `git status`, a spawnSync with no cwd, a stale allowlist entry and an entry
# with no reason or an unknown category; it passes on the self-location form,
# git -C, a spawn with cwd and an allowlisted line. On a copy of the plugin's
# scanned dirs it passes untouched and fails on an injected $PWD or payload
# .cwd read in a hook.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
LINT="$PLUGIN_ROOT/tests/l1-lint/no-cwd-reads.sh"
ALLOW="$PLUGIN_ROOT/tests/l1-lint/cwd-allowlist.tsv"

SB=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$SB"' EXIT
export TRAJECTORY_DB_PATH="$SB/no-such.db"

# fixture <name> <rel path> <line> — a root holding one file with <line>, and
# an empty allow.tsv beside it; prints the root.
fixture() {
  local r="$SB/$1"
  mkdir -p "$r/$(dirname "$2")"
  printf '%s\n' "$3" > "$r/$2"
  : > "$r/allow.tsv"
  printf '%s' "$r"
}

RC=0
OUT=""
lint() {
  RC=0
  OUT=$(bash "$LINT" "$1" "${2:-$1/allow.tsv}" 2>&1) || RC=$?
}

test_case "the plugin tree passes"
lint "$PLUGIN_ROOT" "$ALLOW"
assert_exit_code 0 "$RC" "no-cwd-reads passes on the plugin with cwd-allowlist.tsv"

test_case "a planted process.cwd() fails"
R=$(fixture ts-cwd mcp/trajectory-server/src/root.ts 'const root = process.cwd();')
lint "$R"
assert_exit_code 1 "$RC" "process.cwd() is a hit"
assert_contains "$OUT" "mcp/trajectory-server/src/root.ts:1 reads process.cwd()" "the failure names the file and line"

test_case "a planted \$PWD fails"
R=$(fixture sh-pwd scripts/root.sh 'ROOT="$PWD"')
lint "$R"
assert_exit_code 1 "$RC" "\$PWD is a hit"
assert_contains "$OUT" "scripts/root.sh:1 reads the cwd" "the failure names the file and line"

test_case "a bare git status fails; git -C passes"
R=$(fixture sh-git scripts/st.sh 'git status --porcelain')
lint "$R"
assert_exit_code 1 "$RC" "a git command with no -C is a hit"
assert_contains "$OUT" "scripts/st.sh:1 runs git with no -C" "the failure names the file and line"
R=$(fixture sh-git-c scripts/st.sh 'git -C "$REPO" status --porcelain')
lint "$R"
assert_exit_code 0 "$RC" "git -C <repo> passes"
R=$(fixture sh-git-msg scripts/msg.sh 'echo "BLOCKED: run git status in the worktree" >&2')
lint "$R"
assert_exit_code 0 "$RC" "git named inside a quoted message passes"

test_case "a spawnSync with no cwd fails; one with cwd passes"
R=$(fixture ts-spawn mcp/trajectory-server/src/run.ts "const r = spawnSync('x', []);")
lint "$R"
assert_exit_code 1 "$RC" "spawnSync with no cwd is a hit"
assert_contains "$OUT" "mcp/trajectory-server/src/run.ts:1 spawns with no cwd" "the failure names the file and line"
R=$(fixture ts-spawn-cwd mcp/trajectory-server/src/run.ts "const r = spawnSync('x', [], { cwd: root });")
lint "$R"
assert_exit_code 0 "$RC" "spawnSync with cwd passes"

test_case "the self-location form passes"
R=$(fixture sh-self scripts/self.sh 'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"')
lint "$R"
assert_exit_code 0 "$RC" "cd \"\$(dirname …)\" && pwd is exempt"

test_case "an allowlisted line passes"
R=$(fixture sh-allowed scripts/scan.sh 'DIR="${1:-$PWD}"')
printf 'scripts/scan.sh\tDIR="${1:-$PWD}"\tfallback\tonly a manual run with no argument\n' > "$R/allow.tsv"
lint "$R"
assert_exit_code 0 "$RC" "a hit matched by an entry passes"

test_case "a stale allowlist entry fails"
R=$(fixture stale scripts/clean.sh 'echo ok')
printf 'scripts/clean.sh\tDIR="${1:-$PWD}"\tfallback\tremoved long ago\n' > "$R/allow.tsv"
lint "$R"
assert_exit_code 1 "$RC" "an entry matching no hit fails"
assert_contains "$OUT" "stale entry" "the failure names the stale entry"

test_case "an entry with no reason or an unknown category fails"
R=$(fixture no-reason scripts/scan.sh 'DIR="${1:-$PWD}"')
printf 'scripts/scan.sh\tDIR="${1:-$PWD}"\tfallback\n' > "$R/allow.tsv"
lint "$R"
assert_exit_code 1 "$RC" "an entry with no reason fails"
printf 'scripts/scan.sh\tDIR="${1:-$PWD}"\twhatever\tsome reason\n' > "$R/allow.tsv"
lint "$R"
assert_exit_code 1 "$RC" "an entry with an unknown category fails"
assert_contains "$OUT" "has category 'whatever'" "the failure names the category"

test_case "a copy of the plugin passes; an injected hook read fails"
M="$SB/mirror"
mkdir -p "$M/mcp/trajectory-server" "$M/tests"
cp -R "$PLUGIN_ROOT/scripts" "$PLUGIN_ROOT/skills" "$M/"
cp -R "$PLUGIN_ROOT/mcp/trajectory-server/src" "$M/mcp/trajectory-server/"
cp -R "$PLUGIN_ROOT/tests/lib" "$M/tests/"
lint "$M" "$ALLOW"
assert_exit_code 0 "$RC" "the lint passes on an unmodified copy"
HOOKS="$M/scripts/hooks"
printf '%s\n' 'case "$PWD" in */.claude/worktrees/*) WT="${PWD%%/.claude/worktrees/*}" ;; esac' >> "$HOOKS/swe-boundary.sh"
lint "$M" "$ALLOW"
assert_exit_code 1 "$RC" "the lint fails on an injected \$PWD read"
assert_contains "$OUT" "swe-boundary.sh" "the failure names the file"
cp "$PLUGIN_ROOT/scripts/hooks/swe-boundary.sh" "$HOOKS/swe-boundary.sh"
printf '%s\n' 'ROOT=$(jq -r .cwd <<<"$INPUT")' >> "$HOOKS/containment-guard.sh"
lint "$M" "$ALLOW"
assert_exit_code 1 "$RC" "the lint fails on the payload .cwd as a root"
assert_contains "$OUT" "containment-guard.sh" "the failure names the file"

summarize
