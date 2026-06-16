#!/usr/bin/env bash
# resource-search.sh — deterministic 3rd-party-resource discovery + ranking.
#
# Discovers candidate Claude Code resources (skills, MCP/toolkits, plugins) for
# a capability query, then ranks them by a deterministic score so the ordering
# is reproducible from (query, kind, candidate set) alone — no LLM, no randomness.
#
# The fetch step is abstracted behind TMB_RESOURCE_SEARCH_FIXTURE: when that env
# var points at a JSON file, the candidate set is read from it (the test hook —
# no network). Otherwise the real lookup runs. Either way the ranking below is
# identical, so tests exercise the production ranking path on stubbed input.
#
# Input candidate shape (array, from fixture or live fetch):
#   [ { "name": "...", "kind": "skill|mcp|plugin", "source_url": "...",
#       "description": "...", "stars": 0, "downloads": 0 }, ... ]
#
# Output shape on stdout:
#   {
#     "query": "<query>",
#     "kind":  "<kind>",
#     "candidates": [
#       { "name", "kind", "source_url", "score", "signals": { ... } }, ...
#     ]   # sorted by score desc, then name asc (stable, deterministic)
#   }
#
# Score (deterministic):
#   relevance = count of query tokens that appear in name+description (case-insensitive)
#   reputation = log-bucketed stars + downloads signal, capped
#   score = relevance * 10 + reputation
#
# Usage:
#   bash scripts/resource-search.sh --query <q> [--kind skill|mcp|plugin|any]

set -uo pipefail

QUERY=""
KIND="any"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --query) QUERY="${2:-}"; shift 2 ;;
    --kind)  KIND="${2:-any}"; shift 2 ;;
    *) echo "{\"error\":\"unknown arg: $1\"}" >&2; exit 1 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo '{"error":"jq missing"}' >&2; exit 1; }
[ -n "$QUERY" ] || { echo '{"error":"--query is required"}' >&2; exit 1; }

case "$KIND" in
  skill|mcp|plugin|any) : ;;
  *) echo "{\"error\":\"invalid kind: $KIND\"}" >&2; exit 1 ;;
esac

# Acquire the candidate set. Fixture path (test hook) takes precedence over any
# live lookup so CI never touches the network.
candidates_json=""
if [ -n "${TMB_RESOURCE_SEARCH_FIXTURE:-}" ]; then
  [ -f "$TMB_RESOURCE_SEARCH_FIXTURE" ] || {
    echo "{\"error\":\"fixture not found: $TMB_RESOURCE_SEARCH_FIXTURE\"}" >&2
    exit 1
  }
  candidates_json=$(cat "$TMB_RESOURCE_SEARCH_FIXTURE")
  if ! printf '%s' "$candidates_json" | jq -e 'type == "array"' >/dev/null 2>&1; then
    echo '{"error":"fixture is not a JSON array of candidates"}' >&2
    exit 1
  fi
else
  # Live discovery is not implemented for #657 beyond the deterministic ranking
  # contract; the network adapter lands with later pipeline stages. Until then
  # an empty candidate set is the honest, deterministic answer.
  candidates_json='[]'
fi

# Rank in jq — pure, deterministic. Filter by kind (unless 'any'), score each
# candidate, sort by score desc then name asc for a stable order.
printf '%s' "$candidates_json" \
| jq -c \
    --arg query "$QUERY" \
    --arg kind "$KIND" \
'
  def tokens($s): ($s | ascii_downcase | gsub("[^a-z0-9]+"; " ") | split(" ") | map(select(length > 0)));
  ( tokens($query) | unique ) as $qtok
  | [ .[]
      | select($kind == "any" or .kind == $kind)
      | . as $c
      | ( (($c.name // "") + " " + ($c.description // "")) ) as $hay
      | ( tokens($hay) | unique ) as $htok
      | ( [ $qtok[] | select(. as $t | $htok | index($t)) ] | length ) as $relevance
      | ( (($c.stars // 0) + ($c.downloads // 0)) ) as $rawrep
      | ( if $rawrep <= 0 then 0
          elif $rawrep < 10 then 1
          elif $rawrep < 100 then 2
          elif $rawrep < 1000 then 3
          elif $rawrep < 10000 then 4
          else 5 end ) as $reputation
      | {
          name: ($c.name // ""),
          kind: ($c.kind // "any"),
          source_url: ($c.source_url // ""),
          score: ($relevance * 10 + $reputation),
          signals: {
            relevance: $relevance,
            reputation: $reputation,
            stars: ($c.stars // 0),
            downloads: ($c.downloads // 0)
          }
        }
    ]
  | sort_by([ (- .score), .name ])
  | { query: $query, kind: $kind, candidates: . }
'
