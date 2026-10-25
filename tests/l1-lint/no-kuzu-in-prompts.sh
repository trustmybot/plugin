#!/usr/bin/env bash
# Catch "kuzu" (any case) in shipped prompt files. The world model moved from a
# kuzu graph to directory/file tables in the trajectory DB, so a prompt naming
# kuzu describes a store that no longer exists.
#
# Scans: CLAUDE.md, agents/ and commands/ (depth 1), every *.md under skills/.
#
# Allowlist: tests/l1-lint/no-kuzu-in-prompts.allowlist —
# <path><TAB><substring of the line><TAB><reason>. An entry with no reason or
# matching no hit fails.
#
# --self-test scans fixtures/kuzu-in-prompts/: every non-blank line of
# has-kuzu.md is a hit, clean.md has none, and allowlist.tsv suppresses exactly
# its one entry.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1
ALLOWLIST="tests/l1-lint/no-kuzu-in-prompts.allowlist"
FIXTURES="tests/l1-lint/fixtures/kuzu-in-prompts"

# scan <allowlist> <file>... — prints file:line per hit; exits 1 on any hit or
# a malformed or stale allowlist entry.
scan() {
  local allowlist="$1"
  shift
  local -a a_path=() a_sub=() a_used=()
  local bad=0 n=0 line path sub reason f lineno text i hit
  if [ -f "$allowlist" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      n=$((n + 1))
      case "$line" in '' | '#'*) continue ;; esac
      IFS=$'\t' read -r path sub reason <<<"$line"
      if [ -z "${sub:-}" ] || [ -z "${reason:-}" ]; then
        printf 'ALLOWLIST %s:%s: needs <path><TAB><substring><TAB><reason>\n' "$allowlist" "$n"
        bad=1
        continue
      fi
      a_path+=("$path")
      a_sub+=("$sub")
      a_used+=(0)
    done <"$allowlist"
  fi
  for f in "$@"; do
    [ -f "$f" ] || continue
    while IFS=: read -r lineno text; do
      [ -z "$lineno" ] && continue
      hit=0
      for i in "${!a_path[@]}"; do
        if [ "${a_path[$i]}" = "$f" ] && [[ "$text" == *"${a_sub[$i]}"* ]]; then
          a_used[i]=1
          hit=1
          break
        fi
      done
      [ "$hit" -eq 1 ] && continue
      printf '%s:%s: %s\n' "$f" "$lineno" "$text"
      bad=1
    done < <(grep -niF kuzu "$f" || true)
  done
  for i in "${!a_path[@]}"; do
    if [ "${a_used[$i]}" -eq 0 ]; then
      printf 'ALLOWLIST %s: stale entry (no hit): %s\t%s\n' "$allowlist" "${a_path[$i]}" "${a_sub[$i]}"
      bad=1
    fi
  done
  return "$bad"
}

if [ "${1:-}" = "--self-test" ]; then
  fail=0
  bad_file="$FIXTURES/has-kuzu.md"
  expected=$(grep -c . "$bad_file")
  out=$(scan /dev/null "$bad_file")
  got=$(printf '%s\n' "$out" | grep -c "^$bad_file:")
  [ "$got" = "$expected" ] || {
    printf 'no-kuzu-in-prompts self-test: expected %s hits in has-kuzu.md, got:\n%s\n' "$expected" "$out" >&2
    fail=1
  }
  out=$(scan /dev/null "$FIXTURES/clean.md") || {
    printf 'no-kuzu-in-prompts self-test: false positives in clean.md:\n%s\n' "$out" >&2
    fail=1
  }
  out=$(scan "$FIXTURES/allowlist.tsv" "$bad_file")
  got=$(printf '%s\n' "$out" | grep -c "^$bad_file:")
  if [ "$got" != "$((expected - 1))" ] || printf '%s\n' "$out" | grep '^ALLOWLIST' >/dev/null; then
    printf 'no-kuzu-in-prompts self-test: allowlist.tsv should suppress exactly one hit, got:\n%s\n' "$out" >&2
    fail=1
  fi
  [ "$fail" -eq 0 ] && echo "No-kuzu-in-prompts self-test: PASS"
  exit "$fail"
fi

FILES=()
[ -f CLAUDE.md ] && FILES+=(CLAUDE.md)
while IFS= read -r f; do FILES+=("$f"); done < <(
  find agents commands -maxdepth 1 -type f -name '*.md' 2>/dev/null | sort
  find skills -type f -name '*.md' 2>/dev/null | sort
)

OUT=$(scan "$ALLOWLIST" "${FILES[@]}")
status=$?

if [ "$status" -ne 0 ]; then
  printf 'No-kuzu-in-prompts: FAIL — prompts name kuzu; the world model is directory/file tables in the trajectory DB, built by /scan:\n%s\n' "$OUT" >&2
  exit 1
fi
printf 'No-kuzu-in-prompts: PASS (%d files)\n' "${#FILES[@]}"
