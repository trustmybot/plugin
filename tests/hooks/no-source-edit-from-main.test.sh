#!/usr/bin/env bash
# Tests for scripts/hooks/no-source-edit-from-main.sh.
# Hook contract: blocks Edit/Write tools when bro mode is active and the
# target is source code outside an SWE worktree. Allows in worktrees, on
# .md files, on configs/manifests, and when DB doesn't exist.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/no-source-edit-from-main.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
DB="$TMPDIR/trajectory.db"
TRANSCRIPT_BRO="$TMPDIR/bro.jsonl"
TRANSCRIPT_PLAIN="$TMPDIR/plain.jsonl"
TRANSCRIPT_EXITED="$TMPDIR/exited.jsonl"

export TRAJECTORY_DB_PATH="$DB"

sqlite3 "$DB" "CREATE TABLE meta (k TEXT);"

echo '{"role":"assistant","content":"Entering bro mode."}' > "$TRANSCRIPT_BRO"
echo '{"role":"user","content":"hi"}' > "$TRANSCRIPT_PLAIN"
echo '{"role":"assistant","content":"Entering bro mode."}' > "$TRANSCRIPT_EXITED"
echo '{"role":"user","content":"exit bro mode"}' >> "$TRANSCRIPT_EXITED"

input() {
  jq -n --arg tn "$1" --arg fp "$2" --arg t "${3:-}" '{
    tool_name: $tn,
    tool_input: { file_path: $fp },
    transcript_path: $t
  }'
}

run_hook() {
  echo "$1" | bash "$HOOK" 2>&1 || true
}

# ---- non-block paths ----

test_case "non-Edit tool: silent pass"
out=$(run_hook "$(input 'Bash' 'whatever' "$TRANSCRIPT_BRO")")
assert_eq "" "$out" "non-Edit tool ignored"

test_case "no transcript: pass (can't determine bro state)"
out=$(run_hook "$(input 'Edit' 'src/foo.ts' '')")
assert_eq "" "$out" "no transcript = no block"

test_case "plain transcript (no bro mode): pass"
out=$(run_hook "$(input 'Edit' 'src/foo.ts' "$TRANSCRIPT_PLAIN")")
assert_eq "" "$out" "non-bro session = no block"

test_case "bro mode but exited: pass"
out=$(run_hook "$(input 'Edit' 'src/foo.ts' "$TRANSCRIPT_EXITED")")
assert_eq "" "$out" "exited bro mode = no block"

test_case "TMB_ALLOW_SOURCE_EDIT bypass: pass"
out=$(echo "$(input 'Edit' 'src/foo.ts' "$TRANSCRIPT_BRO")" | env TMB_ALLOW_SOURCE_EDIT=1 bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "env bypass works"

# ---- allowlist paths (bro mode + DB present) ----

test_case "bro mode + .md file: pass"
out=$(run_hook "$(input 'Edit' 'docs/architecture/FILES.md' "$TRANSCRIPT_BRO")")
assert_eq "" "$out" "markdown allowed"

test_case "bro mode + CHANGELOG.md: pass"
out=$(run_hook "$(input 'Edit' 'CHANGELOG.md' "$TRANSCRIPT_BRO")")
assert_eq "" "$out" "CHANGELOG allowed"

test_case "bro mode + LICENSE: pass"
out=$(run_hook "$(input 'Write' 'LICENSE' "$TRANSCRIPT_BRO")")
assert_eq "" "$out" "LICENSE allowed"

test_case "bro mode + .gitignore: pass"
out=$(run_hook "$(input 'Edit' '.gitignore' "$TRANSCRIPT_BRO")")
assert_eq "" "$out" "gitignore allowed"

test_case "bro mode + agents/swe.md: pass (agent prompts editable)"
out=$(run_hook "$(input 'Edit' 'agents/swe.md' "$TRANSCRIPT_BRO")")
assert_eq "" "$out" "agent prompts allowed"

test_case "bro mode + skills/tmb_foo/SKILL.md: pass"
out=$(run_hook "$(input 'Edit' 'skills/tmb_foo/SKILL.md' "$TRANSCRIPT_BRO")")
assert_eq "" "$out" "skill prompts allowed"

test_case "bro mode + hooks.json: pass"
out=$(run_hook "$(input 'Edit' 'hooks/hooks.json' "$TRANSCRIPT_BRO")")
assert_eq "" "$out" "hooks manifest allowed"

test_case "bro mode + .claude-plugin/plugin.json: pass"
out=$(run_hook "$(input 'Edit' '.claude-plugin/plugin.json' "$TRANSCRIPT_BRO")")
assert_eq "" "$out" "plugin manifest allowed"

test_case "bro mode + .github/workflows/test.yml: pass"
out=$(run_hook "$(input 'Edit' '.github/workflows/test.yml' "$TRANSCRIPT_BRO")")
assert_eq "" "$out" "github workflows allowed"

# ---- block paths ----

test_case "bro mode + src/foo.ts: BLOCK"
out=$(run_hook "$(input 'Edit' 'src/foo.ts' "$TRANSCRIPT_BRO")")
assert_contains "$out" '"permissionDecision":"deny"' "deny decision emitted"
assert_contains "$out" 'bro is a pure planner' "reason cites doctrine"

test_case "bro mode + Write to mcp/server.ts: BLOCK"
out=$(run_hook "$(input 'Write' 'mcp/trajectory-server/src/index.ts' "$TRANSCRIPT_BRO")")
assert_contains "$out" '"permissionDecision":"deny"' "deny decision emitted"

test_case "bro mode + scripts/hooks/foo.sh: BLOCK (shell hook source)"
out=$(run_hook "$(input 'Edit' 'scripts/hooks/foo.sh' "$TRANSCRIPT_BRO")")
assert_contains "$out" '"permissionDecision":"deny"' "deny decision emitted"

test_case "bro mode + tests/lib/assert.sh: BLOCK"
out=$(run_hook "$(input 'Edit' 'tests/lib/assert.sh' "$TRANSCRIPT_BRO")")
assert_contains "$out" '"permissionDecision":"deny"' "deny decision emitted"

# ---- worktree path: SWE allowed ----

test_case "in worktree: pass even for source"
PWD_ORIG=$PWD
WORKTREE_DIR="$TMPDIR/.claude/worktrees/task-42"
mkdir -p "$WORKTREE_DIR"
cd "$WORKTREE_DIR"
out=$(run_hook "$(input 'Edit' 'src/foo.ts' "$TRANSCRIPT_BRO")")
cd "$PWD_ORIG"
assert_eq "" "$out" "worktree edits pass"

# ---- DB-missing graceful path ----

test_case "no DB: pass even on source (not a TMB project)"
rm -f "$DB"
out=$(run_hook "$(input 'Edit' 'src/foo.ts' "$TRANSCRIPT_BRO")")
assert_eq "" "$out" "no DB = not a TMB project = allow"
