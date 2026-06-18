#!/usr/bin/env bash
# Run-log usage detection for L5/L6 (issue #119).
#
# The L5/L6 runner invokes `claude -p --output-format stream-json --verbose`
# and persists the stream to a per-row run log ($project/trajectory.jsonl).
# This helper reads that log and answers "did bro invoke skill/plugin X?" —
# the signal that previously came from the skill_invocations table (#118,
# being retired). Moving it to the run log keeps the assertion alive once the
# table is gone.
#
# Detection signals, in priority order:
#   1. stream-json tool_use: {"type":"tool_use","name":"Skill",
#      "input":{"skill":"<plugin>:<name>"}} — the strongest signal. CC
#      delivers skill names plugin-prefixed (e.g. "tmb:tmb_planning"); a bare
#      "tmb_planning" also matches.
#   2. tool_result text "Launching skill: <plugin>:<name>".
#   3. system/init event plugins[] array — plugin presence (coarse; proves the
#      plugin loaded, not that a specific skill fired).
#   4. --debug line: Skill prompt: showing "<plugin>:<skill>".
#
# KNOWN LIMITATION — subagent (swe) attribution. When bro spawns swe via the
# Task tool, swe runs in its own CC session whose stream-json is NOT merged
# into bro's run log. A skill swe loads therefore leaves no tool_use in this
# log, so tmb_usage_in_log cannot attribute it. Row 05 (swe dispatch) depends
# on swe-side skill usage and is intentionally NOT re-pointed onto this helper.
# Do not attempt swe-via-Task attribution here.

set -uo pipefail

# tmb_usage_in_log <run_log> <name>
# Returns 0 iff <run_log> shows <name> was invoked as a skill, the plugin was
# loaded, or the debug line names it. <name> may be bare ("tmb_planning") or
# plugin-prefixed ("tmb:tmb_planning"); both forms are accepted and the bare
# form matches a prefixed log entry (and vice versa).
tmb_usage_in_log() {
  local run_log="$1" name="$2"
  [ -n "$run_log" ] || return 1
  [ -f "$run_log" ] || return 1
  [ -n "$name" ] || return 1

  # Bare name (strip any plugin prefix) for prefix-agnostic matching.
  local bare="${name#*:}"

  # ---- Signal 1: stream-json tool_use name=Skill, input.skill matches ----
  # Match when the recorded skill equals the bare or prefixed name, or ends
  # in ":<bare>" (log prefixed, query bare), or the query is prefixed and the
  # log is bare.
  if command -v jq >/dev/null 2>&1; then
    if jq -e --arg bare "$bare" '
          select(.type=="assistant")
          | .message.content[]?
          | select(.type=="tool_use" and .name=="Skill")
          | (.input.skill // "")
          | (. == $bare) or (sub("^[^:]*:";"") == $bare)
        ' "$run_log" >/dev/null 2>&1; then
      return 0
    fi
  fi

  # ---- Signal 2: "Launching skill: <plugin>:<name>" tool_result text ----
  if grep -Eq "Launching skill:[^\"]*(^|:|\b)${bare}\b" "$run_log" 2>/dev/null; then
    return 0
  fi

  # ---- Signal 4: --debug line: Skill prompt: showing "<plugin>:<skill>" ----
  if grep -Eq "Skill prompt: showing \"[^\"]*${bare}\"" "$run_log" 2>/dev/null; then
    return 0
  fi

  # ---- Signal 3: system/init event plugins[] (plugin presence, coarse) ----
  # Only consulted when <name> is plugin-prefixed (a plugin id, not a skill);
  # plugins[] lists plugin ids, not skills, so a bare skill name must not
  # match here.
  if [ "$name" != "$bare" ] && command -v jq >/dev/null 2>&1; then
    local plugin="${name%%:*}"
    if jq -e --arg plugin "$plugin" '
          select(.type=="system" and (.subtype=="init"))
          | (.plugins // [])
          | any(. == $plugin or (sub("@.*";"") == $plugin))
        ' "$run_log" >/dev/null 2>&1; then
      return 0
    fi
  fi

  return 1
}
