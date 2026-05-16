#!/usr/bin/env bash
# Apply axis (SWE-bench standard): did the agent at least leave the project
# in a state where a diff would apply? Distinguishes "malformed patch /
# no edits attempted" from "wrong logic" — both fail resolved, but only
# apply=0 indicates the agent didn't engage with the task at all.
#
# For our setup: count file changes vs the initial setup commit (HEAD~N
# where N is the number of setup commits; for simplicity we diff against
# the FIRST commit on the branch). Apply=1 iff ≥1 tracked file changed.
#
# Usage:
#   bash apply.sh <project_dir>
#
# Writes JSON to stdout: { axis, applied, files_changed }

set -uo pipefail

PROJECT="${1:?project dir required}"

cd "$PROJECT" 2>/dev/null || {
  jq -nc '{axis: "apply", applied: 0, files_changed: 0, note: "project dir gone"}'
  exit 0
}

# Compare working tree (+ staged + committed since the initial commit)
# against the first commit on the branch. Counts any tracked file that
# differs from the starting state.
FIRST_COMMIT=$(git rev-list --max-parents=0 HEAD 2>/dev/null | head -1)
if [ -z "$FIRST_COMMIT" ]; then
  jq -nc '{axis: "apply", applied: 0, files_changed: 0, note: "no git history"}'
  exit 0
fi

# `git diff --name-only $FIRST_COMMIT` captures committed changes vs the
# initial state. We also include uncommitted (working tree + staged) edits
# so an agent that edits without committing still counts as "applied."
COMMITTED=$(git diff --name-only "$FIRST_COMMIT" HEAD 2>/dev/null | wc -l | tr -d ' ')
UNSTAGED=$(git diff --name-only HEAD 2>/dev/null | wc -l | tr -d ' ')
STAGED=$(git diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')
UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')

TOTAL=$((COMMITTED + UNSTAGED + STAGED + UNTRACKED))
APPLIED=0
[ "$TOTAL" -gt 0 ] && APPLIED=1

jq -nc --argjson applied "$APPLIED" --argjson files "$TOTAL" \
  '{axis: "apply", applied: $applied, files_changed: $files}'
