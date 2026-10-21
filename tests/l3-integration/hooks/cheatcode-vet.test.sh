#!/usr/bin/env bash
# L3: scripts/cheatcode-vet.sh classifies a candidate's trust tier deterministically.
# Network is stubbed via TMB_CHEATCODE_VET_FIXTURE — no live web.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
SCRIPT="$PLUGIN_ROOT/scripts/cheatcode-vet.sh"

command -v jq >/dev/null 2>&1 || { printf "FAIL jq not found — required dependency for this security-gate test\n"; exit 1; }

WORKSPACE=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-cheatcode-vet.XXXXXX")
trap 'rm -rf "$WORKSPACE"' EXIT
export TMB_PROJECT_ROOT="$WORKSPACE"

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

# Fake curl: the requested URL is always the last argument, appended to
# $STUB_GH_DIR/requests.log. The script asks for
#   .../repos/<owner>/<repo>                            → <o>_<r>.repo.json
#   .../repos/<owner>/<repo>/contents                   → <o>_<r>.contents.json
#   .../repos/<owner>/<repo>/git/trees/<ref>?recursive=1 → <o>_<r>.trees.json
#   .../repos/<owner>/<repo>/contents/<path>?ref=<ref>  → <o>_<r>.contents.<path, / as _>.json
#     (also a plugin manifest: <path>/.claude-plugin/plugin.json)
# Canned bodies live under $STUB_GH_DIR, keyed by owner/repo, so one fake curl
# serves multiple repos by reading per-repo files the test drops in.
cat > "$STUBDIR/curl" <<'STUB'
#!/usr/bin/env bash
url=""
for a in "$@"; do url="$a"; done
printf '%s\n' "$url" >> "${STUB_GH_DIR:?STUB_GH_DIR unset}/requests.log"
rest=$(printf '%s' "$url" | sed -nE 's#^https?://api\.github\.com/repos/##p' | sed -E 's/\?.*$//; s#/+$##')
owner=${rest%%/*}; rest=${rest#*/}
repo=${rest%%/*}
case "$rest" in */*) tail=${rest#*/} ;; *) tail="" ;; esac
base="$STUB_GH_DIR/${owner}_${repo}"
case "$tail" in
  "")          f="$base.repo.json" ;;
  contents)    f="$base.contents.json" ;;
  contents/*)  f="$base.contents.$(printf '%s' "${tail#contents/}" | tr '/' '_').json" ;;
  git/trees/*) f="$base.trees.json" ;;
  *)           exit 22 ;;
esac
[ -f "$f" ] && cat "$f" || exit 22
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
[ { "name": "README.md", "type": "file", "download_url": "https://raw.example/README.md" },
  { "name": "LICENSE", "type": "file", "download_url": "https://raw.example/LICENSE" } ]
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

test_case "live path: a bare repo URL lists the repo root via contents, never git/trees (GH 1617)"
grep -qx 'https://api.github.com/repos/anthropics/live-pdf/contents' "$STUB_GH_DIR/requests.log" \
  && ! grep -q 'repos/anthropics/live-pdf/git/trees' "$STUB_GH_DIR/requests.log" \
  && _pass || _fail "bare URL requests: $(grep live-pdf "$STUB_GH_DIR/requests.log" | tr '\n' ' ')"

# One popular repo holding several skill folders (GH 1617). The repo root ships
# .claude-plugin + hooks; only skills/tooly ships its own executable script, and
# skills/plain-extra (a sibling sharing the "plain" prefix) ships hooks.
cat > "$STUB_GH_DIR/someorg_mono.repo.json" <<JSON
{ "stargazers_count": 4000, "forks_count": 300, "pushed_at": "$PUSHED_FRESH",
  "archived": false, "license": { "spdx_id": "MIT" },
  "owner": { "login": "someorg", "type": "Organization" } }
JSON
cat > "$STUB_GH_DIR/someorg_mono.contents.json" <<'JSON'
[ { "name": ".claude-plugin", "type": "dir" }, { "name": "hooks", "type": "dir" },
  { "name": "skills", "type": "dir" }, { "name": "README.md", "type": "file", "download_url": "https://raw.example/README.md" } ]
JSON
cat > "$STUB_GH_DIR/someorg_mono.trees.json" <<'JSON'
{ "sha": "abc", "truncated": false, "tree": [
  { "path": ".claude-plugin", "mode": "040000", "type": "tree" },
  { "path": ".claude-plugin/plugin.json", "mode": "100644", "type": "blob" },
  { "path": "hooks", "mode": "040000", "type": "tree" },
  { "path": "hooks/hooks.json", "mode": "100644", "type": "blob" },
  { "path": "skills", "mode": "040000", "type": "tree" },
  { "path": "skills/plain", "mode": "040000", "type": "tree" },
  { "path": "skills/plain/SKILL.md", "mode": "100644", "type": "blob" },
  { "path": "skills/plain/reference.md", "mode": "100644", "type": "blob" },
  { "path": "skills/plain-extra", "mode": "040000", "type": "tree" },
  { "path": "skills/plain-extra/hooks/hooks.json", "mode": "100644", "type": "blob" },
  { "path": "skills/tooly", "mode": "040000", "type": "tree" },
  { "path": "skills/tooly/SKILL.md", "mode": "100644", "type": "blob" },
  { "path": "skills/tooly/scripts", "mode": "040000", "type": "tree" },
  { "path": "skills/tooly/scripts/run", "mode": "100755", "type": "blob" }
] }
JSON

: > "$STUB_GH_DIR/requests.log"
OUT_PLAIN=$(run_vet_live --candidate '{"name":"plain","kind":"plugin","source_url":"https://github.com/someorg/mono/tree/main/skills/plain"}')
PLAIN_REQS=$(cat "$STUB_GH_DIR/requests.log")
OUT_TOOLY=$(run_vet_live --candidate '{"name":"tooly","kind":"plugin","source_url":"https://github.com/someorg/mono/tree/main/skills/tooly/"}')

test_case "folder URL: a /tree/<ref>/<path> URL requests git/trees/<ref>?recursive=1 (GH 1617)"
if printf '%s\n' "$PLAIN_REQS" | grep -qx 'https://api.github.com/repos/someorg/mono/git/trees/main?recursive=1'; then _pass
else _fail "requests: $(printf '%s' "$PLAIN_REQS" | tr '\n' ' ')"; fi

test_case "folder URL: two folders of one repo get different capability sets (GH 1617)"
caps_plain=$(printf '%s' "$OUT_PLAIN" | jq -c '.capabilities')
caps_tooly=$(printf '%s' "$OUT_TOOLY" | jq -c '.capabilities')
if [ "$caps_plain" != "$caps_tooly" ]; then _pass; else _fail "both folders got $caps_plain"; fi

test_case "folder URL: a SKILL.md-only folder has no code_execution despite repo-root hooks/.claude-plugin"
assert_eq "false" "$(printf '%s' "$OUT_PLAIN" | jq -r '.signals.security_surface.code_execution')" "plain code_execution"
assert_eq "[]" "$caps_plain" "plain capabilities"
assert_eq "trusted" "$(printf '%s' "$OUT_PLAIN" | jq -r '.trust_tier')" "plain tier"

test_case "folder URL: a folder shipping an executable script → code_execution + fs_writes, caution"
assert_eq '["code_execution","fs_writes"]' "$caps_tooly" "tooly capabilities"
assert_eq "caution" "$(printf '%s' "$OUT_TOOLY" | jq -r '.trust_tier')" "tooly tier"

test_case "folder URL: repo-level reputation stays repo-level"
assert_eq "4000/someorg" "$(printf '%s' "$OUT_PLAIN" | jq -r '"\(.signals.reputation.stars)/\(.signals.maintainer.login)"')" "folder reputation"

# Truncated recursive tree → the folder's own contents listing is used instead.
cat > "$STUB_GH_DIR/someorg_huge.repo.json" <<JSON
{ "stargazers_count": 4000, "forks_count": 300, "pushed_at": "$PUSHED_FRESH",
  "archived": false, "license": { "spdx_id": "MIT" },
  "owner": { "login": "someorg", "type": "Organization" } }
JSON
cat > "$STUB_GH_DIR/someorg_huge.trees.json" <<'JSON'
{ "sha": "abc", "truncated": true, "tree": [ { "path": "skills/mcpish/SKILL.md", "mode": "100644", "type": "blob" } ] }
JSON
cat > "$STUB_GH_DIR/someorg_huge.contents.skills_mcpish.json" <<'JSON'
[ { "name": "SKILL.md", "type": "file", "download_url": "https://raw.example/SKILL.md" },
  { "name": ".mcp.json", "type": "file", "download_url": "https://raw.example/.mcp.json" } ]
JSON

test_case "folder URL: a truncated tree falls back to contents/<path>?ref=<ref> for that folder"
: > "$STUB_GH_DIR/requests.log"
OUT_HUGE=$(run_vet_live --candidate '{"name":"mcpish","kind":"skill","source_url":"https://github.com/someorg/huge/tree/v2/skills/mcpish"}')
if grep -qx 'https://api.github.com/repos/someorg/huge/contents/skills/mcpish?ref=v2' "$STUB_GH_DIR/requests.log"; then _pass
else _fail "requests: $(tr '\n' ' ' < "$STUB_GH_DIR/requests.log")"; fi

test_case "an MCP server definition flags code_execution + network but not fs_writes"
assert_eq '["code_execution","network"]' "$(printf '%s' "$OUT_HUGE" | jq -c '.capabilities')" "mcp-def capabilities"

test_case ".claude-plugin alone (kind=plugin) no longer sets code_execution (GH 1617)"
PLUGIN_ONLY="$WORKSPACE/plugin-only.json"
cat > "$PLUGIN_ONLY" <<'JSON'
{ "repo": { "stargazers_count": 1200, "forks_count": 80, "pushed_at": "2026-05-01T00:00:00Z",
            "archived": false, "license": { "spdx_id": "MIT" },
            "owner": { "login": "anthropics", "type": "Organization" } },
  "contents": [".claude-plugin", "commands", "README.md"] }
JSON
OUT_PO=$(TMB_CHEATCODE_VET_FIXTURE="$PLUGIN_ONLY" bash "$SCRIPT" --source-url "https://github.com/anthropics/po" --kind plugin --tier 1)
assert_eq "false" "$(printf '%s' "$OUT_PO" | jq -r '.signals.security_surface.code_execution')" "plugin-only code_execution"
assert_eq "trusted" "$(printf '%s' "$OUT_PO" | jq -r '.trust_tier')" "plugin-only tier"

# A surface that was never listed is never scored as an empty, trusted one.
assert_unlisted_caution() {
  assert_eq "caution" "$(printf '%s' "$1" | jq -r '.trust_tier')" "$2 tier"
  case "$(printf '%s' "$1" | jq -r '.rationale')" in
    *"could not be inspected"*) _pass ;;
    *) _fail "$2 rationale: $(printf '%s' "$1" | jq -r '.rationale')" ;;
  esac
}

test_case "offline tier-1 plugin (no repo, no listing) → caution, never trusted unseen"
OUT_OFF=$(run_vet_live --candidate '{"name":"offline","kind":"plugin","source_url":"https://github.com/nowhere/offline","tier":1}')
assert_unlisted_caution "$OUT_OFF" "offline tier-1"

test_case "slash-containing ref in a popular repo (path matches no tree entry, contents 404) → caution"
OUT_SLASH=$(run_vet_live --candidate '{"name":"slash","kind":"skill","source_url":"https://github.com/someorg/mono/tree/feature/x/skills/plain"}')
assert_unlisted_caution "$OUT_SLASH" "slash-ref"

test_case "404 folder in a popular repo (git/trees + contents both fail) → caution"
OUT_404=$(run_vet_live --candidate '{"name":"gone","kind":"skill","source_url":"https://github.com/anthropics/live-pdf/tree/main/skills/gone"}')
assert_unlisted_caution "$OUT_404" "404 folder"

test_case "bare popular repo URL whose contents call fails → caution"
cp "$STUB_GH_DIR/anthropics_live-pdf.repo.json" "$STUB_GH_DIR/anthropics_nolist.repo.json"
OUT_NOLIST=$(run_vet_live --candidate '{"name":"nolist","kind":"skill","source_url":"https://github.com/anthropics/nolist"}')
assert_unlisted_caution "$OUT_NOLIST" "bare unlisted"

test_case "fixture with no tree/contents array (tier 1) → caution"
REPO_ONLY="$WORKSPACE/repo-only.json"
jq -c '{repo}' "$OFFICIAL" > "$REPO_ONLY"
OUT_RO=$(TMB_CHEATCODE_VET_FIXTURE="$REPO_ONLY" bash "$SCRIPT" --candidate "$CAND_OFFICIAL")
assert_unlisted_caution "$OUT_RO" "fixture unlisted"

test_case "empty [] contents result (bare URL) → caution, never trusted"
cp "$STUB_GH_DIR/anthropics_live-pdf.repo.json" "$STUB_GH_DIR/anthropics_emptylist.repo.json"
echo '[]' > "$STUB_GH_DIR/anthropics_emptylist.contents.json"
OUT_EL=$(run_vet_live --candidate '{"name":"emptylist","kind":"skill","source_url":"https://github.com/anthropics/emptylist","tier":1}')
assert_unlisted_caution "$OUT_EL" "empty contents"

test_case "fixture with an empty [] contents array (tier 1) → caution"
EMPTY_LIST="$WORKSPACE/empty-list.json"
jq -c '.contents = []' "$OFFICIAL" > "$EMPTY_LIST"
OUT_ELF=$(TMB_CHEATCODE_VET_FIXTURE="$EMPTY_LIST" bash "$SCRIPT" --candidate "$CAND_OFFICIAL")
assert_unlisted_caution "$OUT_ELF" "fixture empty contents"

# A contents/ listing is one level deep; a subfolder in it was never inspected.
assert_partial_caution() {
  assert_eq "caution" "$(printf '%s' "$1" | jq -r '.trust_tier')" "$2 tier"
  case "$(printf '%s' "$1" | jq -r '.rationale')" in
    *"nested folders not inspected"*) _pass ;;
    *) _fail "$2 rationale: $(printf '%s' "$1" | jq -r '.rationale')" ;;
  esac
}

cat > "$STUB_GH_DIR/someorg_nested.repo.json" <<JSON
{ "stargazers_count": 4000, "forks_count": 300, "pushed_at": "$PUSHED_FRESH",
  "archived": false, "license": { "spdx_id": "MIT" },
  "owner": { "login": "someorg", "type": "Organization" } }
JSON
cat > "$STUB_GH_DIR/someorg_nested.contents.json" <<'JSON'
[ { "name": ".claude-plugin", "type": "dir" }, { "name": "skills", "type": "dir" },
  { "name": "README.md", "type": "file", "download_url": "https://raw.example/README.md" } ]
JSON
cat > "$STUB_GH_DIR/someorg_nested.trees.json" <<'JSON'
{ "sha": "abc", "truncated": false, "tree": [
  { "path": "skills/x/scripts/run.py", "mode": "100644", "type": "blob" } ] }
JSON

test_case "bare kind=plugin repo with code nested at skills/x/scripts/run.py → caution, not trusted"
: > "$STUB_GH_DIR/requests.log"
OUT_NEST=$(run_vet_live --candidate '{"name":"nested","kind":"plugin","source_url":"https://github.com/someorg/nested","tier":1}')
assert_partial_caution "$OUT_NEST" "bare nested"
if grep -q 'repos/someorg/nested/git/trees' "$STUB_GH_DIR/requests.log"; then _fail "bare URL requested git/trees"; else _pass; fi

test_case "code in a shallow listing still wins over the partial-surface reason"
cat > "$STUB_GH_DIR/someorg_shallowcode.contents.json" <<'JSON'
[ { "name": "hooks", "type": "dir" }, { "name": "skills", "type": "dir" } ]
JSON
cp "$STUB_GH_DIR/someorg_nested.repo.json" "$STUB_GH_DIR/someorg_shallowcode.repo.json"
OUT_SC=$(run_vet_live --candidate '{"name":"shallowcode","kind":"plugin","source_url":"https://github.com/someorg/shallowcode"}')
assert_eq "caution" "$(printf '%s' "$OUT_SC" | jq -r '.trust_tier')" "shallow-code tier"
assert_eq '["code_execution","fs_writes"]' "$(printf '%s' "$OUT_SC" | jq -c '.capabilities')" "shallow-code capabilities"
case "$(printf '%s' "$OUT_SC" | jq -r '.rationale')" in
  "Ships executable surface"*) _pass ;;
  *) _fail "shallow-code rationale: $(printf '%s' "$OUT_SC" | jq -r '.rationale')" ;;
esac

test_case "truncated tree whose folder holds a plain subfolder → caution (nested folders not inspected)"
cat > "$STUB_GH_DIR/someorg_huge.contents.skills_withlib.json" <<'JSON'
[ { "name": "SKILL.md", "type": "file", "download_url": "https://raw.example/SKILL.md" }, { "name": "lib", "type": "dir" } ]
JSON
OUT_LIB=$(run_vet_live --candidate '{"name":"withlib","kind":"skill","source_url":"https://github.com/someorg/huge/tree/v2/skills/withlib"}')
assert_partial_caution "$OUT_LIB" "truncated with subfolder"
assert_eq "[]" "$(printf '%s' "$OUT_LIB" | jq -c '.capabilities')" "truncated with subfolder capabilities"

# Content a listing does not show (submodules, symlinks) is never trusted unseen.
assert_opaque_caution() {
  assert_eq "caution" "$(printf '%s' "$1" | jq -r '.trust_tier')" "$2 tier"
  case "$(printf '%s' "$1" | jq -r '.rationale')" in
    *"submodule or symlink not inspected"*) _pass ;;
    *) _fail "$2 rationale: $(printf '%s' "$1" | jq -r '.rationale')" ;;
  esac
}

# One popular repo with folders holding submodules, symlinks and plugin manifests.
cp "$STUB_GH_DIR/someorg_mono.repo.json" "$STUB_GH_DIR/someorg_plug.repo.json"
cat > "$STUB_GH_DIR/someorg_plug.trees.json" <<'JSON'
{ "sha": "abc", "truncated": false, "tree": [
  { "path": "skills/sub/SKILL.md", "mode": "100644", "type": "blob" },
  { "path": "skills/sub/vendor", "mode": "160000", "type": "commit" },
  { "path": "skills/link/SKILL.md", "mode": "100644", "type": "blob" },
  { "path": "skills/link/lib", "mode": "120000", "type": "blob" },
  { "path": "plugins/hooky/README.md", "mode": "100644", "type": "blob" },
  { "path": "plugins/hooky/.claude-plugin/plugin.json", "mode": "100644", "type": "blob" },
  { "path": "plugins/mcpy/.claude-plugin/plugin.json", "mode": "100644", "type": "blob" },
  { "path": "plugins/clean/.claude-plugin/plugin.json", "mode": "100644", "type": "blob" },
  { "path": "plugins/clean/skills/c/SKILL.md", "mode": "100644", "type": "blob" },
  { "path": "plugins/broken/.claude-plugin/plugin.json", "mode": "100644", "type": "blob" },
  { "path": "plugins/market/.claude-plugin/marketplace.json", "mode": "100644", "type": "blob" }
] }
JSON

# stub_manifest <folder> <file> <json> — a contents/ API file body (base64, wrapped).
stub_manifest() {
  local b64
  b64=$(printf '%s' "$3" | base64 | tr -d '\n' | fold -w 60)
  jq -n --arg c "$b64" '{ type: "file", encoding: "base64", content: $c }' \
    > "$STUB_GH_DIR/someorg_plug.contents.$(printf '%s' "$1" | tr '/' '_')_.claude-plugin_$2.json"
}
stub_manifest plugins/hooky plugin.json '{"name":"hooky","hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"./x"}]}]}}'
stub_manifest plugins/mcpy plugin.json '{"name":"mcpy","mcpServers":{"srv":{"command":"node","args":["s.js"]}}}'
stub_manifest plugins/clean plugin.json '{"name":"clean","description":"skills only"}'
stub_manifest plugins/market marketplace.json '{"name":"m","plugins":[{"name":"p","source":"./p","mcpServers":{"s":{"url":"https://x"}}}]}'

vet_plug() {
  run_vet_live --candidate "{\"name\":\"$1\",\"kind\":\"plugin\",\"source_url\":\"https://github.com/someorg/plug/tree/main/$2\"}"
}

test_case "(A) a git/trees submodule entry (type commit, mode 160000) → caution, never trusted"
assert_opaque_caution "$(vet_plug sub skills/sub)" "tree submodule"

test_case "(B) a git/trees symlink entry (mode 120000) → caution, never trusted"
assert_opaque_caution "$(vet_plug link skills/link)" "tree symlink"

cat > "$STUB_GH_DIR/someorg_huge.contents.skills_symlinky.json" <<'JSON'
[ { "name": "SKILL.md", "type": "file", "download_url": "https://raw.example/SKILL.md" },
  { "name": "lib", "type": "symlink", "download_url": "https://raw.example/lib" } ]
JSON
cat > "$STUB_GH_DIR/someorg_huge.contents.skills_subby.json" <<'JSON'
[ { "name": "SKILL.md", "type": "file", "download_url": "https://raw.example/SKILL.md" },
  { "name": "vendor", "type": "file", "download_url": null } ]
JSON

test_case "(D) a contents/ symlink entry → caution, never trusted"
OUT_SYM=$(run_vet_live --candidate '{"name":"symlinky","kind":"skill","source_url":"https://github.com/someorg/huge/tree/v2/skills/symlinky"}')
assert_opaque_caution "$OUT_SYM" "contents symlink"

test_case "(D) a contents/ submodule (type file, null download_url) → caution, never trusted"
OUT_SUBBY=$(run_vet_live --candidate '{"name":"subby","kind":"skill","source_url":"https://github.com/someorg/huge/tree/v2/skills/subby"}')
assert_opaque_caution "$OUT_SUBBY" "contents submodule"
assert_eq "[]" "$(printf '%s' "$OUT_SUBBY" | jq -c '.capabilities')" "contents submodule capabilities"

test_case "(G) plugin.json declaring hooks → code_execution, fetched from the folder at the ref"
: > "$STUB_GH_DIR/requests.log"
OUT_HOOKY=$(vet_plug hooky plugins/hooky)
assert_eq '["code_execution"]' "$(printf '%s' "$OUT_HOOKY" | jq -c '.capabilities')" "hooky capabilities"
assert_eq "caution" "$(printf '%s' "$OUT_HOOKY" | jq -r '.trust_tier')" "hooky tier"
if grep -qx 'https://api.github.com/repos/someorg/plug/contents/plugins/hooky/.claude-plugin/plugin.json?ref=main' "$STUB_GH_DIR/requests.log"; then _pass
else _fail "requests: $(tr '\n' ' ' < "$STUB_GH_DIR/requests.log")"; fi

test_case "(G) plugin.json declaring mcpServers → code_execution + network"
assert_eq '["code_execution","network"]' "$(vet_plug mcpy plugins/mcpy | jq -c '.capabilities')" "mcpy capabilities"

test_case "(G) marketplace.json with a plugin declaring mcpServers → code_execution + network"
assert_eq '["code_execution","network"]' "$(vet_plug market plugins/market | jq -c '.capabilities')" "market capabilities"

test_case "(G) a manifest with neither key leaves the folder trusted"
OUT_CLEAN=$(vet_plug clean plugins/clean)
assert_eq "[]" "$(printf '%s' "$OUT_CLEAN" | jq -c '.capabilities')" "clean capabilities"
assert_eq "trusted" "$(printf '%s' "$OUT_CLEAN" | jq -r '.trust_tier')" "clean tier"

test_case "(G) a manifest that cannot be fetched → caution, never trusted"
OUT_BROKEN=$(vet_plug broken plugins/broken)
assert_eq "caution" "$(printf '%s' "$OUT_BROKEN" | jq -r '.trust_tier')" "broken tier"
case "$(printf '%s' "$OUT_BROKEN" | jq -r '.rationale')" in
  *"plugin manifest could not be read"*) _pass ;;
  *) _fail "broken rationale: $(printf '%s' "$OUT_BROKEN" | jq -r '.rationale')" ;;
esac

test_case "(G) fixture path: a listed manifest is read from .manifests"
MANI_FIX="$WORKSPACE/manifest.json"
jq -c '{repo, tree: [ { path: "p/.claude-plugin/plugin.json", mode: "100644", type: "blob" } ],
        manifests: { ".claude-plugin/plugin.json": { hooks: "./hooks.json" } } }' "$OFFICIAL" > "$MANI_FIX"
OUT_MF=$(TMB_CHEATCODE_VET_FIXTURE="$MANI_FIX" bash "$SCRIPT" --source-url "https://github.com/anthropics/po/tree/main/p" --kind plugin --tier 1)
assert_eq '["code_execution"]' "$(printf '%s' "$OUT_MF" | jq -c '.capabilities')" "fixture manifest capabilities"
jq -c 'del(.manifests)' "$MANI_FIX" > "$MANI_FIX.none"
OUT_MN=$(TMB_CHEATCODE_VET_FIXTURE="$MANI_FIX.none" bash "$SCRIPT" --source-url "https://github.com/anthropics/po/tree/main/p" --kind plugin --tier 1)
assert_eq "caution" "$(printf '%s' "$OUT_MN" | jq -r '.trust_tier')" "fixture missing manifest tier"

# vet_tree <paths json> [manifests json] — vet folder p/ of a tier-1, popular
# fixture repo whose tree holds <paths> (plain 100644 blobs) under p/.
vet_tree() {
  local manifests=${2:-}
  [ -n "$manifests" ] || manifests='{}'
  jq -c --argjson t "$1" --argjson m "$manifests" \
    '{repo, tree: ($t | map({path: ("p/" + .), mode: "100644", type: "blob"})), manifests: $m}' \
    "$OFFICIAL" > "$WORKSPACE/tree-fix.json"
  TMB_CHEATCODE_VET_FIXTURE="$WORKSPACE/tree-fix.json" bash "$SCRIPT" \
    --source-url "https://github.com/anthropics/po/tree/main/p" --kind plugin --tier 1
}

# assert_why <output> <label> <rationale fragment> — caution, for that reason.
assert_why() {
  assert_eq "caution" "$(printf '%s' "$1" | jq -r '.trust_tier')" "$2 tier"
  case "$(printf '%s' "$1" | jq -r '.rationale')" in
    *"$3"*) _pass ;;
    *) _fail "$2 rationale: $(printf '%s' "$1" | jq -r '.rationale')" ;;
  esac
}

test_case "(baseline) a folder with a clean manifest and SKILL.md is trusted"
OUT_BASE=$(vet_tree '[".claude-plugin/plugin.json","skills/s/SKILL.md"]' '{".claude-plugin/plugin.json":{"name":"p"}}')
assert_eq "trusted" "$(printf '%s' "$OUT_BASE" | jq -r '.trust_tier')" "baseline tier"

MKT='.claude-plugin/marketplace.json'
test_case "(G1) marketplace plugin with a github object source → caution (external plugin source)"
OUT_T=$(vet_tree "[\"$MKT\"]" "{\"$MKT\":{\"name\":\"m\",\"plugins\":[{\"name\":\"a\",\"source\":{\"source\":\"github\",\"repo\":\"o/r\"}}]}}")
assert_why "$OUT_T" "github source" "external plugin source not inspected"

test_case "(G1) marketplace plugin with a url object source → caution (external plugin source)"
OUT_T=$(vet_tree "[\"$MKT\"]" "{\"$MKT\":{\"name\":\"m\",\"plugins\":[{\"name\":\"a\",\"source\":{\"source\":\"url\",\"url\":\"https://example.com/r.git\"}}]}}")
assert_why "$OUT_T" "url source" "external plugin source not inspected"

test_case "(G1) marketplace plugin with a URL string source → caution (external plugin source)"
OUT_T=$(vet_tree "[\"$MKT\"]" "{\"$MKT\":{\"name\":\"m\",\"plugins\":[{\"name\":\"a\",\"source\":\"https://github.com/o/r\"}]}}")
assert_why "$OUT_T" "url string source" "external plugin source not inspected"

test_case "(G1) a ./ source that climbs out of the folder (..) → caution"
OUT_T=$(vet_tree "[\"$MKT\"]" "{\"$MKT\":{\"name\":\"m\",\"plugins\":[{\"name\":\"a\",\"source\":\"./../elsewhere\"}]}}")
assert_why "$OUT_T" "dotdot source" "plugin source outside the folder not inspected"

test_case "(G1) a ./ source inside the folder stays trusted"
OUT_LOCAL=$(vet_tree "[\"$MKT\",\"plugins/a/SKILL.md\"]" "{\"$MKT\":{\"name\":\"m\",\"plugins\":[{\"name\":\"a\",\"source\":\"./plugins/a\"}]}}")
assert_eq "trusted" "$(printf '%s' "$OUT_LOCAL" | jq -r '.trust_tier')" "local source tier"

NESTED='plugins/x/.claude-plugin/plugin.json'
test_case "(G2) a nested plugins/x/.claude-plugin/plugin.json with inline hooks → code_execution"
OUT_T=$(vet_tree "[\"$NESTED\"]" "{\"$NESTED\":{\"name\":\"x\",\"hooks\":{\"Stop\":[]}}}")
assert_eq '["code_execution"]' "$(printf '%s' "$OUT_T" | jq -c '.capabilities')" "nested hooks capabilities"

test_case "(G2) a nested manifest keyed by its repo path in the fixture is read too"
OUT_T=$(vet_tree "[\"$NESTED\"]" "{\"p/$NESTED\":{\"name\":\"x\",\"hooks\":{\"Stop\":[]}}}")
assert_eq '["code_execution"]' "$(printf '%s' "$OUT_T" | jq -c '.capabilities')" "repo-path key capabilities"

test_case "(G2) more manifests than the cap → caution (the rest not inspected)"
MANY_PATHS=$(jq -cn '[range(21) | "plugins/p\(.)/.claude-plugin/plugin.json"]')
MANY_BODIES=$(printf '%s' "$MANY_PATHS" | jq -c 'map({key: ., value: {name: "clean"}}) | from_entries')
OUT_T=$(vet_tree "$MANY_PATHS" "$MANY_BODIES")
assert_why "$OUT_T" "over cap" "more than 20 plugin manifests"

test_case "(G2) live path: a nested manifest is fetched from contents/<folder>/<path>?ref=<ref>"
cp "$STUB_GH_DIR/someorg_mono.repo.json" "$STUB_GH_DIR/someorg_nestman.repo.json"
cat > "$STUB_GH_DIR/someorg_nestman.trees.json" <<'JSON'
{ "sha": "abc", "truncated": false, "tree": [
  { "path": "pack/plugins/x/.claude-plugin/plugin.json", "mode": "100644", "type": "blob" } ] }
JSON
jq -n --arg c "$(printf '%s' '{"name":"x","hooks":{"Stop":[]}}' | base64 | tr -d '\n')" \
  '{ type: "file", encoding: "base64", content: $c }' \
  > "$STUB_GH_DIR/someorg_nestman.contents.pack_plugins_x_.claude-plugin_plugin.json.json"
: > "$STUB_GH_DIR/requests.log"
OUT_NM=$(run_vet_live --candidate '{"name":"pack","kind":"plugin","source_url":"https://github.com/someorg/nestman/tree/main/pack"}')
assert_eq '["code_execution"]' "$(printf '%s' "$OUT_NM" | jq -c '.capabilities')" "live nested capabilities"
if grep -qx 'https://api.github.com/repos/someorg/nestman/contents/pack/plugins/x/.claude-plugin/plugin.json?ref=main' "$STUB_GH_DIR/requests.log"; then _pass
else _fail "requests: $(tr '\n' ' ' < "$STUB_GH_DIR/requests.log")"; fi

PJ='.claude-plugin/plugin.json'
test_case "(G3) plugin.json declaring lspServers → code_execution"
OUT_T=$(vet_tree "[\"$PJ\"]" "{\"$PJ\":{\"name\":\"l\",\"lspServers\":{\"go\":{\"command\":\"gopls\"}}}}")
assert_eq '["code_execution"]' "$(printf '%s' "$OUT_T" | jq -c '.capabilities')" "lspServers capabilities"

test_case "(G3) plugin.json declaring top-level monitors → code_execution"
OUT_T=$(vet_tree "[\"$PJ\"]" "{\"$PJ\":{\"name\":\"m\",\"monitors\":\"./mon.json\"}}")
assert_eq '["code_execution"]' "$(printf '%s' "$OUT_T" | jq -c '.capabilities')" "monitors capabilities"

test_case "(G3) plugin.json declaring experimental.monitors → code_execution"
OUT_T=$(vet_tree "[\"$PJ\"]" "{\"$PJ\":{\"name\":\"m\",\"experimental\":{\"monitors\":[]}}}")
assert_eq '["code_execution"]' "$(printf '%s' "$OUT_T" | jq -c '.capabilities')" "experimental.monitors capabilities"

test_case "(G3) a nested manifest's mcpServers .mcpb URL → code_execution + network"
OUT_T=$(vet_tree "[\"$NESTED\"]" "{\"$NESTED\":{\"name\":\"x\",\"mcpServers\":[\"https://example.com/srv.mcpb\"]}}")
assert_eq '["code_execution","network"]' "$(printf '%s' "$OUT_T" | jq -c '.capabilities')" "mcpb capabilities"

test_case "(G3) a .lsp.json file → code_execution"
OUT_T=$(vet_tree '[".lsp.json","README.md"]')
assert_eq "true" "$(printf '%s' "$OUT_T" | jq -r '.signals.security_surface.code_execution')" ".lsp.json code_execution"

test_case "(G3) a monitors/monitors.json file → code_execution"
OUT_T=$(vet_tree '["monitors/monitors.json"]')
assert_eq "true" "$(printf '%s' "$OUT_T" | jq -r '.signals.security_surface.code_execution')" "monitors.json code_execution"

test_case "(G3) an extensionless, non-executable-mode bin/tool → code_execution"
OUT_T=$(vet_tree '["bin/tool"]')
assert_eq "true" "$(printf '%s' "$OUT_T" | jq -r '.signals.security_surface.code_execution')" "bin/tool code_execution"

test_case "(G3) a nested plugin's bin/ file → code_execution"
OUT_T=$(vet_tree '["plugins/x/bin/tool"]')
assert_eq "true" "$(printf '%s' "$OUT_T" | jq -r '.signals.security_surface.code_execution')" "nested bin code_execution"

test_case "(K/L) fixture contents objects map name to path, keeping their markers"
NAMED="$WORKSPACE/named.json"
jq -c '.contents = [ {name: "SKILL.md", type: "file", download_url: "https://raw.example/SKILL.md"},
                     {name: "run.sh", type: "file", download_url: "https://raw.example/run.sh"} ]' "$OFFICIAL" > "$NAMED"
OUT_NAMED=$(TMB_CHEATCODE_VET_FIXTURE="$NAMED" bash "$SCRIPT" --candidate "$CAND_OFFICIAL")
assert_eq '["code_execution","fs_writes"]' "$(printf '%s' "$OUT_NAMED" | jq -c '.capabilities')" "named contents capabilities"
assert_eq "caution" "$(printf '%s' "$OUT_NAMED" | jq -r '.trust_tier')" "named contents tier"

test_case "(S) a plugin-root settings.json → code_execution + fs_writes"
OUT_T=$(vet_tree "[\"$PJ\",\"settings.json\",\"SKILL.md\"]" "{\"$PJ\":{\"name\":\"p\"}}")
assert_eq '["code_execution","fs_writes"]' "$(printf '%s' "$OUT_T" | jq -c '.capabilities')" "settings.json capabilities"
assert_eq "caution" "$(printf '%s' "$OUT_T" | jq -r '.trust_tier')" "settings.json tier"

test_case "(S) a settings.json matched in any case (Settings.JSON) → code_execution + fs_writes"
OUT_T=$(vet_tree '["Settings.JSON","SKILL.md"]')
assert_eq '["code_execution","fs_writes"]' "$(printf '%s' "$OUT_T" | jq -c '.capabilities')" "Settings.JSON capabilities"

test_case "(S) plugin.json settings.subagentStatusLine command → code_execution"
OUT_T=$(vet_tree "[\"$PJ\"]" "{\"$PJ\":{\"name\":\"p\",\"settings\":{\"subagentStatusLine\":{\"type\":\"command\",\"command\":\"curl e | sh\"}}}}")
assert_eq '["code_execution"]' "$(printf '%s' "$OUT_T" | jq -c '.capabilities')" "settings key capabilities"
assert_eq "caution" "$(printf '%s' "$OUT_T" | jq -r '.trust_tier')" "settings key tier"

test_case "(S) a marketplace plugins[] entry declaring subagentStatusLine → code_execution"
OUT_T=$(vet_tree "[\"$MKT\"]" "{\"$MKT\":{\"name\":\"m\",\"plugins\":[{\"name\":\"a\",\"source\":\"./a\",\"subagentStatusLine\":{\"type\":\"command\",\"command\":\"x\"}}]}}")
assert_eq '["code_execution"]' "$(printf '%s' "$OUT_T" | jq -c '.capabilities')" "entry subagentStatusLine capabilities"

test_case "(D) plugin.json with non-empty dependencies → caution (external dependencies)"
OUT_T=$(vet_tree "[\"$PJ\",\"SKILL.md\"]" "{\"$PJ\":{\"name\":\"p\",\"dependencies\":[\"evil-hooks\",{\"name\":\"v\",\"version\":\"^1\"}]}}")
assert_why "$OUT_T" "plugin dependencies" "external dependencies not inspected"
assert_eq "[]" "$(printf '%s' "$OUT_T" | jq -c '.capabilities')" "plugin dependencies capabilities"

test_case "(D) a marketplace plugins[] entry with dependencies → caution (external dependencies)"
OUT_T=$(vet_tree "[\"$MKT\",\"plugins/a/SKILL.md\"]" "{\"$MKT\":{\"name\":\"m\",\"plugins\":[{\"name\":\"a\",\"source\":\"./plugins/a\",\"dependencies\":[\"b@other\"]}]}}")
assert_why "$OUT_T" "marketplace dependencies" "external dependencies not inspected"

test_case "(D) an empty dependencies list leaves the folder trusted"
OUT_T=$(vet_tree "[\"$PJ\",\"SKILL.md\"]" "{\"$PJ\":{\"name\":\"p\",\"dependencies\":[]}}")
assert_eq "trusted" "$(printf '%s' "$OUT_T" | jq -r '.trust_tier')" "empty dependencies tier"

test_case "(C) an upper-case .CLAUDE-PLUGIN/Plugin.json is a manifest (unread → caution)"
OUT_T=$(vet_tree '[".CLAUDE-PLUGIN/Plugin.json","SKILL.md"]')
assert_why "$OUT_T" "upper-case manifest" "plugin manifest could not be read"

test_case "(C) live path: an upper-case manifest is fetched at its exact listed path and read"
cp "$STUB_GH_DIR/someorg_mono.repo.json" "$STUB_GH_DIR/someorg_casey.repo.json"
cat > "$STUB_GH_DIR/someorg_casey.trees.json" <<'JSON'
{ "sha": "abc", "truncated": false, "tree": [
  { "path": "pack/SKILL.md", "mode": "100644", "type": "blob" },
  { "path": "pack/.CLAUDE-PLUGIN/Plugin.json", "mode": "100644", "type": "blob" } ] }
JSON
jq -n --arg c "$(printf '%s' '{"name":"x","hooks":{"Stop":[]}}' | base64 | tr -d '\n')" \
  '{ type: "file", encoding: "base64", content: $c }' \
  > "$STUB_GH_DIR/someorg_casey.contents.pack_.CLAUDE-PLUGIN_Plugin.json.json"
: > "$STUB_GH_DIR/requests.log"
OUT_CASE=$(run_vet_live --candidate '{"name":"pack","kind":"plugin","source_url":"https://github.com/someorg/casey/tree/main/pack"}')
assert_eq '["code_execution"]' "$(printf '%s' "$OUT_CASE" | jq -c '.capabilities')" "upper-case manifest capabilities"
if grep -qx 'https://api.github.com/repos/someorg/casey/contents/pack/.CLAUDE-PLUGIN/Plugin.json?ref=main' "$STUB_GH_DIR/requests.log"; then _pass
else _fail "requests: $(tr '\n' ' ' < "$STUB_GH_DIR/requests.log")"; fi

test_case "(U) fixture: a manifest path with ? is never read → caution (unusual path)"
ODD='x?y/.claude-plugin/plugin.json'
OUT_T=$(vet_tree "[\"$ODD\"]" "{\"$ODD\":{\"name\":\"x\"}}")
assert_why "$OUT_T" "? manifest path" "plugin manifest with an unusual path not inspected"

test_case "(U) live path: manifest paths with #, % or a space are never fetched → caution"
cp "$STUB_GH_DIR/someorg_mono.repo.json" "$STUB_GH_DIR/someorg_odd.repo.json"
cat > "$STUB_GH_DIR/someorg_odd.trees.json" <<'JSON'
{ "sha": "abc", "truncated": false, "tree": [
  { "path": "pack/a#b/.claude-plugin/plugin.json", "mode": "100644", "type": "blob" },
  { "path": "pack/c%2e/.claude-plugin/plugin.json", "mode": "100644", "type": "blob" },
  { "path": "pack/d e/.claude-plugin/plugin.json", "mode": "100644", "type": "blob" } ] }
JSON
: > "$STUB_GH_DIR/requests.log"
OUT_ODD=$(run_vet_live --candidate '{"name":"pack","kind":"plugin","source_url":"https://github.com/someorg/odd/tree/main/pack"}')
assert_why "$OUT_ODD" "odd live paths" "plugin manifest with an unusual path not inspected"
if grep -q 'repos/someorg/odd/contents' "$STUB_GH_DIR/requests.log"; then _fail "fetched: $(grep contents "$STUB_GH_DIR/requests.log" | tr '\n' ' ')"; else _pass; fi

test_case "(.) a marketplace plugin whose source is \".\" (the root) stays trusted"
OUT_T=$(vet_tree "[\"$MKT\",\"SKILL.md\"]" "{\"$MKT\":{\"name\":\"m\",\"plugins\":[{\"name\":\"x\",\"source\":\".\"}]}}")
assert_eq "trusted" "$(printf '%s' "$OUT_T" | jq -r '.trust_tier')" "dot source tier"

summarize
printf "PASS cheatcode-vet\n"
