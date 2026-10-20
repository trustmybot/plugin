#!/usr/bin/env bash
# Tests for dev-build versions (GH 1604): scripts/maintenance/dev-build-version.sh
# derives X.Y.Z-dev.<n>[.gh<PR>] from the last stable tag, and
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

# main: v1.1.0. dev: two --no-ff merges, the second tagged v1.2.0-rc.1.
REPO="$TMPDIR/repo"
git init -q -b main "$REPO"
g config user.email t@t.io && g config user.name t
g config commit.gpgsign false && g config tag.gpgsign false
echo base > "$REPO/f.txt"
g add f.txt && g commit -qm "init"
g tag v1.1.0
g checkout -q -b dev
for i in 1 2; do
  g checkout -q -b "feat/$i" dev
  echo "$i" >> "$REPO/f.txt"
  g commit -qam "feat $i"
  g checkout -q dev
  g merge -q --no-ff -m "merge feat/$i" "feat/$i"
done
g tag v1.2.0-rc.1

devver() { (cd "$REPO" && bash "$DEVVER" "$@"); }
devver_rc() {
  local rc=0
  (cd "$REPO" && bash "$DEVVER" "$@") >/dev/null 2>&1 || rc=$?
  printf '%s\n' "$rc"
}

test_case "n counts first-parent commits since the last stable tag; the rc tag is ignored"
assert_eq "1.2.0-dev.2.gh1594" "$(devver --next 1.2.0 --pr 1594)" "with --pr"

test_case "without --pr there is no gh suffix"
assert_eq "1.2.0-dev.2" "$(devver --next 1.2.0)" "without --pr"

test_case "--ref stamps an earlier commit"
assert_eq "1.2.0-dev.1" "$(devver --next 1.2.0 --ref dev~1)" "dev~1"

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
