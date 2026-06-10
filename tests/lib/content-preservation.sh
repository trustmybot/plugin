#!/usr/bin/env bash
# content-preservation.sh — token-multiset comparison helper.
#
# Extracts word tokens from two text inputs, sorts them, and diffs — only
# ordering may differ between the two inputs. Any insertion or deletion of
# a word token is a content-preservation failure.
#
# Usage:
#   . path/to/content-preservation.sh
#   assert_token_multiset_eq "$text_a" "$text_b" "label"
#
# The comparison is purely lexical (whitespace-split tokens); it does not
# parse HTML, JSON, or shell quoting.

_token_multiset() {
  printf '%s' "$1" | tr -s '[:space:]' '\n' | grep -v '^$' | sort
}

assert_token_multiset_eq() {
  local a="$1"
  local b="$2"
  local label="${3:-token multiset}"

  local sorted_a sorted_b diff_out
  sorted_a=$(_token_multiset "$a")
  sorted_b=$(_token_multiset "$b")
  diff_out=$(diff <(echo "$sorted_a") <(echo "$sorted_b") || true)

  if [ -z "$diff_out" ]; then
    _pass
  else
    _fail "$label: token multisets differ (added/removed tokens shown below):
$diff_out"
  fi
}
