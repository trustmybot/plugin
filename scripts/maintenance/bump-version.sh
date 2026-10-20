#!/usr/bin/env bash
# Atomic plugin-version bump. Updates the five files that must stay in sync,
# assembles changelog.d/ fragments into the release's CHANGELOG section, or
# fails leaving every file unchanged. Idempotent — re-running with the same
# version and no fragments is a no-op.
#
# Usage:
#   bash scripts/maintenance/bump-version.sh [--dry-run] [--date YYYY-MM-DD] <new-version>
#
#   --dry-run   print the CHANGELOG section the release would get; change nothing
#   --date      release date in the section header (default: today, UTC)
#
# Operates on the checkout holding this script, whatever the cwd.
#
# Touches:
#   1. .claude-plugin/plugin.json                         "version"
#   2. .codex-plugin/plugin.json                          "version"
#   3. package.json                                       "version"
#   4. mcp/trajectory-server/package.json                 "version"
#   5. bun.lock                                           workspace "version"
#   6. CHANGELOG.md   `## Unreleased` (if any) + changelog.d/*.md → `## v<new-version> — <date>`
#   7. changelog.d/*.md (except README.md)                deleted once assembled
#
# Section order is Added, Changed, Fixed, Removed, Security, then any other
# heading the Unreleased block carries. Within a section the Unreleased entries
# come first, then fragments sorted by GH issue number. Same inputs → the same
# bytes. A malformed fragment (changelog.d/README.md) refuses the whole bump.
#
# mcp/trajectory-server/src/index.ts derives the version from package.json
# at runtime (readFileSync → packageVersion) and is not touched.

set -euo pipefail

DRY_RUN=0
RELEASE_DATE=""
NEW_VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --date) RELEASE_DATE="${2:-}"; shift 2 || { echo "Error: --date needs a value" >&2; exit 1; } ;;
    -*) echo "Usage: $0 [--dry-run] [--date YYYY-MM-DD] <new-version>" >&2; exit 1 ;;
    *) [ -z "$NEW_VERSION" ] || { echo "Usage: $0 [--dry-run] [--date YYYY-MM-DD] <new-version>" >&2; exit 1; }
       NEW_VERSION="$1"; shift ;;
  esac
done

if [ -z "$NEW_VERSION" ]; then
  echo "Usage: $0 [--dry-run] [--date YYYY-MM-DD] <new-version>" >&2
  exit 1
fi

SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
if ! [[ "$NEW_VERSION" =~ $SEMVER_RE ]]; then
  echo "Error: '$NEW_VERSION' is not valid SemVer (X.Y.Z or X.Y.Z-pre)" >&2
  exit 1
fi
[ -n "$RELEASE_DATE" ] || RELEASE_DATE="$(date -u +%Y-%m-%d)"
if ! [[ "$RELEASE_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "Error: --date '$RELEASE_DATE' is not YYYY-MM-DD" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/maintenance/lib/changelog-fragments.sh
. "$SCRIPT_DIR/lib/changelog-fragments.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmb-bump-version.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

# ---- CHANGELOG assembly ------------------------------------------------------

FRAGMENTS=()
while IFS= read -r f; do FRAGMENTS+=("$f"); done < <(tmb_fragment_list changelog.d)

malformed=0
for f in ${FRAGMENTS[@]+"${FRAGMENTS[@]}"}; do
  tmb_fragment_validate "$f" >&2 || malformed=1
done
if [ "$malformed" -ne 0 ]; then
  echo "Error: malformed changelog.d/ fragment(s) above — fix them (changelog.d/README.md); nothing was changed" >&2
  exit 1
fi

[ -f CHANGELOG.md ] || { echo "Error: missing CHANGELOG.md" >&2; exit 1; }

# Split the Unreleased block into a preamble and one file per section heading.
SEC_DIR="$TMP_DIR/sections"
mkdir -p "$SEC_DIR"
: > "$SEC_DIR/.order"
: > "$SEC_DIR/.preamble"
awk -v dir="$SEC_DIR" '
  /^## / { inblock = ($0 ~ /^## Unreleased[[:space:]]*$/); next }
  !inblock { next }
  /^### / {
    name = substr($0, 5); sub(/[[:space:]]+$/, "", name)
    out = dir "/" name ".unreleased"
    if (!(name in seen)) { seen[name] = 1; print name >> (dir "/.order") }
    next
  }
  { print >> (out == "" ? dir "/.preamble" : out) }
' CHANGELOG.md

for f in ${FRAGMENTS[@]+"${FRAGMENTS[@]}"}; do
  tmb_fragment_body "$f" >> "$SEC_DIR/$(tmb_fragment_section "$f").fragments"
done

trim_blank() {
  awk 'NF { started = 1 } started { lines[++n] = $0 }
       END { while (n > 0 && lines[n] ~ /^[[:space:]]*$/) n--; for (i = 1; i <= n; i++) print lines[i] }' "$@"
}

ORDER="$TMP_DIR/order"
for s in $TMB_FRAGMENT_SECTIONS; do printf '%s\n' "$s"; done > "$ORDER"
while IFS= read -r s; do
  grep -qxF -- "$s" "$ORDER" || printf '%s\n' "$s" >> "$ORDER"
done < "$SEC_DIR/.order"

BLOCK_BODY="$TMP_DIR/block-body"
: > "$BLOCK_BODY"
preamble="$(trim_blank "$SEC_DIR/.preamble")"
[ -z "$preamble" ] || printf '%s\n\n' "$preamble" >> "$BLOCK_BODY"
while IFS= read -r s; do
  entries=""
  [ -f "$SEC_DIR/$s.unreleased" ] && entries="$(trim_blank "$SEC_DIR/$s.unreleased")"
  if [ -f "$SEC_DIR/$s.fragments" ]; then
    frag="$(cat "$SEC_DIR/$s.fragments")"
    entries="${entries:+$entries
}$frag"
  fi
  [ -n "$entries" ] || continue
  printf '### %s\n%s\n\n' "$s" "$entries" >> "$BLOCK_BODY"
done < "$ORDER"

BLOCK="$TMP_DIR/block"
HAVE_CHANGELOG_WORK=0
if [ -s "$BLOCK_BODY" ]; then
  HAVE_CHANGELOG_WORK=1
  { printf '## v%s — %s\n\n' "$NEW_VERSION" "$RELEASE_DATE"; cat "$BLOCK_BODY"; } > "$BLOCK"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  if [ "$HAVE_CHANGELOG_WORK" -eq 1 ]; then
    cat "$BLOCK"
  else
    echo "Nothing to assemble: no changelog.d/ fragments and no Unreleased entries." >&2
  fi
  exit 0
fi

if [ "$HAVE_CHANGELOG_WORK" -eq 1 ]; then
  if grep -q "^## v${NEW_VERSION} " CHANGELOG.md; then
    echo "Error: CHANGELOG.md already has a '## v${NEW_VERSION}' section; refusing to add a second one" >&2
    exit 1
  fi
  awk -v block="$BLOCK" '
    function emit() { while ((getline l < block) > 0) print l; close(block); done = 1 }
    /^## Unreleased[[:space:]]*$/ && !done { emit(); skip = 1; next }
    /^## / { skip = 0; if (!done) emit() }
    !skip { print }
    END { if (!done) { print ""; emit() } }
  ' CHANGELOG.md > "$TMP_DIR/CHANGELOG.md"
fi

# ---- manifests ---------------------------------------------------------------

FILES=(
  ".claude-plugin/plugin.json"
  ".codex-plugin/plugin.json"
  "package.json"
  "mcp/trajectory-server/package.json"
  "bun.lock"
)

for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "Error: missing $f" >&2; exit 1; }
done

# Read current version from plugin.json as the source of truth.
# BSD sed (macOS) does not support `\s`; use [[:space:]] for portability.
CURRENT="$(grep -E '"version"[[:space:]]*:[[:space:]]*"' .claude-plugin/plugin.json | head -1 | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
if [ -z "$CURRENT" ]; then
  echo "Error: could not read current version from .claude-plugin/plugin.json" >&2
  exit 1
fi

if [ "$CURRENT" = "$NEW_VERSION" ] && [ "$HAVE_CHANGELOG_WORK" -eq 0 ]; then
  echo "Already at $NEW_VERSION — no changes needed."
  exit 0
fi

bump_json() {
  local src="$1" dst="$2"
  # Occurrence guard: exactly one version field must carry the current version.
  # A dependency line could coincidentally share the version string, so abort
  # on zero or multiple candidate lines — leaving every file untouched.
  local candidates
  candidates="$(grep -Ec "\"version\"[[:space:]]*:[[:space:]]*\"$CURRENT\"" "$src" || true)"
  if [ "$candidates" -ne 1 ]; then
    echo "Error: failed to bump $src — expected exactly one \"version\": \"$CURRENT\" line, found $candidates" >&2
    return 1
  fi
  # Match: "version": "X.Y.Z[-pre]" — only the version field; leading
  # indentation precedes the match and is preserved (bun.lock nests deeper).
  sed -E "s/\"version\"[[:space:]]*:[[:space:]]*\"$CURRENT\"/\"version\": \"$NEW_VERSION\"/" "$src" > "$dst"
  if ! grep -q "\"version\": \"$NEW_VERSION\"" "$dst"; then
    echo "Error: failed to bump $src — no version line matched" >&2
    return 1
  fi
}

if [ "$CURRENT" != "$NEW_VERSION" ]; then
  bump_json    .claude-plugin/plugin.json                "$TMP_DIR/plugin.json"
  bump_json    .codex-plugin/plugin.json                 "$TMP_DIR/codex-plugin.json"
  bump_json    package.json                              "$TMP_DIR/root-package.json"
  bump_json    mcp/trajectory-server/package.json        "$TMP_DIR/trajectory-package.json"
  bump_json    bun.lock                                  "$TMP_DIR/bun.lock"
fi

# All edits staged successfully — commit them.
if [ "$CURRENT" != "$NEW_VERSION" ]; then
  mv "$TMP_DIR/plugin.json"             .claude-plugin/plugin.json
  mv "$TMP_DIR/codex-plugin.json"       .codex-plugin/plugin.json
  mv "$TMP_DIR/root-package.json"       package.json
  mv "$TMP_DIR/trajectory-package.json" mcp/trajectory-server/package.json
  mv "$TMP_DIR/bun.lock"                bun.lock
  echo "Bumped $CURRENT → $NEW_VERSION across 5 files."
fi
if [ "$HAVE_CHANGELOG_WORK" -eq 1 ]; then
  mv "$TMP_DIR/CHANGELOG.md" CHANGELOG.md
  for f in ${FRAGMENTS[@]+"${FRAGMENTS[@]}"}; do rm -f "$f"; done
  echo "Assembled ${#FRAGMENTS[@]} changelog.d/ fragment(s) into '## v$NEW_VERSION — $RELEASE_DATE'."
fi
echo "Next: rebuild MCP server, run tests, commit."
