#!/usr/bin/env bash
# Shared assertion helpers for TMB plugin tests.
# Source this at the top of any test file:
#   . "$(dirname "${BASH_SOURCE[0]}")/../lib/assert.sh"
set -euo pipefail

TESTS_PASSED=0
TESTS_FAILED=0
FAILED_TESTS=()

if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  NC='\033[0m'
else
  GREEN=''
  RED=''
  NC=''
fi

_fail() {
  local msg="$1"
  TESTS_FAILED=$((TESTS_FAILED + 1))
  FAILED_TESTS+=("${CURRENT_TEST:-?}: $msg")
  printf "${RED}FAIL${NC} %s — %s\n" "${CURRENT_TEST:-?}" "$msg"
}

_pass() {
  TESTS_PASSED=$((TESTS_PASSED + 1))
  printf "${GREEN}PASS${NC} %s\n" "${CURRENT_TEST:-?}"
}

test_case() {
  CURRENT_TEST="$1"
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="${3:-values}"
  if [ "$expected" = "$actual" ]; then
    _pass
  else
    _fail "$label differ. expected=<$expected> actual=<$actual>"
  fi
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="${3:-output}"
  if echo "$haystack" | grep -q -F -- "$needle"; then
    _pass
  else
    _fail "$label missing substring <$needle>. got=<$haystack>"
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local label="${3:-output}"
  if echo "$haystack" | grep -q -F -- "$needle"; then
    _fail "$label unexpectedly contains <$needle>. got=<$haystack>"
  else
    _pass
  fi
}

assert_exit_code() {
  local expected="$1"
  local actual="$2"
  local label="${3:-exit code}"
  if [ "$expected" = "$actual" ]; then
    _pass
  else
    _fail "$label differ. expected=$expected actual=$actual"
  fi
}

summarize() {
  local total=$((TESTS_PASSED + TESTS_FAILED))
  printf "\n"
  if [ "$TESTS_FAILED" -eq 0 ]; then
    printf "${GREEN}%d/%d passed${NC}\n" "$TESTS_PASSED" "$total"
    return 0
  else
    printf "${RED}%d passed, %d failed${NC} (%d total)\n" "$TESTS_PASSED" "$TESTS_FAILED" "$total"
    printf "\nFailures:\n"
    for line in "${FAILED_TESTS[@]}"; do
      printf "  ${RED}•${NC} %s\n" "$line"
    done
    return 1
  fi
}
