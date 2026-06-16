#!/usr/bin/env bash
# cheatcode-vet.sh — deterministic trust-signal gathering for ONE cheatcode.
#
# Gathers reputation + security-surface signals for a single candidate cheatcode
# (skill, MCP/toolkit, plugin) and emits a DETERMINISTIC trust tier classification
# from the signal set alone — reproducible from (candidate, signals) with no LLM,
# no randomness. The tier is a CLASSIFICATION, NOT an install verdict: the
# "trustworthy enough to install?" decision stays bro + Human (#659).
#
# Signals (all best-effort; any failure degrades that signal to empty/null):
#   reputation     — registry tier (from candidate) + GitHub stars/forks
#   maintenance    — pushed_at recency + archived flag
#   license        — SPDX id (or null)
#   maintainer     — repo owner login + type (User|Organization)
#   security_surface — capability flags derived from kind + repo inspection:
#                        code_execution (ships hooks / MCP servers / scripts),
#                        network, fs_writes
#
# The repo is identified from the candidate's source_url (a github.com URL).
# Signals come from the GitHub REST API, best-effort behind a short curl timeout.
# On any failure (network denied, non-200, bad JSON, non-github URL) the affected
# signal degrades to empty/null and never crashes the script.
#
# The candidate source + GitHub responses are abstracted behind
# TMB_CHEATCODE_VET_FIXTURE: when that env var points at a JSON file, the signal
# inputs are read from it (the test hook — no network). The classification path
# is identical to production, so tests exercise the real tier rules on stubbed
# input.
#
# Fixture shape (object; every field optional):
#   {
#     "repo":     { "stargazers_count", "forks_count", "pushed_at",
#                   "archived", "license": {"spdx_id"},
#                   "owner": {"login","type"} },
#     "contents": [ ".claude-plugin", "hooks", "scripts", ... ]  # top-level entry names
#   }
#
# Input (one candidate per call):
#   --candidate '<json>'   a candidate object {name,kind,source_url,tier?}
#   or the discrete flags:
#   --source-url <url>  --kind <skill|mcp|plugin>  [--tier <1|2>]  [--name <n>]
#
# Output shape on stdout:
#   {
#     "candidate":  { "name", "kind", "source_url", "tier" },
#     "signals": {
#       "reputation":  { "registry_tier", "stars", "forks" },
#       "maintenance": { "pushed_at", "archived", "active" },
#       "license":     "<spdx-id or null>",
#       "maintainer":  { "login", "type" },
#       "security_surface": { "code_execution", "network", "fs_writes" }
#     },
#     "trust_tier":   "trusted|caution|untrusted|unknown",
#     "rationale":    "<one line>",
#     "capabilities": [ "code_execution", "network", "fs_writes" ]
#   }
#
# Trust tier (DETERMINISTIC classification from the signal set):
#   unknown   — no reputation signal at all: no registry tier AND no GitHub repo
#               data (offline / web-denied / non-github url). Honesty over guess.
#   untrusted — archived repo, OR registry tier present but > 2 (unrecognized),
#               OR stale: not pushed in > 730 days.
#   caution   — DEFAULT once any signal exists. Also forced whenever the
#               security_surface flags code_execution (ships hooks/MCP/scripts):
#               a code-executing cheatcode is NEVER trusted on popularity alone.
#   trusted   — official registry (tier 1) OR a well-maintained popular repo
#               (>= 500 stars, pushed within 365 days, not archived), AND the
#               security_surface does NOT flag code_execution.
#
# capabilities[] lists every security_surface flag that is true.

set -uo pipefail

CANDIDATE_JSON=""
SOURCE_URL=""
KIND=""
TIER=""
NAME=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --candidate)  CANDIDATE_JSON="${2:-}"; shift 2 ;;
    --source-url) SOURCE_URL="${2:-}"; shift 2 ;;
    --kind)       KIND="${2:-}"; shift 2 ;;
    --tier)       TIER="${2:-}"; shift 2 ;;
    --name)       NAME="${2:-}"; shift 2 ;;
    *) echo "{\"error\":\"unknown arg: $1\"}" >&2; exit 1 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo '{"error":"jq missing"}' >&2; exit 1; }

# Normalize the candidate into a single JSON object regardless of which input
# form was used. --candidate wins; the discrete flags fill in otherwise.
if [ -n "$CANDIDATE_JSON" ]; then
  if ! printf '%s' "$CANDIDATE_JSON" | jq -e 'type == "object"' >/dev/null 2>&1; then
    echo '{"error":"--candidate is not a JSON object"}' >&2
    exit 1
  fi
  candidate=$(printf '%s' "$CANDIDATE_JSON" | jq -c '{
    name:       (.name // ""),
    kind:       (.kind // "any"),
    source_url: (.source_url // ""),
    tier:       (if (.tier | type) == "number" then .tier else null end)
  }')
else
  [ -n "$SOURCE_URL" ] || { echo '{"error":"--source-url or --candidate is required"}' >&2; exit 1; }
  candidate=$(jq -c -n \
    --arg name "$NAME" \
    --arg kind "${KIND:-any}" \
    --arg url "$SOURCE_URL" \
    --arg tier "$TIER" \
    '{
      name: $name,
      kind: $kind,
      source_url: $url,
      tier: (if ($tier | length) > 0 then ($tier | tonumber) else null end)
    }')
fi

src_url=$(printf '%s' "$candidate" | jq -r '.source_url')
cand_kind=$(printf '%s' "$candidate" | jq -r '.kind')

CURL_TIMEOUT=8

# fetch URL → body on stdout, or empty string on any failure. Never errors.
fetch() {
  curl -fsSL --max-time "$CURL_TIMEOUT" \
    -H "Accept: application/vnd.github+json" \
    "$1" 2>/dev/null || true
}

# Derive owner/repo from a github.com source_url (or empty on no match).
owner_repo() {
  printf '%s' "$1" \
    | sed -nE 's#^https?://github\.com/([^/]+)/([^/.]+)(\.git)?/?.*$#\1/\2#p'
}

# Acquire signal inputs. Fixture path (test hook) takes precedence over any live
# lookup so CI never touches the network.
repo_json='{}'
contents_json='[]'
if [ -n "${TMB_CHEATCODE_VET_FIXTURE:-}" ]; then
  [ -f "$TMB_CHEATCODE_VET_FIXTURE" ] || {
    echo "{\"error\":\"fixture not found: $TMB_CHEATCODE_VET_FIXTURE\"}" >&2
    exit 1
  }
  fixture=$(cat "$TMB_CHEATCODE_VET_FIXTURE")
  if ! printf '%s' "$fixture" | jq -e 'type == "object"' >/dev/null 2>&1; then
    echo '{"error":"fixture is not a JSON object"}' >&2
    exit 1
  fi
  repo_json=$(printf '%s' "$fixture" | jq -c '.repo // {}')
  contents_json=$(printf '%s' "$fixture" | jq -c '(.contents // []) | if type == "array" then . else [] end')
else
  slug=$(owner_repo "$src_url")
  if [ -n "$slug" ]; then
    body=$(fetch "https://api.github.com/repos/$slug")
    if printf '%s' "$body" | jq -e 'type == "object"' >/dev/null 2>&1; then
      repo_json="$body"
    fi
    cbody=$(fetch "https://api.github.com/repos/$slug/contents")
    if printf '%s' "$cbody" | jq -e 'type == "array"' >/dev/null 2>&1; then
      contents_json=$(printf '%s' "$cbody" | jq -c '[ .[].name ]')
    fi
  fi
fi

# Deterministic classification in jq — pure, reproducible from inputs alone.
jq -c -n \
  --argjson candidate "$candidate" \
  --argjson repo "$repo_json" \
  --argjson contents "$contents_json" \
  --arg kind "$cand_kind" \
'
  ($candidate.tier) as $rtier
  | (if ($repo | length) > 0 then true else false end) as $have_repo
  | ($repo.stargazers_count // null) as $stars
  | ($repo.forks_count // null) as $forks
  | ($repo.pushed_at // null) as $pushed
  | (($repo.archived // false) == true) as $archived
  | ($repo.license.spdx_id // null) as $license
  | ($repo.owner.login // null) as $owner_login
  | ($repo.owner.type // null) as $owner_type

  # Days since the last push (null if unknown).
  | (if $pushed == null then null
     else ((now - ($pushed | fromdateiso8601)) / 86400 | floor) end) as $age_days

  # active: pushed within the last 365 days, not archived.
  | (if $age_days == null then null
     elif ($archived) then false
     elif ($age_days <= 365) then true
     else false end) as $active

  # security surface — code execution if the candidate ships executable
  # surface (a plugin/MCP kind, or the repo ships hooks/MCP servers/scripts).
  | ([ "hooks", "scripts", ".claude-plugin", "mcp", "servers", ".mcp.json" ]
       as $exec_markers
     | any($contents[]?; (. // "" | ascii_downcase) as $e
         | any($exec_markers[]; . == $e))) as $repo_ships_exec
  | (($kind == "plugin") or ($kind == "mcp") or $repo_ships_exec) as $code_execution
  | (($kind == "mcp") or $repo_ships_exec) as $network
  | ($code_execution) as $fs_writes

  | {
      code_execution: $code_execution,
      network: $network,
      fs_writes: $fs_writes
    } as $surface
  | ( [ $surface | to_entries[] | select(.value) | .key ] ) as $capabilities

  # Trust tier — deterministic from the signal set.
  | (
      if ($rtier == null) and ($have_repo | not) then "unknown"
      elif $archived then "untrusted"
      elif ($rtier != null) and ($rtier > 2) then "untrusted"
      elif ($age_days != null) and ($age_days > 730) then "untrusted"
      elif $code_execution then "caution"
      elif ($rtier == 1) then "trusted"
      elif ($stars != null) and ($stars >= 500) and ($active == true) then "trusted"
      else "caution"
      end
    ) as $trust_tier

  | (
      if $trust_tier == "unknown" then "No reputation signal (offline, web-denied, or unrecognized source) — tier withheld."
      elif $trust_tier == "untrusted" then
        (if $archived then "Repository is archived."
         elif ($rtier != null) and ($rtier > 2) then "Unrecognized registry tier \($rtier)."
         else "Stale: no push in over 730 days." end)
      elif $trust_tier == "caution" then
        (if $code_execution then "Ships executable surface (\($capabilities | join(", "))) — not trusted on popularity alone."
         else "Signals present but below the trusted bar." end)
      else
        (if ($rtier == 1) then "Official registry (tier 1) with no code-execution surface."
         else "Popular (\($stars) stars), actively maintained, no code-execution surface." end)
      end
    ) as $rationale

  | {
      candidate: $candidate,
      signals: {
        reputation: { registry_tier: $rtier, stars: $stars, forks: $forks },
        maintenance: { pushed_at: $pushed, archived: $archived, active: $active },
        license: $license,
        maintainer: { login: $owner_login, type: $owner_type },
        security_surface: $surface
      },
      trust_tier: $trust_tier,
      rationale: $rationale,
      capabilities: $capabilities
    }
'
