#!/usr/bin/env bash
# L5 isolation setup for 05-swe-atomic-close.
# Scaffold src/ so SWE has a clear directory to land src/auth.py in.
# (In L6 chain, this same scaffold gives step 06 its substrate organically:
# SWE commits src/auth.py here, post-task-close-rescan populates the
# file_registry row with summary=NULL, and step 06 tests bro's read+update.)
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"

mkdir -p "$PROJECT/src"
cat > "$PROJECT/src/__init__.py" <<'PY'
"""src package — SWE lands modules here."""
PY
(
  cd "$PROJECT" || exit 1
  git add src/__init__.py
  git commit -qm 'feat: scaffold src/ package'
) >/dev/null
