#!/usr/bin/env bash
# Lint: structural safety checks on the release scripts.
#
# scripts/release.sh — protects against the "force-push a published tag"
# antipattern: the release script must contain the explicit "Refusing to
# re-tag a PUBLISHED release" guard.
#
# scripts/publish-rc-channel.sh — protects the sanctioned rc-channel publish:
# it must refuse non-rc versions, verify the tag on origin, operate on a temp
# clone (never a hardcoded local catalog path), and clean up via trap.
#
# This test catches accidental removal of these guards during refactors.
#
# This is a lint, not a behavior test, because driving the scripts
# end-to-end requires a real repo + real remote. The behavior is small
# enough that grep'ing for the guard text + the underlying mechanism
# (`git ls-remote --tags`) is sufficient evidence.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/release.sh"
RC_SCRIPT="$ROOT/scripts/publish-rc-channel.sh"

failed=0
fail() { echo "  ✗ $1" >&2; failed=1; }
pass() { echo "  ✓ $1"; }

if [ ! -f "$SCRIPT" ]; then
  fail "scripts/release.sh missing"
  echo "Release-script-safety: FAIL" >&2
  exit 1
fi

# G1: must check the remote before considering retag
if grep -q 'git ls-remote --tags origin "refs/tags/\$NEW_TAG"' "$SCRIPT"; then
  pass "checks remote for the tag before allowing any retag"
else
  fail "missing remote-tag check (git ls-remote --tags origin refs/tags/\$NEW_TAG)"
fi

# G2: must contain the explicit refusal message
if grep -q 'Refusing to re-tag a PUBLISHED release' "$SCRIPT"; then
  pass "contains explicit refusal message for published-tag retag"
else
  fail "missing 'Refusing to re-tag a PUBLISHED release' guard"
fi

# G3: must exit non-zero on the published-retag path (so it actually blocks).
# Look for `exit 1` (any indentation) within ~30 lines after the refusal message.
if awk '
  /Refusing to re-tag a PUBLISHED release/ { found=1; line=NR }
  found && /^[[:space:]]*exit 1[[:space:]]*$/ && NR-line<=30 { print "ok"; exit }
' "$SCRIPT" | grep -q ok; then
  pass "exits non-zero on published-retag refusal path"
else
  fail "no 'exit 1' within 30 lines of the refusal message — guard would be advisory only"
fi

# G4: must mention the doctrinal alternative (bump version, ship new tag)
if grep -q "ship a NEW version with the fix" "$SCRIPT"; then
  pass "documents the doctrinal alternative (bump version)"
else
  fail "missing doctrinal alternative — refusal should explain what to do instead"
fi

# G5: must NOT push to origin a deleted tag in the local-only retag path
# (an earlier version did `git push origin :refs/tags/$NEW_TAG` even for
# local-only tags, which would silently delete the remote tag if it existed)
if awk '/Local-only/{found=1} found && /git push.*:refs\/tags/ {print "BAD"; exit}' "$SCRIPT" | grep -q BAD; then
  fail "local-only retag path still tries to push tag deletion to origin (would corrupt remote)"
else
  pass "local-only retag path doesn't push tag deletion to origin"
fi

# ---------- scripts/publish-rc-channel.sh ----------

if [ ! -f "$RC_SCRIPT" ]; then
  fail "scripts/publish-rc-channel.sh missing"
  echo "Release-script-safety: FAIL" >&2
  exit 1
fi

# R1: strict bash mode
if grep -q 'set -euo pipefail' "$RC_SCRIPT"; then
  pass "publish-rc-channel: uses set -euo pipefail"
else
  fail "publish-rc-channel: missing 'set -euo pipefail'"
fi

# R2: rc-version guard — the refusal regex must be present
if grep -qF 'rc\.[0-9]+$' "$RC_SCRIPT"; then
  pass "publish-rc-channel: enforces the rc-version regex"
else
  fail "publish-rc-channel: missing rc-version guard (X.Y.Z-rc.N regex)"
fi

# R3: tag-existence check on origin (must be pushed before publishing)
if grep -q 'git ls-remote --tags' "$RC_SCRIPT"; then
  pass "publish-rc-channel: verifies the tag exists on origin"
else
  fail "publish-rc-channel: missing tag-existence check (git ls-remote --tags)"
fi

# R4: operates on a temp clone, never a hardcoded local catalog path
if grep -q 'mktemp -d' "$RC_SCRIPT"; then
  pass "publish-rc-channel: clones into a temp dir (mktemp -d)"
else
  fail "publish-rc-channel: no 'mktemp -d' — must use a temp clone, not a hardcoded path"
fi

# R5: trap-based cleanup of the temp clone
if grep -Eq "trap .*rm -rf" "$RC_SCRIPT"; then
  pass "publish-rc-channel: cleans up the temp clone via trap"
else
  fail "publish-rc-channel: missing 'trap ... rm -rf' cleanup of the temp clone"
fi

echo ""
if [ $failed -ne 0 ]; then
  echo "Release-script-safety: FAIL" >&2
  exit 1
fi
echo "Release-script-safety: PASS"
