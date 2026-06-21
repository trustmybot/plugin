#!/usr/bin/env bash
# Seed an existing-repo state: identity exists (so onboarding doesn't fire),
# git ls-files non-empty (so cold-start trigger fires), world model cold
# (no `deep_scan_completed` audit row yet; kuzu graph DB empty).
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

# Drop the fixture-seeded deep_scan_completed audit row so the world-model-cold
# gate genuinely fires (the onboarding-named fixture seeds one; this row tests
# the cold path, so it must start cold).
sqlite3 "$PROJECT/.claude/tmb/trajectory.db" \
  "DELETE FROM audit WHERE event_type='deep_scan_completed';" >/dev/null

mkdir -p "$PROJECT/src"
echo "# placeholder" > "$PROJECT/src/existing.py"
(cd "$PROJECT" && git add . && git commit -qm "seed existing files")
