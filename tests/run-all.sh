#!/usr/bin/env bash
# Full TMB plugin test suite. Exit 0 only if every layer passes.
#
# Layered model (see docs/architecture/FLOWS.md + CONTRIBUTING.md):
#   L0 — Distribution / install-smoke   → tests/docker/install-smoke.Dockerfile (CI-only)
#   L1 — Static / lint                  → tests/lint/*.sh (this file runs them)
#   L2 — Unit (per-component)           → mcp/trajectory-server/src/test/*.ts
#   L3 — Integration (cross-component)  → tests/mcp-integration/*.mjs + tests/hooks/*.sh
#   L4 — Workflow simulation            → tests/workflow-sim/*.mjs
#   L5 — Workflow-doctrine dogfood      → tests/dogfood/ (CI-only, .github/workflows/l5-dogfood.yml)
#   Release canary — final automated gate → tests/docker/release-canary.Dockerfile (RC-only)
#   Manual smoke (fallback)             → tests/manual/scenarios.md (human-walked, only when automated layers can't model the scenario)

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

run_step "L1 lint: agent template line budget"        bash "$HERE/lint/agent-line-budget.sh"
run_step "L1 lint: agent template byte-identity (swe + pr-reviewer)"  bash "$HERE/lint/agent-template-byte-identity.sh"
run_step "L1 lint: agent tmb_owner frontmatter"  bash "$HERE/lint/agent-tmb-owner-frontmatter.sh"
run_step "L1 lint: local agent overrides retain workflow primitives"   bash "$HERE/lint/local-agent-primitives.sh"
run_step "L1 lint: skill frontmatter + name=dirname"  bash "$HERE/lint/skill-frontmatter.sh"
run_step "L1 lint: command frontmatter (description + argument-hint)"  bash "$HERE/lint/command-frontmatter.sh"
run_step "L1 lint: manifest shape (plugin/.mcp/hooks)" bash "$HERE/lint/manifest-shape.sh"
run_step "L1 lint: version sync (3 manifests agree)"  bash "$HERE/lint/version-sync.sh"
run_step "L1 lint: changelog top section current"     bash "$HERE/lint/changelog-current.sh"
run_step "L1 lint: link-check (relative md links)"    bash "$HERE/lint/link-check.sh"
run_step "L1 lint: shellcheck on shell scripts"       bash "$HERE/lint/shellcheck-hooks.sh"
run_step "L1 lint: no destructive SQL in migrations"  bash "$HERE/lint/no-destructive-sql.sh"
run_step "L1 lint: tsc --noEmit on MCP server"        bash "$HERE/lint/tsc-noemit.sh"
run_step "L1 lint: release script safety guards"      bash "$HERE/lint/release-script-safety.sh"
run_step "L1 lint: dist/ matches src/ (committed dist not stale)"  bash "$HERE/lint/dist-fresh.sh"
run_step "L1 lint: GH labels match LABELS.md"         bash "$HERE/lint/labels-stable.sh"
run_step "L1 lint: ENUMs.md vs code parity"           bash "$HERE/lint/enums-stable.sh"
run_step "L1 lint: no negative directives in prompts" bash "$HERE/lint/no-negative-directives.sh"
run_step "L1 lint: issue_sync test must mock spawn"   bash "$HERE/lint/issue-sync-test-isolation.sh"
run_step "L1 lint: no ledger_log/ledger_list refs"    bash "$HERE/lint/no-ledger-references.sh"

# ----- L2 — Unit + L3 — Integration -------------------------------------

printf "\n=== L2 unit: MCP handlers (node --test on built dist/) ===\n"
if (cd "$PLUGIN_ROOT/mcp/trajectory-server" && bun run build && node --experimental-sqlite --test dist/test/*.test.js); then
  printf "→ PASS\n"
else
  printf "→ FAIL\n"
  FAIL=1
fi

run_step "L3 integration: MCP server end-to-end (stdio JSON-RPC)"  bash "$HERE/mcp-integration/run.sh"
run_step "L3 integration: hook script tests"                         bash "$HERE/hooks/run.sh"

# ----- L4 — Workflow simulation (MCP server scripted flows) -----------------

run_step "L4 workflow-sim: flow-02 simple-task"            bun test "$HERE/workflow-sim/flow-02-simple-task.test.mjs"
run_step "L4 workflow-sim: flow-03 difficult-task"          bun test "$HERE/workflow-sim/flow-03-difficult-task.test.mjs"
run_step "L4 workflow-sim: flow-06 push-gate"               bun test "$HERE/workflow-sim/flow-06-push-gate.test.mjs"
run_step "L4 workflow-sim: flow-07 architecture-regen"      bun test "$HERE/workflow-sim/flow-07-architecture-regen.test.mjs"
run_step "L4 workflow-sim: flow-08 swe-retry"               bun test "$HERE/workflow-sim/flow-08-swe-retry.test.mjs"
run_step "L4 workflow-sim: flow-09 anonymous-cold-restart"  bun test "$HERE/workflow-sim/flow-09-anonymous-cold-restart.test.mjs"

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
