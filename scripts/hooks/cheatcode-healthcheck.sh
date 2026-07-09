#!/usr/bin/env bash
# Cheatcode health-check (#113): SessionStart probe that reconciles each
# cheatcodes row's `status` against the real runtime.
#
# Per kind:
#   skill  — file_path exists on disk  → active, else broken.
#   mcp    — server present in `claude mcp list` (or ~/.claude.json
#            mcpServers)             → active, else broken.
#   plugin — present + enabled in `claude plugin list`
#                                    → active, else broken.
# For any row whose computed status differs from the stored one, UPDATE the
# row and emit a `cheatcode_healthcheck` audit row (old→new, name, kind).
#
# Constraints:
#   - Non-load-bearing: always exit 0; never block the session.
#   - Bounded: each external `claude` call is run under `timeout`, and the
#     mcp/plugin listings are fetched once and cached (not per-row).
#   - Graceful skip when sqlite3 / claude / the DB are absent.
#   - Honors TMB_DISABLE_CHEATCODE_HEALTHCHECK=1.
set -uo pipefail

[ "${TMB_DISABLE_CHEATCODE_HEALTHCHECK:-0}" = "1" ] && exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh" 2>/dev/null || exit 0

# Drain stdin (CC delivers a hook payload); we don't read it.
cat >/dev/null 2>&1 || true

tmb_have_sqlite || exit 0

DB=$(tmb_db_path) || exit 0
[ -n "$DB" ] || exit 0

# Cheatcodes table must exist.
have_table=$(tmb_sqlite_ro "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name='cheatcodes';")
[ -n "$have_table" ] || exit 0

# Per-call bound for the external claude listings.
CLAUDE_TIMEOUT="${TMB_CHEATCODE_HEALTHCHECK_TIMEOUT:-4}"

_run_bounded() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$CLAUDE_TIMEOUT" "$@" 2>/dev/null || true
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$CLAUDE_TIMEOUT" "$@" 2>/dev/null || true
  else
    "$@" 2>/dev/null || true
  fi
}

# --- Cache the runtime listings once (not per-row). ----------------------
HAVE_CLAUDE=0
command -v claude >/dev/null 2>&1 && HAVE_CLAUDE=1

MCP_LIST=""
PLUGIN_LIST=""
if [ "$HAVE_CLAUDE" = "1" ]; then
  MCP_LIST=$(_run_bounded claude mcp list)
  PLUGIN_LIST=$(_run_bounded claude plugin list)
fi

# Fallback MCP source: ~/.claude.json mcpServers keys.
CLAUDE_JSON_MCP=""
if command -v jq >/dev/null 2>&1 && [ -f "$HOME/.claude.json" ]; then
  CLAUDE_JSON_MCP=$(jq -r '.mcpServers // {} | keys[]' "$HOME/.claude.json" 2>/dev/null || true)
fi

# --- Probe one row's computed status. ------------------------------------
# Echoes the computed status, or nothing when this kind can't be probed
# (caller leaves the row untouched — never flip on absent evidence).
compute_status() {
  local kind="$1" file_path="$2" name="$3"
  case "$kind" in
    skill)
      [ -n "$file_path" ] || { echo "broken"; return 0; }
      local resolved="$file_path"
      case "$file_path" in
        /*) ;;
        *) [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && resolved="$CLAUDE_PLUGIN_ROOT/$file_path" ;;
      esac
      if [ -f "$resolved" ] || [ -f "$file_path" ]; then echo "active"; else echo "broken"; fi
      ;;
    mcp)
      # No runtime evidence available at all → don't flip.
      [ "$HAVE_CLAUDE" = "1" ] || [ -n "$CLAUDE_JSON_MCP" ] || return 0
      if printf '%s\n' "$MCP_LIST" | grep -qiF -- "$name" \
        || printf '%s\n' "$CLAUDE_JSON_MCP" | grep -qxF -- "$name"; then
        echo "active"
      else
        echo "broken"
      fi
      ;;
    plugin)
      [ "$HAVE_CLAUDE" = "1" ] || return 0
      if printf '%s\n' "$PLUGIN_LIST" | grep -qiF -- "$name"; then
        echo "active"
      else
        echo "broken"
      fi
      ;;
  esac
}

# --- Iterate rows + reconcile. -------------------------------------------
ROWS=$(tmb_sqlite_ro "$DB" "
  SELECT id || '|' || kind || '|' || status || '|' || COALESCE(file_path, '') || '|' || name
    FROM cheatcodes;
")
[ -n "$ROWS" ] || exit 0

NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

while IFS='|' read -r id kind old_status file_path name; do
  [ -n "$id" ] || continue
  new_status=$(compute_status "$kind" "$file_path" "$name")
  [ -n "$new_status" ] || continue
  [ "$new_status" = "$old_status" ] && continue

  SAFE_NAME=$(tmb_sql_quote "$name")
  SAFE_KIND=$(tmb_sql_quote "$kind")
  SAFE_OLD=$(tmb_sql_quote "$old_status")
  SAFE_STATUS=$(tmb_sql_quote "$new_status")
  SAFE_NOW=$(tmb_sql_quote "$NOW")
  SAFE_ID=$(tmb_sql_int "$id")
  [ -n "$SAFE_ID" ] || continue
  SAFE_JSON=$(tmb_sql_quote "$(printf '{"name":"%s","kind":"%s","from":"%s","to":"%s"}' \
    "$name" "$kind" "$old_status" "$new_status")")

  sqlite3 "$DB" <<SQL 2>/dev/null || true
UPDATE cheatcodes SET status = '$SAFE_STATUS', updated_at = '$SAFE_NOW' WHERE id = $SAFE_ID;
INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
VALUES (-1, '', 'cheatcode-healthcheck',
        'cheatcode_healthcheck',
        '$SAFE_NAME ($SAFE_KIND): $SAFE_OLD -> $SAFE_STATUS',
        '$SAFE_JSON', '$SAFE_NOW');
SQL
done <<< "$ROWS"

exit 0
