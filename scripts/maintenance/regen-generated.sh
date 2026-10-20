#!/usr/bin/env bash
# Rebuilds every generated artefact from its sources, in dependency order:
#   1. npm run build (mcp/trajectory-server)  → dist/**, scripts/hooks/lib/audit-events.txt
#   2. gen-enums-doc.mjs --doc                → the generated section of docs/contributing/ENUMS.md
#   3. emit-data-contracts.mjs                → scripts/hooks/lib/data-contracts.json
#   4. gen-erd-doc.mjs, gen-config-keys-doc.mjs (when present)
#
# Usage: bash scripts/maintenance/regen-generated.sh [--check]
#
# Run it after a merge or rebase the tmb-regen merge driver resolved (it keeps
# ours for the generated files), then commit what changed.
# --check rebuilds, lists every file whose regenerated content differs from the
# checked-out one (the committed one on a clean tree), puts the checked-out
# content back and exits 1 when any differ.
# Exit 2: usage error or the build toolchain is missing (run `bun install` in
# mcp/trajectory-server).

set -euo pipefail

CHECK=0
case "${1:-}" in
  "") ;;
  --check) CHECK=1 ;;
  *) echo "Usage: $0 [--check]" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
SERVER="$ROOT/mcp/trajectory-server"

if [ ! -x "$SERVER/node_modules/.bin/tsc" ] || [ ! -x "$SERVER/node_modules/.bin/esbuild" ]; then
  echo "regen-generated: tsc/esbuild not installed in mcp/trajectory-server — run 'bun install' there first" >&2
  exit 2
fi

LOG="$(_t=${TMPDIR:-/tmp}; mktemp "${_t%/}/tmb-regen-XXXXXX")"
UNTRACKED_BEFORE="$(_t=${TMPDIR:-/tmp}; mktemp "${_t%/}/tmb-regen-untracked-XXXXXX")"
git ls-files --others --exclude-standard | LC_ALL=C sort > "$UNTRACKED_BEFORE"
BASELINE="$(git stash create 2>/dev/null || true)"
[ -n "$BASELINE" ] || BASELINE="$(git rev-parse HEAD)"

changed_paths() {
  {
    git diff --name-only "$BASELINE"
    git ls-files --others --exclude-standard | LC_ALL=C sort | LC_ALL=C comm -13 "$UNTRACKED_BEFORE" -
  } | LC_ALL=C sort -u
}

restore() {
  local tracked new
  tracked="$(git diff --name-only "$BASELINE")"
  new="$(git ls-files --others --exclude-standard | LC_ALL=C sort | LC_ALL=C comm -13 "$UNTRACKED_BEFORE" -)"
  if [ -n "$tracked" ]; then
    printf '%s\n' "$tracked" | git restore --source="$BASELINE" --worktree --pathspec-from-file=- 2>/dev/null \
      || echo "regen-generated: could not restore the checked-out files — inspect 'git status'" >&2
  fi
  if [ -n "$new" ]; then
    printf '%s\n' "$new" | while IFS= read -r p; do rm -f -- "$p"; done
  fi
}

cleanup() {
  [ "$CHECK" -eq 1 ] && restore
  rm -f "$LOG" "$UNTRACKED_BEFORE"
}
trap cleanup EXIT

run() {
  local label="$1"; shift
  if ! "$@" >>"$LOG" 2>&1; then
    echo "regen-generated: $label failed:" >&2
    tail -n 40 "$LOG" >&2
    exit 1
  fi
  [ "$CHECK" -eq 1 ] || echo "  ✓ $label"
}

build() { (cd "$SERVER" && npm run build); }
run "npm run build"          build
run "gen-enums-doc.mjs --doc" node scripts/maintenance/gen-enums-doc.mjs --doc
run "emit-data-contracts.mjs" node scripts/maintenance/emit-data-contracts.mjs
for gen in gen-erd-doc.mjs gen-config-keys-doc.mjs; do
  [ -f "scripts/maintenance/$gen" ] && run "$gen" node "scripts/maintenance/$gen"
done

STALE="$(changed_paths)"
if [ "$CHECK" -eq 1 ]; then
  if [ -n "$STALE" ]; then
    echo "regen-generated: stale generated file(s) — run: bash scripts/maintenance/regen-generated.sh" >&2
    printf '%s\n' "$STALE" | sed 's/^/  /' >&2
    exit 1
  fi
  echo "regen-generated: every generated file is current"
  exit 0
fi

if [ -n "$STALE" ]; then
  echo "regen-generated: regenerated — review and commit:"
  printf '%s\n' "$STALE" | sed 's/^/  /'
else
  echo "regen-generated: nothing changed"
fi
