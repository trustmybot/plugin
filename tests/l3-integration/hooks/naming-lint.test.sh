#!/usr/bin/env bash
# Tests for scripts/hooks/naming-lint.sh
# Hook emits additionalContext when a NEW file's basename violates the
# language naming convention. Existing files are never flagged.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/naming-lint.sh"

TMPDIR_NL=$(mktemp -d)
trap 'rm -rf "$TMPDIR_NL"' EXIT

run_hook() {
  echo "$1" | bash "$HOOK" 2>&1 || true
}

make_write() {
  local path="$1"
  jq -nc --arg p "$path" '{tool_name: "Write", tool_input: {file_path: $p, content: "x"}}'
}

make_edit() {
  local path="$1"
  jq -nc --arg p "$path" '{tool_name: "Edit", tool_input: {file_path: $p, new_string: "x"}}'
}

# ──────────────────────────────────────────────────────────────
# Case 1: non-Edit/Write tool passes silently
# ──────────────────────────────────────────────────────────────
test_case "Bash tool exits silently"
input=$(jq -nc '{tool_name: "Bash", tool_input: {command: "ls"}}')
out=$(run_hook "$input")
assert_eq "" "$out" "Bash tool produces no output"

# ──────────────────────────────────────────────────────────────
# Case 2: bypass env var
# ──────────────────────────────────────────────────────────────
test_case "TMB_SKIP_NAMING_LINT=1 bypasses hook"
input=$(make_write "$TMPDIR_NL/BadName.py")
out=$(echo "$input" | TMB_SKIP_NAMING_LINT=1 bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "bypass env var produces no output"

# ──────────────────────────────────────────────────────────────
# Case 3: existing file is silently skipped (no rename enforcement)
# ──────────────────────────────────────────────────────────────
test_case "existing file is skipped even if name is wrong"
existing="$TMPDIR_NL/BadFile.py"
touch "$existing"
input=$(make_write "$existing")
out=$(run_hook "$input")
assert_eq "" "$out" "existing file produces no output"

# ──────────────────────────────────────────────────────────────
# Case 4: Python — valid snake_case passes
# ──────────────────────────────────────────────────────────────
test_case "valid snake_case .py passes silently"
input=$(make_write "$TMPDIR_NL/my_module.py")
out=$(run_hook "$input")
assert_eq "" "$out" "snake_case .py produces no output"

# ──────────────────────────────────────────────────────────────
# Case 5: Python — PascalCase violates
# ──────────────────────────────────────────────────────────────
test_case "PascalCase .py emits advisory"
input=$(make_write "$TMPDIR_NL/MyModule.py")
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "PascalCase .py triggers advisory"
assert_contains "$out" "snake_case" "advisory mentions snake_case"

# ──────────────────────────────────────────────────────────────
# Case 6: TypeScript — valid kebab-case passes
# ──────────────────────────────────────────────────────────────
test_case "valid kebab-case .ts passes silently"
input=$(make_write "$TMPDIR_NL/my-module.ts")
out=$(run_hook "$input")
assert_eq "" "$out" "kebab-case .ts produces no output"

# ──────────────────────────────────────────────────────────────
# Case 7: TypeScript — camelCase violates
# ──────────────────────────────────────────────────────────────
test_case "camelCase .ts emits advisory"
input=$(make_write "$TMPDIR_NL/myModule.ts")
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "camelCase .ts triggers advisory"
assert_contains "$out" "kebab-case" "advisory mentions kebab-case"

# ──────────────────────────────────────────────────────────────
# Case 8: Shell — valid kebab-case .sh passes
# ──────────────────────────────────────────────────────────────
test_case "valid kebab-case .sh passes silently"
input=$(make_write "$TMPDIR_NL/my-script.sh")
out=$(run_hook "$input")
assert_eq "" "$out" "kebab-case .sh produces no output"

# ──────────────────────────────────────────────────────────────
# Case 9: Shell — snake_case violates
# ──────────────────────────────────────────────────────────────
test_case "snake_case .sh emits advisory"
input=$(make_write "$TMPDIR_NL/my_script.sh")
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "snake_case .sh triggers advisory"
assert_contains "$out" "kebab-case" "advisory mentions kebab-case"

# ──────────────────────────────────────────────────────────────
# Case 10: SQL — valid snake_case passes
# ──────────────────────────────────────────────────────────────
test_case "valid snake_case .sql passes silently"
input=$(make_write "$TMPDIR_NL/create_table.sql")
out=$(run_hook "$input")
assert_eq "" "$out" "snake_case .sql produces no output"

# ──────────────────────────────────────────────────────────────
# Case 11: SQL — camelCase violates
# ──────────────────────────────────────────────────────────────
test_case "camelCase .sql emits advisory"
input=$(make_write "$TMPDIR_NL/createTable.sql")
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "camelCase .sql triggers advisory"

# ──────────────────────────────────────────────────────────────
# Case 12: TSX — PascalCase passes (React component)
# ──────────────────────────────────────────────────────────────
test_case "PascalCase .tsx passes silently (React component)"
input=$(make_write "$TMPDIR_NL/MyComponent.tsx")
out=$(run_hook "$input")
assert_eq "" "$out" "PascalCase .tsx produces no output"

# ──────────────────────────────────────────────────────────────
# Case 13: TSX — kebab-case passes (route/hook file)
# ──────────────────────────────────────────────────────────────
test_case "kebab-case .tsx passes silently (route/hook)"
input=$(make_write "$TMPDIR_NL/use-auth.tsx")
out=$(run_hook "$input")
assert_eq "" "$out" "kebab-case .tsx produces no output"

# ──────────────────────────────────────────────────────────────
# Case 14: special metadata files are exempt
# ──────────────────────────────────────────────────────────────
test_case "__init__.py is exempt"
input=$(make_write "$TMPDIR_NL/__init__.py")
out=$(run_hook "$input")
assert_eq "" "$out" "__init__.py exempt"

test_case "index.ts is exempt"
input=$(make_write "$TMPDIR_NL/index.ts")
out=$(run_hook "$input")
assert_eq "" "$out" "index.ts exempt"

# ──────────────────────────────────────────────────────────────
# Case 15: node_modules path is skipped
# ──────────────────────────────────────────────────────────────
test_case "node_modules path is skipped"
input=$(make_write "/tmp/node_modules/BadName.ts")
out=$(run_hook "$input")
assert_eq "" "$out" "node_modules path produces no output"

# ──────────────────────────────────────────────────────────────
# Case 16: advisory output has correct JSON structure
# ──────────────────────────────────────────────────────────────
test_case "advisory output is valid JSON with hookEventName=PreToolUse"
input=$(make_write "$TMPDIR_NL/BadModule.ts")
out=$(run_hook "$input")
event=$(echo "$out" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null || echo "")
assert_eq "PreToolUse" "$event" "hookEventName is PreToolUse"

summarize
