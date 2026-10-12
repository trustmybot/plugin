#!/usr/bin/env bash
# Full TMB plugin test suite. Exit 0 only if every layer passes.
# This script runs L1–L4 only. See tests/README.md for the full pyramid.
#
# Layered model (authoritative reference: tests/README.md):
#   L0 — Install-smoke (Docker)          → tests/l0-install/install-smoke.Dockerfile (CI-only)
#   L1 — Static / lint                   → tests/l1-lint/*.sh              ← this file
#   L2 — Unit (MCP handlers)             → mcp/trajectory-server/src/test/*.ts ← this file
#   L3 — Integration (server + hooks)    → tests/l3-integration/mcp/*.mjs + tests/l3-integration/hooks/*.sh ← this file
#   L4 — Workflow simulation             → tests/l4-workflow-sim/*.mjs     ← this file
#   L5 — Per-row eval (real CC)          → bash tests/l5-l6/run-l5.sh (token required)
#   L6 — Multi-turn chain (real CC)      → bash tests/l5-l6/run-l6-chain.sh (token required)
#   Release canary                       → tests/l0-install/release-canary.Dockerfile (CI-only, RC tags)

set -uo pipefail

export TMB_DISABLE_REMOTE_SYNC=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/.." && pwd)"
FAIL=0

run_step() {
  local label="$1"
  shift
  printf "\n=== %s ===\n" "$label"
  if "$@"; then
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
# (`HOME=$(mktemp -d) bash tests/run-all.sh`) must end with that HOME holding
# nothing but the embedding model cache, .cache/huggingface.
_run_tmp=$(mktemp -d)
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
# gh/glab stubs append to a sentinel file on invocation and exit 97; a 0-byte
# sentinel means the step made no live CLI calls (B5 incident guard). The
# `claude` stub exits 0 with a one-line marker, so no lint, unit test or
# workflow flow reaches the real CLI (which writes ~/.claude.json).
_stub_dir="$_run_tmp/stubs"
mkdir -p "$_stub_dir"
_sentinel="$_stub_dir/live-cli-sentinel"
touch "$_sentinel"
for _cli in gh glab; do
  cat > "$_stub_dir/$_cli" <<STUB
#!/usr/bin/env bash
echo "LIVE-CLI BLOCKED: $_cli \$*" >> "$_sentinel"
echo "tmb test-stub: $_cli blocked (exit 97)" >&2
exit 97
STUB
  chmod +x "$_stub_dir/$_cli"
done
cat > "$_stub_dir/claude" <<'STUB'
#!/usr/bin/env bash
echo "tmb test-stub: claude $*"
exit 0
STUB
chmod +x "$_stub_dir/claude"

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

# ----- L1 — Static / lint -----------------------------------------------
# Offline: lints that would query a forge (TMB_L1_OFFLINE=1) skip, and the
# stubs above shadow gh/glab/claude.

_l1_saved_path="$PATH"
export PATH="$_stub_dir:$PATH" TMB_L1_OFFLINE=1

run_step "L1 lint: agent template line budget"        bash "$HERE/l1-lint/agent-line-budget.sh"
run_step "L1 lint: agent template byte-identity (swe + pr-reviewer)"  bash "$HERE/l1-lint/agent-template-byte-identity.sh"
run_step "L1 lint: local agent overrides retain workflow primitives"   bash "$HERE/l1-lint/local-agent-primitives.sh"
run_step "L1 lint: shipped swe/pr-reviewer task_brief contract (#300)"  bash "$HERE/l1-lint/agent-task-brief-contract.sh"
run_step "L1 lint: skill frontmatter + name=dirname"  bash "$HERE/l1-lint/skill-frontmatter.sh"
run_step "L1 lint: command frontmatter (description + argument-hint)"  bash "$HERE/l1-lint/command-frontmatter.sh"
run_step "L1 lint: manifest shape (plugin/.mcp/hooks)" bash "$HERE/l1-lint/manifest-shape.sh"
run_step "L1 lint: Codex Scope-4 Agent contract"      bash "$HERE/l1-lint/codex-scope4-contract.sh"
run_step "L1 lint: version sync (4 manifests agree)"  bash "$HERE/l1-lint/version-sync.sh"
run_step "L1 lint: changelog top section current"     bash "$HERE/l1-lint/changelog-current.sh"
run_step "L1 lint: link-check (relative md links)"    bash "$HERE/l1-lint/link-check.sh"
run_step "L1 lint: shellcheck on shell scripts"       bash "$HERE/l1-lint/shellcheck-hooks.sh"
run_step "L1 lint: no destructive SQL in migrations"  bash "$HERE/l1-lint/no-destructive-sql.sh"
run_step "L1 lint: tsc --noEmit on MCP server"        bash "$HERE/l1-lint/tsc-noemit.sh"
run_step "L1 lint: release script safety guards"      bash "$HERE/l1-lint/release-script-safety.sh"
run_step "L1 lint: dist/ matches src/ (committed dist not stale)"  bash "$HERE/l1-lint/dist-fresh.sh"
run_step "L1 lint: bundle whitespace preserves string constants"  bash "$HERE/l1-lint/bundle-whitespace-safety.sh"
run_step "L1 lint: GH labels match LABELS.md"         bash "$HERE/l1-lint/labels-stable.sh"
run_step "L1 lint: shipped skills match builtin seed"  bash "$HERE/l1-lint/skill-catalog-sync.sh"
run_step "L1 lint: ENUMs.md vs code parity"           bash "$HERE/l1-lint/enums-stable.sh"
run_step "L1 lint: ENUMS.md event table + audit-events.txt generated fresh"  bash "$HERE/l1-lint/enums-doc-fresh.sh"
run_step "L1 lint: ERD.md generated from schema.sql"  bash "$HERE/l1-lint/erd-doc-fresh.sh"
run_step "L1 lint: CONFIG_KEYS.md generated from code" bash "$HERE/l1-lint/config-keys-doc-fresh.sh"
run_step "L1 lint: tool docs list every family + tool" bash "$HERE/l1-lint/tool-families-documented.sh"
run_step "L1 lint: REFERENCE.md hook rows are real, wired hooks" bash "$HERE/l1-lint/hooks-doc-fresh.sh"
run_step "L1 lint: no negative directives in prompts" bash "$HERE/l1-lint/no-negative-directives.sh"
run_step "L1 lint: issue_sync test must mock spawn"   bash "$HERE/l1-lint/issue-sync-test-isolation.sh"
run_step "L1 lint: no audit_append without from_node" bash "$HERE/l1-lint/no-audit-log-without-from-node.sh"
run_step "L1 lint: no citations in prompts"           bash "$HERE/l1-lint/no-citations-in-prompts.sh"
run_step "L1 lint: no file_registry refs (v7 retirement)"  bash "$HERE/l1-lint/no-file-registry-refs.sh"
run_step "L1 lint: kuzu trustedDependencies declared"  bash "$HERE/l1-lint/kuzu-trusted-dep.sh"
run_step "L1 lint: no audit_append kind= arg"         bash "$HERE/l1-lint/no-audit-log-kind.sh"
run_step "L1 lint: single audit write path (insertAudit)"  bash "$HERE/l1-lint/single-audit-write-path.sh"
run_step "L1 lint: no developer paths in artifacts"   bash "$HERE/l1-lint/no-developer-paths.sh"
run_step "L1 lint: no stale framing prose"            bash "$HERE/l1-lint/stale-framing-prose.sh"
run_step "L1 lint: no hardcoded plugin name"          bash "$HERE/l1-lint/no-hardcoded-plugin-name.sh"
run_step "L1 lint: CI workflow file refs exist"       bash "$HERE/l1-lint/ci-workflow-refs-exist.sh"
run_step "L1 lint: no bare role compare in hooks"     bash "$HERE/l1-lint/no-bare-role-compare.sh"
run_step "L1 lint: symlink targets all resolve"       bash "$HERE/l1-lint/symlink-targets.sh"
run_step "L1 lint: hooks.json commands executable"     bash "$HERE/l1-lint/hooks-executable.sh"
run_step "L1 lint: hooks.json routes through dispatch.sh" bash "$HERE/l1-lint/hooks-via-dispatcher.sh"
run_step "L1 lint: hook wrapper timeouts cover budgets" bash "$HERE/l1-lint/hook-timeout-budget.sh"
run_step "L1 lint: deny-capable hooks register onFailure: block" bash "$HERE/l1-lint/hook-onfailure.sh"
run_step "L1 lint: valid permissionDecision values"    bash "$HERE/l1-lint/valid-permission-decisions.sh"
run_step "L1 lint: no directories-table refs"         bash "$HERE/l1-lint/no-directories-table-refs.sh"
run_step "L1 lint: RAG schema invariants"             bash "$HERE/l1-lint/rag-schema-invariants.sh"
run_step "L1 lint: tool-description byte budget"      bash "$HERE/l1-lint/tool-description-budget.sh"
run_step "L1 lint: dir toolchain allowlist"           bash "$HERE/l1-lint/dir-toolchain.sh"
run_step "L1 lint: no raw SQL interpolation in hooks" bash "$HERE/l1-lint/no-raw-sql-interpolation.sh"
run_step "L1 lint: no direct sqlite3 writes in scripts" bash "$HERE/l1-lint/no-direct-sqlite-write.sh"
run_step "L1 lint: one trajectory-DB path rule (no private copies)" bash "$HERE/l1-lint/no-private-db-path.sh"
run_step "L1 lint: no writes under the home directory (self-test)" bash "$HERE/l1-lint/no-home-writes.sh" --self-test
run_step "L1 lint: no writes under the home directory" bash "$HERE/l1-lint/no-home-writes.sh"
run_step "L1 lint: no hard-coded /tmp writes (self-test)" bash "$HERE/l1-lint/no-tmp-writes.sh" --self-test
run_step "L1 lint: no hard-coded /tmp writes" bash "$HERE/l1-lint/no-tmp-writes.sh"
run_step "L1 lint: no datetime('now') in scripts"     bash "$HERE/l1-lint/no-datetime-now-in-hooks.sh"
run_step "L1 lint: no secrets in tracked source"    bash "$HERE/l1-lint/no-secrets-in-source.sh"
run_step "L1 lint: main-source-guard + CODEOWNERS present" bash "$HERE/l1-lint/main-guard-files-present.sh"
run_step "L1 lint: no filesystem writes at module load" bash "$HERE/l1-lint/no-module-load-writes.sh"
run_step "L1 lint: hook tests that source assert.sh call summarize" bash "$HERE/l1-lint/test-summarize-present.sh"

# Every tests/l1-lint/*.sh has a run_step line above.
l1_lints_all_wired() {
  local lint missing=0
  for lint in "$HERE"/l1-lint/*.sh; do
    if ! grep -qF "l1-lint/$(basename "$lint")\"" "$HERE/run-all.sh"; then
      echo "  ✗ tests/l1-lint/$(basename "$lint") has no run_step in tests/run-all.sh" >&2
      missing=1
    fi
  done
  return "$missing"
}
run_step "L1 self-check: every tests/l1-lint/*.sh runs here" l1_lints_all_wired

# ----- L1-adjacent: benchmark selftest (fast, deterministic) ------------

run_step "L1 bench: measurement harness selftest"     bash "$HERE/benchmarks/selftest.sh"

export PATH="$_l1_saved_path"
unset TMB_L1_OFFLINE
live_cli_check "L1" || FAIL=1

# ----- L2 — Unit (no live gh/glab/claude calls) -----------------------------
# Builds dist/ and runs the MCP unit suite once, behind the live-CLI stubs and
# with TMB_FORBID_LIVE_SYNC=1.

printf "\n=== L2 unit: MCP handlers (node --test on built dist/, live-CLI stubs) ===\n"
if (
  export PATH="$_stub_dir:$PATH"
  export TMB_FORBID_LIVE_SYNC=1
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

run_step "L3 integration: MCP server end-to-end (stdio JSON-RPC)"  bash "$HERE/l3-integration/mcp/run.sh"
run_step "L3 integration: hook script tests"                         bash "$HERE/l3-integration/hooks/run.sh"
run_step "L3 integration: deterministic health-check (scripts/health.sh)"  bash "$HERE/l3-integration/health.test.sh"
run_step "L3 integration: L5 scorer unit tests"                      bash "$HERE/l5-l6/lib/scorers-test.sh"

# ----- L4 — Workflow simulation (MCP server scripted flows) -----------------
# The spawned server inherits the stubs and TMB_FORBID_LIVE_SYNC=1, so its
# gh/glab auth probes and any claude call never reach a real CLI.

_l4_saved_path="$PATH"
export PATH="$_stub_dir:$PATH" TMB_FORBID_LIVE_SYNC=1
run_step "L4 workflow-sim: flow-02 simple-task"            bun test "$HERE/l4-workflow-sim/flow-02-simple-task.test.mjs"
run_step "L4 workflow-sim: flow-03 difficult-task"          bun test "$HERE/l4-workflow-sim/flow-03-difficult-task.test.mjs"
run_step "L4 workflow-sim: flow-06 push-gate"               bun test "$HERE/l4-workflow-sim/flow-06-push-gate.test.mjs"
run_step "L4 workflow-sim: flow-08 swe-retry"               bun test "$HERE/l4-workflow-sim/flow-08-swe-retry.test.mjs"
run_step "L4 workflow-sim: flow-09 anonymous-cold-restart"  bun test "$HERE/l4-workflow-sim/flow-09-anonymous-cold-restart.test.mjs"
run_step "L4 workflow-sim: flow-10 roundtable-composite"    bun test "$HERE/l4-workflow-sim/flow-10-roundtable-composite.test.mjs"

export PATH="$_l4_saved_path"
unset TMB_FORBID_LIVE_SYNC
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
  printf "L0 install-smoke runs separately in CI (docker required).\n"
  exit 0
else
  printf "One or more layers FAILED. See output above.\n"
  exit 1
fi
