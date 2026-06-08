#!/usr/bin/env bash
# Library: role normalization helper for TMB hooks.
# Sourced (not exec'd) by hook scripts that compare agent/subagent type values.
#
# CC may deliver role values as bare names ("swe", "pr-reviewer") or with a
# plugin prefix ("tmb:swe", "tmb:pr-reviewer"). Hooks that compare against the
# bare form silently pass (exit 0) when they receive the prefixed form, turning
# safety gates into no-ops. Source this helper and normalize before comparing.

# tmb_normalize_role <value>
# Strips the prefix up to and including the first colon, if present.
# "tmb:swe" → "swe"
# "swe"     → "swe"
# Prints the normalized value to stdout.
tmb_normalize_role() {
  local raw="$1"
  printf '%s' "${raw#*:}"
}
