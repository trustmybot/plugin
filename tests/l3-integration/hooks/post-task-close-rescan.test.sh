#!/usr/bin/env bash
# Tests for scripts/maintenance/run-scan.mjs: verifies that the standalone
# rescan invoker derives session_dir from the trajectory.db walk-up, not
# process.cwd(). When cwd is a worktree path (inner subdir), the invoker
# must still find ≥1 repo under the workspace root.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
INVOKER="$PLUGIN_ROOT/scripts/maintenance/run-scan.mjs"

command -v node >/dev/null 2>&1 || { echo "SKIP: node not available"; exit 0; }
[ -f "$INVOKER" ] || { echo "SKIP: run-scan.mjs not found at $INVOKER"; exit 0; }

# Check that the dist build exists (run-scan.mjs imports from dist/).
DIST="$PLUGIN_ROOT/mcp/trajectory-server/dist/db.js"
[ -f "$DIST" ] || { echo "SKIP: dist not built ($DIST missing)"; exit 0; }

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# ── Fixture ──────────────────────────────────────────────────────────────────
# Workspace layout:
#   $WS/                        ← workspace root (holds the trajectory DB)
#     .claude/tmb/trajectory.db
#     repo-a/                   ← a real git repo with one tracked file
#     .claude/worktrees/wt-1/   ← simulated worktree (inner cwd)

WS="$TMPDIR/ws"
mkdir -p "$WS"

# Create a real git repo under the workspace.
REPO="$WS/repo-a"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email t@t.io
git -C "$REPO" config user.name t
echo "hello" > "$REPO/hello.txt"
git -C "$REPO" add .
git -C "$REPO" commit -qm init

# Create the DB at the workspace root (not inside the repo).
DB="$WS/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$DB")"
export TRAJECTORY_DB_PATH="$DB"

# Simulate a worktree path (inner subdir) as cwd.
WT="$WS/.claude/worktrees/wt-1"
mkdir -p "$WT"

# ── Test: rescan from worktree cwd finds ≥1 repo ─────────────────────────────
test_case "rescan from worktree cwd finds ≥1 repo (session_dir walk-up)"

# Run the invoker with cwd set to the worktree path (inner path).
# The invoker should walk up from the worktree, find the DB at WS, derive
# session_dir=$WS, and discover repo-a.
OUT=$( (cd "$WT" && node --experimental-sqlite "$INVOKER" 2>&1) || true )

# The invoker emits a summary line on stderr on success. Check for it.
if echo "$OUT" | grep -q "\[post-close-rescan\] OK"; then
  _pass
else
  _fail "invoker did not emit OK line. output: $OUT"
fi

# Verify the repos table has at least one row now.
REPO_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM repos;" 2>/dev/null || echo 0)
if [ "$REPO_COUNT" -ge 1 ]; then
  _pass
else
  _fail "expected ≥1 repo in DB after rescan, got $REPO_COUNT. invoker output: $OUT"
fi

test_case "rescan summary reports discovered repos"
if echo "$OUT" | grep -qE "discovered [0-9]+ repos"; then
  _pass
else
  _fail "expected 'discovered N repos' in output, got: $OUT"
fi

# ── Test: lock released after scan completes ─────────────────────────────────
test_case "lock file absent after normal rescan completion"
LOCK="$WS/.claude/tmb/scan.lock"
if [ -f "$LOCK" ]; then
  _fail "lock file still present after completed scan: $LOCK"
else
  _pass
fi

summarize
