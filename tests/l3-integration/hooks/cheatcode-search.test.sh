#!/usr/bin/env bash
# L3: scripts/cheatcode-search.sh ranks fixture candidates deterministically.
# Network is stubbed via TMB_RESOURCE_SEARCH_FIXTURE — no live web.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
SCRIPT="$PLUGIN_ROOT/scripts/cheatcode-search.sh"

command -v jq >/dev/null 2>&1 || { printf "SKIP jq not found\n"; exit 0; }

WORKSPACE=$(mktemp -d)
trap 'rm -rf "$WORKSPACE"' EXIT

FIXTURE="$WORKSPACE/candidates.json"
# Mixed-tier fixture: the curated (tier 2) candidate is strictly MORE relevant
# than the official (tier 1) one, so a tier-blind ranker would float it first.
# Tier dominance must keep official on top.
cat > "$FIXTURE" <<'JSON'
[
  { "name": "curated-pdf", "kind": "skill", "source_url": "https://x.test/a",
    "description": "extract pdf table data from documents", "registry": "pulsemcp", "tier": 2 },
  { "name": "official-pdf", "kind": "skill", "source_url": "https://x.test/b",
    "description": "pdf tooling", "registry": "mcp-official", "tier": 1 },
  { "name": "kube-tool", "kind": "mcp", "source_url": "https://x.test/c",
    "description": "manages kubernetes clusters", "registry": "mcp-official", "tier": 1 }
]
JSON

OUT=$(TMB_RESOURCE_SEARCH_FIXTURE="$FIXTURE" bash "$SCRIPT" --query "pdf table extraction" --kind any)

test_case "output is valid JSON"
if printf '%s' "$OUT" | jq -e . >/dev/null 2>&1; then _pass; else _fail "not JSON: $OUT"; fi

test_case "query echoed back"
got=$(printf '%s' "$OUT" | jq -r '.query')
assert_eq "pdf table extraction" "$got" "query"

test_case "candidates are present"
n=$(printf '%s' "$OUT" | jq '.candidates | length')
if [ "$n" -ge 2 ]; then _pass; else _fail "expected >=2 candidates, got $n"; fi

test_case "ranked by score descending (stable)"
sorted=$(printf '%s' "$OUT" | jq -r '[.candidates[].score] == ([.candidates[].score] | sort | reverse)')
assert_eq "true" "$sorted" "score order"

test_case "official (tier 1) ranks first despite curated being more relevant"
first=$(printf '%s' "$OUT" | jq -r '.candidates[0].name')
assert_eq "official-pdf" "$first" "top candidate"

test_case "signals expose registry + tier (no stars/downloads)"
sig=$(printf '%s' "$OUT" | jq -r '.candidates[0].signals | has("registry") and has("tier") and has("relevance") and (has("stars") | not) and (has("downloads") | not)')
assert_eq "true" "$sig" "signals shape"

test_case "top candidate carries tier 1"
tier=$(printf '%s' "$OUT" | jq -r '.candidates[0].signals.tier')
assert_eq "1" "$tier" "top tier"

test_case "kind filter excludes other kinds"
OUT_SKILL=$(TMB_RESOURCE_SEARCH_FIXTURE="$FIXTURE" bash "$SCRIPT" --query "pdf" --kind skill)
nonskill=$(printf '%s' "$OUT_SKILL" | jq '[.candidates[] | select(.kind != "skill")] | length')
assert_eq "0" "$nonskill" "non-skill candidates filtered out"

test_case "deterministic across runs (identical output)"
OUT2=$(TMB_RESOURCE_SEARCH_FIXTURE="$FIXTURE" bash "$SCRIPT" --query "pdf table extraction" --kind any)
assert_eq "$OUT" "$OUT2" "repeated run output"

test_case "missing --query fails non-zero"
set +e
TMB_RESOURCE_SEARCH_FIXTURE="$FIXTURE" bash "$SCRIPT" --kind any >/dev/null 2>&1
rc=$?
set -e
if [ "$rc" -ne 0 ]; then _pass; else _fail "expected non-zero exit on missing --query"; fi

summarize
printf "PASS cheatcode-search\n"
