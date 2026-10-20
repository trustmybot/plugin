#!/usr/bin/env bash
# Tests for tests/l1-lint/prompt-explicit-paths.sh: a planted relative
# `.claude/` path and a planted bare `git push` fail the lint; the anchored
# forms `<project>/.claude/...` and `git -C <repo path> push` pass.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
set +e
LINT="$HERE/../../l1-lint/prompt-explicit-paths.sh"

WORK=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-prompt-explicit-paths-lint.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# plant <dir> <relative file> <line> — a one-file plugin tree with <line>.
plant() {
  local dir="$WORK/$1"
  mkdir -p "$(dirname "$dir/$2")"
  printf -- '---\nname: x\n---\n\n%s\n' "$3" > "$dir/$2"
  printf '%s' "$dir"
}

run_lint() {
  out=$(bash "$LINT" "$1" 2>&1)
  rc=$?
}

test_case "a relative .claude/ path in a command fails"
run_lint "$(plant rel-claude commands/x.md 'Write the file to `.claude/x`.')"
assert_eq 1 "$rc" "exit code"
assert_contains "$out" "commands/x.md:5: relative .claude/ path" "names file and line"

test_case "a bare git push in a skill fails"
run_lint "$(plant bare-push skills/tmb_x/SKILL.md 'Then `git push origin <feature>`.')"
assert_eq 1 "$rc" "exit code"
assert_contains "$out" "skills/tmb_x/SKILL.md:5: git command without -C" "names file and line"

test_case "bare git switch, checkout and pull in an agent fail"
run_lint "$(plant bare-verbs agents/a.md 'Run `git switch dev`, `git checkout -b x` and `git pull --ff-only`.')"
assert_eq 1 "$rc" "exit code"
assert_contains "$out" "agents/a.md:5: git command without -C" "names file and line"

test_case "<project>/.claude/x passes"
run_lint "$(plant anchored-claude commands/x.md 'Write the file to `<project>/.claude/x`, `~/.claude/y` or `$HOME/.claude/z`.')"
assert_eq 0 "$rc" "exit code"

test_case "git -C <repo path> push passes"
run_lint "$(plant anchored-push skills/tmb_x/SKILL.md 'Then `git -C <repo path> push origin <feature>` and `git -C <repo path> pull --ff-only`.')"
assert_eq 0 "$rc" "exit code"

test_case "the shipped prompts pass"
run_lint "$(cd "$HERE/../../.." && pwd)"
assert_eq 0 "$rc" "exit code"

summarize
