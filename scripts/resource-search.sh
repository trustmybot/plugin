#!/usr/bin/env bash
# resource-search.sh — deterministic 3rd-party-resource discovery + ranking.
#
# Discovers candidate Claude Code resources (skills, MCP/toolkits, plugins) for
# a capability query from real, reputable registries, then ranks them by a
# deterministic score so the ordering is reproducible from (query, kind,
# candidate set) alone — no LLM, no randomness.
#
# Reputation is the REGISTRY TIER, not invented stars:
#   tier 1 = OFFICIAL  (MCP registry, Anthropic marketplace)
#   tier 2 = CURATED   (PulseMCP, Smithery — best-effort, skipped if unreachable)
#
# The candidate source is abstracted behind TMB_RESOURCE_SEARCH_FIXTURE: when
# that env var points at a JSON file, the candidate set is read from it (the
# test hook — no network). Otherwise the registry adapters below run. Either way
# the ranking is identical, so tests exercise the production ranking path on
# stubbed input.
#
# Each live adapter is best-effort: a short curl timeout, and on any failure
# (network denied, non-200, bad JSON) it contributes zero candidates and the
# script continues — it never crashes.
#
# Candidate shape (array, from fixture or merged adapters):
#   [ { "name", "description", "source_url", "kind": "skill|mcp|plugin",
#       "registry": "...", "tier": 1|2 }, ... ]
#
# Output shape on stdout:
#   {
#     "query": "<query>",
#     "kind":  "<kind>",
#     "candidates": [
#       { "name", "kind", "source_url",
#         "score", "signals": { "registry", "tier", "relevance" } }, ...
#     ]   # sorted by score desc, then name asc (stable, deterministic)
#   }
#
# Score (deterministic):
#   relevance  = count of unique query tokens appearing in name+description
#   score      = (tier == 1 ? 200 : 100) + relevance * 10
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

CURL_TIMEOUT=8

# urlencode a string via jq (no external deps beyond jq).
urlenc() { printf '%s' "$1" | jq -sRr @uri; }

# fetch URL → body on stdout, or empty string on any failure. Never errors.
fetch() {
  curl -fsSL --max-time "$CURL_TIMEOUT" "$1" 2>/dev/null || true
}

# Each adapter prints a JSON array of normalized candidates (or [] on failure).

adapter_mcp_official() {
  local q body
  q=$(urlenc "$QUERY")
  body=$(fetch "https://registry.modelcontextprotocol.io/v0.1/servers?search=${q}&limit=50")
  [ -n "$body" ] || { echo '[]'; return; }
  # Registry entries nest the server object under .server in the current schema;
  # tolerate both the wrapped and flat shapes.
  printf '%s' "$body" | jq -c '
    [ (.servers // [])[]
      | (.server // .)
      | {
          name: (.name // ""),
          description: (.description // ""),
          source_url: (
            (.repository.url // .websiteUrl // "")
            | if type == "string" then . else "" end
          ),
          kind: "mcp",
          registry: "mcp-official",
          tier: 1
        }
    ]
  ' 2>/dev/null || echo '[]'
}

adapter_anthropic_marketplace() {
  local body
  body=$(fetch "https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json")
  [ -n "$body" ] || { echo '[]'; return; }
  # A plugin's source may be a string or an object ({source,url,path,...});
  # prefer an explicit url, falling back to homepage. Guard with strings only so
  # source_url is always a scalar (it is used as a dedupe key downstream).
  printf '%s' "$body" | jq -c '
    [ (.plugins // [])[]
      | {
          name: (.name // ""),
          description: (.description // ""),
          source_url: (
            (.source_url // (.source | if type == "object" then .url else . end) // .homepage // "")
            | if type == "string" then . else "" end
          ),
          kind: "plugin",
          registry: "anthropic-official",
          tier: 1
        }
    ]
  ' 2>/dev/null || echo '[]'
}

adapter_pulsemcp() {
  local q body
  q=$(urlenc "$QUERY")
  body=$(fetch "https://api.pulsemcp.com/v0beta/servers?query=${q}&count_per_page=50")
  [ -n "$body" ] || { echo '[]'; return; }
  printf '%s' "$body" | jq -c '
    [ (.servers // .results // [])[]
      | {
          name: (.name // ""),
          description: (.description // ""),
          source_url: (
            (.source_code_url // .source_url // .external_url // .url // "")
            | if type == "string" then . else "" end
          ),
          kind: "mcp",
          registry: "pulsemcp",
          tier: 2
        }
    ]
  ' 2>/dev/null || echo '[]'
}

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
  # Merge best-effort registry adapters. Each yields [] on any failure, so an
  # offline/denied environment degrades gracefully to an empty candidate set.
  # arrayify normalizes any adapter output to a valid JSON array so the merge
  # below can never be poisoned by a stray non-array.
  arrayify() {
    if printf '%s' "$1" | jq -e 'type == "array"' >/dev/null 2>&1; then
      printf '%s' "$1"
    else
      printf '[]'
    fi
  }
  official_mcp=$(arrayify "$(adapter_mcp_official)")
  official_market=$(arrayify "$(adapter_anthropic_marketplace)")
  curated_pulse=$(arrayify "$(adapter_pulsemcp)")
  candidates_json=$(jq -c -n \
    --argjson a "$official_mcp" \
    --argjson b "$official_market" \
    --argjson c "$curated_pulse" \
    '$a + $b + $c')
fi

# Dedupe by source_url, keeping the lowest tier (most trusted), then rank in jq —
# pure, deterministic. Filter by kind (unless 'any'), score, sort by score desc
# then name asc for a stable order.
printf '%s' "$candidates_json" \
| jq -c \
    --arg query "$QUERY" \
    --arg kind "$KIND" \
'
  def tokens($s): ($s | ascii_downcase | gsub("[^a-z0-9]+"; " ") | split(" ") | map(select(length > 0)));
  ( tokens($query) | unique ) as $qtok
  | ( reduce .[] as $c ({};
        ($c.source_url // "") as $u
        | if $u == "" then .
          elif (.[$u] | not) or ($c.tier < .[$u].tier) then .[$u] = $c
          else . end)
      | [ .[] ] ) as $deduped
  | [ $deduped[]
      | select($kind == "any" or .kind == $kind)
      | . as $c
      | (($c.name // "") + " " + ($c.description // "")) as $hay
      | ( tokens($hay) | unique ) as $htok
      | ( [ $qtok[] | select(. as $t | $htok | index($t)) ] | length ) as $relevance
      | ( ($c.tier // 2) ) as $tier
      | {
          name: ($c.name // ""),
          kind: ($c.kind // "any"),
          source_url: ($c.source_url // ""),
          score: ( (if $tier == 1 then 200 else 100 end) + $relevance * 10 ),
          signals: {
            registry: ($c.registry // ""),
            tier: $tier,
            relevance: $relevance
          }
        }
    ]
  | sort_by([ (- .score), .name ])
  | { query: $query, kind: $kind, candidates: . }
'
