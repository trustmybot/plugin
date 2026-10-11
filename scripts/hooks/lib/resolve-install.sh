#!/usr/bin/env bash
# Library: pick THE TMB install for this project.
# Sourced (not exec'd). No set -e/-euo/-euo pipefail here — libs must not
# mutate caller shell options.
#
# Claude Code records every plugin install in
# ~/.claude/plugins/installed_plugins.json (read only here; TMB_INSTALLED_JSON
# overrides the path for tests). An entry is { scope, projectPath?,
# installPath, installedAt, version } under the key <plugin>@<marketplace>.
#
# tmb_active_install prints the installPath every hook of this project runs:
#   1. a CLAUDE_PLUGIN_ROOT outside any plugins cache that no entry names (a
#      dev checkout or --plugin-dir) resolves to itself, whatever the manifest
#      holds for this project;
#   2. candidates = entries for this plugin (any marketplace) whose installPath
#      exists;
#   3. a project/local entry whose canonical projectPath equals the canonical
#      CLAUDE_PROJECT_DIR wins; two of them → the newest installedAt, with a
#      stderr notice naming both;
#   4. otherwise the newest user-scope entry;
#   5. otherwise (no entry) CLAUDE_PLUGIN_ROOT.

_tmb_canonical_dir() {
  (cd "${1:-}" 2>/dev/null && pwd -P) || printf '%s\n' "${1:-}"
}

_tmb_install_plugin_name() {
  local manifest="${CLAUDE_PLUGIN_ROOT:-}/.claude-plugin/plugin.json"
  local name=""
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$manifest" ] && command -v jq >/dev/null 2>&1; then
    name=$(jq -r '.name // empty' "$manifest" 2>/dev/null || true)
  fi
  printf '%s\n' "${name:-tmb}"
}

tmb_installed_json() {
  printf '%s\n' "${TMB_INSTALLED_JSON:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json}"
}

# tmb_install_candidates
# One TSV line per existing install of this plugin:
#   <scope>\t<canonical projectPath or ->\t<installPath>\t<installedAt>\t<version>
tmb_install_candidates() {
  local json name
  json=$(tmb_installed_json)
  [ -f "$json" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  name=$(_tmb_install_plugin_name)
  local scope project install at version
  while IFS=$'\t' read -r scope project install at version; do
    [ "$install" != "-" ] && [ -d "$install" ] || continue
    if [ "$project" != "-" ]; then
      project=$(_tmb_canonical_dir "$project")
    fi
    printf '%s\t%s\t%s\t%s\t%s\n' "$scope" "$project" "$install" "$at" "$version"
  done < <(jq -r --arg p "${name}@" '
    def field($v; $d): if ($v | type) == "string" and $v != "" then $v else $d end;
    (.plugins // {}) | to_entries[] | select(.key | startswith($p)) | .value[]?
    | [field(.scope; "user"), field(.projectPath; "-"), field(.installPath; "-"),
       field(.installedAt; "-"), field(.version; "-")] | @tsv' "$json" 2>/dev/null)
}

# tmb_project_installs — candidates of scope project/local for this project,
# newest installedAt first.
tmb_project_installs() {
  [ -n "${CLAUDE_PROJECT_DIR:-}" ] || return 0
  local here
  here=$(_tmb_canonical_dir "$CLAUDE_PROJECT_DIR")
  tmb_install_candidates | awk -F'\t' -v here="$here" \
    '($1 == "project" || $1 == "local") && $2 == here' | sort -t$'\t' -k4,4r
}

# tmb_user_installs — user-scope candidates, newest installedAt first.
tmb_user_installs() {
  tmb_install_candidates | awk -F'\t' '$1 == "user"' | sort -t$'\t' -k4,4r
}

tmb_active_install() {
  local self="${CLAUDE_PLUGIN_ROOT:-}" projects first second
  if [ -n "$self" ]; then
    case "$self" in
      */plugins/cache/*) ;;
      *)
        if ! tmb_install_candidates | cut -f3 | grep -qxF "$self"; then
          printf '%s\n' "$self"
          return 0
        fi
        ;;
    esac
  fi
  projects=$(tmb_project_installs)
  if [ -n "$projects" ]; then
    first=$(printf '%s\n' "$projects" | sed -n 1p | cut -f3)
    second=$(printf '%s\n' "$projects" | sed -n 2p | cut -f3)
    if [ -n "$second" ]; then
      printf 'TMB: two project installs for %s — using %s (newest), ignoring %s\n' \
        "$CLAUDE_PROJECT_DIR" "$first" "$second" >&2
    fi
    printf '%s\n' "$first"
    return 0
  fi
  first=$(tmb_user_installs | sed -n 1p | cut -f3)
  if [ -n "$first" ]; then
    printf '%s\n' "$first"
    return 0
  fi
  printf '%s\n' "$self"
}
