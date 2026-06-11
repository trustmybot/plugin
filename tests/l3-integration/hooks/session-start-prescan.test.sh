#!/usr/bin/env bash
# Tests for scripts/hooks/session-start-prescan.sh.
# Covers: output is valid JSON, additionalContext is emitted, cache-friendly
# ordering, cold-session auto-scan launch, bypass env, and warm-session path.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/session-start-prescan.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
DB="$TMPDIR/trajectory.db"

export TRAJECTORY_DB_PATH="$DB"

sqlite3 "$DB" "
  CREATE TABLE issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    objective TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO issues (objective, status) VALUES ('test issue', 'open');
  INSERT INTO tasks (issue_id, status) VALUES (1, 'pending');
"

run_hook() {
  bash "$HOOK" 2>/dev/null || true
}

OUT=$(run_hook)

# ---- basic output shape ----

test_case "hook emits non-empty output"

# Check output is non-empty
if [ -z "$OUT" ]; then
  _fail "hook produced empty output"
else
  _pass
fi

test_case "output is valid JSON"
if echo "$OUT" | jq . >/dev/null 2>&1; then
  _pass
else
  _fail "output is not valid JSON: $OUT"
fi

test_case "output contains hookSpecificOutput"
assert_contains "$OUT" "hookSpecificOutput" "JSON has hookSpecificOutput"

test_case "output contains SessionStart event"
assert_contains "$OUT" "SessionStart" "JSON has SessionStart"

test_case "additionalContext is a string"
ctx_type=$(echo "$OUT" | jq -r '.hookSpecificOutput.additionalContext | type' 2>/dev/null || echo "MISSING")
assert_eq "string" "$ctx_type" "additionalContext type"

CTX=$(echo "$OUT" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || echo "")

# ---- stable markers present ----

test_case "stable: Top-level dirs line present"
assert_contains "$CTX" "Top-level dirs:" "Top-level dirs line present"

test_case "stable: Stacks detected line present"
assert_contains "$CTX" "Stacks detected:" "Stacks detected line present"

test_case "stable: Architecture docs line present"
assert_contains "$CTX" "Architecture docs:" "Architecture docs line present"

test_case "stable: World model line present"
assert_contains "$CTX" "World model:" "World model line present"

# ---- volatile markers present ----

test_case "volatile: Git branch line present"
assert_contains "$CTX" "Git branch:" "Git branch line present"

test_case "volatile: Open issues line present"
assert_contains "$CTX" "Open issues:" "Open issues line present"

test_case "volatile: Pending tasks line present"
assert_contains "$CTX" "Pending tasks:" "Pending tasks line present"

test_case "volatile: Last 5 commits present"
assert_contains "$CTX" "Last 5 commits:" "Last 5 commits line present"

# ---- cache-friendly ordering: stable before volatile ----
# Strategy: find the byte-offset of a stable marker and a volatile marker;
# assert stable_offset < volatile_offset.

stable_marker="Top-level dirs:"
volatile_marker="Git branch:"

stable_pos=$(echo "$CTX" | grep -b -o "$stable_marker" 2>/dev/null | head -1 | cut -d: -f1 || echo "")
volatile_pos=$(echo "$CTX" | grep -b -o "$volatile_marker" 2>/dev/null | head -1 | cut -d: -f1 || echo "")

test_case "ordering: 'Top-level dirs' (stable) appears before 'Git branch' (volatile)"
if [ -z "$stable_pos" ] || [ -z "$volatile_pos" ]; then
  _fail "could not locate markers: stable_pos=<$stable_pos> volatile_pos=<$volatile_pos>"
elif [ "$stable_pos" -lt "$volatile_pos" ]; then
  _pass
else
  _fail "stable marker at byte $stable_pos should be before volatile marker at byte $volatile_pos"
fi

test_case "ordering: 'World model' (stable) appears before 'Open issues' (volatile)"
wm_pos=$(echo "$CTX" | grep -b -o "World model:" 2>/dev/null | head -1 | cut -d: -f1 || echo "")
oi_pos=$(echo "$CTX" | grep -b -o "Open issues:" 2>/dev/null | head -1 | cut -d: -f1 || echo "")
if [ -z "$wm_pos" ] || [ -z "$oi_pos" ]; then
  _fail "could not locate markers: wm_pos=<$wm_pos> oi_pos=<$oi_pos>"
elif [ "$wm_pos" -lt "$oi_pos" ]; then
  _pass
else
  _fail "world-model marker at byte $wm_pos should be before open-issues marker at byte $oi_pos"
fi

# ---- no-DB graceful exit ----

test_case "missing DB: hook exits silently (no output)"
rm -f "$DB"
out_no_db=$(bash "$HOOK" 2>/dev/null || true)
assert_eq "" "$out_no_db" "no output when DB missing"

# Re-create DB for the remaining cold/warm tests.
sqlite3 "$DB" "
  CREATE TABLE issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    objective TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO issues (objective, status) VALUES ('test issue', 'open');
  INSERT INTO tasks (issue_id, status) VALUES (1, 'pending');
"

# ---- cold session: auto-scan fires ----
# Build a fake invoker that records its invocation without actually running a scan.
FAKE_INVOKER_DIR="$TMPDIR/fake-maintenance"
mkdir -p "$FAKE_INVOKER_DIR"
INVOCATION_FLAG="$TMPDIR/invoked"
cat > "$FAKE_INVOKER_DIR/run-scan-initial.mjs" <<'FAKE'
#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
// Record invocation and exit cleanly.
writeFileSync(process.env.INVOCATION_FLAG, '1');
FAKE

# Build a fake scripts tree: hooks/, maintenance/, and scan.sh (availability sentinel).
FAKE_SCRIPTS="$TMPDIR/fake-scripts"
mkdir -p "$FAKE_SCRIPTS/hooks"
mkdir -p "$FAKE_SCRIPTS/maintenance"
cp "$PLUGIN_ROOT/scripts/hooks/session-start-prescan.sh" "$FAKE_SCRIPTS/hooks/session-start-prescan.sh"
cp "$FAKE_INVOKER_DIR/run-scan-initial.mjs" "$FAKE_SCRIPTS/maintenance/run-scan-initial.mjs"
# Provide a stub scan.sh so the hook's availability check passes.
echo '#!/usr/bin/env bash' > "$FAKE_SCRIPTS/scan.sh"
chmod +x "$FAKE_SCRIPTS/scan.sh"
FAKE_HOOK="$FAKE_SCRIPTS/hooks/session-start-prescan.sh"

test_case "cold + invoker present: context says scan started"
rm -f "$INVOCATION_FLAG"
COLD_OUT=$(TRAJECTORY_DB_PATH="$DB" INVOCATION_FLAG="$INVOCATION_FLAG" TMB_SKIP_AUTO_PRESCAN=0 bash "$FAKE_HOOK" 2>/dev/null || true)
COLD_CTX=$(echo "$COLD_OUT" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || echo "")
assert_contains "$COLD_CTX" "scan is running in the background" "cold context mentions background scan"

test_case "cold + invoker present: scan process was invoked"
# Give the background node process a moment to write the flag.
sleep 0.5
if [ -f "$INVOCATION_FLAG" ]; then
  _pass
else
  _fail "fake invoker was not called (flag missing at $INVOCATION_FLAG)"
fi

test_case "cold + invoker present: no Human-directed /scan instruction"
assert_not_contains "$COLD_CTX" "tell the Human to run /scan" "no manual scan instruction"

# ---- cold + TMB_SKIP_AUTO_PRESCAN=1: warn only, no invocation ----

test_case "cold + TMB_SKIP_AUTO_PRESCAN=1: context says world model is cold"
rm -f "$INVOCATION_FLAG"
SKIP_OUT=$(TRAJECTORY_DB_PATH="$DB" TMB_SKIP_AUTO_PRESCAN=1 bash "$FAKE_HOOK" 2>/dev/null || true)
SKIP_CTX=$(echo "$SKIP_OUT" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || echo "")
assert_contains "$SKIP_CTX" "cold" "skip context mentions cold"

test_case "cold + TMB_SKIP_AUTO_PRESCAN=1: invoker not called"
sleep 0.2
if [ -f "$INVOCATION_FLAG" ]; then
  _fail "invoker was called despite TMB_SKIP_AUTO_PRESCAN=1"
else
  _pass
fi

test_case "cold + TMB_SKIP_AUTO_PRESCAN=1: no background scan message"
assert_not_contains "$SKIP_CTX" "scan is running in the background" "no background scan message when bypassed"

# ---- warm session: no scan, no cold note ----
# Run in $TMPDIR (not the live repo) so git output is empty and cannot
# contain commit messages with "world model is cold" text.

test_case "warm: context shows warm world model"
sqlite3 "$DB" "INSERT INTO audit (event_type) VALUES ('deep_scan_completed');"
WARM_OUT=$(cd "$TMPDIR" && TRAJECTORY_DB_PATH="$DB" bash "$FAKE_HOOK" 2>/dev/null || true)
WARM_CTX=$(echo "$WARM_OUT" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || echo "")
assert_contains "$WARM_CTX" "warm" "warm context shows warm"

test_case "warm: no background scan note in context"
assert_not_contains "$WARM_CTX" "scan is running in the background" "no scan note in warm session"

test_case "warm: no cold message in context"
assert_not_contains "$WARM_CTX" "world model is cold" "no cold message in warm session"

summarize
