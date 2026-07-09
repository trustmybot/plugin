#!/usr/bin/env bash
# L3: scripts/cheatcode-search.sh ranks fixture candidates deterministically.
# Network is stubbed via TMB_CHEATCODE_SEARCH_FIXTURE — no live web.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
SCRIPT="$PLUGIN_ROOT/scripts/cheatcode-search.sh"

command -v jq >/dev/null 2>&1 || { printf "FAIL jq not found — required dependency for this security-gate test\n"; exit 1; }

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

OUT=$(TMB_CHEATCODE_SEARCH_FIXTURE="$FIXTURE" bash "$SCRIPT" --query "pdf table extraction" --kind any)

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
OUT_SKILL=$(TMB_CHEATCODE_SEARCH_FIXTURE="$FIXTURE" bash "$SCRIPT" --query "pdf" --kind skill)
nonskill=$(printf '%s' "$OUT_SKILL" | jq '[.candidates[] | select(.kind != "skill")] | length')
assert_eq "0" "$nonskill" "non-skill candidates filtered out"

test_case "deterministic across runs (identical output)"
OUT2=$(TMB_CHEATCODE_SEARCH_FIXTURE="$FIXTURE" bash "$SCRIPT" --query "pdf table extraction" --kind any)
assert_eq "$OUT" "$OUT2" "repeated run output"

test_case "missing --query fails non-zero"
set +e
TMB_CHEATCODE_SEARCH_FIXTURE="$FIXTURE" bash "$SCRIPT" --kind any >/dev/null 2>&1
rc=$?
set -e
if [ "$rc" -ne 0 ]; then _pass; else _fail "expected non-zero exit on missing --query"; fi

# ---------------------------------------------------------------------------
# Un-fixtured live path (#109): run WITHOUT TMB_CHEATCODE_SEARCH_FIXTURE, but
# with the registry fetch (curl) stubbed by a fake `curl` on PATH that returns
# canned per-registry JSON. This drives the REAL adapters (mcp-official tier 1,
# pulsemcp tier 2) AND the real dedupe + tier+relevance RANKING — a regression in
# either the adapter parse or the ranking fails here, not just behind a fixture.
# The canned pulsemcp (tier 2) candidate is strictly MORE relevant than the
# mcp-official (tier 1) one, so tier dominance is what keeps official on top.
# ---------------------------------------------------------------------------
STUBDIR="$WORKSPACE/stub-bin"
mkdir -p "$STUBDIR"

cat > "$STUBDIR/curl" <<'STUB'
#!/usr/bin/env bash
url=""
for a in "$@"; do url="$a"; done
case "$url" in
  *registry.modelcontextprotocol.io*)
    cat <<'JSON'
{ "servers": [
  { "server": { "name": "official-pdf",
                "description": "pdf tooling",
                "repository": { "url": "https://github.com/mcp/official-pdf" } } } ] }
JSON
    ;;
  *raw.githubusercontent.com*)
    printf '%s\n' '{ "plugins": [] }'
    ;;
  *api.pulsemcp.com*)
    cat <<'JSON'
{ "servers": [
  { "name": "curated-pdf",
    "description": "extract pdf table data from documents",
    "source_code_url": "https://github.com/curated/curated-pdf" } ] }
JSON
    ;;
  *)
    exit 22
    ;;
esac
STUB
chmod +x "$STUBDIR/curl"

run_search_live() {
  # Explicitly UNSET the fixture so the live (stubbed-curl) adapter path runs.
  PATH="$STUBDIR:$PATH" env -u TMB_CHEATCODE_SEARCH_FIXTURE bash "$SCRIPT" "$@"
}

OUT_LIVE=$(run_search_live --query "pdf table extraction" --kind any)

test_case "live path output is valid JSON"
if printf '%s' "$OUT_LIVE" | jq -e . >/dev/null 2>&1; then _pass; else _fail "not JSON: $OUT_LIVE"; fi

test_case "live path: real adapters yield both registries' candidates"
names=$(printf '%s' "$OUT_LIVE" | jq -r '[.candidates[].name] | sort | join(",")')
assert_eq "curated-pdf,official-pdf" "$names" "live candidate names"

test_case "live path: tier-1 official ranks first despite tier-2 curated being more relevant"
assert_eq "official-pdf" "$(printf '%s' "$OUT_LIVE" | jq -r '.candidates[0].name')" "live top candidate"

test_case "live path: ranked by score descending"
sorted=$(printf '%s' "$OUT_LIVE" | jq -r '[.candidates[].score] == ([.candidates[].score] | sort | reverse)')
assert_eq "true" "$sorted" "live score order"

test_case "live path: tiers come from the real adapters (official=1, curated=2)"
otier=$(printf '%s' "$OUT_LIVE" | jq -r '.candidates[] | select(.name=="official-pdf") | .signals.tier')
ctier=$(printf '%s' "$OUT_LIVE" | jq -r '.candidates[] | select(.name=="curated-pdf") | .signals.tier')
assert_eq "1" "$otier" "official tier"
assert_eq "2" "$ctier" "curated tier"

test_case "live path: curated (tier 2) has higher relevance than official (tier 1)"
orel=$(printf '%s' "$OUT_LIVE" | jq -r '.candidates[] | select(.name=="official-pdf") | .signals.relevance')
crel=$(printf '%s' "$OUT_LIVE" | jq -r '.candidates[] | select(.name=="curated-pdf") | .signals.relevance')
if [ "$crel" -gt "$orel" ]; then _pass; else _fail "expected curated relevance ($crel) > official ($orel)"; fi

test_case "live path: kind filter (mcp) keeps only mcp-kind candidates"
OUT_LIVE_MCP=$(run_search_live --query "pdf table extraction" --kind mcp)
nonmcp=$(printf '%s' "$OUT_LIVE_MCP" | jq '[.candidates[] | select(.kind != "mcp")] | length')
assert_eq "0" "$nonmcp" "live non-mcp filtered out"

summarize
printf "PASS cheatcode-search\n"
