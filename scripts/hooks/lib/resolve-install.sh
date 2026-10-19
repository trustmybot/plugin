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
        if ! tmb_install_candidates | cut -f3 | grep -xF "$self" >/dev/null; then
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

# tmb_duplicate_installs <project_dir>
# Claude Code registers the hooks of only one enabled plugin per manifest name;
# the other copy's hooks.json is skipped with a note under /plugin Errors. This
# lists the enabled <plugin>@<marketplace> keys of this plugin that apply to
# <project_dir>, one TSV line each:
#   <marketplace>\t<version>\t<installPath>\t<scope>
# and prints nothing when there are fewer than two.
#   - applies: a user-scope entry, or a project/local entry whose canonical
#     projectPath is the canonical <project_dir>; a key with both reports its
#     project/local entry (one key is one copy);
#   - enabled: enabledPlugins[key] is true in the first of
#     <project>/.claude/settings.local.json, <project>/.claude/settings.json,
#     ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json that sets the key.
# Read-only; an unreadable or invalid file counts as unset.
tmb_duplicate_installs() {
  local project="${1:-}" json name here f enabled rows
  [ -n "$project" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  json=$(tmb_installed_json)
  [ -r "$json" ] || return 0
  name=$(_tmb_install_plugin_name)
  here=$(_tmb_canonical_dir "$project")
  enabled=$(for f in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" "$here/.claude/settings.json" "$here/.claude/settings.local.json"; do
      [ -r "$f" ] && jq -c '(.enabledPlugins // {}) | if type == "object" then . else {} end' "$f" 2>/dev/null
    done | jq -sc 'add // {}' 2>/dev/null)
  [ -n "$enabled" ] || enabled='{}'
  local key scope proj install version rank
  rows=$(while IFS=$'\t' read -r key scope proj install version; do
      [ -n "$key" ] || continue
      case "$scope" in
        (project|local)
          [ "$proj" != "-" ] && [ "$(_tmb_canonical_dir "$proj")" = "$here" ] || continue
          rank=0 ;;
        (*) rank=1 ;;
      esac
      printf '%s\t%s\t%s\t%s\t%s\n' "${key#*@}" "$rank" "$version" "$install" "$scope"
    done < <(jq -r --arg p "${name}@" --argjson on "$enabled" '
      def field($v; $d): if ($v | type) == "string" and $v != "" then $v else $d end;
      (.plugins // {}) | to_entries[] | select((.key | startswith($p)) and $on[.key] == true)
      | .key as $k | .value[]?
      | [$k, field(.scope; "user"), field(.projectPath; "-"), field(.installPath; "-"), field(.version; "-")]
      | @tsv' "$json" 2>/dev/null) \
    | sort -t$'\t' -k1,1 -k2,2n | awk -F'\t' -v OFS='\t' '!seen[$1]++ { print $1, $3, $4, $5 }')
  [ "$(printf '%s\n' "$rows" | grep -c .)" -gt 1 ] || return 0
  printf '%s\n' "$rows"
}

# tmb_duplicate_installs_names <rows> — "a@1.0.1, b@1.0.2" from tmb_duplicate_installs output.
tmb_duplicate_installs_names() {
  printf '%s\n' "${1:-}" | awk -F'\t' 'NF { printf "%s%s@%s", (n++ ? ", " : ""), $1, $2 }'
}

tmb_user_settings_json() {
  printf '%s\n' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
}

tmb_legacy_user_hooks_doc() {
  printf '%s\n' "docs/reference/UPGRADE.md#upgrading-into-v110--remove-leftover-user-wide-hooks"
}

# tmb_legacy_user_hooks [project_dir]
# Before 1.1.0, /onboard wrote hook commands running
# ~/.claude/tmb-hooks/resolve-hook.sh into the user-scope settings.json, so
# they fire in every project; 1.1.0 writes its shim only into
# <project>/.claude/settings.local.json. Every resolve-hook.sh command under
# .hooks of tmb_user_settings_json is therefore a leftover. One TSV row each:
#   hook\t<line>\t<--hook name or ?>
# and, only when there is one, one row per other existing project whose
# recorded install of this plugin is below 1.1.0 (prerelease tags ignored, so
# 1.1.0-rc.1 counts as 1.1.0) — they lose those hooks once they are removed:
#   project\t<canonical projectPath>\t<version>
# Read-only; a missing or unparsable settings file prints nothing.
tmb_legacy_user_hooks() {
  local here="" settings json name hooks rows p v
  command -v jq >/dev/null 2>&1 || return 0
  settings=$(tmb_user_settings_json)
  [ -r "$settings" ] || return 0
  [ "$(jq '[(.hooks // {}) | objects | .[] | arrays | .[] | objects | .hooks | arrays | .[]
      | objects | .command | strings | select(contains("resolve-hook.sh"))] | length' "$settings" 2>/dev/null)" \
    -gt 0 ] 2>/dev/null || return 0
  hooks=$(awk '
    /"command"/ && index($0, "resolve-hook.sh") {
      rest = $0
      while ((i = index(rest, "resolve-hook.sh")) > 0) {
        rest = substr(rest, i + 15)
        seg = rest
        j = index(seg, "resolve-hook.sh")
        if (j > 0) seg = substr(seg, 1, j - 1)
        name = "?"
        if (match(seg, /--hook[ \t]+[A-Za-z0-9._-]+/)) {
          name = substr(seg, RSTART, RLENGTH)
          sub(/^--hook[ \t]+/, "", name)
        }
        printf "hook\t%d\t%s\n", NR, name
      }
    }' "$settings" 2>/dev/null)
  [ -n "$hooks" ] || return 0
  printf '%s\n' "$hooks"
  [ -n "${1:-}" ] && here=$(_tmb_canonical_dir "$1")
  json=$(tmb_installed_json)
  [ -r "$json" ] || return 0
  name=$(_tmb_install_plugin_name)
  rows=$(jq -r --arg p "${name}@" '
    (.plugins // {}) | to_entries[] | select(.key | startswith($p)) | .value[]?
    | select((.projectPath | type) == "string" and .projectPath != "" and (.version | type) == "string")
    | select((.version | split("-")[0] | split(".") | map(tonumber? // -1)) < [1, 1, 0])
    | [.projectPath, .version] | @tsv' "$json" 2>/dev/null)
  while IFS=$'\t' read -r p v; do
    [ -n "$p" ] && [ -d "$p" ] || continue
    p=$(_tmb_canonical_dir "$p")
    [ "$p" != "$here" ] || continue
    printf 'project\t%s\t%s\n' "$p" "$v"
  done <<<"$rows" | awk -F'\t' '!seen[$2]++'
}

# tmb_legacy_user_hooks_entries <rows> — "line 12 swe-scope-guard, line 20 bash-guard".
tmb_legacy_user_hooks_entries() {
  printf '%s\n' "${1:-}" | awk -F'\t' '$1 == "hook" { printf "%sline %s %s", (n++ ? ", " : ""), $2, $3 }'
}

# tmb_legacy_user_hooks_projects <rows> — "/a (1.0.2), /b (1.0.1)", empty when none.
tmb_legacy_user_hooks_projects() {
  printf '%s\n' "${1:-}" | awk -F'\t' '$1 == "project" { printf "%s%s (%s)", (n++ ? ", " : ""), $2, $3 }'
}
