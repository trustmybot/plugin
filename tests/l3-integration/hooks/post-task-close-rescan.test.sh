#!/usr/bin/env bash
# Tests for scripts/maintenance/run-scan.mjs: verifies that the standalone
# rescan invoker derives session_dir from the trajectory.db walk-up, not
# process.cwd(). When cwd is a worktree path (inner subdir), the invoker
# must still find ≥1 repo under the workspace root. It needs an explicit
# TRAJECTORY_DB_PATH and never migrates; the post-task-close-rescan.sh hook
# supplies that path (GH 1639).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
. "$HERE/../../l5-l6/lib/timeout-shim.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
INVOKER="$PLUGIN_ROOT/scripts/maintenance/run-scan.mjs"

command -v node >/dev/null 2>&1 || { echo "SKIP: node not available"; exit 0; }
[ -f "$INVOKER" ] || { echo "SKIP: run-scan.mjs not found at $INVOKER"; exit 0; }

# Check that the dist build exists (run-scan.mjs imports from dist/).
DIST="$PLUGIN_ROOT/mcp/trajectory-server/dist/db.js"
[ -f "$DIST" ] || { echo "SKIP: dist not built ($DIST missing)"; exit 0; }

TMPDIR=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-post-task-close-rescan.XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT

# Scan shells out to `claude plugin list`; a stub keeps the run hermetic (the
# real CLI writes its own state under HOME).
mkdir -p "$TMPDIR/stub-bin"
printf '#!/usr/bin/env bash\necho "[]"\n' > "$TMPDIR/stub-bin/claude"
chmod +x "$TMPDIR/stub-bin/claude"
export PATH="$TMPDIR/stub-bin:$PATH"

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
node --experimental-sqlite --no-warnings --input-type=module \
  -e "const { TrajectoryDB } = await import('$DIST'); new TrajectoryDB(process.env.TRAJECTORY_DB_PATH).close();"

# Simulate a worktree path (inner subdir) as cwd.
WT="$WS/.claude/worktrees/wt-1"
mkdir -p "$WT"

# ── Test: rescan from worktree cwd finds ≥1 repo ─────────────────────────────
test_case "rescan from worktree cwd finds ≥1 repo (project root from the argument)"

# Run the invoker with cwd set to the worktree path (inner path) and the
# project root passed explicitly: it scans session_dir=$WS, not the cwd, and
# discovers repo-a.
# Hard timeout of 60s: if scan hangs (DB lock, git-log) the test
# fails loudly instead of stalling the entire runner.
OUT=$( (cd "$WT" && _l5_timeout 60 node --experimental-sqlite "$INVOKER" "$WS" 2>&1) || true )

# The invoker emits a summary line on stderr on success. Check for it.
if echo "$OUT" | grep "\[post-close-rescan\] OK" >/dev/null; then
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
if echo "$OUT" | grep -E "discovered [0-9]+ repos" >/dev/null; then
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

# ── Test: the invoker never discovers the DB itself (GH 1639) ────────────────
test_case "no TRAJECTORY_DB_PATH: exits 2 and scans nothing"
RC=0
NO_DB_OUT=$( (cd "$WT" && env -u TRAJECTORY_DB_PATH CLAUDE_PROJECT_DIR="$WS" node --experimental-sqlite "$INVOKER" "$WS" 2>&1) ) || RC=$?
if [ "$RC" -eq 2 ] && echo "$NO_DB_OUT" | grep "TRAJECTORY_DB_PATH is not set" >/dev/null; then
  _pass
else
  _fail "want exit 2 naming TRAJECTORY_DB_PATH, got exit $RC: $NO_DB_OUT"
fi

test_case "an older-schema DB: exits 1 with the refusal and stays unmigrated"
OLD_DB="$TMPDIR/old/trajectory.db"
mkdir -p "$(dirname "$OLD_DB")"
cp "$DB" "$OLD_DB"
sqlite3 "$OLD_DB" "UPDATE plugin_meta SET schema_version = schema_version - 1 WHERE id = 1;"
OLD_VERSION=$(sqlite3 "$OLD_DB" "SELECT schema_version FROM plugin_meta WHERE id = 1;")
RC=0
OLD_OUT=$( (cd "$WT" && TRAJECTORY_DB_PATH="$OLD_DB" node --experimental-sqlite "$INVOKER" "$WS" 2>&1) ) || RC=$?
if [ "$RC" -eq 1 ] && echo "$OLD_OUT" | grep "only the trajectory-server migrates the DB" >/dev/null \
  && [ "$(sqlite3 "$OLD_DB" "SELECT schema_version FROM plugin_meta WHERE id = 1;")" = "$OLD_VERSION" ] \
  && [ -z "$(find "$(dirname "$OLD_DB")" -name '*.bak')" ]; then
  _pass
else
  _fail "want exit 1, the refusal, v$OLD_VERSION kept and no .bak; got exit $RC: $OLD_OUT"
fi

# A rollback-journal DB must not be switched to WAL on the way to the refusal (GH 1679).
DELETE_DB="$TMPDIR/old-delete/trajectory.db"
mkdir -p "$(dirname "$DELETE_DB")"
cp "$OLD_DB" "$DELETE_DB"
sqlite3 "$DELETE_DB" "PRAGMA journal_mode = DELETE;" >/dev/null
# macOS sqlite3 keeps the -shm it opened the WAL copy with; the fixture starts without it.
rm -f "$DELETE_DB-shm" "$DELETE_DB-wal"
cp "$DELETE_DB" "$TMPDIR/old-delete.pristine"
for SCRIPT in "$INVOKER" "$PLUGIN_ROOT/scripts/maintenance/run-scan-initial.mjs" "$PLUGIN_ROOT/mcp/trajectory-server/scripts/smoke-world-model.mjs"; do
  test_case "a delete-mode older-schema DB: $(basename "$SCRIPT") exits non-zero and leaves it byte-identical"
  RC=0
  SCRIPT_OUT=$( (cd "$WT" && TRAJECTORY_DB_PATH="$DELETE_DB" node --experimental-sqlite "$SCRIPT" "$WS" 2>&1) ) || RC=$?
  SIDECARS=$(find "$(dirname "$DELETE_DB")" -type f ! -name trajectory.db)
  if [ "$RC" -ne 0 ] && cmp -s "$TMPDIR/old-delete.pristine" "$DELETE_DB" && [ -z "$SIDECARS" ]; then
    _pass
  else
    _fail "want non-zero exit, an unchanged DB and no sidecar files; got exit $RC, sidecars: [$SIDECARS], output: $SCRIPT_OUT"
  fi
done

# ── Hook: post-task-close-rescan.sh hands the invoker an explicit DB path ────
# A fake plugin tree whose run-scan.mjs records the TRAJECTORY_DB_PATH it got.
FAKE="$TMPDIR/fake-plugin/scripts"
mkdir -p "$FAKE/hooks/lib" "$FAKE/maintenance"
cp "$PLUGIN_ROOT/scripts/hooks/post-task-close-rescan.sh" "$FAKE/hooks/"
cp "$PLUGIN_ROOT/scripts/hooks/lib/query-task.sh" "$FAKE/hooks/lib/"
RECORD="$TMPDIR/invoker-db-path"
cat > "$FAKE/maintenance/run-scan.mjs" <<'FAKEINV'
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.RECORD_PATH, process.env.TRAJECTORY_DB_PATH ?? '<unset>');
FAKEINV
CLOSE_EVENT='{"tool_name":"mcp__plugin_tmb_trajectory-server__bro_atomic_close"}'

run_fake_hook() {
  printf '%s' "$1" | (cd "$WT" && env -u TRAJECTORY_DB_PATH -u CLAUDE_PLUGIN_ROOT -u TMB_SKIP_AUTO_RESCAN \
    CLAUDE_PROJECT_DIR="$WS" TMB_FORBID_LIVE_SYNC=1 RECORD_PATH="$RECORD" bash "$FAKE/hooks/post-task-close-rescan.sh")
  for _ in $(seq 1 50); do [ -f "$RECORD" ] && break; sleep 0.1; done
}

test_case "hook passes the resolved DB as TRAJECTORY_DB_PATH"
rm -f "$RECORD"
run_fake_hook "$CLOSE_EVENT"
if [ -f "$RECORD" ] && [ "$(cat "$RECORD")" = "$DB" ]; then
  _pass
else
  _fail "invoker got '$(cat "$RECORD" 2>/dev/null || echo '<not run>')', want $DB"
fi

test_case "hook ignores other tools"
rm -f "$RECORD"
printf '%s' '{"tool_name":"mcp__plugin_tmb_trajectory-server__task_get"}' | (cd "$WT" && env -u TRAJECTORY_DB_PATH \
  CLAUDE_PROJECT_DIR="$WS" TMB_FORBID_LIVE_SYNC=1 RECORD_PATH="$RECORD" bash "$FAKE/hooks/post-task-close-rescan.sh")
sleep 0.3
if [ -f "$RECORD" ]; then _fail "invoker ran for a non-close tool"; else _pass; fi

summarize
