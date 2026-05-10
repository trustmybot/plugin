#!/usr/bin/env bash
# Onboarded but no /scan has run — simulate the production state where
# bro tried to dispatch tasks against an empty file_registry.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"

# Drop the fixture-seeded deep_scan_completed audit row so the gate fires.
sqlite3 "$PROJECT/.claude/tmb/trajectory.db" \
  "DELETE FROM audit WHERE event_type='deep_scan_completed';" >/dev/null

# Seed source so /scan has something to discover. Without this, bro's
# /scan would correctly find nothing and the gate would still fire.
mkdir -p "$PROJECT/src"
cat > "$PROJECT/src/cli.py" <<'PY'
"""TODO CLI entry point."""
import sys

def main():
    if len(sys.argv) < 2:
        print("usage: cli.py <command>")
        return
    print(f"command: {sys.argv[1]}")

if __name__ == "__main__":
    main()
PY

(
  cd "$PROJECT" || exit 1
  git add src/cli.py
  git commit -qm 'feat: scaffold cli.py'
) >/dev/null
