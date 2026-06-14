#!/usr/bin/env bash
# SessionStart hook — emits the deterministic part of the project prescan
# as `additionalContext` so bro doesn't need to re-derive it on the first
# code-touching ask. The judgment-bound bits (cold-start deep-scan AUQ)
# stay in the tmb_project-prescan skill.
#
# Always silent on failure — a slow / broken prescan must never block
# session start.

set -uo pipefail

# Bypass for tests: TMB_SKIP_AUTO_PRESCAN=1 suppresses the auto-fire.
SKIP_AUTO_PRESCAN="${TMB_SKIP_AUTO_PRESCAN:-0}"

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

# Version-skew probe (#602). Surface the ACTIVE plugin version and, when the
# marketplace cache holds a NEWER version that isn't the running one, a
# 'restart to apply' line. Read-only and non-fatal — every step falls through
# silently so a missing manifest / non-cache install just omits the line.
#
# CLAUDE_PLUGIN_ROOT for a marketplace install is a versioned cache dir:
#   ~/.claude/plugins/cache/<owner>/<plugin>/<version>
# so the active version is that leaf and sibling versions live alongside it.
PLUGIN_VERSION=""
NEWER_CACHED_VERSION=""
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
  PLUGIN_VERSION=$(jq -r '.version // empty' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || true)
  VERSIONS_DIR=$(dirname "${CLAUDE_PLUGIN_ROOT}")
  if [ -n "$PLUGIN_VERSION" ] && [ -d "$VERSIONS_DIR" ]; then
    HIGHEST_CACHED=""
    while IFS= read -r vdir; do
      [ -d "$vdir" ] || continue
      vname=$(basename "$vdir")
      case "$vname" in
        [0-9]*) ;;
        *) continue ;;
      esac
      if [ -z "$HIGHEST_CACHED" ]; then
        HIGHEST_CACHED="$vname"
      else
        HIGHEST_CACHED=$(printf '%s\n%s\n' "$HIGHEST_CACHED" "$vname" | sort -V | tail -1)
      fi
    done < <(find "$VERSIONS_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)
    # A newer version is cached but not active when the highest cached dir
    # sorts strictly above the running version.
    if [ -n "$HIGHEST_CACHED" ] && [ "$HIGHEST_CACHED" != "$PLUGIN_VERSION" ]; then
      TOP=$(printf '%s\n%s\n' "$PLUGIN_VERSION" "$HIGHEST_CACHED" | sort -V | tail -1)
      [ "$TOP" = "$HIGHEST_CACHED" ] && NEWER_CACHED_VERSION="$HIGHEST_CACHED"
    fi
  fi
fi

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

# World model status (cold vs warm). The world model lives in the kuzu graph
# (ADR 0002), not SQLite — so the warm/cold proxy is the deep_scan_completed
# audit event (the same signal the registry-cold gate uses): present ⇒ a scan
# has populated the graph.
WORLD_MODEL_SCANNED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM audit WHERE event_type='deep_scan_completed';" 2>/dev/null || echo 0)
SOURCE_FILE_COUNT=$(git ls-files 2>/dev/null | grep -cvE '^(\.claude/|node_modules/|dist/|build/|\.git/)' || echo 0)

WORLD_MODEL_STATE="warm"
COLD_NOTE=""
if [ "$WORLD_MODEL_SCANNED" = "0" ] && [ "$SOURCE_FILE_COUNT" != "0" ]; then
  WORLD_MODEL_STATE="cold"

  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  SCAN_SH="$SCRIPT_DIR/../scan.sh"
  INVOKER="$SCRIPT_DIR/../maintenance/run-scan-initial.mjs"

  if [ "$SKIP_AUTO_PRESCAN" != "1" ] && [ -f "$SCAN_SH" ] && [ -f "$INVOKER" ] && command -v node >/dev/null 2>&1; then
    node --experimental-sqlite "$INVOKER" >/dev/null 2>&1 &
    disown
    COLD_NOTE="world model was cold — a deterministic scan is running in the background; re-read world_model_get before planning"
  else
    COLD_NOTE="world model is cold — run /scan before planning so world_model_get has a project map"
  fi
fi

LAST_5=$(printf '%s' "$LAST_5_RAW" | head -5 | sed 's/^/  /')

# Assemble the inventory block.
# STABLE fields first (same across sessions): dirs, stacks, arch docs, world model state.
# VOLATILE fields last (change per session/turn): branch, counts, commits.
# This order maximises CC prompt-cache reuse — cache breaks at the first byte-difference.
COLD_SUFFIX=""
[ -n "$COLD_NOTE" ] && COLD_SUFFIX="
$COLD_NOTE"

# Version-skew note (#602) — only when a newer version sits in the cache but
# the older one is still running.
[ -n "$NEWER_CACHED_VERSION" ] && COLD_SUFFIX="${COLD_SUFFIX}
newer plugin version ${NEWER_CACHED_VERSION} is installed but ${PLUGIN_VERSION} is still running — restart Claude Code (or /reload-plugins) to apply"

PLUGIN_VERSION_LINE="(unknown)"
[ -n "$PLUGIN_VERSION" ] && PLUGIN_VERSION_LINE="$PLUGIN_VERSION"

INVENTORY=$(cat <<EOF
=== Project Inventory (auto, deterministic) ===
Plugin version:    ${PLUGIN_VERSION_LINE}
Top-level dirs:    ${TOPLEVEL}
Stacks detected:   ${STACKS}
Architecture docs: ${HAS_ARCH_DOCS}
World model:       ${WORLD_MODEL_STATE} (kuzu graph; ${SOURCE_FILE_COUNT} source files)
Git branch:        ${BRANCH} (${COMMIT_COUNT} commits, ${DIRTY_COUNT} dirty paths)
Open issues:       ${OPEN_ISSUES}
Pending tasks:     ${PENDING_TASKS}
Last 5 commits:
${LAST_5}
================================================${COLD_SUFFIX}
EOF
)

jq -nc --arg ctx "$INVENTORY" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'
exit 0
