# shellcheck shell=bash
# Shared by session-start-persona.sh and user-prompt-persona.sh, which deliver
# bro's persona: Claude Code never loads a plugin's CLAUDE.md, so the hooks
# inject $CLAUDE_PLUGIN_ROOT/CLAUDE.md as context. Works without jq (raw text
# and a sed parse), writes only the per-session marker
#   <project>/.claude/<plugin>/sessions/<session_id>.persona
# and never touches the project's CLAUDE.md.

# shellcheck source=scripts/hooks/lib/query-task.sh
. "$(dirname "${BASH_SOURCE[0]}")/query-task.sh"

PERSONA_HAVE_JQ=0
command -v jq >/dev/null 2>&1 && PERSONA_HAVE_JQ=1

# persona_init — sets PERSONA_PLUGIN_ROOT, PERSONA_SOURCE, PERSONA_PROJECT,
# PERSONA_PLUGIN_NAME and PERSONA_PLUGIN_VERSION. Returns 1 when the project
# root is the plugin root (Claude Code loads that CLAUDE.md itself) or the
# plugin root cannot be resolved.
persona_init() {
  local hooks_dir project_real plugin_real
  hooks_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  PERSONA_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$hooks_dir/../.." 2>/dev/null && pwd)}"
  [ -n "$PERSONA_PLUGIN_ROOT" ] || return 1
  PERSONA_SOURCE="$PERSONA_PLUGIN_ROOT/CLAUDE.md"
  PERSONA_PROJECT="${CLAUDE_PROJECT_DIR:-$PWD}"
  project_real=$(cd "$PERSONA_PROJECT" 2>/dev/null && pwd -P) || project_real=""
  plugin_real=$(cd "$PERSONA_PLUGIN_ROOT" 2>/dev/null && pwd -P) || plugin_real=""
  [ -n "$plugin_real" ] && [ "$project_real" = "$plugin_real" ] && return 1
  [ -n "$project_real" ] && PERSONA_PROJECT="$project_real"
  PERSONA_PLUGIN_VERSION=$(persona_manifest_field version)
  PERSONA_PLUGIN_NAME=$(persona_manifest_field name)
  [ -n "$PERSONA_PLUGIN_NAME" ] || PERSONA_PLUGIN_NAME=$(tmb_plugin_name)
  return 0
}

# persona_manifest_field <key> — a top-level string from .claude-plugin/plugin.json.
persona_manifest_field() {
  local manifest="$PERSONA_PLUGIN_ROOT/.claude-plugin/plugin.json"
  [ -f "$manifest" ] || return 0
  if [ "$PERSONA_HAVE_JQ" = 1 ]; then
    jq -r --arg k "$1" '.[$k] // empty' "$manifest" 2>/dev/null || true
  else
    sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$manifest" 2>/dev/null | head -1
  fi
}

# persona_session_id <payload> — the payload's session_id, empty when missing
# or not a safe file name.
persona_session_id() {
  local sid
  if [ "$PERSONA_HAVE_JQ" = 1 ]; then
    sid=$(printf '%s' "$1" | jq -r '.session_id // empty' 2>/dev/null || true)
  else
    sid=$(printf '%s' "$1" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  fi
  case "$sid" in
    ''|*/*|.*) return 0 ;;
  esac
  printf '%s\n' "$sid"
}

# persona_marker <session_id> <suffix> — the marker path for this session.
persona_marker() {
  printf '%s/%s/%s/sessions/%s.%s\n' "$PERSONA_PROJECT" "$TMB_STATE_HOST_DIR" "$PERSONA_PLUGIN_NAME" "$1" "$2"
}

# persona_mark <session_id> <suffix> — writes the marker; prunes markers older
# than 24 h.
persona_mark() {
  local marker dir
  [ -n "$1" ] && [ -d "$PERSONA_PROJECT" ] || return 0
  marker=$(persona_marker "$1" "$2")
  dir=$(dirname "$marker")
  mkdir -p "$dir" 2>/dev/null || return 0
  find "$dir" -maxdepth 1 -type f -name '*.persona*' -mmin +1440 -delete 2>/dev/null || true
  : > "$marker" 2>/dev/null || true
}

# persona_context — prints the header line, the old-block note when the
# project's CLAUDE.md still holds a tmb:persona block, and the plugin's
# CLAUDE.md. Returns 1 when that file cannot be read or is empty.
persona_context() {
  local body header
  [ -r "$PERSONA_SOURCE" ] || return 1
  body=$(cat "$PERSONA_SOURCE" 2>/dev/null) || return 1
  [ -n "$body" ] || return 1
  header="[Persona loaded by the TMB persona hook from the ${PERSONA_PLUGIN_NAME} plugin's CLAUDE.md, v${PERSONA_PLUGIN_VERSION:-unknown}]"
  printf '%s\n' "$header"
  if [ -f "$PERSONA_PROJECT/CLAUDE.md" ] && grep -F '<!-- tmb:persona start' "$PERSONA_PROJECT/CLAUDE.md" >/dev/null 2>&1; then
    printf '%s\n' "[The project's CLAUDE.md still holds a <!-- tmb:persona --> block from an older /onboard. It is no longer needed, since this hook delivers the persona; tell the Human they may delete it.]"
  fi
  printf '\n%s\n' "$body"
}

# persona_emit <hook_event_name> <context> — hookSpecificOutput JSON, or the
# raw text when jq is missing.
persona_emit() {
  if [ "$PERSONA_HAVE_JQ" = 1 ]; then
    jq -nc --arg ev "$1" --arg ctx "$2" '{hookSpecificOutput: {hookEventName: $ev, additionalContext: $ctx}}' 2>/dev/null || true
  else
    printf '%s\n' "$2"
  fi
}
