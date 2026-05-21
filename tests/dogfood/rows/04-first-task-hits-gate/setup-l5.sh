#!/usr/bin/env bash
# Onboarded but no /scan has run — simulate the production state where
# bro tried to dispatch tasks against an empty file_registry.
#
# Bro is asked to "make a todo CLI by Python in src/cli.py with tests in
# tests/test_cli.py" — a full feature ask. The gate response is the
# load-bearing check (deep_scan_completed audit + task created). Bro
# typically continues to dispatch SWE + atomic-close in the same turn;
# step 05 owns its own dispatch assertion.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"

# Drop the fixture-seeded deep_scan_completed audit row so the gate fires.
sqlite3 "$PROJECT/.claude/tmb/trajectory.db" \
  "DELETE FROM audit WHERE event_type='deep_scan_completed';" >/dev/null

# Scaffold src/ + tests/ so /scan has something to discover. Without this,
# bro's /scan would correctly find nothing and the gate would still fire.
mkdir -p "$PROJECT/src" "$PROJECT/tests"
cat > "$PROJECT/src/__init__.py" <<'PY'
"""src package — SWE lands cli.py here."""
PY
cat > "$PROJECT/tests/__init__.py" <<'PY'
"""tests package."""
PY

(
  cd "$PROJECT" || exit 1
  git add src/__init__.py tests/__init__.py
  git commit -qm 'feat: scaffold src/ + tests/'
) >/dev/null
