#!/usr/bin/env bash
# Interactive remediation for the CC plugin MCP-config cache bug (issue #2888).
#
# Three independent recovery steps:
#   Step A — clear per-project `disabledMcpServers["plugin:tmb:trajectory-server"]`
#            entries from ~/.claude.json. CC writes this flag when a user
#            disables an MCP server through CC's UI; it persists across plugin
#            re-enable, plugin updates, full CC restarts, and rm -rf .claude/.
#            The plugin cannot read or write this — CC-owned state.
#   Step C — cache GC (#602): prune stale cached versions under
#            ~/.claude/plugins/cache/<owner>/<plugin>/<version>, keeping only
#            the ACTIVE (from installed_plugins.json) + the single PREVIOUS
#            version. The active version is never removed.
#   Step B — nuke ~/.claude/plugins/cache/<marketplace-owner>/ + remove plugin entries
#            from installed_plugins.json. The Mode A recovery doctrine for
#            CC's plugin-cache bug.
#
# Each mutating step has its own y/N prompt. Step A is the lighter, more common
# fix and defaults to y; Step C prunes conservatively; Step B is the most
# aggressive and defaults to N.
# Pass --dry-run to preview every step: each prints what it would do, no
# prompt is shown and nothing is written.
# Idempotent: re-runs see nothing to do and exit 0.
# Run from a terminal: inside Claude Code (CLAUDE_PROJECT_DIR or
# CLAUDE_PLUGIN_ROOT set) it refuses and changes nothing.

set -euo pipefail

if [ -n "${CLAUDE_PROJECT_DIR:-}" ] || [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  printf 'Refusing to run inside Claude Code: this script edits ~/.claude.json\n' >&2
  printf '(which Claude Code reads on every prompt) and the plugins cache.\n' >&2
  printf 'Quit Claude Code first, then run it from a regular terminal.\n' >&2
  exit 1
fi

INSTALLED_JSON="${HOME}/.claude/plugins/installed_plugins.json"
CC_CONFIG="${HOME}/.claude.json"

# ---- Channel detection -------------------------------------------------------
# Detect installed tmb channels from installed_plugins.json.
# macOS bash 3.2 compatible: use while-read instead of mapfile.
DETECTED_CHANNELS=()
if [ -f "$INSTALLED_JSON" ]; then
  while IFS= read -r entry; do
    [ -n "$entry" ] && DETECTED_CHANNELS+=("$entry")
  done < <(jq -r '.plugins | keys[]' "$INSTALLED_JSON" 2>/dev/null | grep -E '^tmb@' || true)
fi

# Allow --channel override (stable, rc or dev) and --dry-run (preview every step).
CHANNEL_ARG=""
DRY_RUN=0
ARGS=("$@")
i=0
while [ $i -lt ${#ARGS[@]} ]; do
  arg="${ARGS[$i]}"
  case "$arg" in
    --channel=*) CHANNEL_ARG="${arg#--channel=}" ;;
    --channel)
      i=$((i + 1))
      [ $i -lt ${#ARGS[@]} ] && CHANNEL_ARG="${ARGS[$i]}" ;;
    --dry-run) DRY_RUN=1 ;;
  esac
  i=$((i + 1))
done

if [ -n "$CHANNEL_ARG" ]; then
  case "$CHANNEL_ARG" in
    stable) PLUGIN_ENTRY="tmb@trustmybot" ;;
    rc|dev) PLUGIN_ENTRY="tmb@trustmybot-${CHANNEL_ARG}" ;;
    *)
      printf 'Unknown channel: %s\n' "$CHANNEL_ARG" >&2
      printf 'Pass --channel stable|rc|dev.\n' >&2
      exit 2
      ;;
  esac
elif [ "${#DETECTED_CHANNELS[@]}" -eq 1 ]; then
  PLUGIN_ENTRY="${DETECTED_CHANNELS[0]}"
elif [ "${#DETECTED_CHANNELS[@]}" -gt 1 ]; then
  printf 'Multiple tmb channels installed: %s\n' "${DETECTED_CHANNELS[*]}" >&2
  printf 'Pass --channel stable|rc|dev to choose.\n' >&2
  exit 2
else
  printf 'No tmb installation found in %s\n' "$INSTALLED_JSON" >&2
  printf 'Pass --channel stable|rc|dev to specify explicitly.\n' >&2
  exit 1
fi

PLUGIN_NAME="tmb"
MARKETPLACE_OWNER="${PLUGIN_ENTRY#*@}"

CACHE_DIR="${HOME}/.claude/plugins/cache/${MARKETPLACE_OWNER}"
if [ "$MARKETPLACE_OWNER" = "trustmybot" ]; then
  INSTALL_SCOPE="project"
else
  INSTALL_SCOPE="local"
fi
SCOPE_DOC="docs/reference/INSTALL.md#recommended-scope-project-or-local"
MCP_SERVER_KEY="plugin:tmb:trajectory-server"

if ! command -v jq >/dev/null 2>&1; then
  printf 'Error: jq is required but not on PATH.\n' >&2
  exit 1
fi

printf '=== TMB MCP-cache heal — issue #2888 ===\n\n'

# ============================================================================
# Step A — clear disabledMcpServers entries in ~/.claude.json
# ============================================================================

printf '%s\n\n' '--- Step A: per-project disabledMcpServers flags in ~/.claude.json ---'

disabled_projects=()
if [ ! -f "$CC_CONFIG" ]; then
  printf '  %s not found — skipping Step A.\n\n' "$CC_CONFIG"
else
  has_projects=$(jq -r 'if has("projects") then "yes" else "no" end' "$CC_CONFIG" 2>/dev/null || echo "no")
  if [ "$has_projects" != "yes" ]; then
    printf '  No .projects key in %s — skipping Step A.\n\n' "$CC_CONFIG"
  else
    while IFS= read -r project; do
      [ -n "$project" ] && disabled_projects+=("$project")
    done < <(jq -r --arg key "$MCP_SERVER_KEY" '
      .projects
      | to_entries
      | map(select(
          (.value.disabledMcpServers // [])
          | type == "array"
          and (index($key) != null)
        ))
      | .[].key
    ' "$CC_CONFIG" 2>/dev/null || true)

    if [ "${#disabled_projects[@]}" -eq 0 ]; then
      printf '  No projects have %s in disabledMcpServers.\n' "$MCP_SERVER_KEY"
      printf '  No disabled-MCP flags to clear; skipping.\n\n'
    else
      printf '  Projects with trajectory-server disabled:\n'
      for p in "${disabled_projects[@]}"; do
        printf '    %s\n' "$p"
      done
      printf '\n  Would: for each above, remove "%s" from .projects."<path>".disabledMcpServers\n' "$MCP_SERVER_KEY"
      printf '         (preserves every other disabled server + other keys).\n\n'
      if [ "$DRY_RUN" -eq 1 ]; then
        answer_a="dry-run"
        printf '  [dry-run] Step A would: back up %s to %s.bak.<timestamp>, then remove "%s" from .projects."<path>".disabledMcpServers for:\n' "$CC_CONFIG" "$CC_CONFIG" "$MCP_SERVER_KEY"
        for p in "${disabled_projects[@]}"; do
          printf '    %s\n' "$p"
        done
        printf '\n'
      else
        printf '  Proceed with Step A? (Y/n) '
        read -r answer_a
      fi
      case "$answer_a" in
        dry-run)
          ;;
        n|N|no|NO)
          printf '  Skipped Step A.\n\n'
          ;;
        *)
          ts=$(date -u +%Y%m%dT%H%M%SZ)
          backup="${CC_CONFIG}.bak.${ts}"
          cp -p "$CC_CONFIG" "$backup"
          printf '  Backup: %s\n' "$backup"
          for p in "${disabled_projects[@]}"; do
            tmp="${CC_CONFIG}.tmp.$$"
            jq --arg path "$p" --arg key "$MCP_SERVER_KEY" '
              .projects[$path].disabledMcpServers =
                ((.projects[$path].disabledMcpServers // []) | map(select(. != $key)))
            ' "$CC_CONFIG" > "$tmp"
            mv -f "$tmp" "$CC_CONFIG"
            printf '  Cleaned: %s\n' "$p"
          done
          printf '\n'
          ;;
      esac
    fi
  fi
fi

# ============================================================================
# Step C — cache GC (#602): prune stale cached versions, keep active + previous
# ============================================================================

printf '%s\n\n' '--- Step C: cache GC — prune stale cached versions (keep active + previous) ---'

VERSIONS_DIR="${CACHE_DIR}/${PLUGIN_NAME}"

# Active version from installed_plugins.json — the version CC currently resolves.
ACTIVE_VERSION=""
if [ -f "$INSTALLED_JSON" ]; then
  ACTIVE_VERSION=$(jq -r --arg entry "$PLUGIN_ENTRY" '
    (.plugins[$entry] // [])
    | map(.version) | map(select(. != null and . != "unknown"))
    | first // empty
  ' "$INSTALLED_JSON" 2>/dev/null || true)
fi

if [ ! -d "$VERSIONS_DIR" ]; then
  printf '  No version cache at %s — nothing to GC.\n\n' "$VERSIONS_DIR"
else
  # Collect numeric-leading version dirs (skip "unknown" and stray names).
  GC_VERSIONS=()
  while IFS= read -r vdir; do
    [ -d "$vdir" ] || continue
    vname="$(basename "$vdir")"
    case "$vname" in
      [0-9]*) GC_VERSIONS+=("$vname") ;;
    esac
  done < <(find "$VERSIONS_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)

  if [ "${#GC_VERSIONS[@]}" -eq 0 ]; then
    printf '  No semver version dirs under %s — nothing to GC.\n\n' "$VERSIONS_DIR"
  else
    # Sort versions ascending; keep set = active + previous (the highest version
    # that sorts strictly below active). Anything else is prunable. The active
    # version is NEVER in the prune list.
    SORTED=()
    while IFS= read -r v; do
      [ -n "$v" ] && SORTED+=("$v")
    done < <(printf '%s\n' "${GC_VERSIONS[@]}" | sort -V)

    # Fall back to the highest cached version as "active" when installed_plugins
    # has no usable version (keeps GC safe — we never guess-delete the top).
    if [ -z "$ACTIVE_VERSION" ]; then
      ACTIVE_VERSION="${SORTED[$(( ${#SORTED[@]} - 1 ))]}"
      printf '  (no active version in installed_plugins — treating highest cached %s as active)\n' "$ACTIVE_VERSION"
    fi

    # Previous = highest version strictly below active.
    PREVIOUS_VERSION=""
    for v in "${SORTED[@]}"; do
      if [ "$v" != "$ACTIVE_VERSION" ]; then
        top=$(printf '%s\n%s\n' "$v" "$ACTIVE_VERSION" | sort -V | tail -1)
        [ "$top" = "$ACTIVE_VERSION" ] && PREVIOUS_VERSION="$v"
      fi
    done

    PRUNE=()
    for v in "${SORTED[@]}"; do
      [ "$v" = "$ACTIVE_VERSION" ] && continue
      [ "$v" = "$PREVIOUS_VERSION" ] && continue
      PRUNE+=("$v")
    done

    printf '  cache dir:        %s\n' "$VERSIONS_DIR"
    printf '  cached versions:  %s\n' "${SORTED[*]}"
    printf '  active (keep):    %s\n' "$ACTIVE_VERSION"
    printf '  previous (keep):  %s\n' "${PREVIOUS_VERSION:-(none)}"

    if [ "${#PRUNE[@]}" -eq 0 ]; then
      printf '  Nothing to prune — only active + previous are cached.\n\n'
    else
      printf '\n  Would remove %s stale version(s):\n' "${#PRUNE[@]}"
      for v in "${PRUNE[@]}"; do
        printf '    rm -rf %s/%s\n' "$VERSIONS_DIR" "$v"
      done

      if [ "$DRY_RUN" -eq 1 ]; then
        printf '\n  [dry-run] Step C would: rm -rf'
        for v in "${PRUNE[@]}"; do
          printf ' %s/%s' "$VERSIONS_DIR" "$v"
        done
        printf '\n\n'
      else
        printf '\n  Proceed with Step C prune? (Y/n) '
        read -r answer_c
        case "$answer_c" in
          n|N|no|NO)
            printf '  Skipped Step C.\n\n'
            ;;
          *)
            for v in "${PRUNE[@]}"; do
              # Final guard: never delete the active version, whatever the list says.
              [ "$v" = "$ACTIVE_VERSION" ] && continue
              rm -rf "${VERSIONS_DIR:?}/${v:?}"
              printf '  Removed %s/%s\n' "$VERSIONS_DIR" "$v"
            done
            printf '\n'
            ;;
        esac
      fi
    fi
  fi
fi

# ============================================================================
# Step B — plugin cache + installed_plugins.json
# ============================================================================

printf '%s\n\n' '--- Step B: plugin cache + installed_plugins.json ---'

cache_exists="no"
[ -d "$CACHE_DIR" ] && cache_exists="yes"

manifest_exists="no"
matching_count=0
recorded_scope=""
total_count=0
if [ -f "$INSTALLED_JSON" ]; then
  manifest_exists="yes"
  total_count=$(jq -r '.plugins | length' "$INSTALLED_JSON" 2>/dev/null || echo 0)
  matching_count=$(jq --arg entry "$PLUGIN_ENTRY" \
    '[.plugins | to_entries[] | select(.key == $entry)] | length' \
    "$INSTALLED_JSON" 2>/dev/null || echo 0)
  recorded_scope=$(jq -r --arg entry "$PLUGIN_ENTRY" \
    '(.plugins[$entry] // []) | map(.scope // empty) | first // empty' \
    "$INSTALLED_JSON" 2>/dev/null || true)
fi
case "$recorded_scope" in
  project|local) UNINSTALL_SCOPE="$recorded_scope" ;;
  *) UNINSTALL_SCOPE="$INSTALL_SCOPE" ;;
esac

printf 'Discovered state:\n'
printf '  cache dir:           %s (%s)\n' "$CACHE_DIR" "$cache_exists"
if [ "$manifest_exists" = "yes" ]; then
  printf '  installed_plugins:   %s\n' "$INSTALLED_JSON"
  printf '  total entries:       %s\n' "$total_count"
  printf '  matching "%s": %s\n' "$PLUGIN_ENTRY" "$matching_count"
else
  printf '  installed_plugins:   %s (missing)\n' "$INSTALLED_JSON"
fi

if [ "$cache_exists" = "yes" ]; then
  printf '\nCache subdirectories under %s:\n' "$CACHE_DIR"
  for sub in "$CACHE_DIR"/*/; do
    [ -d "$sub" ] || continue
    name="$(basename "$sub")"
    versions=()
    for v in "$sub"*/; do
      [ -d "$v" ] || continue
      versions+=("$(basename "$v")")
    done
    if [ "${#versions[@]}" -gt 0 ]; then
      printf '  %s: %s\n' "$name" "${versions[*]}"
    else
      printf '  %s: (empty)\n' "$name"
    fi
  done
fi

if command -v pgrep >/dev/null 2>&1; then
  pgrep_count=$({ pgrep -f 'trajectory-server/dist/index.js' 2>/dev/null || true; } | wc -l | tr -d ' ')
  [ -z "$pgrep_count" ] && pgrep_count=0
  printf '\ntrajectory-server processes: %s\n' "$pgrep_count"
else
  printf '\ntrajectory-server processes: unknown (pgrep missing)\n'
fi

if [ "$cache_exists" = "no" ] && [ "$matching_count" -eq 0 ]; then
  printf '\n  Nothing to nuke — cache dir already gone and no %s entry in installed_plugins.json.\n' "$PLUGIN_ENTRY"
  printf '  Skipping Step B.\n\n'
  printf 'Done. To reinstall:\n'
  printf '  1. From the project root: claude plugin install %s --scope %s\n' "$PLUGIN_ENTRY" "$INSTALL_SCOPE"
  printf '     (scope rule: %s)\n' "$SCOPE_DOC"
  printf '  2. Launch Claude Code.\n'
  printf '  3. Verify with: tail -1 <project>/.claude/%s/logs/mcp-health.log\n' "$PLUGIN_NAME"
  printf '     (expect mcp_alive:true)\n'
  exit 0
fi

printf '\nDry-run — would remove:\n'
if [ "$cache_exists" = "yes" ]; then
  printf '  rm -rf %s\n' "$CACHE_DIR"
fi
if [ "$matching_count" -gt 0 ]; then
  printf '  jq "del(.plugins[\"%s\"])" %s   (%s entries)\n' \
    "$PLUGIN_ENTRY" "$INSTALLED_JSON" "$matching_count"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf '\n[dry-run] Step B would:'
  [ "$cache_exists" = "yes" ] && printf ' rm -rf %s;' "$CACHE_DIR"
  [ "$matching_count" -gt 0 ] && printf ' jq "del(.plugins[\"%s\"])" %s' "$PLUGIN_ENTRY" "$INSTALLED_JSON"
  printf '\n\n--dry-run: nothing was changed. Re-run without --dry-run to apply.\n'
  exit 0
fi

printf '\nProceed with Step B (cache nuke)? (y/N) '
read -r answer_b
case "$answer_b" in
  y|Y|yes|YES)
    ;;
  *)
    printf '\nSkipped Step B. Manual recovery options:\n'
    printf '  1. claude --plugin-dir <plugin-source-path>   (cache-bust via inline)\n'
    printf '  2. From the project root: claude plugin uninstall %s --scope %s, then reinstall with: claude plugin install %s --scope %s\n' \
      "$PLUGIN_ENTRY" "$UNINSTALL_SCOPE" "$PLUGIN_ENTRY" "$INSTALL_SCOPE"
    printf '     (scope rule: %s)\n' "$SCOPE_DOC"
    printf '  3. Re-run this script and answer y to Step B.\n'
    exit 0
    ;;
esac

if [ "$cache_exists" = "yes" ]; then
  rm -rf "$CACHE_DIR"
  printf 'Removed %s\n' "$CACHE_DIR"
fi

if [ "$matching_count" -gt 0 ]; then
  tmp="${INSTALLED_JSON}.tmp.$$"
  jq --arg entry "$PLUGIN_ENTRY" 'del(.plugins[$entry])' \
    "$INSTALLED_JSON" > "$tmp"
  mv -f "$tmp" "$INSTALLED_JSON"
  printf 'Removed %s entries from %s\n' "$matching_count" "$INSTALLED_JSON"
fi

printf '\nDone. To reinstall:\n'
printf '  1. From the project root: claude plugin install %s --scope %s\n' "$PLUGIN_ENTRY" "$INSTALL_SCOPE"
printf '     (scope rule: %s)\n' "$SCOPE_DOC"
printf '  2. Launch Claude Code.\n'
printf '  3. Verify with: tail -1 <project>/.claude/%s/logs/mcp-health.log\n' "$PLUGIN_NAME"
printf '     (expect mcp_alive:true)\n'
