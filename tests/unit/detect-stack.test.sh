#!/usr/bin/env bash
set -eo pipefail

SCRIPT="$(cd "$(dirname "$0")/../.." && pwd)/scripts/detect-stack.sh"
PASS=0
FAIL=0

ok() {
  echo "PASS: $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "FAIL: $1"
  FAIL=$((FAIL + 1))
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    ok "$desc"
  else
    fail "$desc (expected='$expected' got='$actual')"
  fi
}

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    ok "$desc"
  else
    fail "$desc (expected to contain '$needle' in '$haystack')"
  fi
}

assert_not_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    fail "$desc (expected NOT to contain '$needle' in '$haystack')"
  else
    ok "$desc"
  fi
}

TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

valid_json() {
  python3 -c "import json, sys; json.load(sys.stdin)" <<<"$1" 2>/dev/null
}

has_field() {
  local json="$1" field="$2"
  python3 -c "
import json, sys
data = json.loads(sys.argv[1])
assert sys.argv[2] in data, f'missing field: {sys.argv[2]}'
" "$json" "$field" 2>/dev/null
}

echo "=== detect-stack.sh unit tests ==="

TEST1="$TMPDIR_BASE/empty"
mkdir -p "$TEST1"
OUT1=$(bash "$SCRIPT" --cwd "$TEST1")
if valid_json "$OUT1"; then
  ok "empty repo: output is valid JSON"
else
  fail "empty repo: output is not valid JSON"
fi

for field in files_present languages package_managers test_runners linters git_remotes detector detected_at; do
  if has_field "$OUT1" "$field"; then
    ok "empty repo: field '$field' present"
  else
    fail "empty repo: field '$field' missing"
  fi
done

LANGS1=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['languages'])" "$OUT1")
assert_eq "empty repo: languages is empty list" "[]" "$LANGS1"

DETECTOR1=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['detector'])" "$OUT1")
assert_eq "empty repo: detector is file-presence" "file-presence" "$DETECTOR1"

TEST2="$TMPDIR_BASE/python"
mkdir -p "$TEST2"
touch "$TEST2/pyproject.toml"
OUT2=$(bash "$SCRIPT" --cwd "$TEST2")
if valid_json "$OUT2"; then
  ok "python repo: output is valid JSON"
else
  fail "python repo: output is not valid JSON"
fi

LANGS2=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['languages'])" "$OUT2")
assert_contains "python repo: languages includes python" "python" "$LANGS2"

FILES2=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['files_present'])" "$OUT2")
assert_contains "python repo: files_present includes pyproject.toml" "pyproject.toml" "$FILES2"

TEST3="$TMPDIR_BASE/polyglot"
mkdir -p "$TEST3"
touch "$TEST3/pyproject.toml"
touch "$TEST3/package.json"
touch "$TEST3/tsconfig.json"
touch "$TEST3/Cargo.toml"
OUT3=$(bash "$SCRIPT" --cwd "$TEST3")
if valid_json "$OUT3"; then
  ok "polyglot repo: output is valid JSON"
else
  fail "polyglot repo: output is not valid JSON"
fi

LANGS3=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['languages'])" "$OUT3")
assert_contains "polyglot repo: languages includes python" "python" "$LANGS3"
assert_contains "polyglot repo: languages includes javascript" "javascript" "$LANGS3"
assert_contains "polyglot repo: languages includes typescript" "typescript" "$LANGS3"
assert_contains "polyglot repo: languages includes rust" "rust" "$LANGS3"

TEST4="$TMPDIR_BASE/node"
mkdir -p "$TEST4"
touch "$TEST4/package.json"
OUT4=$(bash "$SCRIPT" --cwd "$TEST4")
if valid_json "$OUT4"; then
  ok "node repo: output is valid JSON"
else
  fail "node repo: output is not valid JSON"
fi

LANGS4=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['languages'])" "$OUT4")
assert_contains "node repo: languages includes javascript" "javascript" "$LANGS4"
assert_not_contains "node repo: languages does not include python" "'python'" "$LANGS4"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
