#!/usr/bin/env bash
# Full TMB plugin test suite. Exit 0 only if every layer passes.
# This script runs L1–L4 only. See tests/README.md for the full pyramid.
#
# Layered model (authoritative reference: tests/README.md):
#   L0 — Install-smoke (Docker)          → tests/l0-install/install-smoke.Dockerfile (installation layer: run locally with Docker before a PR; release-gate also runs it on rc tags)
#   L1 — Static / lint                   → tests/l1-lint/*.sh              ← this file
#   L2 — Unit (MCP handlers)             → mcp/trajectory-server/src/test/*.ts ← this file
#   L3 — Integration (server + hooks)    → tests/l3-integration/mcp/*.mjs (hook suites: mcp/trajectory-server/src/test/*-l3.test.ts, run in L2) ← this file
#   L4 — Workflow simulation             → tests/l4-workflow-sim/*.mjs     ← this file
#   L5 — Per-row eval (real CC)          → bash tests/l5-l6/run-l5.sh (token required)
#   L6 — Multi-turn chain (real CC)      → bash tests/l5-l6/run-l6-chain.sh (token required)
#   Release canary                       → tests/l0-install/release-canary.Dockerfile (release-gate on RC tags)

set -uo pipefail

export TMB_DISABLE_REMOTE_SYNC=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/.." && pwd)"
FAIL=0

# --l1-only: stop after the L1 block (PR check, GH 2064).
_l1_only=0
[ "${1:-}" = "--l1-only" ] && _l1_only=1

# TMB_L1_SKIP: space-separated lint basenames whose steps print SKIP instead of running.
_l1_skipped() {
  local arg skip
  for skip in ${TMB_L1_SKIP:-}; do
    for arg in "$@"; do
      [ "${arg##*/}" = "$skip" ] && return 0
    done
  done
  return 1
}

run_step() {
  local label="$1"
  shift
  printf "\n=== %s ===\n" "$label"
  if _l1_skipped "$@"; then
    printf "→ SKIP (TMB_L1_SKIP)\n"
  elif "$@"; then
    printf "→ PASS\n"
  else
    printf "→ FAIL\n"
    FAIL=1
  fi
}

# ----- Run scratch + HOME footprint ------------------------------------------
# Stubs and tool caches (bun, mise state) live in one run-scoped temp dir that
# goes when the run ends; the real mise installs on PATH (and their config)
# stay resolvable under any HOME. A run started with an empty HOME
# (`HOME=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/home.XXXXXX") bash tests/run-all.sh`) must end with that HOME holding
# nothing but the embedding model cache, .cache/huggingface.
_run_tmp=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-run-all.XXXXXX")
trap 'rm -rf "$_run_tmp"' EXIT
_home_isolated=0
[ -z "$(ls -A "$HOME" 2>/dev/null)" ] && _home_isolated=1
export BUN_INSTALL_CACHE_DIR="$_run_tmp/bun-install-cache"
export BUN_RUNTIME_TRANSPILER_CACHE_PATH="$_run_tmp/bun-transpiler-cache"
export MISE_STATE_DIR="$_run_tmp/mise-state" MISE_CACHE_DIR="$_run_tmp/mise-cache"
if [ -z "${MISE_DATA_DIR:-}" ]; then
  MISE_DATA_DIR=$(printf '%s\n' "$PATH" | tr ':' '\n' | sed -n 's|^\(.*/mise\)/installs/.*|\1|p' | head -1)
  export MISE_DATA_DIR="${MISE_DATA_DIR:-$_run_tmp/mise-data}"
fi
_mise_home="${MISE_DATA_DIR%/.local/share/mise}"
if [ -z "${MISE_CONFIG_DIR:-}" ] && [ "$_mise_home" != "$MISE_DATA_DIR" ] && [ -d "$_mise_home/.config/mise" ]; then
  export MISE_CONFIG_DIR="$_mise_home/.config/mise"
fi

# ----- Live-CLI stubs (L1, L2 and L4) ----------------------------------------
# gh/glab/claude stubs append to a sentinel file on invocation and exit 97; a
# 0-byte sentinel means the step made no live CLI calls (B5 incident guard).
# L2 and L4 also run with TMB_FORBID_LIVE_SYNC=1, under which the scan walker
# reads its plugin list from TMB_SCAN_PLUGIN_JSON (an empty list here) instead
# of spawning `claude plugin list --json`.
_stub_dir="$_run_tmp/stubs"
mkdir -p "$_stub_dir"
_sentinel="$_stub_dir/live-cli-sentinel"
touch "$_sentinel"
for _cli in gh glab claude; do
  cat > "$_stub_dir/$_cli" <<STUB
#!/usr/bin/env bash
echo "LIVE-CLI BLOCKED: $_cli \$*" >> "$_sentinel"
echo "tmb test-stub: $_cli blocked (exit 97)" >&2
exit 97
STUB
  chmod +x "$_stub_dir/$_cli"
done
_scan_plugin_json="$_run_tmp/claude-plugin-list.json"
echo '[]' > "$_scan_plugin_json"

# live_cli_check <step>: fail when the stubs were called, then reset.
live_cli_check() {
  if [ -s "$_sentinel" ]; then
    printf "→ FAIL: live CLI calls detected during %s:\n" "$1"
    cat "$_sentinel"
    : > "$_sentinel"
    return 1
  fi
  printf "→ sentinel 0-byte: no live CLI calls during %s. PASS\n" "$1"
}

# ----- Build the generated payload --------------------------------------
# Server dist, dashboard dist, audit-events.txt and data-contracts.json, which
# the L1 lints below read (GH 2054).
run_step "Build: generated payload (bun run build:payload)" bun run --cwd "$PLUGIN_ROOT" build:payload

# ----- L1 — Static / lint -----------------------------------------------
# Offline: lints that would query a forge (TMB_L1_OFFLINE=1) skip, and the
# stubs above shadow gh/glab/claude.

_l1_saved_path="$PATH"
export PATH="$_stub_dir:$PATH" TMB_L1_OFFLINE=1

run_step "L1 lint: agent template line budget"        node --test "$HERE/l1-lint/agent-line-budget.test.mjs"
run_step "L1 lint: agent frontmatter declares experimental.cacheTtl"  node --test "$HERE/l1-lint/agent-cache-ttl.test.mjs"
run_step "L1 lint: agent template byte-identity (swe + code-reviewer)"  node --test "$HERE/l1-lint/agent-template-byte-identity.test.mjs"
run_step "L1 lint: local agent overrides retain workflow primitives"   node --test "$HERE/l1-lint/local-agent-primitives.test.mjs"
run_step "L1 lint: shipped swe/code-reviewer task_brief contract (#300)"  node --test "$HERE/l1-lint/agent-task-brief-contract.test.mjs"
run_step "L1 lint: skill frontmatter + name=dirname"  node --test "$HERE/l1-lint/skill-frontmatter.test.mjs"
run_step "L1 lint: command frontmatter (description + argument-hint)"  node --test "$HERE/l1-lint/command-frontmatter.test.mjs"
run_step "L1 lint: manifest shape (plugin/.mcp/hooks)" node --test "$HERE/l1-lint/manifest-shape.test.mjs"
run_step "L1 lint: Codex Scope-4 Agent contract"      bash "$HERE/l1-lint/codex-scope4-contract.sh"
run_step "L1 lint: legacy reviewer name only where allowlisted (GH 1641)"  node --test "$HERE/l1-lint/legacy-reviewer-name.test.mjs"
run_step "L1 lint: version sync (4 manifests agree)"  node --test "$HERE/l1-lint/version-sync.test.mjs"
run_step "L1 lint: changelog top section current"     node --test "$HERE/l1-lint/changelog-current.test.mjs"
run_step "L1 lint: link-check (relative md links)"    node --test "$HERE/l1-lint/link-check.test.mjs"
run_step "L1 lint: shellcheck on shell scripts"       node --test "$HERE/l1-lint/shellcheck-hooks.test.mjs"
run_step "L1 lint: no bare mktemp (explicit path template)"  node --test "$HERE/l1-lint/no-bare-mktemp.test.mjs"
run_step "L1 lint: no grep -q in pipelines under pipefail" node --test "$HERE/l1-lint/no-grep-q-in-pipelines.test.mjs"
run_step "L1 lint: no wall-clock asserts in tests" node --test "$HERE/l1-lint/no-wall-clock-asserts.test.mjs"
run_step "L1 lint: no destructive SQL in migrations"  node --test "$HERE/l1-lint/no-destructive-sql.test.mjs"
run_step "L1 lint: tsc --noEmit on MCP server"        node --test "$HERE/l1-lint/tsc-noemit.test.mjs"
run_step "L1 lint: dist entrypoints are esbuild bundles" node --test "$HERE/l1-lint/dist-bundles.test.mjs"
run_step "L1 lint: bundle whitespace preserves string constants"  node --test "$HERE/l1-lint/bundle-whitespace-safety.test.mjs"
run_step "L1 lint: labels.json triage rule + LABELS.md generated fresh"  node --test "$HERE/l1-lint/labels.test.mjs"
run_step "L1 lint: no generated output tracked in git"  node --test "$HERE/l1-lint/no-tracked-generated.test.mjs"
run_step "L1 lint: bug.yml matches the bug-report FORM_FIELDS"  node --test "$HERE/l1-lint/bug-form.test.mjs"
run_step "L1 lint: new ts/tsx/sh files open with a purpose header"  node --test "$HERE/l1-lint/purpose-header.test.mjs"
run_step "L1 lint: shipped skills match builtin seed"  node --test "$HERE/l1-lint/skill-catalog-sync.test.mjs"
run_step "L1 lint: ENUMs.md vs code parity"           node --test "$HERE/l1-lint/enums-stable.test.mjs"
run_step "L1 lint: ENUMS.md event table + audit-events.txt generated fresh"  node --test "$HERE/l1-lint/enums-doc-fresh.test.mjs"
run_step "L1 lint: ERD.md generated from schema.sql"  node --test "$HERE/l1-lint/erd-doc-fresh.test.mjs"
run_step "L1 lint: CONFIG_KEYS.md generated from code" node --test "$HERE/l1-lint/config-keys-doc-fresh.test.mjs"
run_step "L1 lint: tool docs list every family + tool" node --test "$HERE/l1-lint/tool-families-documented.test.mjs"
run_step "L1 lint: no negative directives in prompts" node --test "$HERE/l1-lint/no-negative-directives.test.mjs"
run_step "L1 lint: issue_sync test must mock spawn"   node --test "$HERE/l1-lint/issue-sync-test-isolation.test.mjs"
run_step "L1 lint: no audit_append without from_node" node --test "$HERE/l1-lint/no-audit-log-without-from-node.test.mjs"
run_step "L1 lint: no citations in prompts"           node --test "$HERE/l1-lint/no-citations-in-prompts.test.mjs"
run_step "L1 lint: no kuzu in prompts"                node --test "$HERE/l1-lint/no-kuzu-in-prompts.test.mjs"
run_step "L1 lint: no repository paths in prompts" node --test "$HERE/l1-lint/no-repo-paths-in-prompts.test.mjs"
run_step "L1 lint: explicit paths and git -C in prompts" node --test "$HERE/l1-lint/prompt-explicit-paths.test.mjs"
run_step "L1 lint: no file_registry refs (v7 retirement)"  node --test "$HERE/l1-lint/no-file-registry-refs.test.mjs"
run_step "L1 lint: no audit_append kind= arg"         node --test "$HERE/l1-lint/no-audit-log-kind.test.mjs"
run_step "L1 lint: single audit write path (insertAudit)"  node --test "$HERE/l1-lint/single-audit-write-path.test.mjs"
run_step "L1 lint: no developer paths in artifacts"   node --test "$HERE/l1-lint/no-developer-paths.test.mjs"
run_step "L1 lint: no stale framing prose"            node --test "$HERE/l1-lint/stale-framing-prose.test.mjs"
run_step "L1 lint: no hardcoded plugin name"          node --test "$HERE/l1-lint/no-hardcoded-plugin-name.test.mjs"
run_step "L1 lint: CI workflow file refs exist"       node --test "$HERE/l1-lint/ci-workflow-refs-exist.test.mjs"
run_step "L1 lint: no bare role compare in hooks"     node --test "$HERE/l1-lint/no-bare-role-compare.test.mjs"
run_step "L1 lint: symlink targets all resolve"       node --test "$HERE/l1-lint/symlink-targets.test.mjs"
run_step "L1 lint: hooks.json commands executable"     node --test "$HERE/l1-lint/hooks-executable.test.mjs"
run_step "L1 lint: L5 harness helpers (flow-helpers.test.sh)" bash "$HERE/l5-l6/lib/flow-helpers.test.sh"
run_step "L1 lint: valid permissionDecision values"    node --test "$HERE/l1-lint/valid-permission-decisions.test.mjs"
run_step "L1 lint: no citations of the retired shell gates" node --test "$HERE/l1-lint/no-retired-hook-gate-paths.test.mjs"
run_step "L1 lint: no directories-table refs"         node --test "$HERE/l1-lint/no-directories-table-refs.test.mjs"
run_step "L1 lint: RAG schema invariants"             node --test "$HERE/l1-lint/rag-schema-invariants.test.mjs"
run_step "L1 lint: tool-description byte budget"      node --test "$HERE/l1-lint/tool-description-budget.test.mjs"
run_step "L1 lint: dir toolchain allowlist"           node --test "$HERE/l1-lint/dir-toolchain.test.mjs"
run_step "L1 lint: no raw SQL interpolation in hooks" node --test "$HERE/l1-lint/no-raw-sql-interpolation.test.mjs"
run_step "L1 lint: tmb_gate_read SQL is read-only" node --test "$HERE/l1-lint/gate-read-sql-readonly.test.mjs"
run_step "L1 lint: no direct sqlite3 writes in scripts" node --test "$HERE/l1-lint/no-direct-sqlite-write.test.mjs"
run_step "L1 lint: every sqlite3 call sets a busy timeout" node --test "$HERE/l1-lint/sqlite3-needs-timeout.test.mjs"
run_step "L1 lint: one trajectory-DB path rule (no private copies)" node --test "$HERE/l1-lint/no-private-db-path.test.mjs"
run_step "L1 lint: no writes under the home directory" node --test "$HERE/l1-lint/no-home-writes.test.mjs"
run_step "L1 lint: claude CLI config calls pinned to project scope" node --test "$HERE/l1-lint/cli-config-scope.test.mjs"
run_step "L1 lint: no in-session plugin commands prescribed" node --test "$HERE/l1-lint/no-in-session-plugin-commands.test.mjs"
run_step "L1 lint: no hard-coded /tmp writes" node --test "$HERE/l1-lint/no-tmp-writes.test.mjs"
run_step "L1 lint: live-db shim survives a plain parent directory" node --test "$HERE/lib/live-db-shim.test.mjs"
run_step "L1 lint: no datetime('now') in scripts"     node --test "$HERE/l1-lint/no-datetime-now-in-hooks.test.mjs"
run_step "L1 lint: no secrets in tracked source"    node --test "$HERE/l1-lint/no-secrets-in-source.test.mjs"
run_step "L1 lint: main-source-guard + CODEOWNERS present" node --test "$HERE/l1-lint/main-guard-files-present.test.mjs"
run_step "L1 lint: no filesystem writes at module load" node --test "$HERE/l1-lint/no-module-load-writes.test.mjs"
run_step "L1 lint: scan-forking unit tests pin TRAJECTORY_DB_PATH" node --test "$HERE/l1-lint/no-unpinned-scan-in-tests.test.mjs"
run_step "L1 lint: no .tmp-* scratch dir in the checkout" node --test "$HERE/l1-lint/no-scratch-in-tree.test.mjs"
run_step "L1 lint: nothing finds the project or a repo from the cwd" node --test "$HERE/l1-lint/no-cwd-reads.test.mjs"
run_step "L1 lint: /onboard option wording is plain language" node --test "$HERE/l1-lint/onboard-option-wording.test.mjs"
run_step "L1 lint: release-payload workflow safety shape" node --test "$HERE/l1-lint/release-payload-workflow.test.mjs"

# Every tests/l1-lint/*.sh and tests/l1-lint/*.test.mjs has a run_step line above.
l1_lints_all_wired() {
  local lint missing=0
  for lint in "$HERE"/l1-lint/*.sh "$HERE"/l1-lint/*.test.mjs; do
    if ! grep -qF "l1-lint/$(basename "$lint")\"" "$HERE/run-all.sh"; then
      echo "  ✗ tests/l1-lint/$(basename "$lint") has no run_step in tests/run-all.sh" >&2
      missing=1
    fi
  done
  return "$missing"
}
run_step "L1 self-check: every tests/l1-lint/*.sh and *.test.mjs runs here" l1_lints_all_wired

# ----- L1-adjacent: benchmark selftest (fast, deterministic) ------------

run_step "L1 bench: measurement harness selftest"     node --test "$HERE/benchmarks/selftest.test.mjs"

export PATH="$_l1_saved_path"
unset TMB_L1_OFFLINE
live_cli_check "L1" || FAIL=1
[ "$_l1_only" = 1 ] && exit "$FAIL"

# ----- L2 — Unit (no live gh/glab/claude calls) -----------------------------
# Builds dist/ and runs the MCP unit suite once, behind the live-CLI stubs and
# with TMB_FORBID_LIVE_SYNC=1 and the scan plugin-list fixture.

printf "\n=== L2 unit: MCP handlers (node --test on built dist/, live-CLI stubs) ===\n"
if (
  export PATH="$_stub_dir:$PATH"
  export TMB_FORBID_LIVE_SYNC=1 TMB_SCAN_PLUGIN_JSON="$_scan_plugin_json"
  cd "$PLUGIN_ROOT/mcp/trajectory-server"
  bun run build && node --experimental-sqlite --test dist/test/*.test.js
); then
  printf "→ PASS\n"
else
  printf "→ FAIL\n"
  FAIL=1
fi
live_cli_check "L2" || FAIL=1

# ----- L3 — Integration ------------------------------------------------------

run_step "L3 integration: MCP server end-to-end (stdio JSON-RPC)"  node "$HERE/l3-integration/mcp/run.mjs"
run_step "L3 integration: L5 scorer unit tests"                      node --experimental-strip-types --experimental-sqlite --test "$HERE/l5-l6/lib/scorers.test.ts"
run_step "L3 integration: L5/L6 helper libs (TS)"                     node --experimental-strip-types --experimental-sqlite --test "$HERE/l5-l6/lib/flow-helpers.test.ts" "$HERE/l5-l6/lib/l6-chain-helpers.test.ts" "$HERE/l5-l6/lib/sandbox.test.ts" "$HERE/l5-l6/lib/smoke-helpers.test.ts" "$HERE/l5-l6/lib/timeout.test.ts"
run_step "L3 integration: sandbox network probe + inspect-trajectory" node --experimental-strip-types --test "$HERE/l5-l6/probes/sandbox-network-probe.test.ts" "$HERE/l5-l6/inspect-trajectory.test.ts"
run_step "L3 integration: runtime payload prune (dev-build)"          node --test "$HERE/l3-integration/runtime-payload.test.mjs"
run_step "L3 integration: generated payload parity (dev-build)"       node --test "$HERE/l3-integration/payload-parity.test.mjs"
run_step "L3 integration: await payload/<tag> on the remote"          node --test "$HERE/l3-integration/await-payload-tag.test.mjs"
run_step "L3 integration: release.ts + publish-rc-channel.ts (stubbed git/gh)"  node --test "$HERE/l3-integration/release-scripts.test.mjs"
run_step "L3 integration: changelog fragments + bump-version"         node --test "$HERE/l3-integration/changelog-fragments.test.mjs"
run_step "L3 integration: dev-build-version"                          node --test "$HERE/l3-integration/dev-build-version.test.mjs"

# ----- L4 — Workflow simulation (MCP server scripted flows) -----------------
# The spawned server inherits the stubs, TMB_FORBID_LIVE_SYNC=1 and the scan
# plugin-list fixture, so its gh/glab auth probes and scan never reach a
# real CLI. Each flow gets a 30 s per-test timeout (bun's 5 s default flakes
# under a loaded full run).

_l4_saved_path="$PATH"
export PATH="$_stub_dir:$PATH" TMB_FORBID_LIVE_SYNC=1 TMB_SCAN_PLUGIN_JSON="$_scan_plugin_json"
run_step "L4 workflow-sim: flow-02 simple-task"            bun test --timeout 30000 "$HERE/l4-workflow-sim/flow-02-simple-task.test.mjs"
run_step "L4 workflow-sim: flow-03 difficult-task"          bun test --timeout 30000 "$HERE/l4-workflow-sim/flow-03-difficult-task.test.mjs"
run_step "L4 workflow-sim: flow-06 push-gate"               bun test --timeout 30000 "$HERE/l4-workflow-sim/flow-06-push-gate.test.mjs"
run_step "L4 workflow-sim: flow-08 swe-retry"               bun test --timeout 30000 "$HERE/l4-workflow-sim/flow-08-swe-retry.test.mjs"
run_step "L4 workflow-sim: flow-09 anonymous-cold-restart"  bun test --timeout 30000 "$HERE/l4-workflow-sim/flow-09-anonymous-cold-restart.test.mjs"
run_step "L4 workflow-sim: flow-10 roundtable-composite"    bun test --timeout 30000 "$HERE/l4-workflow-sim/flow-10-roundtable-composite.test.mjs"
run_step "L4 workflow-sim: flow-11 concurrent-siblings" bun test --timeout 30000 "$HERE/l4-workflow-sim/flow-11-concurrent-siblings.test.mjs"
run_step "L4 workflow-sim: flow-12 spec-amend"        bun test --timeout 30000 "$HERE/l4-workflow-sim/flow-12-spec-amend.test.mjs"
run_step "L4 workflow-sim: flow-13 issue-update-milestone" bun test --timeout 30000 "$HERE/l4-workflow-sim/flow-13-issue-update-milestone.test.mjs"
run_step "L4 workflow-sim: flow-14 repo-rename"       bun test --timeout 30000 "$HERE/l4-workflow-sim/flow-14-repo-rename.test.mjs"

export PATH="$_l4_saved_path"
unset TMB_FORBID_LIVE_SYNC TMB_SCAN_PLUGIN_JSON
live_cli_check "L4" || FAIL=1

# ----- isolated-HOME footprint ------------------------------------------------

if [ "$_home_isolated" -eq 1 ]; then
  printf "\n=== HOME footprint (run started with an empty HOME) ===\n"
  _home_leaks=$(find "$HOME" -mindepth 1 \( -path "$HOME/.cache/huggingface" -prune \) -o \( -path "$HOME/.cache" \) -o -print 2>/dev/null | sed "s|^$HOME|\$HOME|")
  if [ -n "$_home_leaks" ]; then
    printf "→ FAIL: the run wrote under HOME:\n%s\n" "$_home_leaks"
    FAIL=1
  else
    printf "→ PASS: HOME holds nothing but .cache/huggingface\n"
  fi
fi

# ----- summary -----------------------------------------------------------

printf "\n========================================\n"
if [ "$FAIL" -eq 0 ]; then
  printf "All test layers passed (L1 + L2 + L3 + L4).\n"
  printf "L0 install-smoke is separate: run node --experimental-strip-types tests/l0-install/run-docker.ts install with Docker before a PR (release-gate also runs it on rc tags).\n"
  exit 0
else
  printf "One or more layers FAILED. See output above.\n"
  exit 1
fi
