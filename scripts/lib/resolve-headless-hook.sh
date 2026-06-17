#!/usr/bin/env bash
# Version-agnostic headless-hook resolver (#74/#680).
#
# /onboard materializes a stable copy of this script at ~/.claude/tmb-hooks/
# resolve-hook.sh and writes version-agnostic commands into the user-global
# ~/.claude/settings.json (which DO fire under headless `claude -p`, unlike
# marketplace plugin hooks). Each settings.json command is:
#
#   bash ~/.claude/tmb-hooks/resolve-hook.sh --marketplace <mp> --hook <basename>
#
# This resolver discovers the ACTIVE tmb cache version at hook-fire time and
# execs the real gate `.../cache/<mp>/tmb/<version>/scripts/hooks/<basename>.sh`,
# forwarding stdin + any pass-through argv untouched. Because the version is
# resolved at fire-time (not baked in at onboard-time), a plugin upgrade or
# cache-clean that bumps the active version no longer orphans the hook paths.
#
# Active-version source of truth (in order):
#   1. CC's installed-plugins manifest ~/.claude/plugins/installed_plugins.json
#      — the `installPath` of the tmb@<marketplace> entry.
#   2. Fallback: highest-semver directory under
#      ~/.claude/plugins/cache/<marketplace>/tmb/.
#
# Fail-open-LOUD: if no active version resolves (manifest absent AND no cache
# dirs), print one loud stderr warning and exit 0. NEVER exit 2 — that would
# block every tool call and brick the user. NEVER crash the tool call.

set -uo pipefail

CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
MANIFEST="$CLAUDE_HOME/plugins/installed_plugins.json"

marketplace=""
hook=""
passthrough=()

while [ $# -gt 0 ]; do
  case "$1" in
    --marketplace)
      marketplace="${2:-}"
      shift 2
      ;;
    --hook)
      hook="${2:-}"
      shift 2
      ;;
    *)
      passthrough+=("$1")
      shift
      ;;
  esac
done

warn_open() {
  printf 'TMB resolve-hook: %s — failing OPEN (gate skipped) for marketplace=%s hook=%s\n' \
    "$1" "${marketplace:-?}" "${hook:-?}" >&2
  exit 0
}

if [ -z "$marketplace" ] || [ -z "$hook" ]; then
  warn_open "missing --marketplace/--hook arg"
fi

# 1) Authoritative: the installPath recorded for tmb@<marketplace> in CC's
#    installed-plugins manifest. installPath points straight at the active
#    cache version dir, e.g. .../cache/<mp>/tmb/<version>.
version_root=""
if [ -f "$MANIFEST" ] && command -v jq >/dev/null 2>&1; then
  version_root="$(jq -r --arg key "tmb@${marketplace}" '
    (.plugins[$key] // [])
    | map(.installPath // empty)
    | last // empty
  ' "$MANIFEST" 2>/dev/null || true)"
fi

# 2) Fallback: highest-semver dir under the marketplace cache. Used when the
#    manifest is missing/unparseable or has no installPath for this marketplace.
if [ -z "$version_root" ] || [ ! -d "$version_root" ]; then
  cache_tmb="$CLAUDE_HOME/plugins/cache/${marketplace}/tmb"
  if [ -d "$cache_tmb" ]; then
    best="$(
      find "$cache_tmb" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; 2>/dev/null \
        | sort -t. -k1,1n -k2,2n -k3,3n -V \
        | tail -n 1
    )"
    if [ -n "$best" ]; then
      version_root="$cache_tmb/$best"
    fi
  fi
fi

if [ -z "$version_root" ] || [ ! -d "$version_root" ]; then
  warn_open "no active tmb version resolved (manifest + cache fallback both empty)"
fi

target="$version_root/scripts/hooks/${hook}.sh"
if [ ! -f "$target" ]; then
  warn_open "resolved version has no hook script at $target"
fi

# Forward stdin + pass-through argv untouched so the real gate sees identical
# input to what it would receive as a plugin hook.
if [ "${#passthrough[@]}" -gt 0 ]; then
  exec bash "$target" "${passthrough[@]}"
else
  exec bash "$target"
fi
