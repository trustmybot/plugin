#!/usr/bin/env bash
# SessionStart: MCP trajectory-server presence sample + legacy-shim detector.
#
# 1. Samples `pgrep` for this plugin's trajectory-server up to
#    TMB_MCP_HEALTH_SAMPLES times (default 3), TMB_MCP_HEALTH_INTERVAL_S apart
#    (default 1.2 s) — CC may not have spawned the server yet when SessionStart
#    fires. Still absent after the last sample → one soft additionalContext
#    note. A pgrep sample is not evidence the server failed, so this hook never
#    halts the session; the evidence-based HALT lives in activation-routine.sh.
# 2. Warns when ~/.claude/settings.json (read only) still holds `_tmb_managed`
#    hook groups — leftovers from older /onboard runs that wrote TMB gates
#    user-wide. They fire in every project, so they are always foreign.
# 3. Install-scope notice, once per session (marker
#    <project>/.claude/<plugin>/sessions/<session_id>.install-notice when the
#    project has a TMB state dir): a user-scope install beside this project's
#    install is ignored; a user-scope install alone gets a `--scope project`
#    recommendation. Read from installed_plugins.json via lib/resolve-install.sh.
# 4. Appends one forensic JSONL line to <project>/.claude/<plugin>/logs/
#    mcp-health.log when the project has a TMB state dir. Nothing is written
#    under $HOME.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/resolve-install.sh
. "$SCRIPT_DIR/lib/resolve-install.sh"

INPUT=$(cat)
command -v jq >/dev/null 2>&1 || exit 0

event=$(printf '%s' "$INPUT" | jq -r '.hook_event_name // .hookEventName // .event // "unknown"' 2>/dev/null || true)
[ -n "$event" ] || event="unknown"
session_id=$(printf '%s' "$INPUT" | jq -r '.session_id // .sessionId // empty' 2>/dev/null || true)

SAMPLES="${TMB_MCP_HEALTH_SAMPLES:-3}"
INTERVAL="${TMB_MCP_HEALTH_INTERVAL_S:-1.2}"
case "$SAMPLES" in ''|*[!0-9]*) SAMPLES=3 ;; esac

if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  pgrep_pattern="${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/index.js"
else
  pgrep_pattern="trajectory-server/dist/index.js"
fi

pgrep_count=-1
samples_taken=0
if command -v pgrep >/dev/null 2>&1; then
  pgrep_count=0
  while [ "$samples_taken" -lt "$SAMPLES" ]; do
    [ "$samples_taken" -gt 0 ] && sleep "$INTERVAL"
    samples_taken=$((samples_taken + 1))
    pgrep_count=$({ pgrep -f "$pgrep_pattern" 2>/dev/null || true; } | wc -l | tr -d ' ')
    [ -n "$pgrep_count" ] || pgrep_count=0
    [ "$pgrep_count" -gt 0 ] && break
  done
fi

CONTEXT=""
if [ "$pgrep_count" -eq 0 ]; then
  CONTEXT="trajectory-server not detected yet at SessionStart; if a trajectory tool returns is_error, load tmb_recovery §C"
fi

# --- Legacy user-wide shim detector (read only) -----------------------------
USER_SETTINGS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
if [ -f "$USER_SETTINGS" ]; then
  legacy=$(jq -r '
    [ (.hooks // {}) | to_entries[] | .key as $ev | .value[]?
      | select(any(.hooks[]?; ._tmb_managed == true))
      | "\($ev) \(.matcher // "*")" ]
    | join(", ")' "$USER_SETTINGS" 2>/dev/null || true)
  if [ -n "$legacy" ]; then
    LEGACY_TEXT="TMB: ${USER_SETTINGS} holds TMB-managed hook groups left by an older /onboard (${legacy}). They fire in every project and every session; TMB keeps its hooks inside the project now. To remove them, keep only the hook objects without \"_tmb_managed\": true, e.g. jq '.hooks |= with_entries(.value |= (map(.hooks |= map(select(._tmb_managed != true))) | map(select(.hooks | length > 0))))' on that file, then delete its tmb-hooks/ directory."
    CONTEXT="${CONTEXT:+$CONTEXT

}${LEGACY_TEXT}"
  fi
fi

# --- Install-scope notice, once per session ---------------------------------
install_version() {
  local line="$1" v
  v=$(printf '%s\n' "$line" | cut -f5)
  [ -n "$v" ] && [ "$v" != "-" ] || v=$(basename "$(printf '%s\n' "$line" | cut -f3)")
  printf '%s\n' "$v"
}
user_install=$(tmb_user_installs 2>/dev/null | sed -n 1p)
if [ -n "$user_install" ]; then
  project_install=$(tmb_project_installs 2>/dev/null | sed -n 1p)
  if [ -n "$project_install" ]; then
    NOTICE="TMB: user-scope TMB v$(install_version "$user_install") ignored — project install v$(install_version "$project_install") in use."
  else
    NOTICE="TMB installed at user scope; \`--scope project\` is recommended (see docs/reference/INSTALL.md)."
  fi
  case "$session_id" in
    ''|*/*|.*) NOTICE_MARKER="" ;;
    *)
      NOTICE_MARKER=""
      if STATE_DIR=$(tmb_state_dir 2>/dev/null); then
        NOTICE_MARKER="$STATE_DIR/sessions/$session_id.install-notice"
      fi
      ;;
  esac
  if [ -n "$NOTICE_MARKER" ] && [ -e "$NOTICE_MARKER" ]; then
    NOTICE=""
  elif [ -n "$NOTICE_MARKER" ] && [ "$event" = "SessionStart" ]; then
    if mkdir -p "$(dirname "$NOTICE_MARKER")" 2>/dev/null; then
      find "$(dirname "$NOTICE_MARKER")" -maxdepth 1 -type f -name '*.install-notice' -mmin +1440 -delete 2>/dev/null || true
      : > "$NOTICE_MARKER" 2>/dev/null
    fi
  fi
  if [ -n "$NOTICE" ]; then
    CONTEXT="${CONTEXT:+$CONTEXT

}${NOTICE}"
  fi
fi

# --- Forensic log, project-local ---------------------------------------------
if STATE_DIR=$(tmb_state_dir 2>/dev/null) && mkdir -p "$STATE_DIR/logs" 2>/dev/null; then
  LOG_FILE="$STATE_DIR/logs/mcp-health.log"
  if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)" -gt 1048576 ]; then
    mv -f "$LOG_FILE" "${LOG_FILE}.1" 2>/dev/null || true
  fi
  alive=null
  [ "$pgrep_count" -gt 0 ] && alive=true
  [ "$pgrep_count" -eq 0 ] && alive=false
  jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg ev "$event" --argjson alive "$alive" \
    --argjson count "$pgrep_count" --argjson samples "$samples_taken" --arg sid "$session_id" \
    --arg db "$(tmb_db_path 2>/dev/null)" \
    '{ts:$ts,event:$ev,mcp_alive:$alive,pgrep_count:$count,samples:$samples,session_id:$sid,db_path:$db}' \
    >> "$LOG_FILE" 2>/dev/null || true
fi

if [ -n "$CONTEXT" ] && [ "$event" = "SessionStart" ]; then
  jq -nc --arg ctx "$CONTEXT" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'
fi
exit 0
