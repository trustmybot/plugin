#!/usr/bin/env bash
# Tests for scripts/hooks/commit-msg-lint.sh
# Hook emits additionalContext when a git commit -m message violates
# Conventional Commits + emoji format; is advisory (never blocks).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/commit-msg-lint.sh"

run_hook() {
  echo "$1" | bash "$HOOK" 2>&1 || true
}

make_bash_input() {
  local cmd="$1"
  jq -nc --arg cmd "$cmd" '{tool_name: "Bash", tool_input: {command: $cmd}}'
}

# ──────────────────────────────────────────────────────────────
# Case 1: non-Bash tool passes through silently
# ──────────────────────────────────────────────────────────────
test_case "non-Bash tool exits silently"
input=$(jq -nc '{tool_name: "Read", tool_input: {file_path: "/tmp/foo"}}')
out=$(run_hook "$input")
assert_eq "" "$out" "non-Bash tool produces no output"

# ──────────────────────────────────────────────────────────────
# Case 2: Bash command that is not a git commit passes silently
# ──────────────────────────────────────────────────────────────
test_case "non-commit Bash command exits silently"
input=$(make_bash_input "ls -la")
out=$(run_hook "$input")
assert_eq "" "$out" "non-commit bash command produces no output"

# ──────────────────────────────────────────────────────────────
# Case 3: bypass env var skips processing
# ──────────────────────────────────────────────────────────────
test_case "TMB_SKIP_COMMIT_MSG_LINT=1 bypasses hook"
input=$(make_bash_input "git commit -m 'bad message no emoji'")
out=$(echo "$input" | TMB_SKIP_COMMIT_MSG_LINT=1 bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "bypass env var produces no output"

# ──────────────────────────────────────────────────────────────
# Case 4: valid emoji + type message passes silently
# ──────────────────────────────────────────────────────────────
test_case "valid emoji+type message passes silently"
input=$(make_bash_input "git commit -m '✨ feat(auth): add JWT refresh endpoint'")
out=$(run_hook "$input")
assert_eq "" "$out" "valid message produces no output"

test_case "valid colon-emoji type message passes silently"
input=$(make_bash_input "git commit -m ':bug: fix(db): prevent null pointer in query'")
out=$(run_hook "$input")
assert_eq "" "$out" "colon-emoji message produces no output"

# ──────────────────────────────────────────────────────────────
# Case 5: missing emoji prefix emits advisory
# ──────────────────────────────────────────────────────────────
test_case "missing emoji prefix emits additionalContext"
input=$(make_bash_input "git commit -m 'feat(auth): add refresh endpoint'")
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "hook emits additionalContext on missing emoji"
assert_contains "$out" "commit-msg-lint" "advisory includes hook name"

# ──────────────────────────────────────────────────────────────
# Case 6: unknown type emits advisory
# ──────────────────────────────────────────────────────────────
test_case "unknown type emits additionalContext"
input=$(make_bash_input "git commit -m '🔥 update(auth): change something'")
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "hook emits additionalContext on unknown type"

# ──────────────────────────────────────────────────────────────
# Case 7: subject >72 chars emits advisory
# ──────────────────────────────────────────────────────────────
test_case "subject over 72 chars emits additionalContext"
long="🐛 fix(auth): this is a very long commit message that exceeds seventy-two characters total"
input=$(make_bash_input "git commit -m '$long'")
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "hook emits advisory on long subject"
assert_contains "$out" ">72" "advisory mentions >72"

# ──────────────────────────────────────────────────────────────
# Case 8: amend / no-edit / merge passes through silently (exempt)
# ──────────────────────────────────────────────────────────────
test_case "--amend flag is exempt from lint"
input=$(make_bash_input "git commit --amend --no-edit")
out=$(run_hook "$input")
assert_eq "" "$out" "amend/no-edit exempt"

test_case "--fixup flag is exempt from lint"
input=$(make_bash_input "git commit --fixup=HEAD")
out=$(run_hook "$input")
assert_eq "" "$out" "fixup exempt"

# ──────────────────────────────────────────────────────────────
# Case 9: HEREDOC commits skip lint (can't inspect rendered body)
# ──────────────────────────────────────────────────────────────
test_case "HEREDOC commit command skips lint silently"
input=$(make_bash_input 'git commit -m "$(cat <<EOF\nmy msg\nEOF\n)"')
out=$(run_hook "$input")
assert_eq "" "$out" "HEREDOC commits skip lint"

# ──────────────────────────────────────────────────────────────
# Case 10: advisory output is JSON with hookSpecificOutput structure
# ──────────────────────────────────────────────────────────────
test_case "advisory output is valid JSON with hookSpecificOutput"
input=$(make_bash_input "git commit -m 'bad message without emoji or type'")
out=$(run_hook "$input")
event=$(echo "$out" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null || echo "")
assert_eq "PreToolUse" "$event" "hookEventName is PreToolUse"

summarize
