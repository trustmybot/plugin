#!/usr/bin/env bash
# L3 sandbox isolation test.
#
# Proves that the sandbox stubs (gh, glab, git-remote-https) fail loudly with
# "tmb sandbox" in stderr and never reach the real network/API.
# Also verifies PATH + HOME are fully restored after teardown.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"

. "$HERE/../../lib/assert.sh"

SANDBOX_LIB="$PLUGIN_ROOT/tests/l5-l6/lib/sandbox.sh"

# shellcheck source=tests/l5-l6/lib/sandbox.sh
. "$SANDBOX_LIB"

SCRATCH=$(mktemp -d)
trap 'tmb_test_sandbox_teardown 2>/dev/null || true; rm -rf "$SCRATCH"' EXIT

tmb_test_sandbox_init "$SCRATCH"

# ---- 1. gh repo create is blocked ----
test_case "gh repo create fails with sandbox message"
gh_out=$(gh repo create "probe-repo-$$" 2>&1) && gh_exit=0 || gh_exit=$?
assert_exit_code 1 "$gh_exit" "gh exit code"
assert_contains "$gh_out" "tmb sandbox" "gh stderr"

# ---- 2. glab repo create is blocked ----
test_case "glab repo create fails with sandbox message"
glab_out=$(glab repo create "probe-$$" 2>&1) && glab_exit=0 || glab_exit=$?
assert_exit_code 1 "$glab_exit" "glab exit code"
assert_contains "$glab_out" "tmb sandbox" "glab stderr"

# ---- 3. git push https:// is blocked (via git-remote-https stub or proxy) ----
probe_repo=$(mktemp -d)
git -C "$probe_repo" init -q -b main
git -C "$probe_repo" config user.email "test@tmb.invalid"
git -C "$probe_repo" config user.name "TMB Test"
echo "probe" > "$probe_repo/README.md"
git -C "$probe_repo" add .
git -C "$probe_repo" commit -qm "probe"
https_out=$(git -C "$probe_repo" push "https://github.com/probe/probe.git" main 2>&1) && https_exit=0 || https_exit=$?
rm -rf "$probe_repo"
# git exits 1 when the stub intercepts, 128 when the proxy blocks at the transport layer
test_case "git push to https remote is blocked — exit non-zero"
if [ "$https_exit" -ne 0 ]; then
  _pass
else
  _fail "git push https: expected non-zero exit, got 0"
fi

test_case "git push to https remote is blocked — sandbox, transport, or credential-prompt suppressed"
if echo "$https_out" | grep -q "tmb sandbox"; then
  _pass
elif echo "$https_out" | grep -qiE "transport|blocked|disabled|Couldn.t connect|Failed to connect|Connection refused|Connection reset|Connection timed out|SSL_ERROR_SYSCALL|Could not resolve host|unable to access|terminal prompts disabled|could not read Username|Device not configured|Authentication failed"; then
  _pass
else
  _fail "git push https: expected sandbox or network-blocked or credential-suppressed message, got: $https_out"
fi

# ---- 4. Teardown restores PATH and HOME ----
ORIG_PATH="$TMB_SANDBOX_ORIG_PATH"
ORIG_HOME="$TMB_SANDBOX_ORIG_HOME"
tmb_test_sandbox_teardown
trap 'rm -rf "$SCRATCH"' EXIT

test_case "PATH restored after teardown"
assert_eq "$ORIG_PATH" "$PATH" "PATH after teardown"

test_case "HOME restored after teardown"
assert_eq "$ORIG_HOME" "$HOME" "HOME after teardown"

test_case "TMB_SANDBOX_ORIG_PATH unset after teardown"
if [ -z "${TMB_SANDBOX_ORIG_PATH:-}" ]; then
  _pass
else
  _fail "TMB_SANDBOX_ORIG_PATH still set after teardown: $TMB_SANDBOX_ORIG_PATH"
fi

test_case "TMB_TEST_REMOTE unset after teardown"
if [ -z "${TMB_TEST_REMOTE:-}" ]; then
  _pass
else
  _fail "TMB_TEST_REMOTE still set after teardown: $TMB_TEST_REMOTE"
fi

summarize
