#!/usr/bin/env bash
# Tests for the tmb-regen merge driver (GH 1277): .gitattributes routes the
# generated artefacts to it, scripts/maintenance/install-merge-driver.sh puts it
# in the repo's .git/config, a merge where both sides changed dist/index.js
# completes with ours and no conflict markers, and
# scripts/maintenance/regen-generated.sh --check then reports the file stale.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
. "$HERE/../../lib/tmpdir-cleanup.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"

TMPDIR=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-merge-driver.XXXXXX")
trap 'tmpdir_cleanup "$TMPDIR"' EXIT
export GIT_OPTIONAL_LOCKS=0

# A copy of this checkout (tracked + untracked, not ignored) as a fresh repo.
REPO="$TMPDIR/repo"
mkdir -p "$REPO"
(cd "$PLUGIN_ROOT" && git ls-files -co --exclude-standard \
   | grep -v '^mcp/trajectory-server/node_modules' \
   | while IFS= read -r p; do [ -e "$p" ] && printf '%s\n' "$p"; done \
   | tar -cf - -T -) | tar -xf - -C "$REPO"
git -c gc.auto=0 init -q -b dev "$REPO"
git -C "$REPO" config gc.auto 0 && git -C "$REPO" config maintenance.auto false
git -C "$REPO" config user.email t@t.io && git -C "$REPO" config user.name t
git -C "$REPO" add -A && git -C "$REPO" commit -qm base
DIST="mcp/trajectory-server/dist/index.js"

# With the toolchain, regenerate once here and commit, so the bundle's baked
# dependency paths match this location and only the merge makes a file stale.
HAVE_TSC=0
REGEN_ENV=(env HOME="$TMPDIR/home" npm_config_cache="$TMPDIR/home/.npm")
if [ -x "$PLUGIN_ROOT/mcp/trajectory-server/node_modules/.bin/tsc" ]; then
  HAVE_TSC=1
  mkdir -p "$TMPDIR/home"
  ln -s "$PLUGIN_ROOT/mcp/trajectory-server/node_modules" "$REPO/mcp/trajectory-server/node_modules"
  printf 'mcp/trajectory-server/node_modules\n' >> "$REPO/.git/info/exclude"
  "${REGEN_ENV[@]}" bash "$REPO/scripts/maintenance/regen-generated.sh" >/dev/null
  git -C "$REPO" add -A && git -C "$REPO" commit -qm "regen at this location" --allow-empty
fi

git -C "$REPO" checkout -q -b side-a
printf '// side a\n' >> "$REPO/$DIST"
git -C "$REPO" commit -qam "a"
git -C "$REPO" checkout -q -b side-b dev
printf '// side b\n' >> "$REPO/$DIST"
git -C "$REPO" commit -qam "b"

test_case ".gitattributes routes the generated artefacts to tmb-regen"
for p in "$DIST" mcp/trajectory-server/dist/tools/index.js scripts/hooks/lib/audit-events.txt scripts/hooks/lib/data-contracts.json; do
  assert_contains "$(git -C "$REPO" check-attr merge -- "$p")" "merge: tmb-regen" "$p"
done
assert_contains "$(git -C "$REPO" check-attr merge -- docs/contributing/ENUMS.md)" "merge: unspecified" "ENUMS.md stays text-merged"

test_case "without the driver installed, both sides changing dist/index.js conflict"
git -C "$REPO" checkout -q -b control side-a
rc=0; git -C "$REPO" merge -q --no-edit side-b >/dev/null 2>&1 || rc=$?
if [ "$rc" -ne 0 ]; then _pass; else _fail "expected a conflict without the driver"; fi
git -C "$REPO" merge --abort 2>/dev/null || true

test_case "install-merge-driver.sh writes the driver into the repo's .git/config"
bash "$REPO/scripts/maintenance/install-merge-driver.sh" "$REPO" >/dev/null
assert_contains "$(git config -f "$REPO/.git/config" --get merge.tmb-regen.driver)" "regen-generated.sh" "driver in .git/config"
assert_eq "" "$(git config --global --get merge.tmb-regen.driver 2>/dev/null || true)" "nothing global"

test_case "with no argument, run from a worktree's copy outside any repo cwd, it targets the main checkout"
MAIN="$TMPDIR/main"
mkdir -p "$MAIN/scripts/maintenance" "$TMPDIR/outside"
cp "$PLUGIN_ROOT/scripts/maintenance/install-merge-driver.sh" "$MAIN/scripts/maintenance/"
git -c gc.auto=0 init -q -b dev "$MAIN"
git -C "$MAIN" config user.email t@t.io && git -C "$MAIN" config user.name t
git -C "$MAIN" add -A && git -C "$MAIN" commit -qm base
WT="$MAIN/.claude/worktrees/feature"
git -C "$MAIN" worktree add -q -b feature "$WT"
out=$(cd "$TMPDIR/outside" && bash "$WT/scripts/maintenance/install-merge-driver.sh")
assert_contains "$(git config -f "$MAIN/.git/config" --get merge.tmb-regen.driver)" "regen-generated.sh" "driver in the main checkout's common-dir config"
assert_contains "$out" "$(cd "$MAIN" && pwd -P)/.git/config" "reports the main checkout's config"
assert_eq "" "$(ls -A "$TMPDIR/outside")" "nothing written in the cwd"

test_case "with the driver, the merge completes with ours and no conflict markers"
git -C "$REPO" checkout -q side-a
rc=0; git -C "$REPO" merge --no-edit side-b >"$TMPDIR/merge.out" 2>&1 || rc=$?
assert_eq 0 "$rc" "merge exits 0"
if grep -q '^<<<<<<<\|^>>>>>>>' "$REPO/$DIST"; then _fail "conflict markers in $DIST"; else _pass; fi
assert_eq "// side a" "$(tail -n 1 "$REPO/$DIST")" "ours kept"
assert_contains "$(cat "$TMPDIR/merge.out")" "tmb-regen: kept ours for $DIST" "driver names the file"
assert_eq "" "$(git -C "$REPO" status --porcelain --untracked-files=no)" "merge committed cleanly"

test_case "regen-generated.sh --check reports the merged file stale; one regen makes it current"
if [ "$HAVE_TSC" -eq 0 ]; then
  echo "  ⊘ tsc not installed in mcp/trajectory-server — regen half skipped (run 'bun install' first)"
  _pass
else
  rc=0; "${REGEN_ENV[@]}" bash "$REPO/scripts/maintenance/regen-generated.sh" --check >/dev/null 2>"$TMPDIR/check.err" || rc=$?
  assert_eq 1 "$rc" "--check exits 1"
  stale=$(grep '^  ' "$TMPDIR/check.err" | sed 's/^  //')
  assert_eq "$DIST" "$stale" "exactly the merged file is stale"
  assert_eq "// side a" "$(tail -n 1 "$REPO/$DIST")" "--check leaves the checked-out file in place"
  "${REGEN_ENV[@]}" bash "$REPO/scripts/maintenance/regen-generated.sh" >/dev/null
  if grep -qx '// side a' "$REPO/$DIST"; then _fail "regen kept the hand edit"; else _pass; fi
  git -C "$REPO" commit -qam "regen after merge"
  rc=0; "${REGEN_ENV[@]}" bash "$REPO/scripts/maintenance/regen-generated.sh" --check >/dev/null 2>"$TMPDIR/check2.err" || rc=$?
  assert_eq 0 "$rc" "after one regen, --check is clean: $(head -5 "$TMPDIR/check2.err")"
fi

summarize
