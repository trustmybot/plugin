#!/usr/bin/env bash
# L3: scripts/cheatcode-vet.sh classifies a candidate's trust tier deterministically.
# Network is stubbed via TMB_CHEATCODE_VET_FIXTURE — no live web.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
SCRIPT="$PLUGIN_ROOT/scripts/cheatcode-vet.sh"

command -v jq >/dev/null 2>&1 || { printf "SKIP jq not found\n"; exit 0; }

WORKSPACE=$(mktemp -d)
trap 'rm -rf "$WORKSPACE"' EXIT

# An official, popular, well-maintained, no-exec-surface repo → trusted.
OFFICIAL="$WORKSPACE/official.json"
cat > "$OFFICIAL" <<'JSON'
{ "repo": { "stargazers_count": 1200, "forks_count": 80, "pushed_at": "2026-05-01T00:00:00Z",
            "archived": false, "license": { "spdx_id": "MIT" },
            "owner": { "login": "anthropics", "type": "Organization" } },
  "contents": ["README.md", "LICENSE"] }
JSON

# A popular repo that ships hooks + scripts → code_execution surface → caution.
EXEC="$WORKSPACE/exec.json"
cat > "$EXEC" <<'JSON'
{ "repo": { "stargazers_count": 9000, "forks_count": 800, "pushed_at": "2026-06-01T00:00:00Z",
            "archived": false, "license": { "spdx_id": "Apache-2.0" },
            "owner": { "login": "someorg", "type": "Organization" } },
  "contents": ["README.md", "hooks", "scripts"] }
JSON

# Archived repo → untrusted.
ARCHIVED="$WORKSPACE/archived.json"
cat > "$ARCHIVED" <<'JSON'
{ "repo": { "stargazers_count": 50, "forks_count": 2, "pushed_at": "2022-01-01T00:00:00Z",
            "archived": true, "license": { "spdx_id": "MIT" },
            "owner": { "login": "x", "type": "User" } } }
JSON

# Empty signal set + no registry tier → unknown (honesty).
EMPTY="$WORKSPACE/empty.json"
echo '{}' > "$EMPTY"

CAND_OFFICIAL='{"name":"official-pdf","kind":"skill","source_url":"https://github.com/anthropics/pdf","tier":1}'
CAND_EXEC='{"name":"hooky","kind":"skill","source_url":"https://github.com/someorg/hooky"}'
CAND_ARCHIVED='{"name":"old","kind":"skill","source_url":"https://github.com/x/old","tier":2}'
CAND_EMPTY='{"name":"mystery","kind":"skill","source_url":"https://gitlab.com/x/y"}'

OUT=$(TMB_CHEATCODE_VET_FIXTURE="$OFFICIAL" bash "$SCRIPT" --candidate "$CAND_OFFICIAL")

test_case "output is valid JSON"
if printf '%s' "$OUT" | jq -e . >/dev/null 2>&1; then _pass; else _fail "not JSON: $OUT"; fi

test_case "JSON shape: candidate + signals + trust_tier + rationale + capabilities"
shape=$(printf '%s' "$OUT" | jq -r 'has("candidate") and has("signals") and has("trust_tier") and has("rationale") and has("capabilities")')
assert_eq "true" "$shape" "top-level shape"

test_case "signals expose reputation/maintenance/license/maintainer/security_surface"
sig=$(printf '%s' "$OUT" | jq -r '.signals | has("reputation") and has("maintenance") and has("license") and has("maintainer") and has("security_surface")')
assert_eq "true" "$sig" "signals shape"

test_case "official tier-1, no exec surface → trusted"
tier=$(printf '%s' "$OUT" | jq -r '.trust_tier')
assert_eq "trusted" "$tier" "official tier"

test_case "reputation signals carried through (tier + stars)"
rep=$(printf '%s' "$OUT" | jq -r '(.signals.reputation.registry_tier | tostring) + "/" + (.signals.reputation.stars | tostring)')
assert_eq "1/1200" "$rep" "reputation"

test_case "ships hooks/scripts → code_execution capability"
OUT_EXEC=$(TMB_CHEATCODE_VET_FIXTURE="$EXEC" bash "$SCRIPT" --candidate "$CAND_EXEC")
ce=$(printf '%s' "$OUT_EXEC" | jq -r '.signals.security_surface.code_execution')
assert_eq "true" "$ce" "code_execution flag"

test_case "code-executing candidate is never trusted on popularity"
exec_tier=$(printf '%s' "$OUT_EXEC" | jq -r '.trust_tier')
if [ "$exec_tier" != "trusted" ]; then _pass; else _fail "code-executing candidate classified trusted"; fi

test_case "code_execution appears in capabilities[]"
cap=$(printf '%s' "$OUT_EXEC" | jq -r '.capabilities | index("code_execution") != null')
assert_eq "true" "$cap" "capabilities"

test_case "archived repo → untrusted"
OUT_ARCH=$(TMB_CHEATCODE_VET_FIXTURE="$ARCHIVED" bash "$SCRIPT" --candidate "$CAND_ARCHIVED")
arch_tier=$(printf '%s' "$OUT_ARCH" | jq -r '.trust_tier')
assert_eq "untrusted" "$arch_tier" "archived tier"

test_case "empty/failed signal set → unknown (never crashes)"
OUT_EMPTY=$(TMB_CHEATCODE_VET_FIXTURE="$EMPTY" bash "$SCRIPT" --candidate "$CAND_EMPTY")
empty_tier=$(printf '%s' "$OUT_EMPTY" | jq -r '.trust_tier')
assert_eq "unknown" "$empty_tier" "empty tier"

test_case "discrete flags input form works"
OUT_FLAGS=$(TMB_CHEATCODE_VET_FIXTURE="$OFFICIAL" bash "$SCRIPT" --source-url "https://github.com/anthropics/pdf" --kind skill --tier 1 --name flagform)
flag_tier=$(printf '%s' "$OUT_FLAGS" | jq -r '.trust_tier')
assert_eq "trusted" "$flag_tier" "flags-form tier"

test_case "deterministic across runs (identical output)"
OUT2=$(TMB_CHEATCODE_VET_FIXTURE="$OFFICIAL" bash "$SCRIPT" --candidate "$CAND_OFFICIAL")
assert_eq "$OUT" "$OUT2" "repeated run output"

test_case "missing --source-url and --candidate fails non-zero"
set +e
TMB_CHEATCODE_VET_FIXTURE="$OFFICIAL" bash "$SCRIPT" --kind skill >/dev/null 2>&1
rc=$?
set -e
if [ "$rc" -ne 0 ]; then _pass; else _fail "expected non-zero exit on missing candidate"; fi

summarize
printf "PASS cheatcode-vet\n"
