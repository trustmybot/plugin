#!/usr/bin/env bash
# Fail when a tracked file names the reviewer by its pre-GH-1641 name
# (pr-reviewer / pr_reviewer, any case) outside an explicit allowlist. The
# reviewer is code-reviewer with no alias; the old name survives only in the
# v51 migration, its tests and schema fixtures, the rejection tests, a research
# question about the rename, and history (changelog, upgrade notes). It also
# checks that the UPGRADE.md
# schema v51 bullet names the audit.content_json rewrite.
#
# Allowlist: tests/l1-lint/legacy-reviewer-name.allowlist —
# <path><TAB><reason>. A path ending in / covers every file under it. An entry
# with no reason, or one that matches no hit, fails, so the list shrinks as the
# old name goes away.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1
ALLOWLIST="tests/l1-lint/legacy-reviewer-name.allowlist"

declare -a a_path=() a_used=()
bad=0
n=0
while IFS= read -r line || [ -n "$line" ]; do
  n=$((n + 1))
  case "$line" in '' | '#'*) continue ;; esac
  IFS=$'\t' read -r path reason <<<"$line"
  if [ -z "${path:-}" ] || [ -z "${reason:-}" ]; then
    printf 'ALLOWLIST %s:%s: needs <path><TAB><reason>\n' "$ALLOWLIST" "$n"
    bad=1
    continue
  fi
  a_path+=("$path")
  a_used+=(0)
done <"$ALLOWLIST"

allowed() {
  local file="$1" i entry
  for i in "${!a_path[@]}"; do
    entry="${a_path[$i]}"
    case "$entry" in
      */) [ "${file#"$entry"}" != "$file" ] || continue ;;
      *) [ "$file" = "$entry" ] || continue ;;
    esac
    a_used[i]=1
    return 0
  done
  return 1
}

while IFS= read -r file; do
  [ -n "$file" ] || continue
  allowed "$file" && continue
  printf 'legacy reviewer name in %s:\n' "$file"
  git grep -in 'pr-reviewer\|pr_reviewer' -- "$file" | head -5 | sed 's/^/  /'
  bad=1
done < <(git grep -il 'pr-reviewer\|pr_reviewer')

for i in "${!a_path[@]}"; do
  if [ "${a_used[$i]}" -eq 0 ]; then
    printf 'STALE allowlist entry (no file still names pr-reviewer): %s\n' "${a_path[$i]}"
    bad=1
  fi
done

UPGRADE="docs/reference/UPGRADE.md"
if grep -qF "audit rows are untouched" "$UPGRADE" ||
  ! grep -E '^- [^*].*schema v51' "$UPGRADE" | grep -F content_json >/dev/null; then
  printf '%s: the schema v51 migration-list bullet must name the audit.content_json rewrite and not say audit rows are untouched (F182-1)\n' "$UPGRADE"
  bad=1
fi

if [ "$bad" -ne 0 ]; then
  printf '\nThe reviewer is code-reviewer (GH 1641). Rename the reference, or allowlist the file in %s with a reason.\n' "$ALLOWLIST"
  exit 1
fi
echo "legacy-reviewer-name: OK"
