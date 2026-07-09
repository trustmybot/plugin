#!/usr/bin/env bash
# L3: scripts/cheatcode-vet.sh classifies a candidate's trust tier deterministically.
# Network is stubbed via TMB_CHEATCODE_VET_FIXTURE — no live web.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
SCRIPT="$PLUGIN_ROOT/scripts/cheatcode-vet.sh"

command -v jq >/dev/null 2>&1 || { printf "FAIL jq not found — required dependency for this security-gate test\n"; exit 1; }

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

# ---------------------------------------------------------------------------
# Un-fixtured live path (#109): run WITHOUT TMB_CHEATCODE_VET_FIXTURE, but with
# the external signal source (curl → GitHub REST) stubbed by a fake `curl` on
# PATH that returns canned repo/contents JSON. This exercises the REAL adapter
# (owner_repo derivation + fetch + JSON parse) AND the real tier classification
# end-to-end — a regression in either fails here, not just behind the fixture.
# ---------------------------------------------------------------------------
STUBDIR="$WORKSPACE/stub-bin"
mkdir -p "$STUBDIR"

# Fake curl: the requested URL is always the last argument. The script asks for
#   .../repos/<owner>/<repo>            → a repo object
#   .../repos/<owner>/<repo>/contents   → an array of {name} entries
# Canned bodies live under $STUB_GH_DIR, keyed by owner/repo, so one fake curl
# serves multiple repos by reading per-repo files the test drops in.
cat > "$STUBDIR/curl" <<'STUB'
#!/usr/bin/env bash
url=""
for a in "$@"; do url="$a"; done
slug=$(printf '%s' "$url" | sed -nE 's#^https?://api\.github\.com/repos/([^/]+)/([^/]+)(/contents)?/?$#\1/\2#p')
suffix=$(printf '%s' "$url" | sed -nE 's#.*/repos/[^/]+/[^/]+(/contents)?/?$#\1#p')
base="${STUB_GH_DIR:?STUB_GH_DIR unset}/$(printf '%s' "$slug" | tr '/' '_')"
if [ "$suffix" = "/contents" ]; then
  [ -f "$base.contents.json" ] && cat "$base.contents.json" || exit 22
else
  [ -f "$base.repo.json" ] && cat "$base.repo.json" || exit 22
fi
STUB
chmod +x "$STUBDIR/curl"

STUB_GH_DIR="$WORKSPACE/gh"
mkdir -p "$STUB_GH_DIR"
export STUB_GH_DIR

# High-signal repo (popular, fresh, no exec surface) → trusted via the live path.
PUSHED_FRESH=$(date -u -v-30d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ)
cat > "$STUB_GH_DIR/anthropics_live-pdf.repo.json" <<JSON
{ "stargazers_count": 2500, "forks_count": 120, "pushed_at": "$PUSHED_FRESH",
  "archived": false, "license": { "spdx_id": "MIT" },
  "owner": { "login": "anthropics", "type": "Organization" } }
JSON
cat > "$STUB_GH_DIR/anthropics_live-pdf.contents.json" <<'JSON'
[ { "name": "README.md" }, { "name": "LICENSE" }, { "name": "src" } ]
JSON

# Thin repo (few stars, ships hooks → exec surface) → caution via the live path.
cat > "$STUB_GH_DIR/someorg_live-thin.repo.json" <<JSON
{ "stargazers_count": 3, "forks_count": 0, "pushed_at": "$PUSHED_FRESH",
  "archived": false, "license": null,
  "owner": { "login": "someorg", "type": "Organization" } }
JSON
cat > "$STUB_GH_DIR/someorg_live-thin.contents.json" <<'JSON'
[ { "name": "README.md" }, { "name": "hooks" } ]
JSON

run_vet_live() {
  # Explicitly UNSET the fixture so the live (stubbed-curl) path runs.
  PATH="$STUBDIR:$PATH" env -u TMB_CHEATCODE_VET_FIXTURE bash "$SCRIPT" "$@"
}

# No registry tier on the candidate: trusted MUST come from the live-fetched
# stars+freshness (>=500 stars, pushed within 365d, no exec surface), not a
# tier-1 short-circuit. This pins the real popularity-based classification path.
test_case "live path (stubbed curl): high-signal repo → trusted (stars-driven, no registry tier)"
OUT_LIVE_HI=$(run_vet_live --candidate '{"name":"live-pdf","kind":"skill","source_url":"https://github.com/anthropics/live-pdf"}')
assert_eq "trusted" "$(printf '%s' "$OUT_LIVE_HI" | jq -r '.trust_tier')" "live high-signal tier"

test_case "live path carries the real fetched reputation (stars from stubbed repo JSON)"
assert_eq "2500" "$(printf '%s' "$OUT_LIVE_HI" | jq -r '.signals.reputation.stars')" "live stars"

test_case "live path (stubbed curl): thin repo shipping hooks → caution (exec surface)"
OUT_LIVE_THIN=$(run_vet_live --candidate '{"name":"live-thin","kind":"skill","source_url":"https://github.com/someorg/live-thin"}')
assert_eq "caution" "$(printf '%s' "$OUT_LIVE_THIN" | jq -r '.trust_tier')" "live thin tier"
assert_eq "true" "$(printf '%s' "$OUT_LIVE_THIN" | jq -r '.signals.security_surface.code_execution')" "live exec surface"

test_case "live path: non-github source (no stub hit) → unknown (honesty, never crashes)"
OUT_LIVE_NONE=$(run_vet_live --candidate '{"name":"mystery","kind":"skill","source_url":"https://gitlab.com/x/y"}')
assert_eq "unknown" "$(printf '%s' "$OUT_LIVE_NONE" | jq -r '.trust_tier')" "live non-github tier"

summarize
printf "PASS cheatcode-vet\n"
