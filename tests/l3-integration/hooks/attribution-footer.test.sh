#!/usr/bin/env bash
# Tests for scripts/hooks/attribution-footer.sh (#601).
#
# The hook normalizes the TMB attribution footer on PR/issue/MR bodies after a
# successful create command. We exercise:
#   - normalize_footer (sourced directly): idempotency, bare-CC→TMB rewrite,
#     already-TMB unchanged, empty/no-op bodies.
#   - the full hook end-to-end with stubbed gh/glab on PATH (no network): a
#     create command rewrites the body via edit/update; a non-create or
#     failed-create command makes no edit call.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/attribution-footer.sh"

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq unavailable"; exit 0; }

TMB_FOOTER='🤖 Generated with [Claude Code](https://claude.com/claude-code), powered by [Bro](https://github.com/trustmybot/plugin)'
BARE_CC='🤖 Generated with [Claude Code](https://claude.com/claude-code)'

# ── normalize_footer (pure function, sourced) ────────────────────────────────
# shellcheck source=scripts/hooks/attribution-footer.sh
. "$HOOK"

test_case "bare Claude-Code footer is rewritten to the TMB footer"
OUT=$(printf '%s\n\n%s' "Fixes the thing." "$BARE_CC" | normalize_footer)
assert_contains "$OUT" "$TMB_FOOTER" "TMB footer present after rewrite"
assert_eq "$TMB_FOOTER" "$(printf '%s' "$OUT" | tail -n1)" "body ends with exactly the TMB footer"
test_case "bare-CC line is stripped (not left alongside TMB footer)"
BARE_ONLY=$(printf '%s\n' "$OUT" | grep -F -- "$BARE_CC" | grep -vF -- 'powered by' || true)
assert_eq "" "$BARE_ONLY" "no bare Claude-Code-only line remains"

test_case "normalize_footer is idempotent (twice == once)"
ONCE=$(printf '%s\n\n%s' "Body text." "$BARE_CC" | normalize_footer)
TWICE=$(printf '%s' "$ONCE" | normalize_footer)
assert_eq "$ONCE" "$TWICE" "applying normalize twice equals once"

test_case "body already carrying the TMB footer is unchanged"
ALREADY=$(printf '%s\n\n%s' "Already attributed." "$TMB_FOOTER")
assert_eq "$ALREADY" "$(printf '%s' "$ALREADY" | normalize_footer)" "TMB-footer body unchanged"

test_case "plain body gains the TMB footer"
PLAIN=$(printf '%s' "Just a description." | normalize_footer)
assert_contains "$PLAIN" "$TMB_FOOTER" "TMB footer appended to plain body"
assert_contains "$PLAIN" "Just a description." "original body text preserved"

# ── full hook end-to-end with stubbed gh/glab ────────────────────────────────
STUB_DIR=$(mktemp -d)
EDIT_LOG="$STUB_DIR/edit.log"
trap 'rm -rf "$STUB_DIR"' EXIT

# gh stub: `gh pr view N --json body -q .body` prints a bare-CC body;
# `gh pr edit N --body X` records the body to EDIT_LOG.
cat > "$STUB_DIR/gh" <<STUB
#!/usr/bin/env bash
case "\$1 \$2" in
  "pr view"|"issue view")
    printf '%s\n\n%s' "Stub body." '$BARE_CC'
    ;;
  "pr edit"|"issue edit")
    # last arg is the body
    body="\${!#}"
    printf '%s' "\$body" > "$EDIT_LOG"
    ;;
esac
exit 0
STUB
chmod +x "$STUB_DIR/gh"

run_hook() { printf '%s' "$1" | PATH="$STUB_DIR:$PATH" bash "$HOOK"; }

test_case "gh pr create with a pull URL triggers an edit carrying the TMB footer"
rm -f "$EDIT_LOG"
PAYLOAD=$(jq -cn '{
  tool_name: "Bash",
  tool_input: { command: "gh pr create --fill" },
  tool_response: "https://github.com/o/r/pull/42\n"
}')
run_hook "$PAYLOAD"
if [ -f "$EDIT_LOG" ]; then
  EDITED=$(cat "$EDIT_LOG")
  assert_contains "$EDITED" "$TMB_FOOTER" "edit body carries the TMB footer"
else
  _fail "expected gh edit to be called"
fi

test_case "gh issue create with an issues URL triggers an edit"
rm -f "$EDIT_LOG"
PAYLOAD=$(jq -cn '{
  tool_name: "Bash",
  tool_input: { command: "gh issue create --title x" },
  tool_response: "https://github.com/o/r/issues/7\n"
}')
run_hook "$PAYLOAD"
assert_eq "true" "$([ -f "$EDIT_LOG" ] && echo true || echo false)" "gh issue edit called"

test_case "non-create Bash command makes no edit call"
rm -f "$EDIT_LOG"
PAYLOAD=$(jq -cn '{
  tool_name: "Bash",
  tool_input: { command: "gh pr view 42" },
  tool_response: "some output\n"
}')
run_hook "$PAYLOAD"
assert_eq "false" "$([ -f "$EDIT_LOG" ] && echo true || echo false)" "no edit on non-create command"

test_case "create command but no URL in response (failed create) → no edit"
rm -f "$EDIT_LOG"
PAYLOAD=$(jq -cn '{
  tool_name: "Bash",
  tool_input: { command: "gh pr create --fill" },
  tool_response: "error: could not create pull request\n"
}')
run_hook "$PAYLOAD"
assert_eq "false" "$([ -f "$EDIT_LOG" ] && echo true || echo false)" "no edit when create produced no URL"

test_case "non-Bash tool is ignored"
rm -f "$EDIT_LOG"
PAYLOAD=$(jq -cn '{
  tool_name: "Read",
  tool_input: { command: "gh pr create" },
  tool_response: "https://github.com/o/r/pull/9"
}')
run_hook "$PAYLOAD"
assert_eq "false" "$([ -f "$EDIT_LOG" ] && echo true || echo false)" "no edit for non-Bash tool"

# ── glab parity: stub glab, mr create → update ───────────────────────────────
# `glab mr view N -F json` must return the RAW description as a JSON field (#1034)
# — the hook parses `.description`, never the rendered `glab ... view` table.
cat > "$STUB_DIR/glab" <<STUB
#!/usr/bin/env bash
BARE='$BARE_CC'
case "\$1 \$2" in
  "mr view"|"issue view")
    jq -cn --arg d "Glab body.

\$BARE" '{description:\$d}'
    ;;
  "mr update"|"issue update")
    body="\${!#}"
    printf '%s' "\$body" > "$EDIT_LOG"
    ;;
esac
exit 0
STUB
chmod +x "$STUB_DIR/glab"

test_case "glab mr create with a merge_requests URL triggers an update"
rm -f "$EDIT_LOG"
PAYLOAD=$(jq -cn '{
  tool_name: "Bash",
  tool_input: { command: "glab mr create --fill" },
  tool_response: "https://gitlab.com/o/r/-/merge_requests/13\n"
}')
run_hook "$PAYLOAD"
if [ -f "$EDIT_LOG" ]; then
  assert_contains "$(cat "$EDIT_LOG")" "$TMB_FOOTER" "glab update carries the TMB footer"
else
  _fail "expected glab update to be called"
fi

summarize
