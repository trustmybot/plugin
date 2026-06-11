#!/usr/bin/env bash
# Tests for scripts/hooks/no-source-edit-from-main.sh.
# Hook contract: blocks Edit/Write tools when the target is source code outside
# an SWE worktree in a TMB project. Policy is LOCATION-based — agent identity
# (bro, general-purpose subagent, unknown) is irrelevant; the worktree path
# is the only credential. Allows in worktrees, on .md files, on
# configs/manifests, and when DB doesn't exist.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/no-source-edit-from-main.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
DB="$TMPDIR/trajectory.db"
TRANSCRIPT_BRO="$TMPDIR/bro.jsonl"
TRANSCRIPT_PLAIN="$TMPDIR/plain.jsonl"
TRANSCRIPT_EXITED="$TMPDIR/exited.jsonl"
TRANSCRIPT_EMPTY="$TMPDIR/empty.jsonl"

export TRAJECTORY_DB_PATH="$DB"

sqlite3 "$DB" "CREATE TABLE meta (k TEXT);"

echo '{"role":"assistant","content":"Entering bro mode."}' > "$TRANSCRIPT_BRO"
echo '{"role":"user","content":"hi"}' > "$TRANSCRIPT_PLAIN"
echo '{"role":"assistant","content":"Entering bro mode."}' > "$TRANSCRIPT_EXITED"
echo '{"role":"user","content":"exit bro mode"}' >> "$TRANSCRIPT_EXITED"
touch "$TRANSCRIPT_EMPTY"

# Simulated general-purpose subagent: no bro announcement, no @bro sigil,
# no role identity in the transcript — just a plain task prompt.
TRANSCRIPT_SUBAGENT="$TMPDIR/subagent.jsonl"
echo '{"role":"user","content":"Edit src/foo.ts to fix the bug."}' > "$TRANSCRIPT_SUBAGENT"
echo '{"role":"assistant","content":"On it."}' >> "$TRANSCRIPT_SUBAGENT"

# #276 regression: a plain session that merely mentions the word "bro" (no
# @bro sigil, no announcement) — incl. this hook's own block message — must
# still be denied by the location-based policy (source edit in TMB project).
TRANSCRIPT_BARE_BRO="$TMPDIR/bare-bro.jsonl"
echo '{"role":"user","content":"thanks bro, can you edit src/foo.ts"}' > "$TRANSCRIPT_BARE_BRO"
echo '{"role":"assistant","content":"Source edits go through bro + swe; this is bro-mode territory."}' >> "$TRANSCRIPT_BARE_BRO"

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

test_case "TMB_ALLOW_SOURCE_EDIT bypass: pass"
out=$(echo "$(input 'Edit' 'src/foo.ts' "$TRANSCRIPT_BRO")" | env TMB_ALLOW_SOURCE_EDIT=1 bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "env bypass works"

# ---- location-based block: any agent context is denied ----

test_case "bro mode + src/foo.ts: BLOCK"
out=$(run_hook "$(input 'Edit' 'src/foo.ts' "$TRANSCRIPT_BRO")")
assert_contains "$out" '"permissionDecision":"deny"' "deny decision emitted"
assert_contains "$out" 'source edits from the main checkout are denied for all agent contexts' "reason cites location policy"

test_case "plain session (no bro) + src/foo.ts: BLOCK (location-based)"
out=$(run_hook "$(input 'Edit' 'src/foo.ts' "$TRANSCRIPT_PLAIN")")
assert_contains "$out" '"permissionDecision":"deny"' "non-bro session still denied by location policy"

test_case "exited bro mode + src/foo.ts: BLOCK (exit irrelevant under location policy)"
out=$(run_hook "$(input 'Edit' 'src/foo.ts' "$TRANSCRIPT_EXITED")")
assert_contains "$out" '"permissionDecision":"deny"' "exited bro still denied — identity is not the gate"

test_case "no transcript + src/foo.ts: BLOCK (identity irrelevant)"
out=$(run_hook "$(input 'Edit' 'src/foo.ts' '')")
assert_contains "$out" '"permissionDecision":"deny"' "no transcript = no identity check needed; location denies"

test_case "general-purpose subagent context + src/foo.ts: BLOCK"
out=$(run_hook "$(input 'Edit' 'src/foo.ts' "$TRANSCRIPT_SUBAGENT")")
assert_contains "$out" '"permissionDecision":"deny"' "subagent identity never grants main-checkout source edits"
assert_contains "$out" 'source edits from the main checkout are denied for all agent contexts' "reason cites location policy"

test_case "#276: bare 'bro' word + src/foo.ts: BLOCK (location policy, not substring match)"
out=$(run_hook "$(input 'Edit' 'src/foo.ts' "$TRANSCRIPT_BARE_BRO")")
assert_contains "$out" '"permissionDecision":"deny"' "location policy blocks regardless of bare-word mention"

test_case "unknown/absent agent identity + mcp/server.ts: BLOCK"
out=$(run_hook "$(input 'Write' 'mcp/trajectory-server/src/index.ts' "$TRANSCRIPT_EMPTY")")
assert_contains "$out" '"permissionDecision":"deny"' "absent identity never grants passage"

# ---- allowlist paths (DB present, any context) ----

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

test_case "plain session + .md file: pass (allowlist applies to all contexts)"
out=$(run_hook "$(input 'Edit' 'docs/architecture/FILES.md' "$TRANSCRIPT_PLAIN")")
assert_eq "" "$out" "markdown allowed regardless of agent context"

test_case "bro mode + hooks.json: BLOCK (enforcement surface)"
out=$(run_hook "$(input 'Edit' 'hooks/hooks.json' "$TRANSCRIPT_BRO")")
assert_contains "$out" '"permissionDecision":"deny"' "hooks.json denied from main checkout"
assert_contains "$out" 'enforcement surfaces' "deny message cites enforcement-surface doctrine"

test_case "bro mode + .claude-plugin/plugin.json: pass"
out=$(run_hook "$(input 'Edit' '.claude-plugin/plugin.json' "$TRANSCRIPT_BRO")")
assert_eq "" "$out" "plugin manifest allowed"

test_case "bro mode + .github/workflows/test.yml: pass"
out=$(run_hook "$(input 'Edit' '.github/workflows/test.yml' "$TRANSCRIPT_BRO")")
assert_eq "" "$out" "github workflows allowed"

# ---- enforcement-surface deny-first precedes allowlist ----

test_case "bro mode + scripts/hooks/foo.sh: BLOCK (enforcement surface)"
out=$(run_hook "$(input 'Edit' 'scripts/hooks/foo.sh' "$TRANSCRIPT_BRO")")
assert_contains "$out" '"permissionDecision":"deny"' "deny decision emitted"
assert_contains "$out" 'enforcement surfaces' "deny message cites enforcement-surface doctrine"

test_case "bro mode + scripts/hooks/readme.md: BLOCK (enforcement surface beats .md allowlist)"
out=$(run_hook "$(input 'Edit' 'scripts/hooks/readme.md' "$TRANSCRIPT_BRO")")
assert_contains "$out" '"permissionDecision":"deny"' "hooks-path .md still denied — deny fires before allowlist"

test_case "bro mode + nested hooks/hooks.json: BLOCK"
out=$(run_hook "$(input 'Edit' 'some/path/hooks/hooks.json' "$TRANSCRIPT_BRO")")
assert_contains "$out" '"permissionDecision":"deny"' "nested hooks.json denied from main checkout"

# ---- worktree paths: SWE always allowed ----

test_case "worktree + scripts/hooks/foo.sh: PASS (SWE in worktree edits hooks)"
out=$(run_hook "$(input 'Edit' '.claude/worktrees/task-14/scripts/hooks/foo.sh' "$TRANSCRIPT_BRO")")
assert_eq "" "$out" "SWE in worktree may edit hook files"

test_case "worktree + hooks/hooks.json: PASS (SWE in worktree edits manifest)"
out=$(run_hook "$(input 'Edit' '.claude/worktrees/task-14/hooks/hooks.json' "$TRANSCRIPT_BRO")")
assert_eq "" "$out" "SWE in worktree may edit hooks.json"

test_case "REGRESSION: target inside .claude/worktrees/<slug>/ : PASS (SWE in worktree)"
out=$(run_hook "$(input 'Edit' '.claude/worktrees/task-42/src/foo.ts' "$TRANSCRIPT_BRO")")
assert_eq "" "$out" "worktree-targeted source edit allowed"

test_case "REGRESSION: target with absolute worktree path: PASS"
out=$(run_hook "$(input 'Write' '/tmp/proj/.claude/worktrees/task-42/src/index.ts' "$TRANSCRIPT_BRO")")
assert_eq "" "$out" "absolute worktree path allowed"

test_case "REGRESSION: target outside any worktree, even when CWD pretends: BLOCK"
PWD_ORIG=$PWD
WORKTREE_DIR="$TMPDIR/.claude/worktrees/task-42"
mkdir -p "$WORKTREE_DIR"
cd "$WORKTREE_DIR"
# CWD is a worktree, but TARGET is outside → must still block (the previous
# $PWD-based check would have allowed; the target-based check correctly blocks)
out=$(run_hook "$(input 'Edit' 'src/foo.ts' "$TRANSCRIPT_BRO")")
cd "$PWD_ORIG"
assert_contains "$out" '"permissionDecision":"deny"' "non-worktree target blocked even from worktree CWD"

test_case "worktree target with no transcript: PASS (worktree exemption is location-only)"
out=$(run_hook "$(input 'Edit' '.claude/worktrees/task-99/src/foo.ts' '')")
assert_eq "" "$out" "worktree path exemption needs no transcript"

# ---- other block paths ----

test_case "bro mode + tests/lib/assert.sh: BLOCK"
out=$(run_hook "$(input 'Edit' 'tests/lib/assert.sh' "$TRANSCRIPT_BRO")")
assert_contains "$out" '"permissionDecision":"deny"' "deny decision emitted"

# ---- DB-missing graceful path ----

test_case "no DB: pass even on source (not a TMB project)"
rm -f "$DB"
out=$(run_hook "$(input 'Edit' 'src/foo.ts' "$TRANSCRIPT_BRO")")
assert_eq "" "$out" "no DB = not a TMB project = allow"

summarize
