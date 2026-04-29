#!/usr/bin/env bash
# Unit tests for scripts/lib/glab-retry-merge.sh
# Mocks `glab` and `sleep` in PATH and asserts retry semantics.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"

PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
SCRIPT="$PLUGIN_ROOT/scripts/lib/glab-retry-merge.sh"

# Create a temp dir for mock binaries (includes a no-op sleep to skip waits)
MOCK_DIR=$(mktemp -d -t tmb-glab-mock-XXXX)
RC_FILE=$(mktemp)
trap 'rm -rf "$MOCK_DIR"; rm -f "$RC_FILE"' EXIT

# Mock sleep so retry backoffs don't block tests
cat > "$MOCK_DIR/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$MOCK_DIR/sleep"

# Run the script under the mock PATH.
# Writes exit code to $RC_FILE; always exits 0 so set -e doesn't fire.
# Captures combined stdout+stderr on stdout.
run_script() {
  local out rc
  out=$(PATH="$MOCK_DIR:$PATH" bash "$SCRIPT" "$@" 2>&1); rc=$?
  echo "$rc" > "$RC_FILE"
  echo "$out"
}

last_rc() { cat "$RC_FILE"; }

# ---- success on first attempt ------------------------------------------------

test_case "succeeds on first attempt — no retry needed"
cat > "$MOCK_DIR/glab" <<'EOF'
#!/usr/bin/env bash
echo "Merged into main."
exit 0
EOF
chmod +x "$MOCK_DIR/glab"
out=$(run_script 42 --yes)
assert_contains "$out" "Merged into main." "success output forwarded"
assert_contains "$out" "succeeded on attempt 1" "logged attempt number"
assert_eq "0" "$(last_rc)" "exit code 0 on success"

# ---- 405 then success --------------------------------------------------------

test_case "retries on 405 and succeeds on second attempt"
ATTEMPT_FILE=$(mktemp)
cat > "$MOCK_DIR/glab" <<EOF
#!/usr/bin/env bash
count=\$(cat "$ATTEMPT_FILE" 2>/dev/null || echo 0)
count=\$((count + 1))
echo "\$count" > "$ATTEMPT_FILE"
if [ "\$count" -eq 1 ]; then
  echo "405 Method Not Allowed"
  exit 1
fi
echo "Merged."
exit 0
EOF
chmod +x "$MOCK_DIR/glab"
out=$(run_script 42 --yes)
assert_eq "0" "$(last_rc)" "exit code after retry success"
assert_contains "$out" "405 Method Not Allowed" "405 output forwarded"
assert_contains "$out" "Merged." "success output forwarded"
assert_contains "$out" "succeeded on attempt 2" "logged correct attempt"
rm -f "$ATTEMPT_FILE"

# ---- non-405 fails immediately -----------------------------------------------

test_case "non-405 failure exits immediately without retry"
ATTEMPT_FILE=$(mktemp)
cat > "$MOCK_DIR/glab" <<EOF
#!/usr/bin/env bash
count=\$(cat "$ATTEMPT_FILE" 2>/dev/null || echo 0)
count=\$((count + 1))
echo "\$count" > "$ATTEMPT_FILE"
echo "error: unauthorized"
exit 1
EOF
chmod +x "$MOCK_DIR/glab"
out=$(run_script 42 --yes)
assert_eq "1" "$(last_rc)" "non-zero exit on non-405 error"
assert_contains "$out" "non-405 failure" "non-405 message emitted"
attempt_count=$(cat "$ATTEMPT_FILE")
assert_eq "1" "$attempt_count" "glab called exactly once (no retry)"
rm -f "$ATTEMPT_FILE"

# ---- exhausts all attempts on persistent 405 ---------------------------------

test_case "exhausts 3 attempts on persistent 405 and exits 1"
cat > "$MOCK_DIR/glab" <<'EOF'
#!/usr/bin/env bash
echo "405 Method Not Allowed"
exit 1
EOF
chmod +x "$MOCK_DIR/glab"
out=$(run_script 42 --yes)
assert_eq "1" "$(last_rc)" "exit 1 after exhausting attempts"
assert_contains "$out" "exhausted 3 attempts" "exhaustion message emitted"

# ---- args are forwarded verbatim ---------------------------------------------

test_case "all args are forwarded verbatim to glab mr merge"
cat > "$MOCK_DIR/glab" <<'EOF'
#!/usr/bin/env bash
echo "args: $*"
exit 0
EOF
chmod +x "$MOCK_DIR/glab"
out=$(run_script 99 --yes --remove-source-branch --squash)
assert_contains "$out" "args: mr merge 99 --yes --remove-source-branch --squash" "args forwarded"

summarize
