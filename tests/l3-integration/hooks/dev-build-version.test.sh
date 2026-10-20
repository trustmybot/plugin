#!/usr/bin/env bash
# Tests for dev-build versions (GH 1604): scripts/maintenance/dev-build-version.sh
# derives X.Y.Z-dev.<n>[.gh<PR>] from the highest stable tag, and
# bump-version.sh --version-only stamps it into the five version files without
# touching CHANGELOG.md or changelog.d/.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
DEVVER="$PLUGIN_ROOT/scripts/maintenance/dev-build-version.sh"
BUMP="$PLUGIN_ROOT/scripts/maintenance/bump-version.sh"

TMPDIR=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-dev-build-version.XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT

g() { git -C "$REPO" "$@"; }

# As in the real repo, the release tag sits on a main merge commit that dev
# never contains. main: init (v1.0.0). dev: feat/1, feat/2 (--no-ff). main
# merges dev, tagged v1.1.0. dev: feat/3, feat/4 (--no-ff), tagged v1.2.0-rc.1;
# dev never merges main back, so v1.0.0 is the only stable tag dev reaches.
REPO="$TMPDIR/repo"
git init -q -b main "$REPO"
g config user.email t@t.io && g config user.name t
g config commit.gpgsign false && g config tag.gpgsign false
echo base > "$REPO/f.txt"
g add f.txt && g commit -qm "init"
g tag v1.0.0
g checkout -q -b dev
feature() {
  g checkout -q -b "feat/$1" dev
  echo "$1" >> "$REPO/f.txt"
  g commit -qam "feat $1"
  g checkout -q dev
  g merge -q --no-ff -m "merge feat/$1" "feat/$1"
}
feature 1
feature 2
g checkout -q main
g merge -q --no-ff -m "release 1.1.0" dev
g tag v1.1.0
g checkout -q dev
feature 3
feature 4
g tag v1.2.0-rc.1

devver() { (cd "$REPO" && bash "$DEVVER" "$@"); }
devver_rc() {
  local rc=0
  (cd "$REPO" && bash "$DEVVER" "$@") >/dev/null 2>&1 || rc=$?
  printf '%s\n' "$rc"
}

test_case "n counts dev's first-parent commits since the highest stable tag, which dev does not contain"
assert_eq 1 "$(g merge-base --is-ancestor v1.1.0 dev && echo 0 || echo 1)" "fixture: v1.1.0 not on dev"
assert_eq "1.2.0-dev.2.gh1594" "$(devver --next 1.2.0 --pr 1594)" "with --pr"

test_case "the rc tag is ignored"
assert_eq "1.1.1-dev.2" "$(devver --next 1.1.1)" "--next 1.1.1 is above v1.1.0, not v1.2.0-rc.1"

test_case "without --pr there is no gh suffix"
assert_eq "1.2.0-dev.2" "$(devver --next 1.2.0)" "without --pr"

test_case "--ref stamps an earlier commit"
assert_eq "1.2.0-dev.1" "$(devver --next 1.2.0 --ref dev~1)" "dev~1"

test_case "--next at or below the latest release exits 1"
assert_eq 1 "$(devver_rc --next 1.1.0)" "--next 1.1.0"
assert_eq 1 "$(devver_rc --next 1.0.9)" "--next 1.0.9"
assert_eq 1 "$(devver_rc --next 0.9.0)" "--next 0.9.0"

test_case "with no stable tag n counts every first-parent commit"
NOTAG="$TMPDIR/notag"
git init -q -b main "$NOTAG"
git -C "$NOTAG" -c user.email=t@t.io -c user.name=t -c commit.gpgsign=false commit -q --allow-empty -m one
git -C "$NOTAG" -c user.email=t@t.io -c user.name=t -c commit.gpgsign=false commit -q --allow-empty -m two
assert_eq "0.1.0-dev.2" "$( (cd "$NOTAG" && bash "$DEVVER" --next 0.1.0) )" "no tags"

test_case "bad --next and --pr exit 1"
assert_eq 1 "$(devver_rc --next 1.2)" "--next 1.2"
assert_eq 1 "$(devver_rc --next v1.2.0)" "--next v1.2.0"
assert_eq 1 "$(devver_rc --next 1.2.0-rc.1)" "--next prerelease"
assert_eq 1 "$(devver_rc --next 1.2.0 --pr abc)" "--pr abc"
assert_eq 1 "$(devver_rc --next 1.2.0 --pr '#12')" "--pr #12"
assert_eq 1 "$(devver_rc --pr 12)" "missing --next"

test_case "--version-only sets all five versions and leaves CHANGELOG.md and fragments alone"
B="$TMPDIR/bump"
VERSION_FILES=(.claude-plugin/plugin.json .codex-plugin/plugin.json package.json mcp/trajectory-server/package.json bun.lock)
mkdir -p "$B/scripts/maintenance/lib" "$B/changelog.d"
for f in "${VERSION_FILES[@]}"; do
  mkdir -p "$B/$(dirname "$f")"
  cp "$PLUGIN_ROOT/$f" "$B/$f"
done
cp "$BUMP" "$B/scripts/maintenance/"
cp "$PLUGIN_ROOT/scripts/maintenance/lib/changelog-fragments.sh" "$B/scripts/maintenance/lib/"
printf '# Changelog\n\n## Unreleased\n\n### Fixed\n- **Old** (GH 100): old.\n' > "$B/CHANGELOG.md"
printf '### Tweaked\n- **Not validated** (GH 77): a malformed fragment does not block a version-only bump.\n' > "$B/changelog.d/77-dummy.md"
cl_before=$(cksum < "$B/CHANGELOG.md")
frag_before=$(cksum < "$B/changelog.d/77-dummy.md")
rc=0; (cd "$TMPDIR" && bash "$B/scripts/maintenance/bump-version.sh" --version-only 1.2.0-dev.2.gh1594) >/dev/null 2>"$TMPDIR/bump.err" || rc=$?
assert_eq 0 "$rc" "exit 0 ($(cat "$TMPDIR/bump.err"))"
for f in "${VERSION_FILES[@]}"; do
  assert_contains "$(cat "$B/$f")" '"version": "1.2.0-dev.2.gh1594"' "$f bumped"
done
assert_eq "$cl_before" "$(cksum < "$B/CHANGELOG.md")" "CHANGELOG.md unchanged"
assert_eq "$frag_before" "$(cksum < "$B/changelog.d/77-dummy.md")" "fragment unchanged"

test_case "--version-only refuses --dry-run"
rc=0; (cd "$TMPDIR" && bash "$B/scripts/maintenance/bump-version.sh" --version-only --dry-run 1.2.0) >/dev/null 2>&1 || rc=$?
assert_eq 1 "$rc" "exit 1"

summarize
