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

input_with_agent() {
  jq -n --arg tn "$1" --arg fp "$2" --arg at "$3" '{
    tool_name: $tn,
    agent_type: $at,
    tool_input: { file_path: $fp }
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
assert_contains "$out" 'source edits from the main checkout are denied' "reason cites location policy"

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
assert_contains "$out" 'source edits from the main checkout are denied' "reason cites location policy"

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

# ---- Rule 2: Bash write-forms targeting prompt surfaces (main checkout) ----

bash_input() {
  jq -n --arg cmd "$1" '{
    tool_name: "Bash",
    tool_input: { command: $cmd }
  }'
}

test_case "Bash non-write: silent pass"
out=$(run_hook "$(bash_input 'cat agents/swe.md')")
assert_eq "" "$out" "cat is read-only, should pass"

test_case "Bash redirect > to agents/swe.md: DENIED (bro context)"
out=$(run_hook "$(bash_input 'echo "content" > agents/swe.md')")
assert_contains "$out" '"permissionDecision":"deny"' "redirect > to agents/*.md denied from main checkout"
assert_contains "$out" "prompt-surface" "deny reason mentions prompt-surface"

test_case "Bash redirect >> to CLAUDE.md: DENIED"
out=$(run_hook "$(bash_input 'echo "extra" >> CLAUDE.md')")
assert_contains "$out" '"permissionDecision":"deny"' "redirect >> to CLAUDE.md denied"

test_case "Bash tee to commands/scan.md: DENIED"
out=$(run_hook "$(bash_input 'cat /tmp/x | tee commands/scan.md')")
assert_contains "$out" '"permissionDecision":"deny"' "tee to commands/*.md denied"

test_case "Bash sed -i on skills/tmb_planning/SKILL.md: DENIED"
out=$(run_hook "$(bash_input "sed -i 's/old/new/' skills/tmb_planning/SKILL.md")")
assert_contains "$out" '"permissionDecision":"deny"' "sed -i on SKILL.md denied"

test_case "Bash perl -i on agents/bro.md: DENIED"
out=$(run_hook "$(bash_input "perl -i -pe 's/x/y/' agents/bro.md")")
assert_contains "$out" '"permissionDecision":"deny"' "perl -i on agents/*.md denied"

test_case "Bash python3 open w to agents/swe.md: DENIED"
out=$(run_hook "$(bash_input "python3 -c \"open('agents/swe.md','w').write('x')\"")")
assert_contains "$out" '"permissionDecision":"deny"' "python3 open w to agents/*.md denied"

test_case "Bash python open a to GEMINI.md: DENIED"
out=$(run_hook "$(bash_input "python -c \"open('GEMINI.md','a').write('x')\"")")
assert_contains "$out" '"permissionDecision":"deny"' "python open a to GEMINI.md denied"

test_case "Bash cp to templates/agents/foo.md: DENIED"
out=$(run_hook "$(bash_input 'cp /tmp/foo.md templates/agents/foo.md')")
assert_contains "$out" '"permissionDecision":"deny"' "cp to templates/*.md denied"

test_case "Bash mv to commands/foo.md: DENIED"
out=$(run_hook "$(bash_input 'mv /tmp/foo.md commands/foo.md')")
assert_contains "$out" '"permissionDecision":"deny"' "mv to commands/*.md denied"

test_case "Bash rsync to agents/foo.md: DENIED"
out=$(run_hook "$(bash_input 'rsync -av /tmp/agent.md agents/foo.md')")
assert_contains "$out" '"permissionDecision":"deny"' "rsync to agents/*.md denied"

test_case "Bash redirect > to non-prompt file: pass"
out=$(run_hook "$(bash_input 'echo "hello" > src/index.ts')")
assert_eq "" "$out" "redirect to non-prompt file passes"

test_case "Bash sed -n (read-only) on agents/swe.md: pass"
out=$(run_hook "$(bash_input "sed -n '1,5p' agents/swe.md")")
assert_eq "" "$out" "sed -n is read-only, should pass"

test_case "Bash grep on agents/swe.md: pass"
out=$(run_hook "$(bash_input 'grep "pattern" agents/swe.md')")
assert_eq "" "$out" "grep is read-only, should pass"

test_case "Bash write in a worktree path: pass (worktree exemption)"
out=$(run_hook "$(bash_input 'echo "x" > .claude/worktrees/task-99/agents/swe.md')")
assert_eq "" "$out" "worktree-targeted write passes"

test_case "Bash redirect > to CODEX.md: DENIED"
out=$(run_hook "$(bash_input 'echo "x" > CODEX.md')")
assert_contains "$out" '"permissionDecision":"deny"' "redirect to CODEX.md denied"

test_case "Bash redirect > to CURSOR.md: DENIED"
out=$(run_hook "$(bash_input 'echo "x" > CURSOR.md')")
assert_contains "$out" '"permissionDecision":"deny"' "redirect to CURSOR.md denied"

test_case "Bash deny applies regardless of agent identity (no agent_type field)"
out=$(run_hook "$(bash_input 'echo "x" > agents/swe.md')")
assert_contains "$out" '"permissionDecision":"deny"' "deny fires even with no agent identity"

# ---- Rule 2 false-positive regressions (destination-coupling) ----

test_case "Bash grep containing > char: NOT denied (not a redirect)"
out=$(run_hook "$(bash_input 'grep ">" agents/swe.md')")
assert_eq "" "$out" "grep with > in pattern should not be denied"

test_case "Bash awk comparison > on .md file: NOT denied (comparison, not redirect)"
out=$(run_hook "$(bash_input "awk '\$1 > 5' agents/swe.md")")
assert_eq "" "$out" "awk comparison operator should not be denied"

test_case "Bash echo with prompt path in string redirected to /tmp: NOT denied"
out=$(run_hook "$(bash_input 'echo "see agents/swe.md for details" > /tmp/notes.txt')")
assert_eq "" "$out" "redirect to /tmp mentioning a prompt path should not be denied"

test_case "Bash git commit -m message mentioning agents/swe.md: NOT denied"
out=$(run_hook "$(bash_input 'git commit -m "touch agents/swe.md"')")
assert_eq "" "$out" "commit message mentioning prompt path should not be denied"

# ---- Non-isolated SWE first-class (agent_type=swe permit) ----
# Restore DB (removed in the "no DB" test case above)
sqlite3 "$DB" "CREATE TABLE meta (k TEXT);" 2>/dev/null || true

test_case "agent_type=swe + src/foo.ts from main: ALLOWED (non-isolated SWE permit)"
out=$(run_hook "$(input_with_agent 'Edit' 'src/foo.ts' 'swe')")
assert_eq "" "$out" "swe role may edit source from main checkout"

test_case "agent_type=swe + mcp/server.ts from main: ALLOWED"
out=$(run_hook "$(input_with_agent 'Write' 'mcp/trajectory-server/src/index.ts' 'swe')")
assert_eq "" "$out" "swe role may write .ts source from main checkout"

test_case "agent_type=bro + src/foo.ts from main: DENIED (bro may not use swe permit)"
out=$(run_hook "$(input_with_agent 'Edit' 'src/foo.ts' 'bro')")
assert_contains "$out" '"permissionDecision":"deny"' "bro is denied even with explicit agent_type"

test_case "no agent_type + src/foo.ts from main: DENIED (fail closed)"
out=$(run_hook "$(input 'Edit' 'src/foo.ts' '')")
assert_contains "$out" '"permissionDecision":"deny"' "absent agent_type fails closed"

test_case "agent_type=swe + scripts/hooks/foo.sh from main: DENIED (enforcement surface)"
out=$(run_hook "$(input_with_agent 'Edit' 'scripts/hooks/foo.sh' 'swe')")
assert_contains "$out" '"permissionDecision":"deny"' "swe cannot edit enforcement surfaces from main"
assert_contains "$out" 'enforcement surfaces' "deny message cites enforcement-surface doctrine"

test_case "agent_type=swe + hooks/hooks.json from main: DENIED (enforcement surface)"
out=$(run_hook "$(input_with_agent 'Edit' 'hooks/hooks.json' 'swe')")
assert_contains "$out" '"permissionDecision":"deny"' "swe cannot edit hooks.json from main"

test_case "REGRESSION: worktree path edit + agent_type=swe: ALLOWED"
out=$(run_hook "$(input_with_agent 'Edit' '.claude/worktrees/task-99/src/foo.ts' 'swe')")
assert_eq "" "$out" "worktree-path edit always allowed regardless of agent_type"

test_case "deny message teaches recovery without mentioning shell rc files"
out=$(run_hook "$(input_with_agent 'Edit' 'src/foo.ts' 'bro')")
assert_not_contains "$out" 'bashrc' "deny message must not mention bashrc"
assert_contains "$out" 'non-isolated' "deny message mentions non-isolated mode"

# ---- Managed-repo scope by REGISTRATION (#693): multi-repo workspace ----
# Rule 1 now scopes by REGISTRATION: an absolute target is guarded iff its
# git-root resolves to a `repos` row (matched by path). Build two REAL git repos
# under the workspace — register only the managed one; the sibling is an
# unregistered tree whose source edits are outside Rule 1 scope.
WS_ROOT="$TMPDIR/ws"
MANAGED_REPO="$WS_ROOT/plugin"
SIBLING_REPO="$WS_ROOT/benchmarks"
mkdir -p "$WS_ROOT/.claude/tmb"
git init -q -b main "$MANAGED_REPO"
mkdir -p "$MANAGED_REPO/src"
git init -q -b main "$SIBLING_REPO"
mkdir -p "$SIBLING_REPO/src"
MANAGED_ROOT=$(git -C "$MANAGED_REPO" rev-parse --show-toplevel)
SIBLING_ROOT=$(git -C "$SIBLING_REPO" rev-parse --show-toplevel)

MANAGED_DB="$WS_ROOT/.claude/tmb/trajectory.db"
sqlite3 "$MANAGED_DB" "CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT);"
sqlite3 "$MANAGED_DB" "CREATE TABLE repos(name TEXT PRIMARY KEY, path TEXT NOT NULL, file_count INTEGER NOT NULL DEFAULT 0, last_scanned_at TEXT NOT NULL DEFAULT (datetime('now')), target_branch TEXT, branching_model TEXT, protected_branches TEXT);"
sqlite3 "$MANAGED_DB" "INSERT INTO repos (name, path) VALUES ('plugin', '$MANAGED_ROOT');"

run_hook_db() {
  echo "$2" | env TRAJECTORY_DB_PATH="$1" bash "$HOOK" 2>&1 || true
}

test_case "registration scope + edit inside REGISTERED repo from main: BLOCK"
out=$(run_hook_db "$MANAGED_DB" "$(input 'Edit' "$MANAGED_ROOT/src/foo.ts" "$TRANSCRIPT_BRO")")
assert_contains "$out" '"permissionDecision":"deny"' "source edit inside the registered repo still denied from main"

test_case "registration scope + edit in UNREGISTERED sibling repo from main: ALLOWED (no-op)"
out=$(run_hook_db "$MANAGED_DB" "$(input 'Edit' "$SIBLING_ROOT/src/foo.ts" "$TRANSCRIPT_BRO")")
assert_eq "" "$out" "unregistered sibling-repo source edit allowed — outside Rule 1 scope"

test_case "registration scope + target with no resolvable git-root: BLOCK (fail-closed)"
out=$(run_hook_db "$MANAGED_DB" "$(input 'Edit' '/some/project/src/foo.ts' "$TRANSCRIPT_BRO")")
assert_contains "$out" '"permissionDecision":"deny"' "target outside any git tree fails closed (guarded)"

test_case "single-repo-at-root: the git repo IS the registered root + src/foo.ts: BLOCK"
# repos.path == the repo root, so the target's git-root resolves to a registered
# row and source under it is guarded (the whole tree, since the lone repo is the
# root). This is the single-repo project case.
SR_ROOT="$TMPDIR/repo-at-root"
mkdir -p "$SR_ROOT/.claude/tmb" "$SR_ROOT/src"
git init -q -b main "$SR_ROOT"
SR_REAL=$(git -C "$SR_ROOT" rev-parse --show-toplevel)
SR_DB="$SR_ROOT/.claude/tmb/trajectory.db"
sqlite3 "$SR_DB" "CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT);"
sqlite3 "$SR_DB" "CREATE TABLE repos(name TEXT PRIMARY KEY, path TEXT NOT NULL, file_count INTEGER NOT NULL DEFAULT 0, last_scanned_at TEXT NOT NULL DEFAULT (datetime('now')), target_branch TEXT, branching_model TEXT, protected_branches TEXT);"
sqlite3 "$SR_DB" "INSERT INTO repos (name, path) VALUES ('$(basename "$SR_REAL")', '$SR_REAL');"
out=$(run_hook_db "$SR_DB" "$(input_with_agent 'Edit' "$SR_REAL/src/foo.ts" 'bro')")
assert_contains "$out" '"permissionDecision":"deny"' "source under the single registered repo-at-root is guarded"

summarize
