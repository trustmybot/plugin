#!/usr/bin/env bash
# Every shipped agent (agents/*.md except README.md) and agent template
# (templates/agents/*.md) declares its subagent prompt-cache TTL in frontmatter:
#
#   experimental:
#     cacheTtl: 1h | 5m
#
# agents/swe.md must request 1h (it idles through multi-minute builds and test
# suites between turns); every other agent declares 5m.
#
# Usage: agent-cache-ttl.sh [plugin_root]   (defaults to this checkout's root)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${1:-$HERE/../..}" && pwd)" || {
  printf "  ❌ plugin root not found: %s\n" "${1:-}"
  exit 1
}

FAIL=0
CHECKED=0

frontmatter() {
  awk '
    /^---$/ { fences++; if (fences == 2) exit; next }
    fences == 1 { print }
  ' "$1"
}

# Prints the cacheTtl values nested directly under the experimental: block,
# one per line.
nested_cache_ttls() {
  awk '
    /^experimental:[[:space:]]*$/ { inblock = 1; next }
    inblock && /^  [^ ]/ {
      if ($0 ~ /^  cacheTtl:/) {
        v = $0
        sub(/^  cacheTtl:[[:space:]]*/, "", v)
        sub(/[[:space:]]+$/, "", v)
        print v
      }
      next
    }
    { inblock = 0 }
  '
}

check_file() {
  local f="$1" rel fm exp_count ttls ttl_count ttl
  rel="${f#"$PLUGIN_ROOT"/}"
  CHECKED=$((CHECKED + 1))
  fm=$(frontmatter "$f")

  exp_count=$(printf '%s\n' "$fm" | grep -c '^experimental:[[:space:]]*$')
  if [ "$exp_count" -ne 1 ]; then
    printf "  ❌ %s: expected exactly one 'experimental:' frontmatter line, found %d\n" "$rel" "$exp_count"
    FAIL=$((FAIL + 1))
    return
  fi

  ttls=$(printf '%s\n' "$fm" | nested_cache_ttls)
  ttl_count=$(printf '%s' "$ttls" | grep -c .)
  if [ "$ttl_count" -ne 1 ]; then
    printf "  ❌ %s: expected exactly one '  cacheTtl:' nested under 'experimental:', found %d\n" "$rel" "$ttl_count"
    FAIL=$((FAIL + 1))
    return
  fi

  ttl="$ttls"
  case "$ttl" in
    1h|5m) ;;
    *)
      printf "  ❌ %s: cacheTtl '%s' is not 1h or 5m\n" "$rel" "$ttl"
      FAIL=$((FAIL + 1))
      return
      ;;
  esac

  if [ "$rel" = "agents/swe.md" ] && [ "$ttl" != "1h" ]; then
    printf "  ❌ %s: swe must declare cacheTtl 1h, found %s\n" "$rel" "$ttl"
    FAIL=$((FAIL + 1))
    return
  fi

  printf "  ✓ %s: cacheTtl %s\n" "$rel" "$ttl"
}

printf "Checking experimental.cacheTtl in agent frontmatter\n"
for dir in "$PLUGIN_ROOT/agents" "$PLUGIN_ROOT/templates/agents"; do
  [ -d "$dir" ] || continue
  for f in "$dir"/*.md; do
    [ -f "$f" ] || continue
    [ "$(basename "$f")" = "README.md" ] && continue
    check_file "$f"
  done
done

if [ "$CHECKED" -eq 0 ]; then
  printf "  ❌ no agent files found under %s\n" "$PLUGIN_ROOT"
  exit 1
fi

if [ "$FAIL" -eq 0 ]; then
  printf "All %d agent file(s) declare a valid cacheTtl.\n" "$CHECKED"
  exit 0
fi
printf "%d agent file(s) failed the cacheTtl check.\n" "$FAIL"
exit 1
