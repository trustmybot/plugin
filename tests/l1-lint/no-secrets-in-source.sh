#!/usr/bin/env bash
# L1 lint: scan tracked source for high-confidence secret patterns.
#
# Scans: git ls-files output, excluding tests/fixtures/** and docs/**
#
# Patterns (high-precision; false-positive-averse):
#   1. AWS access key IDs          AKIA[0-9A-Z]{16}
#   2. GitHub personal tokens      ghp_[A-Za-z0-9]{36}
#   3. GitHub fine-grained PATs    github_pat_[A-Za-z0-9_]{22,}
#   4. PEM private key headers     -----BEGIN [A-Z ]*PRIVATE KEY-----
#   5. Generic secret assignments  key/secret/token/password/api_key = '...' or "..." (>=20 chars)
#
# Placeholders excluded from pattern 5: xxx, example, dummy, <...>, ${...}, 0000
#
# Allowlist: tests/l1-lint/.no-secrets-allow
#   Format: path:line-pattern (one entry per line; # = comment)
#   A finding is suppressed when its "file:line: matched-text" output contains
#   both the path portion and the pattern portion of the allowlist entry.
#
# --self-test: seed temp files with one instance of each pattern class,
#   assert all are caught, then confirm the live tree passes.
#
# Exit 0 on pass; exit 1 with file:line listing on fail.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
ALLOWLIST="$HERE/.no-secrets-allow"

# ---------------------------------------------------------------------------
# Pattern definitions (POSIX ERE, macOS grep -E compatible — no \p or \d)
# Note: grep receives these via -e to avoid leading-dash parsing issues.
# ---------------------------------------------------------------------------

P_AWS='AKIA[0-9A-Z]{16}'
P_GHP='ghp_[A-Za-z0-9]{36}'
P_PAT='github_pat_[A-Za-z0-9_]{22,}'
P_PRIVKEY='-----BEGIN [A-Z ]*PRIVATE KEY-----'
# Generic: key/secret/token/password/api_key followed by = or : and a quoted literal >= 20 chars
P_GENERIC='(k(ey)?|secret|token|passw(or)?d|api_key)[[:space:]]*[:=][[:space:]]*['"'"'"][A-Za-z0-9+/_-]{20,}['"'"'"]'
# Placeholder patterns — any match containing these is excluded from P_GENERIC hits
P_PLACEHOLDER='(xxx|example|dummy|<[^>]*>|\$\{[^}]*\}|0000)'

# grep_secret: run grep with all patterns via separate -e flags to avoid
# issues when a pattern starts with '-' (e.g. the PEM header).
grep_secret() {
  grep -oE \
    -e "$P_AWS" \
    -e "$P_GHP" \
    -e "$P_PAT" \
    -e "$P_PRIVKEY" \
    -e "$P_GENERIC" \
    "$@" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Allowlist helper
# ---------------------------------------------------------------------------

is_allowlisted() {
  local finding="$1"
  [ -f "$ALLOWLIST" ] || return 1
  while IFS= read -r entry; do
    case "$entry" in '#'*|'') continue ;; esac
    local path_part line_part
    path_part="${entry%%:*}"
    line_part="${entry#*:}"
    if echo "$finding" | grep -qF "$path_part" && echo "$finding" | grep -qF "$line_part"; then
      return 0
    fi
  done < "$ALLOWLIST"
  return 1
}

# ---------------------------------------------------------------------------
# Self-test mode
# ---------------------------------------------------------------------------

run_self_test() {
  local tmpdir
  tmpdir=$(mktemp -d -t tmb-no-secrets-XXXX)
  trap 'rm -rf "$tmpdir"' EXIT

  local fail=0

  # Seed one file per pattern class
  printf 'AWS_KEY=AKIAIOSFODNN7EXAMPLE\n'                    > "$tmpdir/aws.sh"
  printf 'token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg123\n' > "$tmpdir/ghp.sh"
  printf 'pat=github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1\n'      > "$tmpdir/pat.sh"
  printf '%s\n' '-----BEGIN RSA PRIVATE KEY-----'             > "$tmpdir/privkey.pem"
  printf 'api_key = "abcdefghijklmnopqrstuvwxyz12345"\n'     > "$tmpdir/generic.sh"

  # A placeholder that must NOT be caught (too short + placeholder word)
  printf 'secret = "example"\n' > "$tmpdir/placeholder.sh"

  check_caught() {
    local file="$1" label="$2"
    local result
    result=$(grep_secret "$file")
    if [ -z "$result" ]; then
      printf 'FAIL self-test: pattern class [%s] not caught\n' "$label" >&2
      fail=1
    else
      printf 'PASS self-test: pattern class [%s] caught\n' "$label"
    fi
  }

  check_caught "$tmpdir/aws.sh"      "AWS access key"
  check_caught "$tmpdir/ghp.sh"      "GitHub ghp_ token"
  check_caught "$tmpdir/pat.sh"      "GitHub fine-grained PAT"
  check_caught "$tmpdir/privkey.pem" "PEM private key header"
  check_caught "$tmpdir/generic.sh"  "generic secret assignment"

  # Placeholder must NOT produce a non-placeholder match
  placeholder_hit=$(grep_secret "$tmpdir/placeholder.sh")
  if [ -n "$placeholder_hit" ] && ! printf '%s' "$placeholder_hit" | grep -qE "$P_PLACEHOLDER"; then
    printf 'FAIL self-test: placeholder line was incorrectly flagged\n' >&2
    fail=1
  else
    printf 'PASS self-test: placeholder exclusion correct\n'
  fi

  if [ "$fail" -ne 0 ]; then
    printf '\nno-secrets-in-source --self-test: FAIL\n' >&2
    exit 1
  fi

  printf '\nno-secrets-in-source --self-test: PASS (5 pattern classes verified)\n'

  # Also run the live-tree check as part of self-test
  printf '\nRunning live-tree check...\n'
  if run_live_check; then
    printf 'no-secrets-in-source --self-test + live-tree: PASS\n'
    exit 0
  else
    printf 'no-secrets-in-source --self-test: live-tree FAIL\n' >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Live-tree scan
# ---------------------------------------------------------------------------

run_live_check() {
  cd "$PLUGIN_ROOT" || exit 1

  local findings=()

  while IFS= read -r tracked_file; do
    [ -f "$tracked_file" ] || continue

    # Exclude tests/fixtures/** and docs/**
    case "$tracked_file" in
      tests/fixtures/*|tests/*/fixtures/*|docs/*) continue ;;
    esac

    local lineno=0
    while IFS= read -r line || [ -n "$line" ]; do
      lineno=$((lineno + 1))

      # Quick pre-filter: skip lines with no candidate characters
      case "$line" in
        *AKIA*|*ghp_*|*github_pat_*|*'PRIVATE KEY'*|*secret*|*token*|*passw*|*api_key*|*key*) ;;
        *) continue ;;
      esac

      hit=$(printf '%s' "$line" | grep_secret)
      [ -n "$hit" ] || continue

      # For each match, exclude placeholder-only hits
      filtered_hit=""
      while IFS= read -r h; do
        [ -n "$h" ] || continue
        if printf '%s' "$h" | grep -qE "$P_PLACEHOLDER"; then
          continue
        fi
        filtered_hit="$h"
        break
      done <<< "$hit"
      [ -n "$filtered_hit" ] || continue

      local finding="${tracked_file}:${lineno}: ${filtered_hit}"

      if is_allowlisted "$finding"; then
        continue
      fi

      findings+=("$finding")
    done < "$tracked_file"
  done < <(git ls-files 2>/dev/null)

  if [ "${#findings[@]}" -eq 0 ]; then
    printf 'no-secrets-in-source: PASS\n'
    return 0
  fi

  printf 'no-secrets-in-source: FAIL — %d finding(s):\n' "${#findings[@]}" >&2
  for f in "${findings[@]}"; do
    printf '  %s\n' "$f" >&2
  done
  return 1
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if [ "${1:-}" = "--self-test" ]; then
  run_self_test
else
  run_live_check
fi
