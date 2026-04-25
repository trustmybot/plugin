#!/usr/bin/env bash
# Full TMB plugin test suite. Exit 0 only if every layer passes.
#
# Layered model (see docs/architecture/FLOWS.md + CONTRIBUTING.md):
#   L0 — Distribution / install-smoke   → tests/docker/install-smoke.Dockerfile (CI-only)
#   L1 — Static / lint                  → tests/lint/*.sh (this file runs them)
#   L2 — Unit (per-component)           → mcp/trajectory-server/src/test/*.ts
#   L3 — Integration (cross-component)  → tests/mcp-integration/*.mjs + tests/hooks/*.sh
#   L4 — Workflow simulation            → (planned for v0.2.0)
#   L5 — Manual dogfood                 → tests/manual/scenarios.md (human-walked)
#   L6 — Release canary                 → scripts/release.sh post-tag step

set -uo pipefail

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
run_step "L1 lint: onboarding skill contract"         bash "$HERE/lint/onboarding-skill-contract.sh"
run_step "L1 lint: skill frontmatter + name=dirname"  bash "$HERE/lint/skill-frontmatter.sh"
run_step "L1 lint: manifest shape (plugin/.mcp/hooks)" bash "$HERE/lint/manifest-shape.sh"
run_step "L1 lint: version sync (3 manifests agree)"  bash "$HERE/lint/version-sync.sh"
run_step "L1 lint: changelog top section current"     bash "$HERE/lint/changelog-current.sh"
run_step "L1 lint: link-check (relative md links)"    bash "$HERE/lint/link-check.sh"
run_step "L1 lint: shellcheck on shell scripts"       bash "$HERE/lint/shellcheck-hooks.sh"
run_step "L1 lint: tsc --noEmit on MCP server"        bash "$HERE/lint/tsc-noemit.sh"
run_step "L1 lint: release script safety guards"      bash "$HERE/lint/release-script-safety.sh"

# ----- L2 — Unit + L3 — Integration -------------------------------------

printf "\n=== L2 unit: MCP handlers (node --test on built dist/) ===\n"
if (cd "$PLUGIN_ROOT/mcp/trajectory-server" && bun run build && node --test dist/test/*.test.js); then
  printf "→ PASS\n"
else
  printf "→ FAIL\n"
  FAIL=1
fi

run_step "L3 integration: MCP server end-to-end (stdio JSON-RPC)"  bash "$HERE/mcp-integration/run.sh"
run_step "L3 integration: hook script tests"                         bash "$HERE/hooks/run.sh"

# ----- summary -----------------------------------------------------------

printf "\n========================================\n"
if [ "$FAIL" -eq 0 ]; then
  printf "All test layers passed (L1 + L2 + L3).\n"
  printf "L0 install-smoke runs separately in CI (docker required).\n"
  exit 0
else
  printf "One or more layers FAILED. See output above.\n"
  exit 1
fi
