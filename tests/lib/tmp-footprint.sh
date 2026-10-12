#!/usr/bin/env bash
# tmp-footprint.sh — /tmp growth check for test runners that share /tmp with
# other sessions.
#
# A runner names everything it creates with its run id (TMB_TEST_RUN_ID,
# exported to the tests). After the suite, a new top-level /tmp entry whose name
# carries the run id is this run's leak and fails the check; any other new
# tmb*/claude* entry may belong to a concurrent session, so it is printed as a
# warning and never fails. Claude Code's own per-session entries
# (claude-*-cwd, claude-<uid>) are not counted at all.
#
# Usage:
#   . tests/lib/tmp-footprint.sh
#   tmp_footprint_start <label>          # sets + exports TMB_TEST_RUN_ID
#   dir=$(mktemp -d "$(tmp_footprint_parent)/$TMB_TEST_RUN_ID.XXXXXX")
#   ...run the suite...
#   tmp_footprint_check "<suite name>" [own dir ...] || fail=1

tmp_footprint_parent() { printf '%s' "${TMPDIR:-/tmp}" | sed 's|/*$||'; }

tmp_footprint_entries() {
  find /tmp/ -mindepth 1 -maxdepth 1 \( -name 'tmb*' -o -name 'claude*' \) \
    ! -name 'claude-*-cwd' ! -name "claude-$(id -u)" -print 2>/dev/null | sort || true
}

tmp_footprint_start() {
  TMB_TEST_RUN_ID="tmb-$1-$$-$(date +%s)"
  export TMB_TEST_RUN_ID
  _TMP_FOOTPRINT_BEFORE="$(tmp_footprint_entries)"
}

tmp_footprint_check() {
  local suite="$1"; shift
  local new own="" foreign="" entry real mine skip
  new="$(comm -13 <(printf '%s\n' "$_TMP_FOOTPRINT_BEFORE") <(tmp_footprint_entries) | sed '/^$/d')"
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    real="$(cd "$entry" 2>/dev/null && pwd -P || printf '%s' "$entry")"
    skip=0
    for mine in "$@"; do
      { [ "$entry" = "$mine" ] || [ "$real" = "$(cd "$mine" 2>/dev/null && pwd -P)" ]; } && skip=1
    done
    [ "$skip" -eq 1 ] && continue
    case "$(basename "$entry")" in
      *"$TMB_TEST_RUN_ID"*) own="$own$entry"$'\n' ;;
      *) foreign="$foreign$entry"$'\n' ;;
    esac
  done <<< "$new"
  if [ -n "$foreign" ]; then
    printf 'warning: /tmp gained entries not named for this run (another session?):\n%s' "$foreign"
  fi
  if [ -n "$own" ]; then
    printf '\nFAIL footprint: %s left entries in /tmp:\n%s' "$suite" "$own"
    return 1
  fi
  printf 'footprint: /tmp gained no entries from this run (%s)\n' "$TMB_TEST_RUN_ID"
}
