#!/usr/bin/env bash
# Exercise the real Codex installer in an isolated CODEX_HOME.
#
# Usage:
#   bash tests/l0-install/codex-plugin-surface-smoke.sh [artifact-root]
#
# Pass a fixed-SHA artifact directory for release evidence. With no argument,
# the script checks the current repository checkout.

set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARTIFACT_ROOT="$(cd "${1:-$PLUGIN_ROOT}" && pwd -P)"
CODEX_BIN="${CODEX_BIN:-codex}"

for tool in "$CODEX_BIN" jq cmp find; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'codex-plugin-surface-smoke: missing required tool: %s\n' "$tool" >&2
    exit 1
  fi
done

for required in \
  "$ARTIFACT_ROOT/.agents/plugins/marketplace.json" \
  "$ARTIFACT_ROOT/.codex-plugin/plugin.json" \
  "$ARTIFACT_ROOT/commands" \
  "$ARTIFACT_ROOT/skills"; do
  if [ ! -e "$required" ]; then
    printf 'codex-plugin-surface-smoke: artifact is missing %s\n' "$required" >&2
    exit 1
  fi
done

SMOKE_PARENT="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
SMOKE_HOME="$(mktemp -d "$SMOKE_PARENT/tmb-codex-plugin-surface.XXXXXX")"
cleanup() {
  case "$SMOKE_HOME" in
    "$SMOKE_PARENT"/tmb-codex-plugin-surface.*)
      rm -rf -- "$SMOKE_HOME"
      ;;
    *)
      printf 'codex-plugin-surface-smoke: refusing to clean unexpected path: %s\n' "$SMOKE_HOME" >&2
      ;;
  esac
}
trap cleanup EXIT

MARKETPLACE_JSON="$SMOKE_HOME/marketplace-add.json"
INSTALL_JSON="$SMOKE_HOME/plugin-add.json"

env CODEX_HOME="$SMOKE_HOME" "$CODEX_BIN" plugin marketplace add "$ARTIFACT_ROOT" --json > "$MARKETPLACE_JSON"
MARKETPLACE_NAME="$(jq -er '.marketplaceName' "$MARKETPLACE_JSON")"
env CODEX_HOME="$SMOKE_HOME" "$CODEX_BIN" plugin add "tmb@$MARKETPLACE_NAME" --json > "$INSTALL_JSON"

INSTALLED_PATH="$(jq -er '.installedPath' "$INSTALL_JSON")"
case "$INSTALLED_PATH" in
  "$SMOKE_HOME"/plugins/cache/*) ;;
  *)
    printf 'codex-plugin-surface-smoke: installer returned an out-of-home cache path: %s\n' "$INSTALLED_PATH" >&2
    exit 1
    ;;
esac

INSTALLED_MANIFEST="$INSTALLED_PATH/.codex-plugin/plugin.json"
jq -e '
  .commands == [] and
  .skills == "./adapters/codex/skills/"
' "$INSTALLED_MANIFEST" >/dev/null

SKILLS_REL="$(jq -er '.skills' "$INSTALLED_MANIFEST")"
SKILLS_DIR="$(cd "$INSTALLED_PATH/$SKILLS_REL" && pwd -P)"
ACTUAL_SKILLS="$(find "$SKILLS_DIR" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | LC_ALL=C sort)"
EXPECTED_SKILLS="$(printf '%s\n' tmb-agent-setup tmb-bro)"
if [ "$ACTUAL_SKILLS" != "$EXPECTED_SKILLS" ]; then
  printf 'codex-plugin-surface-smoke: unexpected Codex Skill directories:\n%s\n' "$ACTUAL_SKILLS" >&2
  exit 1
fi

if [ -e "$INSTALLED_PATH/.codex-plugin/migrated-command-skills" ] ||
   find "$INSTALLED_PATH" -type d -name 'source-command-*' -print -quit | grep -q .; then
  printf 'codex-plugin-surface-smoke: Claude commands migrated into Codex Skills\n' >&2
  exit 1
fi

compare_regular_tree() {
  local source_dir="$1"
  local installed_dir="$2"
  local source_files
  local installed_files
  local relative_path

  source_files="$(cd "$source_dir" && find . -type f | LC_ALL=C sort)"
  installed_files="$(cd "$installed_dir" && find . -type f | LC_ALL=C sort)"
  if [ "$source_files" != "$installed_files" ]; then
    printf 'codex-plugin-surface-smoke: regular-file inventory changed for %s\n' "$source_dir" >&2
    exit 1
  fi
  while IFS= read -r relative_path; do
    [ -z "$relative_path" ] && continue
    if ! cmp -s "$source_dir/$relative_path" "$installed_dir/$relative_path"; then
      printf 'codex-plugin-surface-smoke: installed bytes changed for %s\n' "$source_dir/$relative_path" >&2
      exit 1
    fi
  done <<< "$source_files"
}

ROOT_SKILL_DIRS="$(find "$ARTIFACT_ROOT/skills" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | LC_ALL=C sort)"
INSTALLED_ROOT_SKILL_DIRS="$(find "$INSTALLED_PATH/skills" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | LC_ALL=C sort)"
if [ "$ROOT_SKILL_DIRS" != "$INSTALLED_ROOT_SKILL_DIRS" ]; then
  printf 'codex-plugin-surface-smoke: root Claude Skill directories changed during installation\n' >&2
  exit 1
fi

compare_regular_tree "$ARTIFACT_ROOT/commands" "$INSTALLED_PATH/commands"
compare_regular_tree "$ARTIFACT_ROOT/skills" "$INSTALLED_PATH/skills"

printf 'codex-plugin-surface-smoke: PASS\n'
printf '  Codex: %s\n' "$(env CODEX_HOME="$SMOKE_HOME" "$CODEX_BIN" --version)"
printf '  Codex Skills: %s\n' "$(printf '%s' "$ACTUAL_SKILLS" | tr '\n' ' ')"
printf '  Claude commands/ and skills/: regular files and Skill directories preserved\n'
printf '  source-command-* migrations: absent\n'
