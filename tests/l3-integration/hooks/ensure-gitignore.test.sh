#!/usr/bin/env bash
# Tests for scripts/hooks/ensure-gitignore.sh.
# Hook contract: SessionStart hook ensures .claude/ is in repo's .gitignore.
# Creates .gitignore if missing; appends if rule absent; idempotent if present.
# Silent no-op when not in a git repo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/ensure-gitignore.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
# Pin the project so the hook never resolves one by walking up from the cwd.
export CLAUDE_PROJECT_DIR="$TMPDIR"

run_in_repo() {
  local repo="$1"
  (cd "$repo" && echo '{}' | CLAUDE_PROJECT_DIR="$repo" bash "$HOOK" 2>&1 || true)
}

test_case "not a git repo: silent no-op"
mkdir -p "$TMPDIR/notrepo"
out=$(run_in_repo "$TMPDIR/notrepo")
assert_eq "" "$out" "silent outside git"
[ ! -f "$TMPDIR/notrepo/.gitignore" ] || { echo "FAIL: created .gitignore outside repo"; exit 1; }

test_case "fresh repo, no .gitignore: creates one with .claude/"
REPO="$TMPDIR/repo1"
mkdir -p "$REPO" && (cd "$REPO" && git init -q -b main)
run_in_repo "$REPO" >/dev/null
[ -f "$REPO/.gitignore" ] || { echo "FAIL: .gitignore not created"; exit 1; }
grep -q '^\.claude/$' "$REPO/.gitignore" || { echo "FAIL: .claude/ not in .gitignore"; exit 1; }
echo "  ✓ created with .claude/"

test_case "existing .gitignore without .claude/: appends"
REPO="$TMPDIR/repo2"
mkdir -p "$REPO" && (cd "$REPO" && git init -q -b main)
printf 'node_modules/\ndist/\n' > "$REPO/.gitignore"
run_in_repo "$REPO" >/dev/null
grep -q '^\.claude/$' "$REPO/.gitignore" || { echo "FAIL: .claude/ not appended"; exit 1; }
grep -q '^node_modules/$' "$REPO/.gitignore" || { echo "FAIL: existing entries removed"; exit 1; }
echo "  ✓ appended without disturbing existing entries"

test_case "existing .gitignore WITH .claude/: idempotent no-op"
REPO="$TMPDIR/repo3"
mkdir -p "$REPO" && (cd "$REPO" && git init -q -b main)
printf 'node_modules/\n.claude/\ndist/\n' > "$REPO/.gitignore"
before_md5=$(md5 -q "$REPO/.gitignore" 2>/dev/null || md5sum "$REPO/.gitignore" | awk '{print $1}')
run_in_repo "$REPO" >/dev/null
after_md5=$(md5 -q "$REPO/.gitignore" 2>/dev/null || md5sum "$REPO/.gitignore" | awk '{print $1}')
assert_eq "$before_md5" "$after_md5" "file unchanged when rule already present"

test_case "existing .gitignore with bare .claude (no slash): idempotent"
REPO="$TMPDIR/repo4"
mkdir -p "$REPO" && (cd "$REPO" && git init -q -b main)
printf '.claude\n' > "$REPO/.gitignore"
before_md5=$(md5 -q "$REPO/.gitignore" 2>/dev/null || md5sum "$REPO/.gitignore" | awk '{print $1}')
run_in_repo "$REPO" >/dev/null
after_md5=$(md5 -q "$REPO/.gitignore" 2>/dev/null || md5sum "$REPO/.gitignore" | awk '{print $1}')
assert_eq "$before_md5" "$after_md5" "matches both .claude/ and .claude variants"

test_case "GH 1550: the project and its registered repos, never the cwd's repo"
WS="$TMPDIR/ws"
SVC="$TMPDIR/elsewhere/svc"
CWD_REPO="$TMPDIR/cwd-repo"
mkdir -p "$WS/.claude/tmb" "$SVC" "$CWD_REPO"
(cd "$WS" && git init -q -b main)
(cd "$SVC" && git init -q -b main)
(cd "$CWD_REPO" && git init -q -b main)
sqlite3 "$WS/.claude/tmb/trajectory.db" "CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL); INSERT INTO repos VALUES ('svc', '$SVC');"
(cd "$CWD_REPO" && echo '{}' | CLAUDE_PROJECT_DIR="$WS" TRAJECTORY_DB_PATH="$WS/.claude/tmb/trajectory.db" bash "$HOOK" >/dev/null 2>&1 || true)
assert_eq "yes" "$(grep -qxF '.claude/' "$WS/.gitignore" 2>/dev/null && echo yes || echo no)" "the project's repo"
assert_eq "yes" "$(grep -qxF '.claude/' "$SVC/.gitignore" 2>/dev/null && echo yes || echo no)" "a registered repo outside the project"
assert_eq "no" "$([ -f "$CWD_REPO/.gitignore" ] && echo yes || echo no)" "the cwd's repo is untouched"

test_case "GH 1553: a relative repos.path resolves against the project root"
mkdir -p "$WS/rel"
(cd "$WS/rel" && git init -q -b main)
sqlite3 "$WS/.claude/tmb/trajectory.db" "INSERT INTO repos VALUES ('rel', 'rel');"
(cd "$CWD_REPO" && echo '{}' | CLAUDE_PROJECT_DIR="$WS" TRAJECTORY_DB_PATH="$WS/.claude/tmb/trajectory.db" bash "$HOOK" >/dev/null 2>&1 || true)
assert_eq "yes" "$(grep -qxF '.claude/' "$WS/rel/.gitignore" 2>/dev/null && echo yes || echo no)" "<project>/rel, not <project>/.claude/tmb/rel"

summarize
