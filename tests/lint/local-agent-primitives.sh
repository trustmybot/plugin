#!/usr/bin/env bash
# Validates that project-local swe + pr-reviewer overrides retain critical
# workflow primitives. No-op when no local override exists.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
FIXTURES_DIR="$HERE/fixtures/local-agent"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

extract_frontmatter() {
  awk '/^---$/{c++; next} c==1{print}' "$1"
}

check_body() {
  local file="$1" primitive="$2" pattern="$3"
  if ! grep -qiE "$pattern" "$file" 2>/dev/null; then
    printf "local-agent-primitives FAIL: %s missing primitive '%s' (e.g. expected reference to '%s')\n" \
      "$file" "$primitive" "$primitive"
    return 1
  fi
  return 0
}

check_frontmatter_tool() {
  local file="$1" tool="$2"
  local fm
  fm="$(extract_frontmatter "$file")"
  if ! printf '%s\n' "$fm" | grep -q "tools:.*${tool}"; then
    printf "local-agent-primitives FAIL: %s missing primitive '%s' (e.g. expected reference to '%s')\n" \
      "$file" "$tool" "$tool"
    return 1
  fi
  return 0
}

lint_file() {
  local file="$1" name="$2"
  local fail=0

  case "$name" in
    swe)
      check_body "$file" "task_get(" "task_get\("                    || fail=1
      check_body "$file" "task_update_status(" "task_update_status\(" || fail=1
      check_body "$file" "git worktree" "git worktree"               || fail=1
      check_body "$file" "atomic close" "atomic.{0,3}close"          || fail=1
      check_frontmatter_tool "$file" "mcp__plugin_tmb_trajectory-server" || fail=1
      ;;
    pr-reviewer)
      check_body "$file" "task_get(" "task_get\("                    || fail=1
      check_body "$file" "validation_record(" "validation_record\("  || fail=1
      check_frontmatter_tool "$file" "mcp__plugin_tmb_trajectory-server" || fail=1
      ;;
  esac

  return "$fail"
}

# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

run_self_test() {
  local fail=0

  run_lint_against() {
    local dir="$1"
    local out exit_code
    out="$(bash "$HERE/local-agent-primitives.sh" --dir "$dir" 2>&1)"
    exit_code=$?
    printf '%s' "$out"
    return "$exit_code"
  }

  # Case 1: valid fixtures — expect exit 0
  printf '[self-test] case: valid (expect exit 0)\n'
  if run_lint_against "$FIXTURES_DIR/valid"; then
    printf '[self-test] PASS: valid dir exits 0\n'
  else
    printf '[self-test] FAIL: valid dir should exit 0 but did not\n'
    fail=1
  fi

  # Case 2: swe missing task_get — expect exit 1, message mentions task_get
  printf '\n[self-test] case: swe-missing-task-get (expect exit 1, mentions task_get)\n'
  local out2
  out2="$(run_lint_against "$FIXTURES_DIR/swe-missing-task-get" 2>&1)" || true
  if printf '%s\n' "$out2" | grep -q "task_get"; then
    printf '[self-test] PASS: message mentions task_get\n'
  else
    printf '[self-test] FAIL: expected mention of task_get in output\n  got: %s\n' "$out2"
    fail=1
  fi
  local ec2=0
  (run_lint_against "$FIXTURES_DIR/swe-missing-task-get" >/dev/null 2>&1) || ec2=$?
  if [ "$ec2" -ne 0 ]; then
    printf '[self-test] PASS: exits non-zero\n'
  else
    printf '[self-test] FAIL: expected non-zero exit for swe-missing-task-get\n'
    fail=1
  fi

  # Case 3: swe missing mcp tool — expect exit 1, message mentions mcp__plugin_tmb_trajectory-server
  printf '\n[self-test] case: swe-missing-mcp-tool (expect exit 1, mentions mcp__plugin_tmb_trajectory-server)\n'
  local out3
  out3="$(run_lint_against "$FIXTURES_DIR/swe-missing-mcp-tool" 2>&1)" || true
  if printf '%s\n' "$out3" | grep -q "mcp__plugin_tmb_trajectory-server"; then
    printf '[self-test] PASS: message mentions mcp__plugin_tmb_trajectory-server\n'
  else
    printf '[self-test] FAIL: expected mention of mcp__plugin_tmb_trajectory-server in output\n  got: %s\n' "$out3"
    fail=1
  fi
  local ec3=0
  (run_lint_against "$FIXTURES_DIR/swe-missing-mcp-tool" >/dev/null 2>&1) || ec3=$?
  if [ "$ec3" -ne 0 ]; then
    printf '[self-test] PASS: exits non-zero\n'
  else
    printf '[self-test] FAIL: expected non-zero exit for swe-missing-mcp-tool\n'
    fail=1
  fi

  # Case 4: pr-reviewer missing validation_record — expect exit 1, message mentions validation_record
  printf '\n[self-test] case: pr-reviewer-missing-validation-record (expect exit 1, mentions validation_record)\n'
  local out4
  out4="$(run_lint_against "$FIXTURES_DIR/pr-reviewer-missing-validation-record" 2>&1)" || true
  if printf '%s\n' "$out4" | grep -q "validation_record"; then
    printf '[self-test] PASS: message mentions validation_record\n'
  else
    printf '[self-test] FAIL: expected mention of validation_record in output\n  got: %s\n' "$out4"
    fail=1
  fi
  local ec4=0
  (run_lint_against "$FIXTURES_DIR/pr-reviewer-missing-validation-record" >/dev/null 2>&1) || ec4=$?
  if [ "$ec4" -ne 0 ]; then
    printf '[self-test] PASS: exits non-zero\n'
  else
    printf '[self-test] FAIL: expected non-zero exit for pr-reviewer-missing-validation-record\n'
    fail=1
  fi

  printf '\n'
  if [ "$fail" -eq 0 ]; then
    printf 'local-agent-primitives --self-test: OK\n'
    exit 0
  else
    printf 'local-agent-primitives --self-test: FAIL\n'
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

SELF_TEST=0
AGENT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --self-test)
      SELF_TEST=1
      shift
      ;;
    --dir)
      AGENT_DIR="$2"
      shift 2
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 1
      ;;
  esac
done

if [ "$SELF_TEST" -eq 1 ]; then
  run_self_test
fi

# Default dir: <project>/.claude/agents/ relative to plugin root's parent
if [ -z "$AGENT_DIR" ]; then
  AGENT_DIR="$(cd "$PLUGIN_ROOT/.." && pwd)/.claude/agents"
fi

# ---------------------------------------------------------------------------
# Main lint
# ---------------------------------------------------------------------------

FAIL=0
CHECKED=""

for name in swe pr-reviewer; do
  file="$AGENT_DIR/${name}.md"
  if [ ! -f "$file" ]; then
    continue
  fi
  lint_file "$file" "$name" || FAIL=1
  CHECKED="$CHECKED $name"
done

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

if [ -z "$CHECKED" ]; then
  printf 'local-agent-primitives: OK (no local overrides found — skipped)\n'
else
  printf 'local-agent-primitives: OK (checked:%s)\n' "$CHECKED"
fi
