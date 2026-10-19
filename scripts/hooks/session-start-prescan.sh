#!/usr/bin/env bash
# SessionStart hook — emits the deterministic part of the project prescan
# as `additionalContext` so bro doesn't need to re-derive it on the first
# code-touching ask. The judgment-bound bits (cold-start deep-scan AUQ)
# stay in the tmb_project-prescan skill.
#
# Always silent on failure — a slow / broken prescan must never block
# session start. Without jq it prints only the Tooling line naming it.

set -uo pipefail

# Bypass for tests: TMB_SKIP_AUTO_PRESCAN=1 suppresses the auto-fire.
SKIP_AUTO_PRESCAN="${TMB_SKIP_AUTO_PRESCAN:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/resolve-install.sh
. "$SCRIPT_DIR/lib/resolve-install.sh"

# Without jq every fail-closed TMB gate denies; say so, without jq.
if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Tooling: jq not found — every TMB gate will deny until it is installed"}}'
  exit 0
fi

DB_PATH=$(tmb_db_path_advisory session-start-prescan) || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

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
{ [ -f pyproject.toml ] || [ -f setup.py ] || [ -f requirements.txt ]; } && STACKS="$STACKS Python"
[ -f go.mod ] && STACKS="$STACKS Go"
[ -f Cargo.toml ] && STACKS="$STACKS Rust"
[ -f Gemfile ] && STACKS="$STACKS Ruby"
[ -f composer.json ] && STACKS="$STACKS PHP"
STACKS=$(echo "$STACKS" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
[ -z "$STACKS" ] && STACKS="(none detected)"

# Open issues + pending tasks from the trajectory DB.
OPEN_ISSUES=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM issues WHERE status='open';" 2>/dev/null || echo 0)
PENDING_TASKS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status IN ('pending','running');" 2>/dev/null || echo 0)

# World model status. The world model lives in the kuzu graph (ADR 0002), not
# SQLite. cold = no deep_scan_completed row (the registry-cold gate's signal);
# otherwise the newest repos.last_scanned_at decides warm (< 7 days) vs stale.
WORLD_MODEL_SCANNED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM audit WHERE event_type='deep_scan_completed';" 2>/dev/null || echo 0)

tracked_source_count() {
  local dir="$1"
  git -C "$dir" ls-files 2>/dev/null | awk '!/^(\.claude\/|node_modules\/|dist\/|build\/|\.git\/)/ { n++ } END { print n + 0 }'
}

count_source_files() {
  local repo_paths path total=0 n
  repo_paths=$(tmb_sqlite_ro "$DB_PATH" "SELECT path FROM repos;" 2>/dev/null) || repo_paths=""
  if [ -z "$repo_paths" ]; then
    n=$(tracked_source_count .)
    [[ "$n" =~ ^[0-9]+$ ]] && total=$n
  else
    while IFS= read -r path; do
      [ -d "$path" ] || continue
      n=$(tracked_source_count "$path")
      [[ "$n" =~ ^[0-9]+$ ]] && total=$((total + n))
    done <<<"$repo_paths"
  fi
  printf '%s' "$total"
}

SOURCE_FILE_COUNT=$(count_source_files 2>/dev/null) || SOURCE_FILE_COUNT=0
[[ "$SOURCE_FILE_COUNT" =~ ^[0-9]+$ ]] || SOURCE_FILE_COUNT=0
WORLD_MODEL_STALE_SECS=$((7 * 24 * 3600))
SCAN_AGE_ROW=$(tmb_sqlite_ro "$DB_PATH" "SELECT CAST(strftime('%s','now') - strftime('%s', MAX(last_scanned_at)) AS INTEGER), COALESCE(SUM(file_count), 0) FROM repos;")
SCAN_AGE_SECS="${SCAN_AGE_ROW%%|*}"
SCANNED_FILE_COUNT="${SCAN_AGE_ROW##*|}"

relative_age() {
  local secs="$1"
  [ "$secs" -lt 0 ] && secs=0
  if [ "$secs" -lt 60 ]; then
    printf 'just now'
  elif [ "$secs" -lt 3600 ]; then
    printf '%dm ago' $((secs / 60))
  elif [ "$secs" -lt 86400 ]; then
    printf '%dh ago' $((secs / 3600))
  else
    printf '%dd ago' $((secs / 86400))
  fi
}

COLD_NOTE=""
if [ "$WORLD_MODEL_SCANNED" = "0" ] || [ -z "$WORLD_MODEL_SCANNED" ]; then
  WORLD_MODEL_LINE="cold (no scan yet; ${SOURCE_FILE_COUNT} source files)"
elif [[ "$SCAN_AGE_SECS" =~ ^-?[0-9]+$ ]] && [ "$SCAN_AGE_SECS" -lt "$WORLD_MODEL_STALE_SECS" ]; then
  WORLD_MODEL_LINE="warm (${SCANNED_FILE_COUNT} files, last scan $(relative_age "$SCAN_AGE_SECS"))"
elif [[ "$SCAN_AGE_SECS" =~ ^-?[0-9]+$ ]]; then
  WORLD_MODEL_LINE="stale (last scan $(relative_age "$SCAN_AGE_SECS")) — run /scan"
else
  WORLD_MODEL_LINE="stale (last scan unknown) — run /scan"
fi

if [ "$WORLD_MODEL_SCANNED" = "0" ] && [ "$SOURCE_FILE_COUNT" != "0" ]; then
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

# Trajectory DB data contracts (read-only). The contract list is generated
# from mcp/trajectory-server/src/data-contracts.ts into lib/data-contracts.json;
# every contract runs in one read-only pass (tmb_db_read_budget) under a hard budget
# (TMB_DOCTOR_BUDGET_MS, default 1500, capped at 3000 so the 6 s hook wrapper
# covers it). A timeout or read error never reports healthy; a DB whose
# plugin_meta.schema_version is below the contracts' schema_version says so
# and is never healthy, even when every column the contracts read exists.
CONTRACTS_JSON="$SCRIPT_DIR/lib/data-contracts.json"
DOCTOR_BUDGET_MS="${TMB_DOCTOR_BUDGET_MS:-1500}"
case "$DOCTOR_BUDGET_MS" in ''|*[!0-9]*) DOCTOR_BUDGET_MS=1500 ;; esac
[ "$DOCTOR_BUDGET_MS" -gt 3000 ] && DOCTOR_BUDGET_MS=3000
DOCTOR_STATE="unchecked (no contract list)"
CONTRACT_IDS=$(jq -r '.contracts[].id' "$CONTRACTS_JSON" 2>/dev/null || true)
# shellcheck disable=SC2016
CONTRACT_SCRIPT_JQ='
  def num: (. // "") | tostring | select(test("^[0-9]+([.][0-9]+)?$")) | tonumber | select(. > 0);
  "SELECT \u0027__schema|\u0027 || COALESCE((SELECT schema_version FROM plugin_meta LIMIT 1), \u0027\u0027);",
  ([.contracts[] | .params[]? | ".parameter set :\(.name) \(($ENV[.env] | num) // .default)"] | unique | .[]),
  (.contracts[] | "SELECT \u0027\(.id)|\u0027 || CASE WHEN (\(.sql)) \(.expect.op) \(.expect.value) THEN \u0027ok\u0027 ELSE \u0027fail\u0027 END;")
'
CONTRACT_SCRIPT=$(jq -r "$CONTRACT_SCRIPT_JQ" "$CONTRACTS_JSON" 2>/dev/null || true)
SCHEMA_REQUIRED=$(jq -r '.schema_version // 0' "$CONTRACTS_JSON" 2>/dev/null || echo 0)
case "$SCHEMA_REQUIRED" in ''|*[!0-9]*) SCHEMA_REQUIRED=0 ;; esac
if [ -n "$CONTRACT_IDS" ] && [ -n "$CONTRACT_SCRIPT" ]; then
  DOCTOR_RC=0
  DOCTOR_OUT=$(tmb_db_read_budget "$DB_PATH" "$DOCTOR_BUDGET_MS" <<<"$CONTRACT_SCRIPT") || DOCTOR_RC=$?
  if [ "$DOCTOR_RC" -eq 124 ]; then
    DOCTOR_STATE="unchecked (timeout)"
  else
    FAILED_IDS=""
    FAILED_N=0
    UNCHECKED_N=0
    SCHEMA_STORED=$(printf '%s\n' "$DOCTOR_OUT" | sed -n 's/^__schema|//p' | head -1)
    case "$SCHEMA_STORED" in ''|*[!0-9]*) SCHEMA_STORED="" ;; esac
    SCHEMA_NOTE=""
    [ -n "$SCHEMA_STORED" ] && [ "$SCHEMA_STORED" -lt "$SCHEMA_REQUIRED" ] && \
      SCHEMA_NOTE="schema v${SCHEMA_STORED} < v${SCHEMA_REQUIRED} — start the trajectory server to migrate"
    while IFS= read -r cid; do
      [ -n "$cid" ] || continue
      case "$(printf '%s\n' "$DOCTOR_OUT" | grep -Fx -e "${cid}|ok" -e "${cid}|fail" | head -1)" in
        "${cid}|ok") ;;
        "${cid}|fail") FAILED_N=$((FAILED_N + 1)); FAILED_IDS="${FAILED_IDS:+$FAILED_IDS, }$cid" ;;
        *) UNCHECKED_N=$((UNCHECKED_N + 1)) ;;
      esac
    done <<<"$CONTRACT_IDS"
    if [ "$FAILED_N" -gt 0 ]; then
      DOCTOR_STATE="${FAILED_N} contract violation(s) [${FAILED_IDS}] — run trajectory_doctor"
      if [ "$UNCHECKED_N" -gt 0 ]; then
        DOCTOR_STATE="${DOCTOR_STATE} (${UNCHECKED_N} unchecked${SCHEMA_NOTE:+: $SCHEMA_NOTE})"
      elif [ -n "$SCHEMA_NOTE" ]; then
        DOCTOR_STATE="${DOCTOR_STATE} (${SCHEMA_NOTE})"
      fi
    elif [ "$UNCHECKED_N" -gt 0 ] || [ -n "$SCHEMA_NOTE" ]; then
      DOCTOR_STATE="unchecked (${SCHEMA_NOTE:-read error})"
    else
      DOCTOR_STATE="healthy"
    fi
  fi
fi

LAST_5=$(printf '%s' "$LAST_5_RAW" | head -5 | sed 's/^/  /')

# Assemble the inventory block.
# STABLE fields first (same across sessions): dirs, stacks, world model state.
# VOLATILE fields last (change per session/turn): branch, counts, commits.
# This order maximises CC prompt-cache reuse — cache breaks at the first byte-difference.
COLD_SUFFIX=""
[ -n "$COLD_NOTE" ] && COLD_SUFFIX="
$COLD_NOTE"

# Version-skew note (#602) — only when a newer version sits in the cache but
# the older one is still running.
[ -n "$NEWER_CACHED_VERSION" ] && COLD_SUFFIX="${COLD_SUFFIX}
newer plugin version ${NEWER_CACHED_VERSION} is installed but ${PLUGIN_VERSION} is still running — restart Claude Code (or reconnect the trajectory-server via /mcp) to apply"

# Duplicate enabled copies of this plugin: Claude Code keeps one copy's hooks.
DUP_INSTALLS=$(tmb_duplicate_installs "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null || true)
[ -n "$DUP_INSTALLS" ] && COLD_SUFFIX="${COLD_SUFFIX}
Plugin: duplicate $(_tmb_install_plugin_name) copies enabled ($(printf '%s\n' "$DUP_INSTALLS" | cut -f1 | paste -sd, - | sed 's/,/, /g')) — hooks from one are dropped; run /plugin"

# Pre-1.1.0 TMB hooks in the user-scope settings.json run in every project;
# the Human removes them by hand.
LEGACY_HOOKS=$(tmb_legacy_user_hooks "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null || true)
if [ -n "$LEGACY_HOOKS" ]; then
  LEGACY_PROJECTS=$(tmb_legacy_user_hooks_projects "$LEGACY_HOOKS")
  COLD_SUFFIX="${COLD_SUFFIX}
Plugin: $(tmb_user_settings_json) holds $(printf '%s\n' "$LEGACY_HOOKS" | grep -c '^hook') pre-1.1.0 TMB hook(s) ($(tmb_legacy_user_hooks_entries "$LEGACY_HOOKS")) — they run in every project and can deny what this version allows; the Human removes them by hand, see $(tmb_legacy_user_hooks_doc)${LEGACY_PROJECTS:+; projects on TMB < 1.1.0 lose them too: ${LEGACY_PROJECTS}}"
fi

PLUGIN_VERSION_LINE="(unknown)"
[ -n "$PLUGIN_VERSION" ] && PLUGIN_VERSION_LINE="$PLUGIN_VERSION"

INVENTORY=$(cat <<EOF
=== Project Inventory (auto, deterministic) ===
Plugin version:    ${PLUGIN_VERSION_LINE}
Top-level dirs:    ${TOPLEVEL}
Stacks detected:   ${STACKS}
World model:       ${WORLD_MODEL_LINE}
Trajectory DB:     ${DOCTOR_STATE}
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
