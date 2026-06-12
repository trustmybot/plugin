#!/usr/bin/env bash
# Tests for scripts/hooks/swe-boundary.sh
#
# Hook contract: SWE boundary enforcement.
# (a) git push from SWE context → DENY
# (b) gh/glab MUTATING subcommands from SWE context → DENY (reads allowed)
# (c) Edit/Write target outside assigned worktree → DENY
# (d) Edit/Write to prompt-surface paths → DENY (unless prompt_bearing=1)
#
# Negative cases (bro context) prove bro is NOT blocked.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/swe-boundary.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
DB="$TMPDIR/trajectory.db"
export TRAJECTORY_DB_PATH="$DB"

WT_ROOT="$TMPDIR/repo/.claude/worktrees"
WORKTREE="$WT_ROOT/my-feature"
mkdir -p "$WORKTREE"

sqlite3 "$DB" "
  CREATE TABLE issues (
    id INTEGER PRIMARY KEY,
    objective TEXT NOT NULL DEFAULT 'test',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id),
    branch_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    spec_body TEXT NOT NULL DEFAULT '',
    prompt_bearing INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO issues VALUES (1, 'test', '', 'open', datetime('now'), datetime('now'));
  INSERT INTO tasks VALUES (10, 1, 'feat/my-feature', 'pending', '', 0);
  INSERT INTO tasks VALUES (11, 1, 'feat/prompt-task', 'pending', '', 1);
"

# Worktree for the prompt-bearing task (slug matches feat/prompt-task).
WT_PROMPT="$WT_ROOT/prompt-task"
mkdir -p "$WT_PROMPT"

run_hook_swe() {
  local input="$1"
  (cd "$WORKTREE" && echo "$input" | bash "$HOOK" 2>&1 || true)
}

run_hook_bro() {
  local input="$1"
  echo "$input" | bash "$HOOK" 2>&1 || true
}

run_hook_swe_pwd() {
  local input="$1"
  local pwd_dir="${2:-$WORKTREE}"
  (cd "$pwd_dir" && echo "$input" | bash "$HOOK" 2>&1 || true)
}

make_bash_input() {
  local agent_type="$1" cmd="$2"
  jq -n --arg a "$agent_type" --arg c "$cmd" '{
    tool_name: "Bash",
    agent_type: $a,
    tool_input: {command: $c}
  }'
}

make_edit_input() {
  local agent_type="$1" path="$2"
  jq -n --arg a "$agent_type" --arg p "$path" '{
    tool_name: "Edit",
    agent_type: $a,
    tool_input: {file_path: $p}
  }'
}

make_write_input() {
  local agent_type="$1" path="$2"
  jq -n --arg a "$agent_type" --arg p "$path" '{
    tool_name: "Write",
    agent_type: $a,
    tool_input: {file_path: $p}
  }'
}

make_transcript() {
  local task_id="$1"
  local tf="$TMPDIR/transcript_${task_id}.jsonl"
  printf '{"message":{"content":[{"type":"text","text":"task_id=%s worktree: /some/path"}]}}\n' "$task_id" > "$tf"
  echo "$tf"
}

# ===========================================================================
# Rule (a): git push from SWE context
# ===========================================================================

test_case "(a) SWE git push: DENIED"
out=$(run_hook_swe "$(make_bash_input swe 'git push origin feat/my-feature')")
assert_contains "$out" '"permissionDecision":"deny"' "SWE git push should be denied"
assert_contains "$out" "never push" "deny reason should say never push"

test_case "(a) SWE git push via cd prefix: DENIED"
out=$(run_hook_swe "$(make_bash_input swe "cd $WORKTREE && git push origin feat/my-feature")")
assert_contains "$out" '"permissionDecision":"deny"' "SWE git push with cd prefix should be denied"

test_case "(a) SWE git push --force: NOT denied by this hook (delegated to git-guards)"
out=$(run_hook_swe "$(make_bash_input swe 'git push --force origin feat/my-feature')")
assert_not_contains "$out" '"permissionDecision":"deny"' "force push should not be denied by swe-boundary (git-guards handles it)"

test_case "(a) bro git push: NOT denied (bro is the push agent)"
out=$(run_hook_bro "$(make_bash_input bro 'git push origin dev')")
assert_not_contains "$out" '"permissionDecision":"deny"' "bro push should not be denied"

test_case "(a) bro INSIDE worktree path: git commit/fetch/rebase NOT denied (explicit identity wins)"
out=$(run_hook_swe "$(make_bash_input bro 'git commit -m "review fixup"')")
assert_not_contains "$out" '"permissionDecision":"deny"' "bro git commit inside worktree should be allowed"
out=$(run_hook_swe "$(make_bash_input bro 'git fetch origin')")
assert_not_contains "$out" '"permissionDecision":"deny"' "bro git fetch inside worktree should be allowed"
out=$(run_hook_swe "$(make_bash_input bro 'git rebase origin/dev')")
assert_not_contains "$out" '"permissionDecision":"deny"' "bro git rebase inside worktree should be allowed"

test_case "(a) SWE git status: NOT denied (read-only git)"
out=$(run_hook_swe "$(make_bash_input swe 'git status')")
assert_not_contains "$out" '"permissionDecision":"deny"' "git status should not be denied"

test_case "(a) SWE git log: NOT denied"
out=$(run_hook_swe "$(make_bash_input swe 'git log --oneline -5')")
assert_not_contains "$out" '"permissionDecision":"deny"' "git log should not be denied"

# ===========================================================================
# Rule (b): gh/glab MUTATING subcommands from SWE context
# ===========================================================================

test_case "(b) SWE gh issue create: DENIED"
out=$(run_hook_swe "$(make_bash_input swe 'gh issue create --title "test"')")
assert_contains "$out" '"permissionDecision":"deny"' "SWE gh issue create should be denied"
assert_contains "$out" "mutating" "deny reason should mention mutating"

test_case "(b) SWE gh pr create: DENIED"
out=$(run_hook_swe "$(make_bash_input swe 'gh pr create --base dev')")
assert_contains "$out" '"permissionDecision":"deny"' "SWE gh pr create should be denied"

test_case "(b) SWE gh pr merge: DENIED"
out=$(run_hook_swe "$(make_bash_input swe 'gh pr merge 42')")
assert_contains "$out" '"permissionDecision":"deny"' "SWE gh pr merge should be denied"

test_case "(b) SWE gh api -X POST: DENIED"
out=$(run_hook_swe "$(make_bash_input swe 'gh api repos/foo/bar -X POST --field foo=bar')")
assert_contains "$out" '"permissionDecision":"deny"' "SWE gh api POST should be denied"

test_case "(b) SWE gh api --method DELETE: DENIED"
out=$(run_hook_swe "$(make_bash_input swe 'gh api repos/foo/bar --method DELETE')")
assert_contains "$out" '"permissionDecision":"deny"' "SWE gh api DELETE should be denied"

test_case "(b) SWE glab issue create: DENIED"
out=$(run_hook_swe "$(make_bash_input swe 'glab issue create --title "test"')")
assert_contains "$out" '"permissionDecision":"deny"' "SWE glab issue create should be denied"

test_case "(b) SWE glab mr create: DENIED"
out=$(run_hook_swe "$(make_bash_input swe 'glab mr create --source-branch feat/x')")
assert_contains "$out" '"permissionDecision":"deny"' "SWE glab mr create should be denied"

test_case "(b) SWE gh issue view: NOT denied (read-only)"
out=$(run_hook_swe "$(make_bash_input swe 'gh issue view 42')")
assert_not_contains "$out" '"permissionDecision":"deny"' "gh issue view should be allowed"

test_case "(b) SWE gh issue list: NOT denied (read-only)"
out=$(run_hook_swe "$(make_bash_input swe 'gh issue list --state open')")
assert_not_contains "$out" '"permissionDecision":"deny"' "gh issue list should be allowed"

test_case "(b) SWE gh pr view: NOT denied (read-only)"
out=$(run_hook_swe "$(make_bash_input swe 'gh pr view 42')")
assert_not_contains "$out" '"permissionDecision":"deny"' "gh pr view should be allowed"

test_case "(b) bro gh pr create: NOT denied (bro is allowed)"
out=$(run_hook_bro "$(make_bash_input bro 'gh pr create --base dev --head feat/x')")
assert_not_contains "$out" '"permissionDecision":"deny"' "bro gh pr create should not be denied"

# ===========================================================================
# Rule (c): Edit/Write target outside assigned worktree
# ===========================================================================

test_case "(c) SWE edit inside worktree: allowed"
out=$(run_hook_swe "$(make_edit_input swe "$WORKTREE/src/index.ts")")
assert_not_contains "$out" '"permissionDecision":"deny"' "edit inside worktree should be allowed"

test_case "(c) SWE edit outside worktree (absolute path to /tmp): DENIED"
out=$(run_hook_swe "$(make_edit_input swe '/tmp/some-file.ts')")
assert_contains "$out" '"permissionDecision":"deny"' "edit outside worktree should be denied"
assert_contains "$out" "outside the worktree" "deny reason should mention outside worktree"

test_case "(c) SWE write outside worktree: DENIED"
out=$(run_hook_swe "$(make_write_input swe '/etc/hosts')")
assert_contains "$out" '"permissionDecision":"deny"' "write outside worktree should be denied"

test_case "(c) bro edit outside any worktree: NOT denied by this hook"
out=$(run_hook_bro "$(make_edit_input bro '/tmp/some-file.ts')")
assert_not_contains "$out" '"permissionDecision":"deny"' "bro edit outside worktree should not be denied by swe-boundary"

# ===========================================================================
# Rule (d): prompt-surface paths
# ===========================================================================

# We run from a non-worktree PWD to avoid rule (c) triggering first.
NONWT_DIR="$TMPDIR/non-worktree"
mkdir -p "$NONWT_DIR"

make_edit_with_transcript() {
  local agent_type="$1" path="$2" task_id="$3"
  local tr
  tr=$(make_transcript "$task_id")
  jq -n --arg a "$agent_type" --arg p "$path" --arg tr "$tr" '{
    tool_name: "Edit",
    agent_type: $a,
    agent_transcript_path: $tr,
    tool_input: {file_path: $p}
  }'
}

test_case "(d) SWE edit agents/swe.md: DENIED (no prompt_bearing)"
out=$(cd "$NONWT_DIR" && echo "$(make_edit_with_transcript swe 'agents/swe.md' 10)" | bash "$HOOK" 2>&1 || true)
assert_contains "$out" '"permissionDecision":"deny"' "edit agents/swe.md should be denied"
assert_contains "$out" "prompt-surface" "deny reason should mention prompt-surface"

test_case "(d) SWE edit skills/tmb_planning/SKILL.md: DENIED"
out=$(cd "$NONWT_DIR" && echo "$(make_edit_with_transcript swe 'skills/tmb_planning/SKILL.md' 10)" | bash "$HOOK" 2>&1 || true)
assert_contains "$out" '"permissionDecision":"deny"' "edit SKILL.md should be denied"

test_case "(d) SWE edit CLAUDE.md: DENIED"
out=$(cd "$NONWT_DIR" && echo "$(make_edit_with_transcript swe 'CLAUDE.md' 10)" | bash "$HOOK" 2>&1 || true)
assert_contains "$out" '"permissionDecision":"deny"' "edit CLAUDE.md should be denied"

test_case "(d) SWE edit CODEX.md: DENIED"
out=$(cd "$NONWT_DIR" && echo "$(make_edit_with_transcript swe 'CODEX.md' 10)" | bash "$HOOK" 2>&1 || true)
assert_contains "$out" '"permissionDecision":"deny"' "edit CODEX.md should be denied"

test_case "(d) SWE edit commands/scan.md: DENIED"
out=$(cd "$NONWT_DIR" && echo "$(make_edit_with_transcript swe 'commands/scan.md' 10)" | bash "$HOOK" 2>&1 || true)
assert_contains "$out" '"permissionDecision":"deny"' "edit commands/scan.md should be denied"

test_case "(d) SWE edit agents/swe.md with prompt_bearing=1: ALLOWED"
out=$(cd "$NONWT_DIR" && echo "$(make_edit_with_transcript swe 'agents/swe.md' 11)" | bash "$HOOK" 2>&1 || true)
assert_not_contains "$out" '"permissionDecision":"deny"' "prompt_bearing=1 task should allow prompt-surface edit"

test_case "(d) SWE edit regular source file: NOT denied by rule (d)"
out=$(cd "$NONWT_DIR" && echo "$(make_edit_with_transcript swe 'src/index.ts' 10)" | bash "$HOOK" 2>&1 || true)
assert_not_contains "$out" '"permissionDecision":"deny"' "edit regular source file should not be denied by rule (d)"

test_case "(d) bro edit agents/swe.md: NOT denied by swe-boundary (bro is allowed)"
out=$(cd "$NONWT_DIR" && echo "$(make_edit_with_transcript bro 'agents/swe.md' 10)" | bash "$HOOK" 2>&1 || true)
assert_not_contains "$out" '"permissionDecision":"deny"' "bro edit prompt-surface should not be denied by swe-boundary"

test_case "(d) SWE edit templates/agents/architect.md: DENIED"
out=$(cd "$NONWT_DIR" && echo "$(make_edit_with_transcript swe 'templates/agents/architect.md' 10)" | bash "$HOOK" 2>&1 || true)
assert_contains "$out" '"permissionDecision":"deny"' "edit templates/ should be denied"

# ===========================================================================
# Rule (d) — slug fallback: task_id resolved from worktree slug, no transcript
# ===========================================================================

make_edit_no_transcript() {
  local agent_type="$1" path="$2"
  jq -n --arg a "$agent_type" --arg p "$path" '{
    tool_name: "Edit",
    agent_type: $a,
    tool_input: {file_path: $p}
  }'
}

test_case "(d/slug) prompt_bearing=1 task + worktree context + NO transcript: ALLOWED"
out=$(cd "$WT_PROMPT" && echo "$(make_edit_no_transcript swe "$WT_PROMPT/agents/swe.md")" | bash "$HOOK" 2>&1 || true)
assert_not_contains "$out" '"permissionDecision":"deny"' "prompt_bearing=1 via slug fallback should allow prompt-surface edit"

test_case "(d/slug) prompt_bearing=0 task + worktree context + NO transcript: DENIED"
out=$(cd "$WORKTREE" && echo "$(make_edit_no_transcript swe "$WORKTREE/agents/swe.md")" | bash "$HOOK" 2>&1 || true)
assert_contains "$out" '"permissionDecision":"deny"' "prompt_bearing=0 via slug fallback should deny prompt-surface edit"

test_case "(d/slug) no matching task for slug + NO transcript: DENIED"
WT_UNKNOWN="$WT_ROOT/unknown-task"
mkdir -p "$WT_UNKNOWN"
out=$(cd "$WT_UNKNOWN" && echo "$(make_edit_no_transcript swe "$WT_UNKNOWN/agents/swe.md")" | bash "$HOOK" 2>&1 || true)
assert_contains "$out" '"permissionDecision":"deny"' "no matching task slug should deny prompt-surface edit"

# ===========================================================================
# Rule (e): Bash write-forms targeting prompt surfaces
# ===========================================================================

make_bash_with_transcript() {
  local agent_type="$1" cmd="$2" task_id="$3"
  local tr
  tr=$(make_transcript "$task_id")
  jq -n --arg a "$agent_type" --arg c "$cmd" --arg tr "$tr" '{
    tool_name: "Bash",
    agent_type: $a,
    agent_transcript_path: $tr,
    tool_input: {command: $c}
  }'
}

test_case "(e) SWE redirect > to agents/swe.md: DENIED"
out=$(run_hook_swe "$(make_bash_with_transcript swe 'echo "content" > agents/swe.md' 10)")
assert_contains "$out" '"permissionDecision":"deny"' "redirect > to agents/*.md should be denied"
assert_contains "$out" "prompt-surface" "deny reason should mention prompt-surface"

test_case "(e) SWE redirect >> to CLAUDE.md: DENIED"
out=$(run_hook_swe "$(make_bash_with_transcript swe 'echo "extra" >> CLAUDE.md' 10)")
assert_contains "$out" '"permissionDecision":"deny"' "redirect >> to CLAUDE.md should be denied"

test_case "(e) SWE tee to commands/scan.md: DENIED"
out=$(run_hook_swe "$(make_bash_with_transcript swe 'cat template | tee commands/scan.md' 10)")
assert_contains "$out" '"permissionDecision":"deny"' "tee to commands/*.md should be denied"

test_case "(e) SWE sed -i on skills/tmb_planning/SKILL.md: DENIED"
out=$(run_hook_swe "$(make_bash_with_transcript swe "sed -i 's/old/new/' skills/tmb_planning/SKILL.md" 10)")
assert_contains "$out" '"permissionDecision":"deny"' "sed -i on SKILL.md should be denied"

test_case "(e) SWE perl -i on agents/bro.md: DENIED"
out=$(run_hook_swe "$(make_bash_with_transcript swe "perl -i -pe 's/old/new/' agents/bro.md" 10)")
assert_contains "$out" '"permissionDecision":"deny"' "perl -i on agents/*.md should be denied"

test_case "(e) SWE python3 open w to agents/swe.md: DENIED"
out=$(run_hook_swe "$(make_bash_with_transcript swe "python3 -c \"open('agents/swe.md','w').write('x')\"" 10)")
assert_contains "$out" '"permissionDecision":"deny"' "python3 open w to agents/*.md should be denied"

test_case "(e) SWE python open a to GEMINI.md: DENIED"
out=$(run_hook_swe "$(make_bash_with_transcript swe "python -c \"open('GEMINI.md','a').write('x')\"" 10)")
assert_contains "$out" '"permissionDecision":"deny"' "python open a to GEMINI.md should be denied"

test_case "(e) SWE cp src to templates/agents/foo.md: DENIED"
out=$(run_hook_swe "$(make_bash_with_transcript swe 'cp /tmp/foo.md templates/agents/foo.md' 10)")
assert_contains "$out" '"permissionDecision":"deny"' "cp to templates/*.md should be denied"

test_case "(e) SWE mv src to commands/foo.md: DENIED"
out=$(run_hook_swe "$(make_bash_with_transcript swe 'mv /tmp/foo.md commands/foo.md' 10)")
assert_contains "$out" '"permissionDecision":"deny"' "mv to commands/*.md should be denied"

test_case "(e) SWE rsync src to agents/: DENIED"
out=$(run_hook_swe "$(make_bash_with_transcript swe 'rsync -av /tmp/agent.md agents/agent.md' 10)")
assert_contains "$out" '"permissionDecision":"deny"' "rsync to agents/*.md should be denied"

test_case "(e) SWE cat agents/swe.md: NOT denied (read-only)"
out=$(run_hook_swe "$(make_bash_with_transcript swe 'cat agents/swe.md' 10)")
assert_not_contains "$out" '"permissionDecision":"deny"' "cat is read-only, should not be denied"

test_case "(e) SWE grep in agents/swe.md: NOT denied (read-only)"
out=$(run_hook_swe "$(make_bash_with_transcript swe 'grep "pattern" agents/swe.md' 10)")
assert_not_contains "$out" '"permissionDecision":"deny"' "grep is read-only, should not be denied"

test_case "(e) SWE sed -n on agents/swe.md: NOT denied (read-only)"
out=$(run_hook_swe "$(make_bash_with_transcript swe "sed -n '1,5p' agents/swe.md" 10)")
assert_not_contains "$out" '"permissionDecision":"deny"' "sed -n is read-only, should not be denied"

test_case "(e) SWE redirect > to non-prompt file: NOT denied"
out=$(run_hook_swe "$(make_bash_with_transcript swe 'echo "content" > src/index.ts' 10)")
assert_not_contains "$out" '"permissionDecision":"deny"' "redirect to non-prompt file should not be denied by rule (e)"

test_case "(e) SWE redirect > to agents/swe.md with prompt_bearing=1: ALLOWED"
out=$(run_hook_swe "$(make_bash_with_transcript swe 'echo "content" > agents/swe.md' 11)")
assert_not_contains "$out" '"permissionDecision":"deny"' "prompt_bearing=1 task should allow Bash write to prompt surface"

test_case "(e) SWE sed -i on CLAUDE.md via slug fallback (prompt_bearing=1): ALLOWED"
out=$(cd "$WT_PROMPT" && echo "$(make_bash_input swe "sed -i 's/old/new/' CLAUDE.md")" | bash "$HOOK" 2>&1 || true)
assert_not_contains "$out" '"permissionDecision":"deny"' "slug fallback prompt_bearing=1 should allow sed -i on CLAUDE.md"

test_case "(e) SWE redirect > to agents/swe.md via slug fallback (prompt_bearing=0): DENIED"
out=$(cd "$WORKTREE" && echo "$(make_bash_input swe 'echo x > agents/swe.md')" | bash "$HOOK" 2>&1 || true)
assert_contains "$out" '"permissionDecision":"deny"' "slug fallback prompt_bearing=0 should deny Bash write to prompt surface"

test_case "(e) bro redirect > to agents/swe.md: NOT denied (bro is not SWE)"
out=$(run_hook_bro "$(make_bash_input bro 'echo "content" > agents/swe.md')")
assert_not_contains "$out" '"permissionDecision":"deny"' "bro Bash write to prompt surface not denied by swe-boundary"

# ===========================================================================
# Rule (e) — false-positive regressions (destination-coupling)
# ===========================================================================

test_case "(e/fp) grep containing > char: NOT denied (not a redirect)"
out=$(run_hook_swe "$(make_bash_with_transcript swe 'grep ">" agents/swe.md' 10)")
assert_not_contains "$out" '"permissionDecision":"deny"' "grep with > in pattern should not be denied"

test_case "(e/fp) awk comparison > on .md file: NOT denied (comparison, not redirect)"
out=$(run_hook_swe "$(make_bash_with_transcript swe "awk '\$1 > 5' agents/swe.md" 10)")
assert_not_contains "$out" '"permissionDecision":"deny"' "awk comparison operator should not be denied"

test_case "(e/fp) echo with prompt path in string redirected to /tmp: NOT denied"
out=$(run_hook_swe "$(make_bash_with_transcript swe 'echo "see agents/swe.md for details" > /tmp/notes.txt' 10)")
assert_not_contains "$out" '"permissionDecision":"deny"' "redirect to /tmp mentioning a prompt path should not be denied"

test_case "(e/fp) git commit -m message mentioning agents/swe.md: NOT denied"
out=$(run_hook_swe "$(make_bash_with_transcript swe 'git commit -m "touch agents/swe.md"' 10)")
assert_not_contains "$out" '"permissionDecision":"deny"' "commit message mentioning prompt path should not be denied"

summarize
