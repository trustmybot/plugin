#!/usr/bin/env bash
# Self-test for tests/l1-lint/legacy-reviewer-name.sh (GH 2134).
#
# On a git repo holding the real allowlist and every file that names the old
# reviewer, the lint passes, then fails once a new tracked file uses the old
# name, including one beside the exactly allowlisted research question.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

SB=$(cd "$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-legacy-reviewer-lint.XXXXXX")" && pwd -P)
trap 'rm -rf "$SB"' EXIT
REPO="$SB/repo"
LINT="$REPO/tests/l1-lint/legacy-reviewer-name.sh"

# Split so this test is not itself a hit for the lint it exercises.
OLD_NAME="pr-""reviewer"

copy_tracked() {
  mkdir -p "$REPO/$(dirname "$1")"
  cp "$PLUGIN_ROOT/$1" "$REPO/$1"
}

git init -q "$REPO"
while IFS= read -r hit; do
  copy_tracked "$hit"
done < <(git -C "$PLUGIN_ROOT" grep -il 'pr[-_]reviewer')
copy_tracked tests/l1-lint/legacy-reviewer-name.sh
copy_tracked tests/l1-lint/legacy-reviewer-name.allowlist
copy_tracked docs/reference/UPGRADE.md
git -C "$REPO" add -A

RC=0
OUT=""
lint() {
  RC=0
  OUT=$(bash "$LINT" 2>&1) || RC=$?
}

plant() {
  mkdir -p "$REPO/$(dirname "$1")"
  printf 'agent = "%s"\n' "$OLD_NAME" > "$REPO/$1"
  git -C "$REPO" add -- "$1"
}

unplant() {
  git -C "$REPO" rm -qf -- "$1"
}

test_case "every current hit is allowlisted"
lint
assert_exit_code 0 "$RC" "the lint passes on the real allowlist and hits"

test_case "a new file using the old name fails"
plant scripts/new-agent.sh
lint
assert_exit_code 1 "$RC" "a new tracked file is a hit"
assert_contains "$OUT" "legacy reviewer name in scripts/new-agent.sh" "the failure names the file"
unplant scripts/new-agent.sh

test_case "a file beside the allowlisted research question fails"
plant research/gh1346-ab/m3/other-questions.ts
lint
assert_exit_code 1 "$RC" "the research entry covers one exact file"
assert_contains "$OUT" "legacy reviewer name in research/gh1346-ab/m3/other-questions.ts" "the failure names the file"
unplant research/gh1346-ab/m3/other-questions.ts

summarize
