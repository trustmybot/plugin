#!/usr/bin/env bash
# Tests for scripts/hooks/activation-routine.sh.
# Hook contract: on UserPromptSubmit, when bro mode is active, read
# identity + pending issue from trajectory.db and emit additionalContext
# JSON. Silent no-op otherwise.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/activation-routine.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
DB="$TMPDIR/trajectory.db"
TRANSCRIPT_BRO="$TMPDIR/transcript-bro.jsonl"
TRANSCRIPT_EXITED="$TMPDIR/transcript-exited.jsonl"
TRANSCRIPT_PLAIN="$TMPDIR/transcript-plain.jsonl"

export TRAJECTORY_DB_PATH="$DB"

sqlite3 "$DB" "
  CREATE TABLE identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    human_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    objective TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
"

echo '{"role":"assistant","content":"Entering bro mode."}' > "$TRANSCRIPT_BRO"
echo '{"role":"assistant","content":"Entering bro mode."}' > "$TRANSCRIPT_EXITED"
echo '{"role":"user","content":"exit bro mode"}' >> "$TRANSCRIPT_EXITED"
echo '{"role":"user","content":"hello"}' > "$TRANSCRIPT_PLAIN"

input() {
  jq -n --arg p "$1" --arg t "${2:-}" '{prompt:$p, transcript_path:$t}'
}

run_hook() {
  echo "$1" | bash "$HOOK" 2>&1 || true
}

# ---- non-bro paths: silent no-op ----

test_case "plain prompt + no transcript: silent no-op"
out=$(run_hook "$(input 'just a normal claude question')")
assert_eq "" "$out" "no output"

test_case "plain prompt + plain transcript: silent no-op"
out=$(run_hook "$(input 'still just regular work' "$TRANSCRIPT_PLAIN")")
assert_eq "" "$out" "no output"

test_case "word brother (or similar) does not false-trigger via \\bbro\\b"
out=$(run_hook "$(input 'my brother said hi')")
assert_eq "" "$out" "no output for substring match"

test_case "transcript had bro mode but user later exited: no-op"
out=$(run_hook "$(input 'normal followup' "$TRANSCRIPT_EXITED")")
assert_eq "" "$out" "no output once bro mode exited"

# ---- bro trigger paths: emit additionalContext ----

test_case "@bro greeting + empty DB state (no identity, no pending): emit unset/none"
out=$(run_hook "$(input '@bro hi')")
assert_contains "$out" '"hookEventName":"UserPromptSubmit"' "JSON has correct event name"
assert_contains "$out" 'identity=<unset>' "identity reported as unset"
assert_contains "$out" 'pending=<none>' "pending reported as none"

test_case "@bro greeting + identity row present: emit human name"
sqlite3 "$DB" "INSERT INTO identity (id, human_name, created_at, updated_at) VALUES (1, 'Zax', datetime('now'), datetime('now'));"
out=$(run_hook "$(input '@bro hi')")
assert_contains "$out" 'identity=Zax' "identity reported with name"

test_case "@bro greeting + pending issue: emit issue id + objective"
sqlite3 "$DB" "INSERT INTO issues (objective, status) VALUES ('Wire activation routine hook', 'open');"
out=$(run_hook "$(input '@bro continue')")
assert_contains "$out" 'pending=#1: Wire activation routine hook' "pending issue rendered"

test_case "sticky bro mode (transcript has Entering bro mode., no exit): non-bro prompt still triggers"
out=$(run_hook "$(input 'what about pyproject.toml' "$TRANSCRIPT_BRO")")
assert_contains "$out" '"hookEventName":"UserPromptSubmit"' "sticky bro fires hook"
assert_contains "$out" 'identity=Zax' "still pre-fetches identity"

# ---- DB-missing graceful path ----

test_case "bro trigger but DB doesn't exist: silent no-op (graceful first-activation)"
rm -f "$DB"
out=$(run_hook "$(input '@bro hi')")
assert_eq "" "$out" "no output when DB missing"
