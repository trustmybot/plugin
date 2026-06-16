#!/usr/bin/env bash
# Library: user-toolchain PATH resolution for TMB hooks.
# Sourced (not exec'd) by swe-verification-gate.sh.
# No set -e/-euo/-euo pipefail here — libs must not mutate caller shell options.
#
# Why this exists (#673, second defect):
#   swe-verification-gate.sh runs each typed verification[] command via
#   `bash -c` inside the swe-subagent's PreToolUse hook process. That process
#   starts with a minimal, login-stripped PATH — `npm`/`node` live in mise
#   (e.g. ~/.local/share/mise/installs/node/<v>/bin) and `shellcheck` in
#   homebrew (/opt/homebrew/bin), neither on the inherited PATH. A verification
#   command like `npm test` then exits 127 (command not found) and the gate
#   issues a false DENY.
#
# Chosen mechanism — resolve and prepend the real toolchain dirs in-process:
#   The user runs zsh + mise, so `bash -lc` is unreliable (it sources bash
#   login files, not zsh, and mise activation is a shell hook that never runs
#   in a non-interactive bash). Instead we resolve the toolchain dirs directly:
#     1. mise shims dir ($MISE_DATA_DIR/shims or ~/.local/share/mise/shims) —
#        self-contained shims that dispatch to the active tool version without
#        needing mise to be activated in the shell. Verified to resolve `npm`
#        under a bare PATH=/usr/bin:/bin.
#     2. `mise bin-paths`, if a mise binary can be located at a well-known
#        install path — yields the exact active tool bin dirs.
#     3. homebrew bin/sbin (brew --prefix, else /opt/homebrew, /usr/local) —
#        for shellcheck and other brew-installed verification tools.
#     4. ~/.local/bin — common user-tool location.
#   Existing entries are deduped; the caller's original PATH is preserved as the
#   tail so nothing that was already resolvable stops resolving.

# tmb_user_toolchain_dirs
# Prints the resolved toolchain bin dirs, one per line (may be empty).
# Never fails the caller.
tmb_user_toolchain_dirs() {
  local home="${HOME:-}"

  # 1. mise shims — self-contained, version-dispatching shims.
  local mise_data="${MISE_DATA_DIR:-${XDG_DATA_HOME:-$home/.local/share}/mise}"
  [ -d "$mise_data/shims" ] && printf '%s\n' "$mise_data/shims"

  # 2. mise bin-paths via a locatable mise binary (the minimal PATH may not
  #    have mise on it, so probe well-known install locations directly).
  local mise_bin=""
  local cand
  for cand in \
    "${MISE_INSTALL_PATH:-}" \
    /opt/homebrew/bin/mise \
    /usr/local/bin/mise \
    "$home/.local/bin/mise"; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then
      mise_bin="$cand"
      break
    fi
  done
  if [ -n "$mise_bin" ]; then
    "$mise_bin" bin-paths 2>/dev/null || true
  fi

  # 3. homebrew bin/sbin.
  local brew_prefix=""
  for cand in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$cand" ]; then
      brew_prefix=$("$cand" --prefix 2>/dev/null || true)
      break
    fi
  done
  if [ -n "$brew_prefix" ]; then
    [ -d "$brew_prefix/bin" ] && printf '%s\n' "$brew_prefix/bin"
    [ -d "$brew_prefix/sbin" ] && printf '%s\n' "$brew_prefix/sbin"
  else
    [ -d /opt/homebrew/bin ] && printf '%s\n' /opt/homebrew/bin
    [ -d /opt/homebrew/sbin ] && printf '%s\n' /opt/homebrew/sbin
    [ -d /usr/local/bin ] && printf '%s\n' /usr/local/bin
  fi

  # 4. ~/.local/bin.
  [ -n "$home" ] && [ -d "$home/.local/bin" ] && printf '%s\n' "$home/.local/bin"

  return 0
}

# tmb_resolve_toolchain_path [base_path]
# Prints a PATH string: the resolved toolchain dirs prepended to base_path
# (default: current $PATH), with duplicates removed (first occurrence wins).
# Never fails the caller.
tmb_resolve_toolchain_path() {
  local base="${1:-$PATH}"
  local combined=""
  local dir

  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    combined="${combined:+$combined:}$dir"
  done <<EOF
$(tmb_user_toolchain_dirs)
EOF

  combined="${combined:+$combined:}$base"

  # Dedup, preserving order (first occurrence wins).
  local out=""
  local IFS=:
  for dir in $combined; do
    [ -n "$dir" ] || continue
    case ":$out:" in
      *":$dir:"*) ;;
      *) out="${out:+$out:}$dir" ;;
    esac
  done
  printf '%s\n' "$out"
}
