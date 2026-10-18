#!/usr/bin/env bash
# Tests for scripts/hooks/swe-boundary.sh
#
# Hook contract: SWE boundary enforcement.
# (a) git push from SWE context → DENY
# (b) gh/glab MUTATING subcommands from SWE context → DENY (reads allowed)
# (c) Edit/Write target outside assigned worktree → DENY
# (d) Edit/Write to CLAUDE.md at the worktree root → DENY (always);
#     to other prompt-surface paths → DENY (unless prompt_bearing=1)
# (e) Bash-written CLAUDE.md at the worktree root → DENY (always);
#     other prompt-surface paths → DENY (unless prompt_bearing=1)
# (f) Bash-written path outside the task's files[] dirs → ALLOWED with a
#     once-per-path additionalContext note
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

# Every case resolves against this fixture's project; only the walk-up cases
# below drop CLAUDE_PROJECT_DIR, so no case reads the ambient value.
export CLAUDE_PROJECT_DIR="$TMPDIR/repo"

WT_ROOT="$CLAUDE_PROJECT_DIR/.claude/worktrees"
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
    prompt_bearing INTEGER NOT NULL DEFAULT 0,
    files TEXT NOT NULL DEFAULT '[]'
  );
  INSERT INTO issues VALUES (1, 'test', '', 'open', datetime('now'), datetime('now'));
  INSERT INTO tasks VALUES (10, 1, 'feat/my-feature', 'pending', '', 0, '[]');
  INSERT INTO tasks VALUES (11, 1, 'feat/prompt-task', 'pending', '', 1, '[]');
  INSERT INTO tasks VALUES (12, 1, 'fix/failed-pb', 'failed', '', 1, '[]');
  INSERT INTO tasks VALUES (13, 1, 'fix/failed-nonpb', 'failed', '', 0, '[]');
"

# Worktree for the prompt-bearing task (slug matches feat/prompt-task).
WT_PROMPT="$WT_ROOT/prompt-task"
mkdir -p "$WT_PROMPT"

# Worktrees for the failed-status tasks (slug matches branch_id suffix).
WT_FAILED_PB="$WT_ROOT/failed-pb"
WT_FAILED_NONPB="$WT_ROOT/failed-nonpb"
mkdir -p "$WT_FAILED_PB" "$WT_FAILED_NONPB"

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

# #1016: whitespace-tolerant / wrapper-form push detection must not fail open.
test_case "(a) SWE 'git  push' (double space): DENIED"
out=$(run_hook_swe "$(make_bash_input swe 'git  push origin feat/my-feature')")
assert_contains "$out" '"permissionDecision":"deny"' "double-space SWE push must not fail open"

test_case "(a) SWE 'bash -c \"git push ...\"' wrapper: DENIED"
out=$(run_hook_swe "$(make_bash_input swe 'bash -c "git push origin feat/my-feature"')")
assert_contains "$out" '"permissionDecision":"deny"' "wrapped SWE push must not fail open"

test_case "(a) SWE 'eval \"git push ...\"' wrapper: DENIED"
out=$(run_hook_swe "$(make_bash_input swe 'eval "git push origin feat/my-feature"')")
assert_contains "$out" '"permissionDecision":"deny"' "eval-wrapped SWE push must not fail open"

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

test_case "(d/anchor) SWE edit <worktree>/src/agents/notes.md on a non-prompt_bearing task: ALLOWED"
out=$(run_hook_swe "$(make_edit_with_transcript swe "$WORKTREE/src/agents/notes.md" 10)")
assert_not_contains "$out" '"permissionDecision":"deny"' "a nested agents/ dir is not prompt surface"

test_case "(d/anchor) SWE edit <worktree>/agents/notes.md on a non-prompt_bearing task: DENIED"
out=$(run_hook_swe "$(make_edit_with_transcript swe "$WORKTREE/agents/notes.md" 10)")
assert_contains "$out" '"permissionDecision":"deny"' "a root agents/ dir is prompt surface"

# ===========================================================================
# Rule (d) — failed-status + absolute target + PWD NOT in worktree (#597)
# The regression: a prompt_bearing=1 task whose row is `failed`, edited via an
# ABSOLUTE path while $PWD is outside any worktree, was wrongly denied because
# WORKTREE_ROOT came from $PWD and the slug query filtered on transient status.
# ===========================================================================

test_case "(d/597) failed-status prompt_bearing=1, absolute target, PWD outside worktree: ALLOWED"
out=$(cd "$NONWT_DIR" && echo "$(make_edit_no_transcript swe "$WT_FAILED_PB/agents/swe.md")" | bash "$HOOK" 2>&1 || true)
assert_not_contains "$out" '"permissionDecision":"deny"' "failed-status prompt_bearing=1 via absolute target should be allowed"

test_case "(d/597) failed-status prompt_bearing=0, absolute target, PWD outside worktree: DENIED"
out=$(cd "$NONWT_DIR" && echo "$(make_edit_no_transcript swe "$WT_FAILED_NONPB/agents/swe.md")" | bash "$HOOK" 2>&1 || true)
assert_contains "$out" '"permissionDecision":"deny"' "failed-status prompt_bearing=0 via absolute target should still be denied"

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

test_case "(e) SWE redirect > to agents/swe.md with prompt_bearing=1 (transcript resolves task): ALLOWED"
# Run from a non-worktree PWD so the transcript is the resolver (no slug match).
out=$(run_hook_swe_pwd "$(make_bash_with_transcript swe 'echo "content" > agents/swe.md' 11)" "$NONWT_DIR")
assert_not_contains "$out" '"permissionDecision":"deny"' "prompt_bearing=1 task should allow Bash write to prompt surface"

test_case "(e) SWE sed -i on the root CLAUDE.md on a prompt_bearing=1 task: DENIED (always)"
out=$(cd "$WT_PROMPT" && echo "$(make_bash_input swe "sed -i 's/old/new/' CLAUDE.md")" | bash "$HOOK" 2>&1 || true)
assert_contains "$out" '"permissionDecision":"deny"' "prompt_bearing does not lift the root CLAUDE.md deny"
assert_contains "$out" "Human-owned" "the CLAUDE.md reason"

test_case "(d) SWE Edit of the root CLAUDE.md on a prompt_bearing=1 task: DENIED (always)"
out=$(cd "$WT_PROMPT" && echo "$(make_edit_input swe "$WT_PROMPT/CLAUDE.md")" | bash "$HOOK" 2>&1 || true)
assert_contains "$out" '"permissionDecision":"deny"' "prompt_bearing does not lift the root CLAUDE.md deny for Edit"
assert_contains "$out" "Human-owned" "the CLAUDE.md reason"

test_case "(d) SWE Edit of a nested docs/CLAUDE.md on a prompt_bearing=1 task: ALLOWED"
out=$(cd "$WT_PROMPT" && echo "$(make_edit_input swe "$WT_PROMPT/docs/CLAUDE.md")" | bash "$HOOK" 2>&1 || true)
assert_not_contains "$out" '"permissionDecision":"deny"' "only the repo-root CLAUDE.md is always denied"

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

# ===========================================================================
# GH 1196 — role from identity only; quoted text and heredocs are data
# ===========================================================================

make_bash_no_agent() {
  jq -n --arg d "$1" --arg c "$2" '{tool_name: "Bash", cwd: $d, tool_input: {command: $c}}'
}

test_case "GH 1196: bro 'cd <main> && gh issue create' with the shell inside a worktree: NOT denied"
out=$(run_hook_swe "$(make_bash_no_agent "$WORKTREE" "cd $TMPDIR/repo && gh issue create --title t --body b")")
assert_not_contains "$out" '"permissionDecision":"deny"' "no agent_type is bro, whatever the cwd"

test_case "GH 1196: bro 'git -C <main> push' with the shell inside a worktree: NOT denied"
out=$(run_hook_swe "$(make_bash_no_agent "$WORKTREE" "git -C $TMPDIR/repo push origin dev")")
assert_not_contains "$out" "SWE must never push" "a path never makes bro an SWE"

test_case "GH 1196: SWE python one-liner writing text that mentions gh pr merge: NOT denied"
out=$(run_hook_swe "$(make_bash_input swe "python3 -c \"open('t.txt','w').write('then gh pr merge 3 --merge')\"")")
assert_not_contains "$out" '"permissionDecision":"deny"' "a python program's text is data"

test_case "GH 1196: SWE markdown heredoc mentioning gh pr merge and git push: NOT denied"
out=$(run_hook_swe "$(make_bash_input swe "$(printf '%s\n' "cat > notes.md <<'EOF'" 'gh pr merge 12 --merge' 'git push origin dev' 'EOF')")")
assert_not_contains "$out" '"permissionDecision":"deny"' "heredoc content is data"

test_case "GH 1196: SWE real gh pr merge after a heredoc: DENIED"
out=$(run_hook_swe "$(make_bash_input swe "$(printf '%s\n' "cat > notes.md <<'EOF'" 'text' 'EOF' 'gh pr merge 12 --merge')")")
assert_contains "$out" "gh/glab mutating" "a real statement after the heredoc still fires"

# ===========================================================================
# Rule (b) word parsing — the HTTP verb of an api call is found in any flag
# position and spelling; wrappers and absolute paths do not hide argv0.
# ===========================================================================

for gh_cmd in 'gh api -X POST x' 'gh api -XPOST x' 'gh api --method DELETE x' \
  'gh api --method=PATCH x' 'gh api x -X PUT' '/usr/bin/gh api -X POST x' \
  'sudo gh api -X POST x' 'glab api -X POST x' 'gh api -X post x' \
  'gh issue comment 3 --body x' 'gh release create v1' 'gh repo delete o/r' \
  'gh api repos/o/r/issues -f title=x' 'gh api repos/o/r/issues -F body=@f' \
  'gh api --input body.json repos/o/r/labels' 'glab api projects/1/issues -f title=x'; do
  test_case "(b) SWE '$gh_cmd': DENIED"
  out=$(run_hook_swe "$(make_bash_input swe "$gh_cmd")")
  assert_contains "$out" "gh/glab mutating" "a forge write must be denied for SWE"
done

for gh_cmd in 'gh api repos/o/r' 'gh api -X GET x' 'gh release view v1' \
  'gh api -X GET repos/o/r -f per_page=5' 'echo "gh api repos/o/r/issues -f title=x"' \
  "cat > notes.md <<'EOF'
gh api -X POST x
gh api --method=PATCH x
EOF" \
  'echo "gh api -X POST x"' "grep -n 'gh api --method DELETE x' notes.md"; do
  test_case "(b) SWE read-only or data '${gh_cmd%%$'\n'*}': NOT denied"
  out=$(run_hook_swe "$(make_bash_input swe "$gh_cmd")")
  assert_not_contains "$out" '"permissionDecision":"deny"' "a read or a quoted/heredoc mention is allowed"
done

# Rule (b) — gh/glab is found at any word of a statement, so any wrapper,
# its options and VAR=value prefixes run it without hiding it.

for gh_cmd in 'timeout 5 gh pr merge 3' 'nice gh issue create -t x' \
  'xargs gh pr merge <<< 3' 'echo 3 | xargs -I{} gh pr merge {}' \
  'time -p gh api -X POST x' 'timeout 5 gh api -X POST x' \
  'nice -n 10 glab mr merge 4' 'stdbuf -oL gh issue close 9' \
  'FOO=1 timeout 5 gh pr merge 3' 'ionice -c3 gh pr merge 3' \
  'env -i FOO=1 gh pr merge 3' 'sudo -u bob gh pr merge 3' \
  'xargs -I{} -P4 gh issue close {}'; do
  test_case "(b) SWE wrapped '$gh_cmd': DENIED"
  out=$(run_hook_swe "$(make_bash_input swe "$gh_cmd")")
  assert_contains "$out" "gh/glab mutating" "a wrapped forge write must be denied for SWE"
done

for gh_cmd in 'timeout 5 gh pr view 3' 'echo "timeout 5 gh pr merge 3"' \
  'gh api -X GET x' 'git log --grep="gh pr merge"'; do
  test_case "(b) SWE wrapped read or data '$gh_cmd': NOT denied"
  out=$(run_hook_swe "$(make_bash_input swe "$gh_cmd")")
  assert_not_contains "$out" '"permissionDecision":"deny"' "a wrapped read or a quoted mention is allowed"
done

# GH 1281 — only command-position words run gh/glab: a test fixture written
# through a heredoc, a quoted argument and a data command's operand are text.

for gh_cmd in "cat > x.test.ts <<'EOF'
it('closes', () => {
  run('gh', ['issue', 'close', '1'])
  // gh issue close 1
})
EOF" \
  "printf 'gh pr merge' > notes.txt" 'echo gh pr merge 1' \
  "cat > notes.md <<-EOF
	gh issue close 1
	EOF" \
  "x=\$(cat <<'EOF'
gh pr merge 1
EOF
)"; do
  test_case "GH 1281: SWE text naming a gh mutation '${gh_cmd%%$'\n'*}': NOT denied"
  out=$(run_hook_swe "$(make_bash_input swe "$gh_cmd")")
  assert_not_contains "$out" '"permissionDecision":"deny"' "text is data"
done

for gh_cmd in 'echo "$(gh pr merge 1)"' 'GH_TOKEN=x gh api -X POST repos/o/r/issues' \
  '/usr/bin/gh issue close 2' 'glab mr merge 3' "printf 'x' | xargs gh pr merge" \
  'sudo -u git gh pr merge 1' 'env -u cat gh pr merge 1' 'git bisect run gh pr merge 1' \
  'git submodule foreach gh pr merge 1' "git rebase -x 'gh pr merge 1' main" \
  'git submodule --quiet foreach gh pr merge 1' 'git submodule -q foreach gh pr merge 1' \
  "git rebase -ix 'gh pr merge 1' main" "git rebase -kx 'gh pr merge 1' main" \
  "git rebase --exe='gh pr merge 1' main" "git rebase -i --exe 'gh pr merge 1' main" \
  'git rebase -x "echo hi && gh pr merge 1" main' "git submodule foreach 'echo x; gh pr merge 1'"; do
  test_case "GH 1281: SWE real gh/glab mutation '$gh_cmd': DENIED"
  out=$(run_hook_swe "$(make_bash_input swe "$gh_cmd")")
  assert_contains "$out" "gh/glab mutating" "a command-position forge write still fires"
done

test_case "(b) tmb_gh_mutation keeps no wrapper allowlist"
gh_fn=$(sed -n '/^tmb_gh_mutation() {/,/^}/p' "$PLUGIN_ROOT/scripts/hooks/lib/cmd-analysis.sh")
assert_not_contains "$gh_fn" "nohup" "no wrapper list in tmb_gh_mutation"
assert_not_contains "$gh_fn" "*/sudo" "no wrapper list in tmb_gh_mutation"
assert_not_contains "$gh_fn" "--split-string" "no wrapper option list in tmb_gh_mutation"

# ===========================================================================
# GH 1272 — every Bash write shape reaches the Edit/Write decision for both the
# prompt-surface rule (e) and the scope fence (f).
# ===========================================================================

sqlite3 "$DB" "
  INSERT INTO tasks (id, issue_id, branch_id, status, spec_body, prompt_bearing, files)
    VALUES (20, 1, 'feat/shape-plain', 'running', '', 0, '[\"src/index.ts\",\"notes/\",\"myskills/\"]');
  INSERT INTO tasks (id, issue_id, branch_id, status, spec_body, prompt_bearing, files)
    VALUES (21, 1, 'feat/shape-prompt', 'running', '', 1, '[\"agents/\",\"skills/\",\"commands/\",\"templates/\",\"CLAUDE.md\",\"src/\"]');
"
WT_PLAIN="$WT_ROOT/shape-plain"
WT_PB="$WT_ROOT/shape-prompt"
mkdir -p "$WT_PLAIN" "$WT_PB"

SURFACE='skills/tmb_audit/SKILL.md'
IN_FENCE='src/index.ts'

# shape_write <shape> <target>: the shape writing <target>.
shape_write() {
  local t="$2"
  case "$1" in
    '>') printf 'echo x > %s' "$t" ;;
    '>>') printf 'echo x >> %s' "$t" ;;
    heredoc) printf "cat > %s <<'EOF'\nbody\nEOF" "$t" ;;
    tee) printf 'echo x | tee %s' "$t" ;;
    'tee -a') printf 'echo x | tee -a %s' "$t" ;;
    'sed -i') printf "sed -i 's/a/b/' %s" "$t" ;;
    'perl -i') printf "perl -i -pe 's/a/b/' %s" "$t" ;;
    cp) printf 'cp /tmp/src.md %s' "$t" ;;
    mv) printf 'mv /tmp/src.md %s' "$t" ;;
    install) printf 'install -m 644 /tmp/src.md %s' "$t" ;;
    rsync) printf 'rsync -a /tmp/src.md %s' "$t" ;;
    python3) printf "python3 -c \"open('%s','w').write('x')\"" "$t" ;;
    node) printf "node -e \"require('fs').writeFileSync('%s','x')\"" "$t" ;;
    dd) printf 'dd if=/tmp/src.md of=%s' "$t" ;;
    '>|') printf 'echo x >| %s' "$t" ;;
    'exec N>') printf 'exec 3> %s' "$t" ;;
    truncate) printf 'truncate -s 0 %s' "$t" ;;
    'git mv') printf 'git mv /tmp/src.md %s' "$t" ;;
    'perl -e') printf "perl -e 'open(my \$f, \">\", \"%s\")'" "$t" ;;
  esac
}

# shape_read_input <shape> <surface> <out>: the shape writing <out> with the
# surface path only as a read input.
shape_read_input() {
  local src="$2" out="$3"
  case "$1" in
    '>') printf 'cat %s > %s' "$src" "$out" ;;
    '>>') printf 'cat %s >> %s' "$src" "$out" ;;
    heredoc) printf "cat - %s > %s <<'EOF'\nbody\nEOF" "$src" "$out" ;;
    tee) printf 'cat %s | tee %s' "$src" "$out" ;;
    'tee -a') printf 'cat %s | tee -a %s' "$src" "$out" ;;
    'sed -i') printf "sed -i '/x/r %s' %s" "$src" "$out" ;;
    'perl -i') printf "perl -i -pe 'BEGIN{open(F,\"%s\")}' %s" "$src" "$out" ;;
    cp) printf 'cp %s %s' "$src" "$out" ;;
    install) printf 'install -m 644 %s %s' "$src" "$out" ;;
    rsync) printf 'rsync -a %s %s' "$src" "$out" ;;
    python3) printf "python3 -c \"open('%s','w').write(open('%s').read())\"" "$out" "$src" ;;
    node) printf "node -e \"const fs=require('fs'); fs.writeFileSync('%s', fs.readFileSync('%s'))\"" "$out" "$src" ;;
    dd) printf 'dd if=%s of=%s' "$src" "$out" ;;
  esac
}

run_in() { (cd "$1" && echo "$(make_bash_input swe "$2")" | bash "$HOOK" 2>&1 || true); }

for shape in '>' '>>' heredoc tee 'tee -a' 'sed -i' 'perl -i' cp mv install rsync python3 node dd \
  '>|' 'exec N>' truncate 'git mv' 'perl -e'; do
  test_case "GH 1272 [$shape] non-prompt-bearing task writes $SURFACE: DENIED"
  out=$(run_in "$WT_PLAIN" "$(shape_write "$shape" "$SURFACE")")
  assert_contains "$out" '"permissionDecision":"deny"' "a surface write via $shape is denied"
  assert_contains "$out" "prompt-surface" "the prompt-surface reason"

  test_case "GH 1272 [$shape] prompt-bearing task writes $SURFACE: ALLOWED"
  out=$(run_in "$WT_PB" "$(shape_write "$shape" "$SURFACE")")
  assert_not_contains "$out" '"permissionDecision":"deny"' "prompt_bearing=1 lifts the surface rule for $shape"

  OUT_OF_FENCE="scripts/hooks/x-$(printf '%s' "$shape" | cksum | cut -d' ' -f1).sh"
  test_case "GH 1295 [$shape] write outside files[] ($OUT_OF_FENCE): ALLOWED with a note"
  out=$(run_in "$WT_PLAIN" "$(shape_write "$shape" "$OUT_OF_FENCE")")
  assert_not_contains "$out" '"permissionDecision":"deny"' "an out-of-fence write via $shape is allowed"
  assert_contains "$out" "$OUT_OF_FENCE is outside this task's files[]" "the note names the path"
  assert_contains "$out" "additionalContext" "the note is additionalContext"

  test_case "GH 1272 [$shape] write inside files[] ($IN_FENCE): ALLOWED"
  out=$(run_in "$WT_PLAIN" "$(shape_write "$shape" "$IN_FENCE")")
  assert_not_contains "$out" '"permissionDecision":"deny"' "an in-fence write via $shape is allowed"

  read_cmd=$(shape_read_input "$shape" "$SURFACE" "$IN_FENCE")
  if [ -n "$read_cmd" ]; then
    test_case "GH 1272 [$shape] in-fence write with $SURFACE as read input: ALLOWED"
    out=$(run_in "$WT_PLAIN" "$read_cmd")
    assert_not_contains "$out" '"permissionDecision":"deny"' "a surface read input of $shape is not a write"
  fi
done

for read_cmd in "cat $SURFACE" "grep -n x $SURFACE" "sed -n '1,5p' $SURFACE" "head -3 $SURFACE" \
  "python3 -c \"print(open('$SURFACE').read())\"" "node -e \"process.stdout.write(require('fs').readFileSync('$SURFACE'))\"" \
  "grep -rn x skills/ > /dev/null"; do
  test_case "GH 1272 read '$read_cmd': ALLOWED"
  out=$(run_in "$WT_PLAIN" "$read_cmd")
  assert_not_contains "$out" '"permissionDecision":"deny"' "a read never fires"
done

test_case "GH 1272 mv removes its source: moving $SURFACE away is a surface write"
out=$(run_in "$WT_PLAIN" "mv $SURFACE $IN_FENCE")
assert_contains "$out" "prompt-surface" "the mv source is removed, so it is written"

test_case "GH 1272 path boundary: myskills/ is not the skills/ surface"
out=$(run_in "$WT_PLAIN" 'echo x > myskills/notes.md')
assert_not_contains "$out" '"permissionDecision":"deny"' "myskills/x.md is neither a surface nor out of fence"

test_case "GH 1272 rules/ and .claude/agents/ are surfaces"
out=$(run_in "$WT_PLAIN" 'echo x > rules/style.md')
assert_contains "$out" "prompt-surface" "rules/*.md is a surface"
out=$(run_in "$WT_PLAIN" 'echo x > .claude/agents/local.md')
assert_contains "$out" "prompt-surface" ".claude/agents/*.md is a surface"

test_case "GH 1272 directory-aware: cd into skills/ then write a relative path"
out=$(run_in "$WT_PLAIN" 'cd skills && echo x > tmb_audit/SKILL.md')
assert_contains "$out" "prompt-surface" "the statement's cd dir is applied"
out=$(run_in "$WT_PLAIN" 'cd src && echo x > ../skills/tmb_audit/SKILL.md')
assert_contains "$out" "prompt-surface" "a ../ path from the cd dir is normalized"
out=$(run_in "$WT_PLAIN" 'cd src && echo x > index.ts')
assert_not_contains "$out" '"permissionDecision":"deny"' "src/index.ts via cd stays in fence"

test_case "GH 1272 bash -c and a second statement are judged"
out=$(run_in "$WT_PLAIN" "bash -c 'echo x > $SURFACE'")
assert_contains "$out" "prompt-surface" "a bash -c body is a statement"
out=$(run_in "$WT_PLAIN" "echo ok > $IN_FENCE && echo x > docs/second-statement.md")
assert_contains "$out" "docs/second-statement.md is outside this task's files[]" "every statement's paths are judged"

test_case "GH 1272 interpreter write mode with the path in argv"
out=$(run_in "$WT_PLAIN" "python3 -c \"import sys; open(sys.argv[1],'w').write('x')\" $SURFACE")
assert_contains "$out" "prompt-surface" "the operand of a writing one-liner is written"
out=$(run_in "$WT_PLAIN" "python3 -c \"from pathlib import Path; Path('$SURFACE').write_text('x')\"")
assert_contains "$out" "prompt-surface" "write_text"
out=$(run_in "$WT_PLAIN" "node -e \"require('fs').appendFileSync('$SURFACE','x')\"")
assert_contains "$out" "prompt-surface" "appendFileSync"

test_case "GH 1272 writes outside the worktree are not fenced (/dev/null, /tmp)"
out=$(run_in "$WT_PLAIN" 'ls 2>/dev/null > /tmp/swe-boundary-out.txt')
assert_not_contains "$out" '"permissionDecision":"deny"' "the fence covers the worktree only"

test_case "GH 1272 task with empty files[]: no note"
out=$(run_in "$WORKTREE" "echo x > scripts/hooks/empty-files.sh")
assert_not_contains "$out" '"permissionDecision":"deny"' "no typed files[] means no fence, as for Edit"
assert_not_contains "$out" "outside this task's files[]" "no typed files[] means no note"

test_case "GH 1295 ordinary out-of-fence write inside the worktree: ALLOWED, noted once per path"
out=$(run_in "$WT_PLAIN" 'echo x > docs/once.md')
assert_not_contains "$out" '"permissionDecision":"deny"' "an ordinary out-of-fence path is allowed"
assert_contains "$out" "docs/once.md is outside this task's files[] (myskills, notes, src)" "the note lists files[] dirs"
assert_contains "$out" "list it and why in your report" "the note asks for the report entry"
out=$(run_in "$WT_PLAIN" 'echo y >> docs/once.md')
assert_not_contains "$out" "outside this task's files[]" "the second write to the same path is silent"
assert_eq "$([ -d "$TMPDIR/locks/scope-notes/20" ] && echo yes)" "yes" "the marker lives under the state dir's locks/"

test_case "GH 1295 Edit outside the worktree and prompt surface on a non-bearing task stay DENIED"
out=$(cd "$WT_PLAIN" && echo "$(make_edit_input swe '/tmp/elsewhere.ts')" | bash "$HOOK" 2>&1 || true)
assert_contains "$out" "outside the worktree" "outside-worktree Edit is denied"
out=$(cd "$WT_PLAIN" && echo "$(make_edit_input swe "$WT_PLAIN/$SURFACE")" | bash "$HOOK" 2>&1 || true)
assert_contains "$out" "prompt-surface" "prompt-surface Edit on a non-bearing task is denied"
out=$(run_in "$WT_PLAIN" 'echo x > CLAUDE.md')
assert_contains "$out" "Human-owned" "a Bash write to the root CLAUDE.md is denied"

test_case "GH 1272 Edit/Write and Bash share one surface predicate"
out=$(cd "$WT_PLAIN" && echo "$(make_edit_input swe "$WT_PLAIN/rules/style.md")" | bash "$HOOK" 2>&1 || true)
assert_contains "$out" "prompt-surface" "Edit of rules/*.md reaches the same decision"

test_case "GH 1272 one shared write-shape list: neither guard carries its own copy"
for guard in swe-boundary.sh no-source-edit-from-main.sh; do
  body=$(cat "$PLUGIN_ROOT/scripts/hooks/$guard")
  assert_not_contains "$body" "sed -i" "$guard names no write shape itself"
  assert_not_contains "$body" "_is_prompt_surface_token" "$guard keeps no surface predicate of its own"
  assert_contains "$body" "tmb_cmd_write_paths" "$guard takes written paths from the lib"
  assert_contains "$body" "tmb_is_prompt_surface_path" "$guard takes the surface predicate from the lib"
done

# ===========================================================================
# GH 1279 — a program fed to an interpreter through a heredoc is analysed for
# the paths it writes; a variable set earlier in the same command is resolved;
# a target behind a variable the command does not set is denied for a
# non-prompt-bearing swe. A path outside the worktree is containment-guard's
# deny on the same PreToolUse event, so those cases run both hooks.
# ===========================================================================

CG_HOOK="$PLUGIN_ROOT/scripts/hooks/containment-guard.sh"
sqlite3 "$DB" "
  CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY, task_id INTEGER, issue_id INTEGER, agent_type TEXT,
    started_at TEXT, completed_at TEXT, root_dir TEXT, host TEXT
  );
  INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, root_dir, host)
    VALUES (20, 1, 'swe', datetime('now'), '$WT_PLAIN', 'claude');
"
# run_event <dir> <command>: swe-boundary then containment-guard, as Claude
# Code runs both on one Bash PreToolUse.
run_event() {
  local input
  input=$(make_bash_input swe "$2")
  (cd "$1" && { echo "$input" | bash "$HOOK"; echo "$input" | bash "$CG_HOOK"; } 2>&1 || true)
}
heredoc_prog() { printf '%s\n' "$1 <<'EOF'" "$2" 'EOF'; }

test_case "GH 1279 swe python3 heredoc writing outside the worktree: DENIED"
out=$(run_event "$WT_PLAIN" "$(heredoc_prog 'python3 -' "open('/etc/tmb-1279', 'w').write('x')")")
assert_contains "$out" '"permissionDecision":"deny"' "the program's write is judged"
assert_contains "$out" "/etc/tmb-1279 is outside this run's root" "containment names the path"

test_case "GH 1279 swe python3 heredoc writing inside the worktree: ALLOWED"
out=$(run_event "$WT_PLAIN" "$(heredoc_prog 'python3 -' "open('$IN_FENCE', 'w').write('x')")")
assert_not_contains "$out" '"permissionDecision":"deny"' "an in-worktree, in-fence write"

test_case "GH 1279 swe heredoc programs reach the prompt-surface rule"
for interp in 'python3 -' python3 'node' 'ruby -' 'perl'; do
  case "$interp" in
    python3*) prog="open('$SURFACE', 'w').write('x')" ;;
    node) prog="require('fs').writeFileSync('$SURFACE', 'x')" ;;
    ruby*) prog="File.write('$SURFACE', 'x')" ;;
    perl) prog="open(my \$f, '>', '$SURFACE');" ;;
  esac
  out=$(run_in "$WT_PLAIN" "$(heredoc_prog "$interp" "$prog")")
  assert_contains "$out" "prompt-surface" "$interp heredoc writing $SURFACE"
  out=$(run_in "$WT_PB" "$(heredoc_prog "$interp" "$prog")")
  assert_not_contains "$out" '"permissionDecision":"deny"' "$interp heredoc on a prompt-bearing task"
done
out=$(run_in "$WT_PLAIN" "$(heredoc_prog 'bash -s' "echo x > $SURFACE")")
assert_contains "$out" "prompt-surface" "an sh program's redirect"

test_case "GH 1279 a data heredoc is never scanned"
out=$(run_in "$WT_PLAIN" "$(heredoc_prog 'cat > notes/fixture.py' "open('$SURFACE', 'w')")")
assert_not_contains "$out" '"permissionDecision":"deny"' "cat > f <<EOF body is data"
out=$(run_in "$WT_PLAIN" "$(heredoc_prog 'python3 notes/run.py' "open('$SURFACE', 'w')")")
assert_not_contains "$out" '"permissionDecision":"deny"' "stdin of a script is data"

test_case "GH 1279 variable-held write targets"
out=$(run_event "$WT_PLAIN" 'OUT=/etc/tmb-1279-var; cat > "$OUT" < /dev/null')
assert_contains "$out" "/etc/tmb-1279-var is outside this run's root" "OUT=/etc/x; cat > \$OUT is judged on /etc/x"
out=$(run_event "$WT_PLAIN" "OUT=$WT_PLAIN/$IN_FENCE; cat > \"\$OUT\" < /dev/null")
assert_not_contains "$out" '"permissionDecision":"deny"' "OUT=<worktree>/f; cat > \$OUT"
out=$(run_in "$WT_PLAIN" "D=skills/tmb_audit; echo x > \"\$D/SKILL.md\"")
assert_contains "$out" "prompt-surface" "a resolved variable reaches the prompt-surface rule"
out=$(run_in "$WT_PLAIN" 'cat > "$UNKNOWN/f" < /dev/null')
assert_contains "$out" '"permissionDecision":"deny"' "an unresolvable target is denied"
assert_contains "$out" 'write target \"$UNKNOWN/f\" depends on a variable the guard cannot resolve in this command; inline the path or set the variable in the same command.' "the deny names the variable"
out=$(run_in "$WT_PLAIN" 'F=$(mktemp); echo x > "$F"')
assert_contains "$out" 'write target \"$F\"' "a value built by \$( ) is unresolvable"
out=$(run_in "$WT_PB" 'cat > "$UNKNOWN/f" < /dev/null')
assert_not_contains "$out" '"permissionDecision":"deny"' "a prompt-bearing swe follows the prompt-surface rules as today"
out=$(run_hook_bro "$(make_bash_input bro 'cat > "$UNKNOWN/f" < /dev/null')")
assert_not_contains "$out" "cannot resolve" "bro is not judged by swe-boundary"

# ===========================================================================
# GH 1324 — a loop variable fed by an in-root glob or path lister is judged
# where its files lie; $OLDPWD is the dir before the command's last cd.
# ===========================================================================

mkdir -p "$WT_PLAIN/tests" "$WT_PLAIN/src/a"

test_case "GH 1324 swe bulk loops over in-worktree files: ALLOWED"
out=$(run_event "$WT_PLAIN" "for f in $WT_PLAIN/tests/*.sh; do sed -i 's/a/b/' \"\$f\"; done")
assert_not_contains "$out" '"permissionDecision":"deny"' "for f in <root>/tests/*.sh; sed -i"
out=$(run_event "$WT_PLAIN" "for f in \$(find $WT_PLAIN -name '*.md'); do printf x >> \"\$f\"; done")
assert_not_contains "$out" '"permissionDecision":"deny"' "for f in \$(find <root> -name '*.md'); printf >>"
out=$(run_event "$WT_PLAIN" "while read -r f; do sed -i 's/a/b/' \"\$f\"; done < <(git ls-files src)")
assert_not_contains "$out" '"permissionDecision":"deny"' "while read … done < <(git ls-files src)"
out=$(run_event "$WT_PLAIN" "find src -name '*.ts' | while read -r f; do cp \"\$f\" \"\${f%.ts}.bak\"; done")
assert_not_contains "$out" '"permissionDecision":"deny"' "find src | while read; the \${f%.ts}.bak suffix"

test_case "GH 1324 swe loops over a source outside the worktree: DENIED"
out=$(run_in "$WT_PLAIN" "for f in \$(find / -name x); do rm \"\$f\"; done")
assert_contains "$out" 'write target \"$f\" depends on a variable the guard cannot resolve' "for f in \$(find / …); rm"
out=$(run_in "$WT_PLAIN" "for f in \$(cat list.txt); do rm \"\$f\"; done")
assert_contains "$out" '"permissionDecision":"deny"' "\$(cat list.txt)"
out=$(run_in "$WT_PLAIN" "for f in skills/*/SKILL.md; do sed -i 's/a/b/' \"\$f\"; done")
assert_contains "$out" "prompt-surface" "an in-worktree glob still reaches the prompt-surface rule"

test_case "GH 1324 swe loops over prompt-surface dirs: DENIED (non-prompt-bearing)"
mkdir -p "$WT_PLAIN/agents" "$WT_PLAIN/skills/tmb_audit" "$WT_PB/agents"
out=$(run_in "$WT_PLAIN" "for f in \$(find $WT_PLAIN/agents -name '*.md'); do sed -i s/a/b/ \"\$f\"; done")
assert_contains "$out" "prompt-surface" "find <wt>/agents -name '*.md'"
out=$(run_in "$WT_PLAIN" "for f in \$(find agents -name '*.md'); do sed -i s/a/b/ \"\$f\"; done")
assert_contains "$out" "prompt-surface" "relative find agents"
out=$(run_in "$WT_PLAIN" "find $WT_PLAIN/agents -name '*.md' | while read f; do printf x >> \"\$f\"; done")
assert_contains "$out" "prompt-surface" "find <wt>/agents | while read"
out=$(run_in "$WT_PLAIN" "for f in \$(git ls-files skills); do sed -i s/a/b/ \"\$f\"; done")
assert_contains "$out" "prompt-surface" "git ls-files skills"
out=$(run_in "$WT_PLAIN" "for f in \$(find . -name CLAUDE.md); do sed -i s/a/b/ \"\$f\"; done")
assert_contains "$out" "Human-owned" "a -name CLAUDE.md source reaches the root CLAUDE.md rule"
out=$(run_in "$WT_PB" "for f in \$(find agents -name '*.md'); do sed -i s/a/b/ \"\$f\"; done")
assert_not_contains "$out" '"permissionDecision":"deny"' "a prompt-bearing task may"

test_case "GH 1324 swe loops over the worktree above its prompt-surface dirs"
out=$(run_in "$WT_PLAIN" "for f in \$(find $WT_PLAIN -name '*.md'); do sed -i s/a/b/ \"\$f\"; done")
assert_contains "$out" "reaches prompt-surface paths" "find <wt> -name '*.md': DENIED"
assert_contains "$out" "scope the listing below agents/" "the reason names the remedy"
out=$(run_in "$WT_PLAIN" "for f in \$(find $WT_PLAIN/tests -name '*.md'); do sed -i s/a/b/ \"\$f\"; done")
assert_not_contains "$out" '"permissionDecision":"deny"' "find <wt>/tests -name '*.md': ALLOWED"
out=$(run_in "$WT_PLAIN" "for f in \$(find $WT_PLAIN -name '*.md' -not -path '*/agents/*' -not -path '*/skills/*' -not -path '*/commands/*' -not -path '*/templates/*'); do sed -i s/a/b/ \"\$f\"; done")
assert_not_contains "$out" '"permissionDecision":"deny"' "find <wt> with -not -path exclusions: ALLOWED"
out=$(run_in "$WT_PLAIN" "for f in \$(git ls-files); do sed -i s/a/b/ \"\$f\"; done")
assert_contains "$out" "reaches prompt-surface paths" "git ls-files at the worktree root: DENIED"
out=$(run_in "$WT_PLAIN" "for f in \$(git ls-files tests); do sed -i s/a/b/ \"\$f\"; done")
assert_not_contains "$out" '"permissionDecision":"deny"' "git ls-files tests: ALLOWED"
out=$(run_in "$WT_PB" "for f in \$(find $WT_PB -name '*.md'); do sed -i s/a/b/ \"\$f\"; done")
assert_not_contains "$out" '"permissionDecision":"deny"' "a prompt-bearing task: ALLOWED"

test_case "GH 1324 swe: case-insensitive patterns and partial exclusions DENIED, whole-subtree exclusions ALLOWED"
mkdir -p "$WT_PLAIN/commands"
for src in "find $WT_PLAIN -iname '*.MD'" "find $WT_PLAIN -iname 'skill.md'" "rg --files $WT_PLAIN --iglob '*.MD'" \
  "find $WT_PLAIN -name '*.md' ! -path '*/agents'" "find $WT_PLAIN -name '*.md' -not -path '*/agents/zzz/*'" \
  "find $WT_PLAIN -path '*/agents/zzz' -prune -o -name '*.md' -print" "git ls-files ':!agents/zzz'" "fd -E agents/zzz md $WT_PLAIN"; do
  out=$(run_in "$WT_PLAIN" "for f in \$($src); do sed -i s/a/b/ \"\$f\"; done")
  assert_contains "$out" "reaches prompt-surface paths" "$src: DENIED"
done
for src in "find $WT_PLAIN -name '*.md' -not -path '*/agents/*' -not -path '*/skills/**' -not -path '*/commands/*'" \
  "find $WT_PLAIN -path '*/agents' -prune -o -path '*/skills' -prune -o -path '*/commands' -prune -o -name '*.md' -print" \
  "git ls-files ':!agents' ':!skills' ':!commands'" "fd -E agents -E skills -E commands md $WT_PLAIN" \
  "rg --files $WT_PLAIN --glob '!agents/**' --glob '!skills/**' --glob '!commands'"; do
  out=$(run_in "$WT_PLAIN" "for f in \$($src); do sed -i s/a/b/ \"\$f\"; done")
  assert_not_contains "$out" '"permissionDecision":"deny"' "$src: ALLOWED"
done

test_case "GH 1324 swe loop shapes that leave the worktree: DENIED"
out=$(run_event "$WT_PLAIN" "for f in \$(find -- /etc -name x); do rm \"\$f\"; done")
assert_contains "$out" 'write target \"$f\" depends on a variable the guard cannot resolve' "find -- /etc"
out=$(run_event "$WT_PLAIN" "for d in \$(find $WT_PLAIN -type d); do echo x > \"\$d/../f\"; done")
assert_contains "$out" '"permissionDecision":"deny"' "\$d/../f: find lists the worktree itself"
out=$(run_event "$WT_PLAIN" "echo x > $WT_PLAIN/*/../../../etc/f")
assert_contains "$out" "climbs with .. after a glob" "a glob followed by .."

test_case "GH 1324 swe \$OLDPWD after a cd"
out=$(run_event "$WT_PLAIN" "cd $WT_PLAIN/src/a && echo x > \"\$OLDPWD/$IN_FENCE\"")
assert_not_contains "$out" '"permissionDecision":"deny"' "cd <root>/src/a from the worktree root"
out=$(run_event "$WT_PLAIN" "cd /tmp/tmb-1324 && cd $WT_PLAIN/src && echo x > \"\$OLDPWD/f\"")
assert_contains "$out" "/tmp/tmb-1324/f is outside this run's root" "denied as the real path"
out=$(run_in "$WT_PLAIN" 'echo x > "$OLDPWD/f"')
assert_contains "$out" 'write target \"$OLDPWD/f\"' "no cd: unresolvable"

test_case "GH 1324 the GH 1279 denies hold"
out=$(run_in "$WT_PLAIN" 'cat > "$UNKNOWN/f" < /dev/null')
assert_contains "$out" '"permissionDecision":"deny"' "cat > \$UNKNOWN/f"
out=$(run_in "$WT_PLAIN" 'cat > "$(mktemp)" < /dev/null')
assert_contains "$out" '"permissionDecision":"deny"' "cat > \$(mktemp)"
out=$(run_event "$WT_PLAIN" 'OUT=/etc/tmb-1324; cat > "$OUT" < /dev/null')
assert_contains "$out" "/etc/tmb-1324 is outside this run's root" "OUT=/etc/x; cat > \$OUT"

# ===========================================================================
# GH 1338 — what find -exec / -delete, fd -x and xargs run is judged on the
# paths find or fd lists.
# ===========================================================================

test_case "GH 1338 swe find / fd / xargs writes outside the worktree: DENIED"
out=$(run_in "$WT_PLAIN" "find $CLAUDE_PROJECT_DIR -exec rm {} \\;")
assert_contains "$out" 'write target \"${find_path}\" depends on a variable the guard cannot resolve' "find <project-root> -exec rm from the worktree"
out=$(run_in "$WT_PLAIN" "find $CLAUDE_PROJECT_DIR -print0 | xargs -0 rm")
assert_contains "$out" 'write target \"${xargs_arg}\" depends on a variable the guard cannot resolve' "find <project-root> | xargs rm"
out=$(run_in "$WT_PLAIN" 'find $HOME -delete')
assert_contains "$out" '"permissionDecision":"deny"' "find \$HOME -delete"

test_case "GH 1338 swe find / fd / xargs over prompt-surface dirs: DENIED (non-prompt-bearing)"
for cmd in "find agents -name '*.md' -exec sed -i s/a/b/ {} \\;" "find agents -name '*.md' -delete" \
  "find agents -name '*.md' -print0 | xargs -0 sed -i s/a/b/" "fd -e md . agents -x sed -i s/a/b/"; do
  out=$(run_in "$WT_PLAIN" "$cmd")
  assert_contains "$out" "prompt-surface" "$cmd"
done
out=$(run_in "$WT_PB" "find agents -name '*.md' -exec sed -i s/a/b/ {} \\;")
assert_not_contains "$out" '"permissionDecision":"deny"' "a prompt-bearing task may"

test_case "GH 1338 swe find / fd / xargs inside the worktree, outside prompt-surface dirs: ALLOWED"
for cmd in "find $WT_PLAIN/src -exec rm {} \\;" "find src -name '*.md' -exec sed -i s/a/b/ {} \\;" "find src -name '*.tmp' -delete" \
  "find src -name '*.ts' -print0 | xargs -0 sed -i s/a/b/" "fd -e ts . src -x sed -i s/a/b/ {}" "find agents -name '*.md' -print"; do
  out=$(run_in "$WT_PLAIN" "$cmd")
  assert_not_contains "$out" '"permissionDecision":"deny"' "$cmd"
done

# ===========================================================================
# Layer 1 — schema-mismatch fail-safe (#596)
# A stale legacy ~/.claude/tmb/trajectory.db (old schema, no prompt_bearing
# column) up-tree from the hook's cwd must be treated as UNRESOLVED, not
# queried-and-defaulted-to-0. The hook resolves the live DB instead.
# These cases unset TRAJECTORY_DB_PATH, CLAUDE_PROJECT_DIR (either bypasses walk-up) and the test flags (they disable it);
# they exercise the cwd walk-up + sentinel resolution directly.
# ===========================================================================

# Build a fake HOME containing a stale legacy DB, plus a real project workspace
# (current schema) one level under it with a worktree for a prompt_bearing=1 task.
SCHEMA_HOME="$TMPDIR/schema-home"
mkdir -p "$SCHEMA_HOME/.claude/tmb"
sqlite3 "$SCHEMA_HOME/.claude/tmb/trajectory.db" "
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL,
    branch_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    spec_body TEXT NOT NULL DEFAULT ''
  );
  INSERT INTO tasks VALUES (10, 1, 'feat/prompt-task', 'pending', '');
"

# Live project workspace under that HOME, with the current schema.
LIVE_WS="$SCHEMA_HOME/project"
mkdir -p "$LIVE_WS/.claude/tmb"
sqlite3 "$LIVE_WS/.claude/tmb/trajectory.db" "
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL,
    branch_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    spec_body TEXT NOT NULL DEFAULT '',
    prompt_bearing INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO tasks VALUES (10, 1, 'feat/prompt-task', 'pending', '', 1);
"
LIVE_WT_PROMPT="$LIVE_WS/.claude/worktrees/prompt-task"
mkdir -p "$LIVE_WT_PROMPT/agents"

test_case "(L1) stale legacy DB up-tree, live DB at workspace: prompt_bearing=1 edit ALLOWED"
out=$(cd "$LIVE_WT_PROMPT" && \
  echo "$(make_edit_no_transcript swe "$LIVE_WT_PROMPT/agents/swe.md")" | \
  HOME="$SCHEMA_HOME" env -u TRAJECTORY_DB_PATH -u CLAUDE_PROJECT_DIR -u TMB_TEST_RUN_ID -u TMB_FORBID_LIVE_SYNC bash "$HOOK" 2>&1 || true)
assert_not_contains "$out" '"permissionDecision":"deny"' "live current-schema DB should be resolved, prompt edit allowed"

# The schema probe rejects the legacy DB and accepts the current-schema one.
test_case "(L1) schema probe: rejects legacy DB"
probe_legacy=$( . "$PLUGIN_ROOT/scripts/hooks/lib/query-task.sh"; \
  if tmb_db_schema_current "$SCHEMA_HOME/.claude/tmb/trajectory.db"; then echo current; else echo stale; fi )
assert_eq "stale" "$probe_legacy" "legacy DB (no prompt_bearing) probed as stale"

test_case "(L1) schema probe: accepts current-schema DB"
probe_live=$( . "$PLUGIN_ROOT/scripts/hooks/lib/query-task.sh"; \
  if tmb_db_schema_current "$LIVE_WS/.claude/tmb/trajectory.db"; then echo current; else echo stale; fi )
assert_eq "current" "$probe_live" "current-schema DB probed as current"

# The #596 failure mode: hook cwd=$HOME, walk-up finds nothing, and $HOME
# holds a stale legacy DB plus a home-level workspace pointer. tmb_db_path
# reads no pointer under $HOME and reports unresolved.
test_case "(L1) a home-level workspace pointer is never adopted by tmb_db_path"
SENTINEL_HOME="$TMPDIR/sentinel-stale-home"
mkdir -p "$SENTINEL_HOME/.claude/tmb"
sqlite3 "$SENTINEL_HOME/.claude/tmb/trajectory.db" "
  CREATE TABLE tasks (id INTEGER PRIMARY KEY, branch_id TEXT, status TEXT);
"
printf '%s\n' "$SENTINEL_HOME" > "$SENTINEL_HOME/.claude/tmb-active-workspace"
resolved=$( cd "$SENTINEL_HOME" && \
  HOME="$SENTINEL_HOME" env -u TRAJECTORY_DB_PATH -u CLAUDE_PROJECT_DIR -u TMB_TEST_RUN_ID -u TMB_FORBID_LIVE_SYNC \
  bash -c '. "'"$PLUGIN_ROOT"'/scripts/hooks/lib/query-task.sh"; tmb_db_path || true' )
assert_eq "" "$resolved" "home-level pointer must be treated as unresolved"

summarize
