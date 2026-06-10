#!/usr/bin/env bash
# Tests for scripts/hooks/code-quality-lint.sh
# Hook emits additionalContext on mechanical code-quality violations in
# Edit/Write/MultiEdit tool calls targeting source files.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/code-quality-lint.sh"

run_hook() {
  echo "$1" | bash "$HOOK" 2>&1 || true
}

make_write() {
  local path="$1"
  local content="$2"
  jq -nc --arg p "$path" --arg c "$content" \
    '{tool_name: "Write", tool_input: {file_path: $p, content: $c}}'
}

make_edit() {
  local path="$1"
  local new_string="$2"
  jq -nc --arg p "$path" --arg s "$new_string" \
    '{tool_name: "Edit", tool_input: {file_path: $p, new_string: $s}}'
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
test_case "TMB_SKIP_CQ_LINT=1 bypasses hook"
input=$(make_write "/tmp/foo.py" "except:")
out=$(echo "$input" | TMB_SKIP_CQ_LINT=1 bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "bypass env var produces no output"

# ──────────────────────────────────────────────────────────────
# Case 3: non-source file extensions are ignored
# ──────────────────────────────────────────────────────────────
test_case "markdown file is ignored"
input=$(make_write "/tmp/README.md" "except:")
out=$(run_hook "$input")
assert_eq "" "$out" "md file produces no output"

test_case "shell script is ignored"
input=$(make_write "/tmp/deploy.sh" "except:")
out=$(run_hook "$input")
assert_eq "" "$out" "sh file produces no output"

# ──────────────────────────────────────────────────────────────
# Case 4: Python — bare except
# ──────────────────────────────────────────────────────────────
test_case "Python bare except emits advisory"
input=$(make_write "/tmp/foo.py" "try:
    pass
except:
    pass")
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "bare except triggers advisory"
assert_contains "$out" "bare 'except:'" "advisory mentions bare except"

# ──────────────────────────────────────────────────────────────
# Case 5: Python — except Exception
# ──────────────────────────────────────────────────────────────
test_case "Python except Exception emits advisory"
input=$(make_write "/tmp/foo.py" "try:
    pass
except Exception as e:
    pass")
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "except Exception triggers advisory"
assert_contains "$out" "except Exception" "advisory mentions except Exception"

# ──────────────────────────────────────────────────────────────
# Case 6: Python — f-string SQL
# ──────────────────────────────────────────────────────────────
test_case "Python f-string SQL emits advisory"
input=$(make_write "/tmp/foo.py" 'query = f"SELECT * FROM users WHERE id = {user_id}"')
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "f-string SQL triggers advisory"
assert_contains "$out" "f-string SQL" "advisory mentions f-string SQL"

# ──────────────────────────────────────────────────────────────
# Case 7: Python — datetime.utcnow()
# ──────────────────────────────────────────────────────────────
test_case "Python datetime.utcnow() emits advisory"
input=$(make_write "/tmp/foo.py" "now = datetime.utcnow()")
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "utcnow triggers advisory"
assert_contains "$out" "utcnow" "advisory mentions utcnow"

# ──────────────────────────────────────────────────────────────
# Case 8: Python — mutable default arg
# ──────────────────────────────────────────────────────────────
test_case "Python mutable default list arg emits advisory"
input=$(make_write "/tmp/foo.py" "def process(items=[]):
    pass")
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "mutable default [] triggers advisory"
assert_contains "$out" "mutable default argument" "advisory mentions mutable default"

# ──────────────────────────────────────────────────────────────
# Case 9: TypeScript — catch (e: any)
# ──────────────────────────────────────────────────────────────
test_case "TS catch (e: any) emits advisory"
input=$(make_write "/tmp/foo.ts" "try { } catch (e: any) { console.log(e); }")
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "catch any triggers advisory"
assert_contains "$out" "catch (e: any)" "advisory mentions catch any"

# ──────────────────────────────────────────────────────────────
# Case 10: TypeScript — template-string SQL
# ──────────────────────────────────────────────────────────────
test_case "TS template-string SQL emits advisory"
input=$(make_write "/tmp/foo.ts" 'const q = `SELECT * FROM users WHERE id = ${id}`;')
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "template SQL triggers advisory"
assert_contains "$out" "template-string SQL" "advisory mentions template SQL"

# ──────────────────────────────────────────────────────────────
# Case 11: TODO comment in source file
# ──────────────────────────────────────────────────────────────
test_case "TODO comment in .ts file emits advisory"
input=$(make_write "/tmp/foo.ts" "// TODO: fix this later")
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "TODO triggers advisory"
assert_contains "$out" "TODO/FIXME/HACK" "advisory mentions TODO/FIXME/HACK"

# ──────────────────────────────────────────────────────────────
# Case 12: clean Python file produces no output
# ──────────────────────────────────────────────────────────────
test_case "clean Python file produces no advisory"
input=$(make_write "/tmp/foo.py" "def process(items=None):
    if items is None:
        items = []
    return items")
out=$(run_hook "$input")
assert_eq "" "$out" "clean Python produces no output"

# ──────────────────────────────────────────────────────────────
# Case 13: fixtures path is skipped
# ──────────────────────────────────────────────────────────────
test_case "fixtures path is skipped even with violations"
input=$(make_write "/tmp/fixtures/foo.py" "except:")
out=$(run_hook "$input")
assert_eq "" "$out" "fixtures path produces no output"

# ──────────────────────────────────────────────────────────────
# Case 14: MultiEdit uses new_strings from edits array
# ──────────────────────────────────────────────────────────────
test_case "MultiEdit with bare except in new_string emits advisory"
input=$(jq -nc '{
  tool_name: "MultiEdit",
  tool_input: {
    file_path: "/tmp/foo.py",
    edits: [
      {old_string: "pass", new_string: "except:\n    pass"}
    ]
  }
}')
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "MultiEdit triggers advisory for bare except"

# ──────────────────────────────────────────────────────────────
# Case 15: advisory output has correct hookEventName
# ──────────────────────────────────────────────────────────────
test_case "advisory output is valid JSON with hookEventName=PreToolUse"
input=$(make_write "/tmp/foo.py" "except:")
out=$(run_hook "$input")
event=$(echo "$out" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null || echo "")
assert_eq "PreToolUse" "$event" "hookEventName is PreToolUse"

summarize
