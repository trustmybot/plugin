#!/usr/bin/env bash
# Tests for scripts/hooks/activation-routine.sh.
# Hook contract: on UserPromptSubmit, when bro mode is active, read
# onboarded marker + pending issue from trajectory.db and emit additionalContext
# JSON. Silent no-op otherwise.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/activation-routine.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
DB="$TMPDIR/trajectory.db"
TRANSCRIPT_BRO="$TMPDIR/transcript-bro.jsonl"
TRANSCRIPT_EXITED="$TMPDIR/transcript-exited.jsonl"
TRANSCRIPT_PLAIN="$TMPDIR/transcript-plain.jsonl"

export TRAJECTORY_DB_PATH="$DB"

sqlite3 "$DB" "
  CREATE TABLE plugin_config (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
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

# #276 regression: a transcript that merely mentions the word "bro" (no @bro
# sigil, no announcement) must NOT make the session sticky-bro. Bare-keyword
# scanning matched the hook's own emitted context + assistant mentions of bro.
TRANSCRIPT_BARE_BRO="$TMPDIR/transcript-bare-bro.jsonl"
echo '{"role":"user","content":"thanks bro"}' > "$TRANSCRIPT_BARE_BRO"
echo '{"role":"assistant","content":"bro routes the work to swe; this is bro-mode territory."}' >> "$TRANSCRIPT_BARE_BRO"

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

test_case "#276: bare 'bro' in transcript (no @sigil, no announce): no sticky no-op"
out=$(run_hook "$(input 'a normal question' "$TRANSCRIPT_BARE_BRO")")
assert_eq "" "$out" "casual 'bro' mention must not make the session sticky-bro"

# ---- bro trigger paths: emit additionalContext ----

test_case "@bro greeting + empty DB state (no identity, no pending): emit FIRST CONTACT auto-fire signal"
out=$(run_hook "$(input '@bro hi')")
assert_contains "$out" '"hookEventName":"UserPromptSubmit"' "JSON has correct event name"
assert_contains "$out" 'FIRST CONTACT' "first-contact marker present in injected context"
assert_contains "$out" 'auto-fire /onboard' "auto-fire instruction injected"
assert_contains "$out" 'pending=<none>' "pending reported as none"

test_case "onboarded marker present (post-onboard, #95): emits onboarded=yes, NOT first-contact"
sqlite3 "$DB" "DELETE FROM plugin_config WHERE key='onboarded';"
sqlite3 "$DB" "INSERT INTO plugin_config (key, value_json) VALUES ('onboarded', 'true');"
out=$(run_hook "$(input '@bro hi')")
assert_contains "$out" 'onboarded=yes' "onboarded marker present"
# Critical: the first-contact auto-fire must NOT fire for an existing row
if echo "$out" | grep -q 'FIRST CONTACT'; then
  echo "  FAIL onboarded row should NOT trigger FIRST CONTACT auto-fire (#95 regression)"
  exit 1
fi
sqlite3 "$DB" "DELETE FROM plugin_config WHERE key='onboarded';"

test_case "@bro greeting + onboarded marker present: onboarded=yes (no name stored)"
sqlite3 "$DB" "INSERT INTO plugin_config (key, value_json) VALUES ('onboarded', 'true');"
out=$(run_hook "$(input '@bro hi')")
assert_contains "$out" 'onboarded=yes' "onboarded reported"

test_case "@bro greeting + pending issue: emit issue id + objective"
sqlite3 "$DB" "INSERT INTO issues (objective, status) VALUES ('Wire activation routine hook', 'open');"
out=$(run_hook "$(input '@bro continue')")
assert_contains "$out" 'pending=#1: Wire activation routine hook' "pending issue rendered"

test_case "sticky bro mode (transcript has Entering bro mode., no exit): non-bro prompt still triggers"
out=$(run_hook "$(input 'what about pyproject.toml' "$TRANSCRIPT_BRO")")
assert_contains "$out" '"hookEventName":"UserPromptSubmit"' "sticky bro fires hook"
assert_contains "$out" 'onboarded=yes' "still pre-fetches onboarded marker"

test_case "REGRESSION: user said @bro in prior turn but assistant skipped announce → sticky still fires"
TRANSCRIPT_NO_ANNOUNCE="$TMPDIR/transcript-no-announce.jsonl"
echo '{"role":"user","content":"@bro implement the cli"}' > "$TRANSCRIPT_NO_ANNOUNCE"
echo '{"role":"assistant","content":"On it. What scope?"}' >> "$TRANSCRIPT_NO_ANNOUNCE"
out=$(run_hook "$(input 'small, single-file' "$TRANSCRIPT_NO_ANNOUNCE")")
assert_contains "$out" '"hookEventName":"UserPromptSubmit"' "sticky fires without announce marker"

# ---- cache-friendly ordering tests ----
# Stable marker (onboarded) must appear before volatile marker (pending) in the
# emitted additionalContext — per cache-zone contract in PROMPT_ENGINEERING.md.

test_case "ordering: onboarded= (stable) appears before pending= (volatile) — post-onboard case"
sqlite3 "$DB" "DELETE FROM plugin_config WHERE key='onboarded'; INSERT INTO plugin_config (key, value_json) VALUES ('onboarded', 'true');"
out_order=$(run_hook "$(input '@bro status')")
CTX_ORDER=$(echo "$out_order" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || echo "")
onboarded_pos=$(echo "$CTX_ORDER" | grep -b -o "onboarded=" 2>/dev/null | head -1 | cut -d: -f1 || echo "")
pending_pos=$(echo "$CTX_ORDER" | grep -b -o "pending=" 2>/dev/null | head -1 | cut -d: -f1 || echo "")
if [ -z "$onboarded_pos" ] || [ -z "$pending_pos" ]; then
  _fail "could not locate markers: onboarded_pos=<$onboarded_pos> pending_pos=<$pending_pos> ctx=<$CTX_ORDER>"
elif [ "$onboarded_pos" -lt "$pending_pos" ]; then
  _pass
else
  _fail "stable onboarded= at byte $onboarded_pos should be before volatile pending= at byte $pending_pos"
fi

test_case "ordering: onboarded= (stable) appears before pending= (volatile) — first-contact case"
sqlite3 "$DB" "DELETE FROM plugin_config WHERE key='onboarded';"
out_order_fc=$(run_hook "$(input '@bro hi')")
CTX_ORDER_FC=$(echo "$out_order_fc" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || echo "")
onboarded_pos_fc=$(echo "$CTX_ORDER_FC" | grep -b -o "onboarded=" 2>/dev/null | head -1 | cut -d: -f1 || echo "")
pending_pos_fc=$(echo "$CTX_ORDER_FC" | grep -b -o "pending=" 2>/dev/null | head -1 | cut -d: -f1 || echo "")
if [ -z "$onboarded_pos_fc" ] || [ -z "$pending_pos_fc" ]; then
  _fail "could not locate markers: onboarded_pos=<$onboarded_pos_fc> pending_pos=<$pending_pos_fc>"
elif [ "$onboarded_pos_fc" -lt "$pending_pos_fc" ]; then
  _pass
else
  _fail "stable onboarded= at byte $onboarded_pos_fc should be before volatile pending= at byte $pending_pos_fc"
fi

# ---- DB-missing graceful path ----

test_case "bro trigger but DB doesn't exist: silent no-op (graceful first-activation)"
rm -f "$DB"
out=$(run_hook "$(input '@bro hi')")
assert_eq "" "$out" "no output when DB missing"
