#!/usr/bin/env bash
# Tests for scripts/hooks/prompt-intent-hints.sh
# Covers positive (fires) and negative (false-positive guard) cases for
# every pattern class: consultant-spawn, search-grounding, concerns-protocol,
# push-intent, reonboard-intent, resume-intent, adr-required.
#
# DB-backed classes (push-intent, reonboard-intent, resume-intent,
# consultant-spawn named-role) are tested without a live DB — the hook must
# exit silently (no additionalContext) when the DB is absent or the query
# returns nothing.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/prompt-intent-hints.sh"

# Run the hook with a prompt string; disable all bypass env vars.
run_hook() {
  local prompt="$1"
  local payload
  payload=$(jq -cn --arg p "$prompt" '{prompt:$p}')
  (
    cd "$PLUGIN_ROOT" || exit 1
    printf '%s' "$payload" \
    | TMB_DISABLE_CHEATCODE_INSTALL_HINT=0 \
      TMB_DISABLE_CONSULTANT_HINT=0 \
      TMB_DISABLE_SEARCH_HINT=0 \
      TMB_DISABLE_CONCERNS_HINT=0 \
      TMB_DISABLE_PUSH_INTENT_HINT=0 \
      TMB_DISABLE_REONBOARD_HINT=0 \
      TMB_DISABLE_RESUME_HINT=0 \
      TMB_DISABLE_ADR_HINT=0 \
      TRAJECTORY_DB_PATH=/nonexistent.db \
      bash "$HOOK" 2>&1 || true
  )
}

# Silent when prompt is empty.
test_case "empty prompt emits nothing"
out=$(run_hook "")
assert_not_contains "$out" "additionalContext" "empty prompt must be silent"

# ---------------------------------------------------------------------------
# cheatcode-install: install of a named plugin/skill/mcp/cheatcode
# ---------------------------------------------------------------------------

test_case "cheatcode-install: row-44 install-plugins-in-local-scope prompt fires"
out=$(run_hook "install the feature-dev and code-review plugins in local scope")
assert_contains "$out" "cheatcode-install routing" "named plugin install must fire"
assert_contains "$out" "cheatcode_approve" "CTX must name cheatcode_approve"
assert_contains "$out" "cheatcode_install" "CTX must name cheatcode_install"
assert_contains "$out" "NOT agent" "CTX must say NOT agent-create"

test_case "cheatcode-install: 'install the X skill' fires"
out=$(run_hook "Please install the superpowers skill")
assert_contains "$out" "cheatcode-install routing" "named skill install must fire"

test_case "cheatcode-install: 'install the X mcp' fires"
out=$(run_hook "install the linear mcp")
assert_contains "$out" "cheatcode-install routing" "named mcp install must fire"

test_case "cheatcode-install: 'in global scope' alone fires"
out=$(run_hook "set it up in global scope")
assert_contains "$out" "cheatcode-install routing" "in global scope must fire"

test_case "cheatcode-install: 'npm install' does NOT fire"
out=$(run_hook "Run npm install to get the deps")
assert_not_contains "$out" "cheatcode-install routing" "npm install must not fire"

test_case "cheatcode-install: 'pip install' does NOT fire"
out=$(run_hook "pip install requests for the script")
assert_not_contains "$out" "cheatcode-install routing" "pip install must not fire"

test_case "cheatcode-install: 'bun install' does NOT fire"
out=$(run_hook "bun install in the server directory")
assert_not_contains "$out" "cheatcode-install routing" "bun install (no capability noun) must not fire"

test_case "cheatcode-install: 'install dependencies' does NOT fire"
out=$(run_hook "install dependencies before running the build")
assert_not_contains "$out" "cheatcode-install routing" "install dependencies must not fire"

test_case "cheatcode-install: bare role name still routes to agent-create (no regression)"
out=$(run_hook "get the architect's read on this design choice?")
assert_not_contains "$out" "cheatcode-install routing" "bare role must not hit cheatcode hint"
assert_contains "$out" "consultant-spawn enforcement" "bare role still routes to agent-create"

# ---------------------------------------------------------------------------
# cheatcode-routing: install/add a capability TARGETED AT a known agent
# ("install <X> for swe", "add <X> to bro") → load tmb_cheatcode, not planning
# ---------------------------------------------------------------------------

test_case "cheatcode-routing: 'install <X> for swe and pr-reviewer' fires cheatcode cue"
out=$(run_hook "install typescript-lsp for swe and pr-reviewer")
assert_contains "$out" "cheatcode-routing" "capability-on-agent install must fire"
assert_contains "$out" "tmb_cheatcode" "CTX must point to tmb_cheatcode skill"

test_case "cheatcode-routing: 'add <X> to bro' fires cheatcode cue"
out=$(run_hook "add a web-search tool to bro")
assert_contains "$out" "cheatcode-routing" "add-to-agent must fire"
assert_contains "$out" "tmb_cheatcode" "CTX must point to tmb_cheatcode skill"

test_case "cheatcode-routing: positive cue does not name a 'don't use planning' clause"
out=$(run_hook "install ripgrep for swe")
assert_contains "$out" "cheatcode-routing" "capability-on-agent must fire"
assert_not_contains "$out" "planning" "positive disambiguation only — no negative planning clause"

test_case "cheatcode-routing: plain dependency install does NOT fire cheatcode cue"
out=$(run_hook "npm install to get the deps for the build")
assert_not_contains "$out" "cheatcode-routing" "dependency install (no agent target) must not fire"

test_case "cheatcode-routing: 'install dependencies' does NOT fire cheatcode cue"
out=$(run_hook "install dependencies before running the build")
assert_not_contains "$out" "cheatcode-routing" "install dependencies must not fire"

# ---------------------------------------------------------------------------
# consultant-spawn: domain keyword + advisory shape required
# ---------------------------------------------------------------------------

test_case "consultant-spawn: security + question shape fires"
out=$(run_hook "Is this SQL injection vulnerability safe to ignore?")
assert_contains "$out" "consultant-spawn enforcement" "security + ? must fire"

test_case "consultant-spawn: performance word-boundary + advisory shape fires"
out=$(run_hook "Should we benchmark our perf to find bottlenecks?")
assert_contains "$out" "consultant-spawn enforcement" "perf word + should fires"

test_case "consultant-spawn: 'performance' substring does NOT fire (no advisory shape)"
out=$(run_hook "The CI pipeline has a performance issue I am debugging")
assert_not_contains "$out" "consultant-spawn enforcement" "bare performance substring must not fire"

test_case "consultant-spawn: 'perform' does NOT fire (not word-bounded 'perf')"
out=$(run_hook "Please perform the deployment")
assert_not_contains "$out" "consultant-spawn enforcement" "perform must not fire on perf check"

test_case "consultant-spawn: 'perfect' does NOT fire"
out=$(run_hook "That's a perfect solution to the problem")
assert_not_contains "$out" "consultant-spawn enforcement" "perfect must not fire"

test_case "consultant-spawn: architecture trade-off + question fires"
out=$(run_hook "What are the architecture trade-offs between these two approaches?")
assert_contains "$out" "consultant-spawn enforcement" "architecture trade-off + ? fires"

test_case "consultant-spawn: domain keyword alone without advisory shape does NOT fire"
out=$(run_hook "The security module is now updated")
assert_not_contains "$out" "consultant-spawn enforcement" "security statement without ? must not fire"

test_case "consultant-spawn: legal + should fires"
out=$(run_hook "Should we be worried about GDPR compliance here?")
assert_contains "$out" "consultant-spawn enforcement" "legal/gdpr + should fires"

# ---------------------------------------------------------------------------
# search-grounding: decision-anchored patterns
# ---------------------------------------------------------------------------

test_case "search-grounding: 'why did we' fires"
out=$(run_hook "Why did we choose SQLite over Postgres?")
assert_contains "$out" "search-grounding hint" "why did we must fire"

test_case "search-grounding: 'what did we decide' fires"
out=$(run_hook "What did we decide about the branching model?")
assert_contains "$out" "search-grounding hint" "what did we decide must fire"

test_case "search-grounding: 'rationale for' fires"
out=$(run_hook "What was the rationale for using jq here?")
assert_contains "$out" "search-grounding hint" "rationale for must fire"

test_case "search-grounding: 'why is' does NOT fire (bare debugging — dropped)"
out=$(run_hook "Why is the build failing on CI?")
assert_not_contains "$out" "search-grounding hint" "bare 'why is' must not fire"

test_case "search-grounding: 'why was' does NOT fire (bare debugging — dropped)"
out=$(run_hook "Why was this variable renamed?")
assert_not_contains "$out" "search-grounding hint" "bare 'why was' must not fire"

test_case "search-grounding: 'why are we' does NOT fire"
out=$(run_hook "Why are we using this library instead of that one?")
assert_not_contains "$out" "search-grounding hint" "bare 'why are we' must not fire"

# ---------------------------------------------------------------------------
# concerns-protocol: doubt-class phrases
# ---------------------------------------------------------------------------

test_case "concerns-protocol: 'delete the test' fires with pointer shape"
out=$(run_hook "Can you delete the test that's failing?")
assert_contains "$out" "concerns-protocol hint" "delete the test fires"
assert_contains "$out" "tmb_concerns-protocol" "CTX must point to skill, not restate procedure"

test_case "concerns-protocol: 'force push' fires"
out=$(run_hook "Just force push the branch")
assert_contains "$out" "concerns-protocol hint" "force push fires"

test_case "concerns-protocol: 'skip validation' fires"
out=$(run_hook "Skip validation for this one")
assert_contains "$out" "concerns-protocol hint" "skip validation fires"

test_case "concerns-protocol: 'bypass the check' fires"
out=$(run_hook "Can we bypass the check this time?")
assert_contains "$out" "concerns-protocol hint" "bypass the check fires"

test_case "concerns-protocol: benign 'delete' does NOT fire"
out=$(run_hook "Please delete the temp files after the build")
assert_not_contains "$out" "concerns-protocol hint" "benign delete must not fire"

test_case "concerns-protocol: benign 'push' does NOT fire"
out=$(run_hook "Can you push the code when ready?")
assert_not_contains "$out" "concerns-protocol hint" "benign push must not fire"

# ---------------------------------------------------------------------------
# push-intent: no DB → silent even when pattern matches
# ---------------------------------------------------------------------------

test_case "push-intent: 'git push' with no DB → silent"
out=$(run_hook "git push origin main")
assert_not_contains "$out" "push-intent hint" "push-intent with no DB must be silent"

test_case "push-intent: 'ship it' with no DB → silent"
out=$(run_hook "ship it")
assert_not_contains "$out" "push-intent hint" "ship it with no DB must be silent"

test_case "push-intent: 'ship the code' does NOT fire (not in pattern list)"
out=$(run_hook "ship the code when ready")
assert_not_contains "$out" "push-intent hint" "ship the code is not a push-intent pattern"

# ---------------------------------------------------------------------------
# reonboard-intent: no DB → silent even when pattern matches
# ---------------------------------------------------------------------------

test_case "reonboard-intent: 'host on github' with no DB → silent"
out=$(run_hook "I want to host on github")
assert_not_contains "$out" "reonboard-intent hint" "reonboard with no DB must be silent"

test_case "reonboard-intent: '/onboard' in prompt → skipped"
out=$(run_hook "/onboard my project on github")
assert_not_contains "$out" "reonboard-intent hint" "/onboard prompt must be skipped"

# ---------------------------------------------------------------------------
# resume-intent: no DB → silent even when pattern matches
# ---------------------------------------------------------------------------

test_case "resume-intent: 'keep going' with no DB → silent"
out=$(run_hook "keep going on the auth work")
assert_not_contains "$out" "resume-intent hint" "resume with no DB must be silent"

test_case "resume-intent: 'still pending' with no DB → silent"
out=$(run_hook "Any tasks still pending?")
assert_not_contains "$out" "resume-intent hint" "still pending with no DB must be silent"

# ---------------------------------------------------------------------------
# adr-required: architectural intent
# ---------------------------------------------------------------------------

test_case "adr-required: 'migrate to postgres' fires with pointer shape"
out=$(run_hook "We should migrate to postgres this sprint")
assert_contains "$out" "architectural-change hint" "migrate to postgres fires"
assert_contains "$out" "tmb_planning" "CTX must point to skill, not restate ADR procedure"

test_case "adr-required: 'plugin architecture' fires"
out=$(run_hook "Let's adopt a plugin architecture for extensibility")
assert_contains "$out" "architectural-change hint" "plugin architecture fires"

test_case "adr-required: 'rewrite ... in' two-token check fires"
out=$(run_hook "Let's rewrite the scanner in Go for speed")
assert_contains "$out" "architectural-change hint" "rewrite ... in fires"

test_case "adr-required: 'port ... to' two-token check fires"
out=$(run_hook "Can we port the plugin to TypeScript?")
assert_contains "$out" "architectural-change hint" "port ... to fires"

test_case "adr-required: dead literal 'rewrite ... in' glob does NOT false-negative"
out=$(run_hook "rewrite ... in")
assert_contains "$out" "architectural-change hint" "literal 'rewrite ... in' still matches via two-token"

test_case "adr-required: benign 'port' does NOT fire"
out=$(run_hook "Open port 8080 in the firewall")
assert_not_contains "$out" "architectural-change hint" "open port N must not fire"

test_case "adr-required: 'replatform' fires"
out=$(run_hook "We need to replatform the backend service")
assert_contains "$out" "architectural-change hint" "replatform fires"

test_case "adr-required: 'use react instead' fires"
out=$(run_hook "Should we use React instead of vanilla JS?")
assert_contains "$out" "architectural-change hint" "use react instead fires"

# ---------------------------------------------------------------------------
# Bypass env vars
# ---------------------------------------------------------------------------

test_case "TMB_DISABLE_CONCERNS_HINT=1 suppresses concerns-protocol"
out=$(
  payload=$(jq -cn '{prompt:"delete the test that is flaky"}')
  cd "$PLUGIN_ROOT" || exit 1
  printf '%s' "$payload" \
  | TMB_DISABLE_CONCERNS_HINT=1 TRAJECTORY_DB_PATH=/nonexistent.db bash "$HOOK" 2>&1 || true
)
assert_not_contains "$out" "concerns-protocol hint" "TMB_DISABLE_CONCERNS_HINT=1 must suppress"

test_case "TMB_DISABLE_ADR_HINT=1 suppresses adr-required"
out=$(
  payload=$(jq -cn '{prompt:"migrate to postgres this sprint"}')
  cd "$PLUGIN_ROOT" || exit 1
  printf '%s' "$payload" \
  | TMB_DISABLE_ADR_HINT=1 TRAJECTORY_DB_PATH=/nonexistent.db bash "$HOOK" 2>&1 || true
)
assert_not_contains "$out" "architectural-change hint" "TMB_DISABLE_ADR_HINT=1 must suppress"

test_case "TMB_DISABLE_SEARCH_HINT=1 suppresses search-grounding"
out=$(
  payload=$(jq -cn '{prompt:"why did we choose sqlite?"}')
  cd "$PLUGIN_ROOT" || exit 1
  printf '%s' "$payload" \
  | TMB_DISABLE_SEARCH_HINT=1 TRAJECTORY_DB_PATH=/nonexistent.db bash "$HOOK" 2>&1 || true
)
assert_not_contains "$out" "search-grounding hint" "TMB_DISABLE_SEARCH_HINT=1 must suppress"

# ---------------------------------------------------------------------------
# Advisory hook never exits non-zero
# ---------------------------------------------------------------------------

test_case "hook exits 0 on all inputs"
for prompt in "" "ls" "why is this slow" "delete the test" "migrate to postgres" "git push"; do
  ec=0
  payload=$(jq -cn --arg p "$prompt" '{prompt:$p}')
  printf '%s' "$payload" \
  | TRAJECTORY_DB_PATH=/nonexistent.db bash "$HOOK" >/dev/null 2>&1 || ec=$?
  if [ "$ec" -ne 0 ]; then
    _fail "hook exited $ec for prompt: $prompt"
    break
  fi
done
_pass 2>/dev/null || true

summarize
