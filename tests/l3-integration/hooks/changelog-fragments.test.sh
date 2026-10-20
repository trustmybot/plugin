#!/usr/bin/env bash
# Tests for changelog.d/ fragments (GH 1277): tests/l1-lint/changelog-current.sh
# on a feature branch, and scripts/maintenance/bump-version.sh assembling the
# fragments into a release section, byte-identically for the same inputs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
LINT="$PLUGIN_ROOT/tests/l1-lint/changelog-current.sh"
BUMP="$PLUGIN_ROOT/scripts/maintenance/bump-version.sh"
FIXTURE="$HERE/fixtures/changelog-fragments"

TMPDIR=$(_t=${TMPDIR:-/tmp}; mktemp -d "${_t%/}/tmb-changelog-fragments.XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT

CUTOVER_DAY="2026-10-12"
AFTER_CUTOVER="2026-10-13"

# A repo with origin/dev at an initial commit and a feature branch checked out.
new_repo() {
  local dir="$TMPDIR/$1"
  mkdir -p "$dir/.claude-plugin" "$dir/changelog.d"
  git init -q -b dev "$dir"
  git -C "$dir" config user.email t@t.io && git -C "$dir" config user.name t
  printf '{"version": "1.0.0"}\n' > "$dir/.claude-plugin/plugin.json"
  printf '# Changelog\n\n## Unreleased\n\n### Fixed\n- **Old** (GH 100): old.\n\n## v1.0.0 — 2026-01-01\n\n### Added\n- **First** (GH 1): hi.\n' > "$dir/CHANGELOG.md"
  printf 'readme\n' > "$dir/changelog.d/README.md"
  echo src > "$dir/src.txt"
  git -C "$dir" add . && git -C "$dir" commit -qm "init"
  git -C "$dir" update-ref refs/remotes/origin/dev HEAD
  git -C "$dir" checkout -q -b feat/work
  printf '%s\n' "$dir"
}

commit_all() {
  git -C "$1" add -A && git -C "$1" commit -qm "$2"
}

lint() {
  local dir="$1" today="$2"
  TMB_CHANGELOG_TODAY="$today" bash "$LINT" --root "$dir" 2>&1
}

lint_rc() {
  local rc=0
  TMB_CHANGELOG_TODAY="$2" bash "$LINT" --root "$1" >/dev/null 2>&1 || rc=$?
  printf '%s\n' "$rc"
}

# --- changelog-current.sh ----------------------------------------------------

test_case "a fragment for the cited issue passes, after the cut-over too"
R=$(new_repo frag-ok)
echo change >> "$R/src.txt"
printf '### Fixed\n- **Thing works** (GH 2001): it does.\n' > "$R/changelog.d/2001-thing-works.md"
commit_all "$R" "🐛 fix: thing works (GH 2001)"
assert_eq 0 "$(lint_rc "$R" "$AFTER_CUTOVER")" "fragment → PASS"

test_case "a cited issue with neither a fragment nor a CHANGELOG entry fails"
R=$(new_repo frag-missing)
echo change >> "$R/src.txt"
commit_all "$R" "🐛 fix: untracked change (GH 2002)"
assert_eq 1 "$(lint_rc "$R" "$CUTOVER_DAY")" "missing → FAIL"
assert_contains "$(lint "$R" "$CUTOVER_DAY")" "GH 2002" "names the issue"

test_case "editing CHANGELOG.md and adding a fragment fails (pick one)"
R=$(new_repo both)
printf '### Fixed\n- **Both** (GH 2003): both.\n' > "$R/changelog.d/2003-both.md"
perl -0pi -e 's/### Fixed\n/### Fixed\n- **Both** (GH 2003): both.\n/' "$R/CHANGELOG.md"
commit_all "$R" "🐛 fix: both (GH 2003)"
assert_eq 1 "$(lint_rc "$R" "$CUTOVER_DAY")" "both → FAIL"
assert_contains "$(lint "$R" "$CUTOVER_DAY")" "pick one" "says pick one"

test_case "a fragment with an unknown section fails"
R=$(new_repo bad-section)
printf '### Improved\n- **Better** (GH 2004): better.\n' > "$R/changelog.d/2004-better.md"
commit_all "$R" "✨ feat: better (GH 2004)"
assert_eq 1 "$(lint_rc "$R" "$CUTOVER_DAY")" "malformed section → FAIL"
assert_contains "$(lint "$R" "$CUTOVER_DAY")" "first line must be one of" "explains the section rule"

test_case "fragment filename, issue citation and #<n> ids are validated"
R=$(new_repo bad-shape)
printf '### Fixed\n- **x** (GH 2006): x.\n' > "$R/changelog.d/Fix_Thing.md"
printf '### Fixed\n- **y** (GH 1): cites another issue.\n' > "$R/changelog.d/2007-y.md"
printf '### Fixed\n- **z** (GH 2008): see #123.\n' > "$R/changelog.d/2008-z.md"
commit_all "$R" "🐛 fix: shapes"
out=$(lint "$R" "$CUTOVER_DAY" || true)
assert_eq 1 "$(lint_rc "$R" "$CUTOVER_DAY")" "malformed fragments → FAIL"
assert_contains "$out" "Fix_Thing.md: filename must be" "bad filename named"
assert_contains "$out" "must cite GH 2007" "missing self-citation named"
assert_contains "$out" 'not "#<n>"' "local #id rejected"

test_case "a direct CHANGELOG.md edit passes on the cut-over day and fails after it"
R=$(new_repo direct)
perl -0pi -e 's/### Fixed\n/### Fixed\n- **Direct** (GH 2005): direct.\n/' "$R/CHANGELOG.md"
commit_all "$R" "🐛 fix: direct (GH 2005)"
assert_eq 0 "$(lint_rc "$R" "$CUTOVER_DAY")" "cut-over day → PASS"
assert_eq 1 "$(lint_rc "$R" "$AFTER_CUTOVER")" "after cut-over → FAIL"
assert_contains "$(lint "$R" "$AFTER_CUTOVER")" "edits CHANGELOG.md directly" "names the rule"

test_case "an in-flight branch (every cited issue in the transition list) may still edit CHANGELOG.md"
R=$(new_repo in-flight)
perl -0pi -e 's/### Fixed\n/### Fixed\n- **Runner** (GH 1245): runner.\n/' "$R/CHANGELOG.md"
commit_all "$R" "🧪 test: runner (GH 1245)"
assert_eq 0 "$(lint_rc "$R" "$AFTER_CUTOVER")" "transition → PASS"

test_case "a version bump branch assembles CHANGELOG.md without tripping the direct-edit rule"
R=$(new_repo bump)
printf '{"version": "1.1.0"}\n' > "$R/.claude-plugin/plugin.json"
perl -0pi -e 's/## Unreleased\n/## v1.1.0 — 2026-10-20\n/' "$R/CHANGELOG.md"
commit_all "$R" "🔖 chore: bump 1.1.0"
assert_eq 0 "$(lint_rc "$R" "$AFTER_CUTOVER")" "bump branch → PASS"

test_case "on the base branch the branch rules are skipped"
R=$(new_repo on-dev)
git -C "$R" checkout -q dev
assert_contains "$(lint "$R" "$AFTER_CUTOVER")" "not on a feature branch" "skips on dev"

# --- bump-version.sh assembly ------------------------------------------------

bump_repo() {
  local dir="$TMPDIR/$1"
  mkdir -p "$dir/.claude-plugin" "$dir/.codex-plugin" "$dir/mcp/trajectory-server" "$dir/changelog.d"
  git init -q -b dev "$dir"
  for f in .claude-plugin/plugin.json .codex-plugin/plugin.json package.json mcp/trajectory-server/package.json; do
    printf '{\n  "version": "1.0.0"\n}\n' > "$dir/$f"
  done
  printf '{\n  "workspaces": {\n    "": {\n      "version": "1.0.0"\n    }\n  }\n}\n' > "$dir/bun.lock"
  cp "$FIXTURE/CHANGELOG.md" "$dir/CHANGELOG.md"
  mkdir -p "$dir/scripts/maintenance/lib"
  cp "$BUMP" "$dir/scripts/maintenance/"
  cp "$PLUGIN_ROOT/scripts/maintenance/lib/changelog-fragments.sh" "$dir/scripts/maintenance/lib/"
  printf '%s\n' "$dir"
}

# bump-version.sh operates on the checkout holding it, so run the temp repo's copy from an unrelated cwd.
bump() {
  local dir="$1"; shift
  (cd "$TMPDIR" && bash "$dir/scripts/maintenance/bump-version.sh" "$@")
}

# Copy fragments in the given order so creation order (and mtimes) differ between copies.
add_fragments() {
  local dir="$1"; shift
  local f
  for f in "$@"; do cp "$FIXTURE/changelog.d/$f" "$dir/changelog.d/$f"; done
}

test_case "--dry-run prints the expected section and changes nothing"
B1=$(bump_repo bump-a)
add_fragments "$B1" 10-ten.md 9-nine.md 1277-new-thing.md 42-hole.md 300-flag.md
before=$(cd "$B1" && find . -path ./.git -prune -o -type f -print | LC_ALL=C sort | xargs cat | cksum)
bump "$B1" --dry-run --date 2026-10-12 1.1.0 > "$TMPDIR/dry-a.md"
if cmp -s "$FIXTURE/expected-block.md" "$TMPDIR/dry-a.md"; then _pass; else _fail "dry-run block differs: $(diff "$FIXTURE/expected-block.md" "$TMPDIR/dry-a.md" | head -10)"; fi
after=$(cd "$B1" && find . -path ./.git -prune -o -type f -print | LC_ALL=C sort | xargs cat | cksum)
assert_eq "$before" "$after" "dry-run leaves every file unchanged"

test_case "same inputs in a different creation order → byte-identical section"
B2=$(bump_repo bump-b)
add_fragments "$B2" 300-flag.md 42-hole.md 1277-new-thing.md 9-nine.md 10-ten.md
bump "$B2" --dry-run --date 2026-10-12 1.1.0 > "$TMPDIR/dry-b.md"
if cmp -s "$TMPDIR/dry-a.md" "$TMPDIR/dry-b.md"; then _pass; else _fail "two runs differ"; fi

test_case "the bump writes the section in place of Unreleased and deletes the fragments"
bump "$B1" --date 2026-10-12 1.1.0 >/dev/null
{ printf '# Changelog\n\nAll notable changes.\n\n'; cat "$FIXTURE/expected-block.md"; printf '## v1.0.0 — 2026-01-01\n\n### Added\n- **First release** (GH 1): hello.\n'; } > "$TMPDIR/expected-changelog.md"
if cmp -s "$TMPDIR/expected-changelog.md" "$B1/CHANGELOG.md"; then _pass; else _fail "CHANGELOG differs: $(diff "$TMPDIR/expected-changelog.md" "$B1/CHANGELOG.md" | head -10)"; fi
left=$(find "$B1/changelog.d" -name '*.md' | wc -l | tr -d ' ')
assert_eq 0 "$left" "fragments deleted"
assert_contains "$(cat "$B1/.claude-plugin/plugin.json")" '"version": "1.1.0"' "manifest bumped"

test_case "a malformed fragment refuses the bump and leaves every file unchanged"
B3=$(bump_repo bump-bad)
add_fragments "$B3" 9-nine.md
printf '### Tweaked\n- **Nope** (GH 77): nope.\n' > "$B3/changelog.d/77-nope.md"
before=$(cd "$B3" && find . -path ./.git -prune -o -type f -print | LC_ALL=C sort | xargs cat | cksum)
rc=0; bump "$B3" --date 2026-10-12 1.1.0 >/dev/null 2>"$TMPDIR/bad.err" || rc=$?
assert_eq 1 "$rc" "malformed → exit 1"
assert_contains "$(cat "$TMPDIR/bad.err")" "77-nope.md" "names the fragment"
after=$(cd "$B3" && find . -path ./.git -prune -o -type f -print | LC_ALL=C sort | xargs cat | cksum)
assert_eq "$before" "$after" "nothing changed"

summarize
