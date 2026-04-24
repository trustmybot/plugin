#!/usr/bin/env bash
# Layer 1 static contract lint on the onboarding skill's prompt content.
# Catches prompt-drift regressions WITHOUT running an LLM — these are the
# checks that would have caught "bro fell back to text" + "bro leaked Zax"
# in milliseconds instead of chewing through an interactive dogfood session.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

FAIL=0
pass() { printf "  ✓ %s\n" "$1"; }
fail() { printf "  ✗ %s\n" "$1"; FAIL=1; }

require_contains() {
  local file="$1" needle="$2" msg="$3"
  if grep -qF "$needle" "$file"; then
    pass "$msg"
  else
    fail "$msg — missing: \"$needle\""
  fi
}

require_not_contains() {
  local file="$1" needle="$2" msg="$3"
  if grep -qF "$needle" "$file"; then
    fail "$msg — unexpected literal: \"$needle\""
  else
    pass "$msg"
  fi
}

printf "=== first-run-onboarding/SKILL.md contract ===\n"
F="$PLUGIN_ROOT/skills/first-run-onboarding/SKILL.md"

require_contains "$F" "AskUserQuestion"             "references AskUserQuestion at least once"
require_contains "$F" "mandatory"                   "marks AskUserQuestion call as mandatory"
require_contains "$F" "text fallback"               "explicitly addresses the text-fallback pitfall"
require_contains "$F" "no text fallback"            "explicitly forbids text fallback in the mandatory-tool rule"
require_contains "$F" "userEmail"                   "addresses env-level userEmail leak"
require_contains "$F" "github-flow"                 "maps GitHub Flow to canonical 'github-flow'"
require_contains "$F" "gitflow"                     "maps Git Flow to canonical 'gitflow'"
require_contains "$F" "custom"                      "maps Custom workflow to canonical 'custom'"
require_contains "$F" "identity_set"                "names identity_set as a required MCP write"
require_contains "$F" "config_set"                  "names config_set as a required MCP write"
require_contains "$F" "config_list"                 "requires post-write verify via config_list"
require_contains "$F" "Never narrate"               "forbids hallucinated rejection narration"
require_contains "$F" "git config --get user.name"  "probes git config for local identity"
require_contains "$F" "Detected from git config"    "labels git-detected name appropriately"
require_not_contains "$F" "I'll enter it"           "no redundant I-ll-enter-it placeholder (Other is auto-added)"
require_not_contains "$F" "Type something else"     "no redundant Type-something-else placeholder"

# Identity leak gate: skill must NOT carry a literal `"Zax"` (or similar
# canonical-example user identity) in its examples. Earlier regressions saw
# bro's LLM copy-paste such examples into the live prompt.
require_not_contains "$F" '(e.g. "Zax"'             "no 'e.g. \"Zax\"' literal that would teach LLMs to echo inferred identity"
require_not_contains "$F" '(e.g. \"Zax\")'          "no escaped Zax example"

printf "\n=== tmb-reonboard/SKILL.md contract ===\n"
F="$PLUGIN_ROOT/skills/tmb-reonboard/SKILL.md"

require_contains "$F" "AskUserQuestion"             "references AskUserQuestion"
require_contains "$F" "Keep"                        "offers Keep-current-value as an option pattern"
require_contains "$F" "identity_reset"              "handles Anonymous → identity_reset path"

printf "\n=== architect-workflow/SKILL.md contract ===\n"
F="$PLUGIN_ROOT/skills/architect-workflow/SKILL.md"

require_contains "$F" "discussion_append"           "uses discussion_append for persistence"
require_contains "$F" "kind='question'"             "persists questions"
require_contains "$F" "kind='answer'"               "persists answers"
require_contains "$F" "Scope-ambiguity gate"        "enforces scope-ambiguity gate"
require_contains "$F" "HARD RULE"                   "scope-ambiguity gate is marked HARD RULE"
require_contains "$F" "Auto-mode does NOT waive"    "explicitly forbids auto-mode bypass of the gate"
require_contains "$F" "auto-mode defaults"          "calls out the exact phrase that signals gate violation"
require_contains "$F" "RED FLAG"                    "names violations as RED FLAG in the worked example"
require_contains "$F" "Environment Probe"           "includes Environment Probe step"
require_contains "$F" "uv"                          "probe mentions uv as a detectable tool"
require_contains "$F" "pyproject.toml"              "probe checks for existing pyproject.toml"
require_contains "$F" "Never offer an option that can't be executed" \
                                                    "probe discipline: no ghost options"
require_contains "$F" "text questions"              "uses text Q+A (AskUserQuestion not usable in subagents)"

# Architect must NOT claim AskUserQuestion works inside subagents — that
# belief is what led to the earlier regression where architect wrote
# decisions without asking.
require_not_contains "$F" "call \`AskUserQuestion\`" \
                                                    "no instruction telling architect to call AskUserQuestion (it's subagent-blocked)"

printf "\n"
if [ "$FAIL" -eq 0 ]; then
  printf "Onboarding contract lint: PASS\n"
  exit 0
else
  printf "Onboarding contract lint: FAIL (see above)\n"
  exit 1
fi
