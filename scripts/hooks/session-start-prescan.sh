#!/usr/bin/env bash
# SessionStart hook — emits the deterministic part of the project prescan
# as `additionalContext` so bro doesn't need to re-derive it on the first
# code-touching ask. The judgment-bound bits (cold-start deep-scan AUQ)
# stay in the tmb_project-prescan skill.
#
# Always silent on failure — a slow / broken prescan must never block
# session start.

set -uo pipefail

DB_PATH="${TRAJECTORY_DB_PATH:-}"
if [ -z "$DB_PATH" ]; then
  PLUGIN_NAME="tmb"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
    PLUGIN_NAME=$(jq -r '.name // "tmb"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "tmb")
  fi
  DB_PATH="$PWD/.claude/$PLUGIN_NAME/trajectory.db"
fi

[ -f "$DB_PATH" ] || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# Probe git state. Each query falls through to "(unknown)" on error so
# the hook stays silent rather than blowing up on an unusual repo state.
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
COMMIT_COUNT=$(git rev-list --count HEAD 2>/dev/null || echo 0)
DIRTY_COUNT=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
LAST_5_RAW=$(git log --oneline -5 2>/dev/null || true)

# Top-level layout (one line, names only).
TOPLEVEL=""
for entry in *; do
  [ -e "$entry" ] || continue
  TOPLEVEL="$TOPLEVEL $entry"
done
TOPLEVEL=$(printf '%s' "$TOPLEVEL" | awk '{ for (i=1;i<=NF && i<=10;i++) printf("%s%s", (i>1?" ":""), $i) }')

# Stack indicators.
STACKS=""
[ -f package.json ] && STACKS="$STACKS Node"
[ -f pyproject.toml ] || [ -f setup.py ] || [ -f requirements.txt ] && STACKS="$STACKS Python"
[ -f go.mod ] && STACKS="$STACKS Go"
[ -f Cargo.toml ] && STACKS="$STACKS Rust"
[ -f Gemfile ] && STACKS="$STACKS Ruby"
[ -f composer.json ] && STACKS="$STACKS PHP"
STACKS=$(echo "$STACKS" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
[ -z "$STACKS" ] && STACKS="(none detected)"

# Open issues + pending tasks from the trajectory DB.
OPEN_ISSUES=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM issues WHERE status='open';" 2>/dev/null || echo 0)
PENDING_TASKS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status IN ('pending','running');" 2>/dev/null || echo 0)

# Hand-curated arch docs detection (cheap; one find).
HAS_ARCH_DOCS="no"
if find docs/architecture -maxdepth 2 -type f -name '*.md' 2>/dev/null | head -1 | grep -q .; then
  HAS_ARCH_DOCS="yes"
elif find docs/trustmybot/architecture -maxdepth 2 -type f -name '*.md' 2>/dev/null | head -1 | grep -q .; then
  HAS_ARCH_DOCS="yes"
fi

# World model indexed status (cold vs warm). The world model is the
# directory-level memory bro reasons from (ADR 0001); cold = no
# directories row exists for the project, warm = at least one populated.
WORLD_MODEL_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM directories;" 2>/dev/null || echo 0)
SOURCE_FILE_COUNT=$(git ls-files 2>/dev/null | grep -cvE '^(\.claude/|node_modules/|dist/|build/|\.git/)' || echo 0)

WORLD_MODEL_STATE="warm"
if [ "$WORLD_MODEL_COUNT" = "0" ] && [ "$SOURCE_FILE_COUNT" != "0" ]; then
  WORLD_MODEL_STATE="cold"
fi

LAST_5=$(printf '%s' "$LAST_5_RAW" | head -5 | sed 's/^/  /')

# Assemble the inventory block. Keep it compact — it loads on every
# session start.
INVENTORY=$(cat <<EOF
=== Project Inventory (auto, deterministic) ===
Git branch:        ${BRANCH} (${COMMIT_COUNT} commits, ${DIRTY_COUNT} dirty paths)
Top-level dirs:    ${TOPLEVEL}
Stacks detected:   ${STACKS}
Architecture docs: ${HAS_ARCH_DOCS}
World model:       ${WORLD_MODEL_STATE} (${WORLD_MODEL_COUNT} dirs indexed / ${SOURCE_FILE_COUNT} source files)
Open issues:       ${OPEN_ISSUES}
Pending tasks:     ${PENDING_TASKS}
Last 5 commits:
${LAST_5}
================================================
If World model is cold on the first code-touching ask, tell the Human to run /scan
— world_model_get can't navigate an empty project map.
EOF
)

jq -nc --arg ctx "$INVENTORY" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'
exit 0
