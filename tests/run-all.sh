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

# ----- L1 — Static / lint -----------------------------------------------

run_step "L1 lint: agent template line budget"        bash "$HERE/l1-lint/agent-line-budget.sh"
run_step "L1 lint: agent template byte-identity (swe + pr-reviewer)"  bash "$HERE/l1-lint/agent-template-byte-identity.sh"
run_step "L1 lint: local agent overrides retain workflow primitives"   bash "$HERE/l1-lint/local-agent-primitives.sh"
run_step "L1 lint: shipped swe/pr-reviewer task_brief contract (#300)"  bash "$HERE/l1-lint/agent-task-brief-contract.sh"
run_step "L1 lint: skill frontmatter + name=dirname"  bash "$HERE/l1-lint/skill-frontmatter.sh"
run_step "L1 lint: command frontmatter (description + argument-hint)"  bash "$HERE/l1-lint/command-frontmatter.sh"
run_step "L1 lint: manifest shape (plugin/.mcp/hooks)" bash "$HERE/l1-lint/manifest-shape.sh"
run_step "L1 lint: version sync (3 manifests agree)"  bash "$HERE/l1-lint/version-sync.sh"
run_step "L1 lint: changelog top section current"     bash "$HERE/l1-lint/changelog-current.sh"
run_step "L1 lint: link-check (relative md links)"    bash "$HERE/l1-lint/link-check.sh"
run_step "L1 lint: shellcheck on shell scripts"       bash "$HERE/l1-lint/shellcheck-hooks.sh"
run_step "L1 lint: no destructive SQL in migrations"  bash "$HERE/l1-lint/no-destructive-sql.sh"
run_step "L1 lint: tsc --noEmit on MCP server"        bash "$HERE/l1-lint/tsc-noemit.sh"
run_step "L1 lint: release script safety guards"      bash "$HERE/l1-lint/release-script-safety.sh"
run_step "L1 lint: dist/ matches src/ (committed dist not stale)"  bash "$HERE/l1-lint/dist-fresh.sh"
run_step "L1 lint: GH labels match LABELS.md"         bash "$HERE/l1-lint/labels-stable.sh"
run_step "L1 lint: shipped skills match builtin seed"  bash "$HERE/l1-lint/skill-catalog-sync.sh"
run_step "L1 lint: ENUMs.md vs code parity"           bash "$HERE/l1-lint/enums-stable.sh"
run_step "L1 lint: no negative directives in prompts" bash "$HERE/l1-lint/no-negative-directives.sh"
run_step "L1 lint: issue_sync test must mock spawn"   bash "$HERE/l1-lint/issue-sync-test-isolation.sh"
run_step "L1 lint: no audit_log without from_node"    bash "$HERE/l1-lint/no-audit-log-without-from-node.sh"
run_step "L1 lint: no citations in prompts"           bash "$HERE/l1-lint/no-citations-in-prompts.sh"
run_step "L1 lint: no file_registry refs (v7 retirement)"  bash "$HERE/l1-lint/no-file-registry-refs.sh"
run_step "L1 lint: kuzu trustedDependencies declared"  bash "$HERE/l1-lint/kuzu-trusted-dep.sh"
run_step "L1 lint: no audit_log kind= arg"            bash "$HERE/l1-lint/no-audit-log-kind.sh"
run_step "L1 lint: no developer paths in artifacts"   bash "$HERE/l1-lint/no-developer-paths.sh"
run_step "L1 lint: no stale framing prose"            bash "$HERE/l1-lint/stale-framing-prose.sh"
run_step "L1 lint: no hardcoded plugin name"          bash "$HERE/l1-lint/no-hardcoded-plugin-name.sh"
run_step "L1 lint: CI workflow file refs exist"       bash "$HERE/l1-lint/ci-workflow-refs-exist.sh"
run_step "L1 lint: no bare role compare in hooks"     bash "$HERE/l1-lint/no-bare-role-compare.sh"
run_step "L1 lint: symlink targets all resolve"       bash "$HERE/l1-lint/symlink-targets.sh"
run_step "L1 lint: hooks.json commands executable"     bash "$HERE/l1-lint/hooks-executable.sh"
run_step "L1 lint: valid permissionDecision values"    bash "$HERE/l1-lint/valid-permission-decisions.sh"
run_step "L1 lint: no directories-table refs"         bash "$HERE/l1-lint/no-directories-table-refs.sh"
run_step "L1 lint: RAG schema invariants"             bash "$HERE/l1-lint/rag-schema-invariants.sh"
run_step "L1 lint: tool-description byte budget"      bash "$HERE/l1-lint/tool-description-budget.sh"
run_step "L1 lint: dir toolchain allowlist"           bash "$HERE/l1-lint/dir-toolchain.sh"
run_step "L1 lint: no raw SQL interpolation in hooks" bash "$HERE/l1-lint/no-raw-sql-interpolation.sh"
run_step "L1 lint: no secrets in tracked source"    bash "$HERE/l1-lint/no-secrets-in-source.sh"
run_step "L1 lint: main-source-guard + CODEOWNERS present" bash "$HERE/l1-lint/main-guard-files-present.sh"

# ----- L1-adjacent: benchmark selftest (fast, deterministic) ------------

run_step "L1 bench: measurement harness selftest"     bash "$HERE/benchmarks/selftest.sh"

# ----- L2 — Unit + L3 — Integration -------------------------------------

printf "\n=== L2 unit: MCP handlers (node --test on built dist/) ===\n"
if (cd "$PLUGIN_ROOT/mcp/trajectory-server" && bun run build && node --experimental-sqlite --test dist/test/*.test.js); then
  printf "→ PASS\n"
else
  printf "→ FAIL\n"
  FAIL=1
fi

# ----- L2 adjacent: stubbed-PATH suite (no live gh/glab calls) ---------------
# Runs the MCP unit suite with loud-fail gh/glab PATH stubs and
# TMB_FORBID_LIVE_SYNC=1. Reuses the already-built dist/ — no second build.
# Stubs append to a sentinel file on invocation; a 0-byte sentinel means the
# suite completed without making any live CLI calls (B5 incident guard).
printf "\n=== L2 stubbed-PATH: MCP unit suite with live-CLI stubs (reuses dist/) ===\n"
_stub_dir=$(mktemp -d)
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
_stub_pass=0
if (
  export PATH="$_stub_dir:$PATH"
  export TMB_FORBID_LIVE_SYNC=1
  cd "$PLUGIN_ROOT/mcp/trajectory-server"
  node --experimental-sqlite --test dist/test/*.test.js
); then
  printf "→ PASS\n"
else
  printf "→ FAIL\n"
  _stub_pass=1
fi
if [ -s "$_sentinel" ]; then
  printf "→ FAIL: live CLI calls detected during stubbed-PATH run:\n"
  cat "$_sentinel"
  FAIL=1
elif [ "$_stub_pass" -ne 0 ]; then
  FAIL=1
else
  printf "→ sentinel 0-byte: no live CLI calls. PASS\n"
fi
rm -rf "$_stub_dir"

run_step "L3 integration: MCP server end-to-end (stdio JSON-RPC)"  bash "$HERE/l3-integration/mcp/run.sh"
run_step "L3 integration: hook script tests"                         bash "$HERE/l3-integration/hooks/run.sh"
run_step "L3 integration: deterministic health-check (scripts/health.sh)"  bash "$HERE/l3-integration/health.test.sh"
run_step "L3 integration: L5 scorer unit tests"                      bash "$HERE/l5-l6/lib/scorers-test.sh"

# ----- L4 — Workflow simulation (MCP server scripted flows) -----------------

run_step "L4 workflow-sim: flow-02 simple-task"            bun test "$HERE/l4-workflow-sim/flow-02-simple-task.test.mjs"
run_step "L4 workflow-sim: flow-03 difficult-task"          bun test "$HERE/l4-workflow-sim/flow-03-difficult-task.test.mjs"
run_step "L4 workflow-sim: flow-06 push-gate"               bun test "$HERE/l4-workflow-sim/flow-06-push-gate.test.mjs"
run_step "L4 workflow-sim: flow-08 swe-retry"               bun test "$HERE/l4-workflow-sim/flow-08-swe-retry.test.mjs"
run_step "L4 workflow-sim: flow-09 anonymous-cold-restart"  bun test "$HERE/l4-workflow-sim/flow-09-anonymous-cold-restart.test.mjs"
run_step "L4 workflow-sim: flow-10 roundtable-composite"    bun test "$HERE/l4-workflow-sim/flow-10-roundtable-composite.test.mjs"

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
