#!/usr/bin/env bash
# Shared rules for changelog.d/ fragments, sourced by bump-version.sh (assembly)
# and tests/l1-lint/changelog-current.sh (validation). Format: changelog.d/README.md.

TMB_FRAGMENT_SECTIONS="Added Changed Fixed Removed Security"

# Every fragment file under <dir>, sorted by GH issue number then name.
tmb_fragment_list() {
  local dir="$1" f
  [ -d "$dir" ] || return 0
  for f in "$dir"/*.md; do
    [ -f "$f" ] || continue
    [ "$(basename "$f")" = "README.md" ] && continue
    printf '%s\n' "$f"
  done | LC_ALL=C awk -F/ '{ n = $NF; sub(/-.*/, "", n); printf "%012d\t%s\n", n + 0, $0 }' \
       | LC_ALL=C sort | cut -f2-
}

tmb_fragment_issue() {
  local name
  name="$(basename "$1")"
  printf '%s\n' "${name%%-*}"
}

tmb_fragment_section() {
  head -n 1 "$1" | sed -E 's/^### //'
}

# Body: everything after the section line, leading and trailing blank lines dropped.
tmb_fragment_body() {
  tail -n +2 "$1" | awk '
    NF { started = 1 }
    started { lines[++n] = $0 }
    END { while (n > 0 && lines[n] ~ /^[[:space:]]*$/) n--; for (i = 1; i <= n; i++) print lines[i] }
  '
}

# Prints one line per problem; exit status 1 when the fragment is malformed.
tmb_fragment_validate() {
  local f="$1" name issue first body bad=0
  name="$(basename "$f")"
  if ! printf '%s' "$name" | grep -E '^[1-9][0-9]*-[a-z0-9]+(-[a-z0-9]+)*\.md$' >/dev/null; then
    printf '%s: filename must be <gh-issue>-<slug>.md (lowercase slug, hyphens)\n' "$f"
    return 1
  fi
  issue="$(tmb_fragment_issue "$f")"
  first="$(head -n 1 "$f")"
  if ! printf '%s' "$first" | grep -E "^### ($(printf '%s' "$TMB_FRAGMENT_SECTIONS" | tr ' ' '|'))$" >/dev/null; then
    printf '%s: first line must be one of: ### %s (got "%s")\n' "$f" "$(printf '%s' "$TMB_FRAGMENT_SECTIONS" | sed 's/ /, ### /g')" "$first"
    bad=1
  fi
  body="$(tmb_fragment_body "$f")"
  if [ -z "$body" ]; then
    printf '%s: no entry text after the section line\n' "$f"
    return 1
  fi
  if ! printf '%s\n' "$body" | head -n 1 | grep '^- ' >/dev/null; then
    printf '%s: the entry must start with "- " (one bullet)\n' "$f"
    bad=1
  fi
  if ! printf '%s\n' "$body" | grep -E "GH ${issue}([^0-9]|$)" >/dev/null; then
    printf '%s: the entry must cite GH %s\n' "$f" "$issue"
    bad=1
  fi
  if printf '%s\n' "$body" | grep -E '(^|[^&A-Za-z0-9])#[0-9]+' >/dev/null; then
    printf '%s: cite issues as "GH <n>", not "#<n>"\n' "$f"
    bad=1
  fi
  return "$bad"
}
