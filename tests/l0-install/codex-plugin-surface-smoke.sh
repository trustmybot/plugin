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

for tool in "$CODEX_BIN" jq cmp find git grep node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'codex-plugin-surface-smoke: missing required tool: %s\n' "$tool" >&2
    exit 1
  fi
done

for required in \
  "$ARTIFACT_ROOT/.agents/plugins/marketplace.json" \
  "$ARTIFACT_ROOT/.codex-plugin/plugin.json" \
  "$ARTIFACT_ROOT/commands" \
  "$ARTIFACT_ROOT/skills" \
  "$ARTIFACT_ROOT/hooks/codex/hooks.json" \
  "$ARTIFACT_ROOT/adapters/codex/hooks/dispatcher.mjs" \
  "$ARTIFACT_ROOT/adapters/codex/hooks/repo-policy.mjs"; do
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

validate_installed_cache() {
  case "$INSTALLED_PATH" in
    "$SMOKE_HOME"/plugins/cache/*) ;;
    *)
      printf 'codex-plugin-surface-smoke: installer returned an out-of-home cache path: %s\n' "$INSTALLED_PATH" >&2
      exit 1
      ;;
  esac

  INSTALLED_MANIFEST="$INSTALLED_PATH/.codex-plugin/plugin.json"
  INSTALLED_HOOKS="$INSTALLED_PATH/hooks/codex/hooks.json"
  INSTALLED_DISPATCHER="$INSTALLED_PATH/adapters/codex/hooks/dispatcher.mjs"
  INSTALLED_POLICY="$INSTALLED_PATH/adapters/codex/hooks/repo-policy.mjs"
  for installed_hook_file in "$INSTALLED_MANIFEST" "$INSTALLED_HOOKS" "$INSTALLED_DISPATCHER" "$INSTALLED_POLICY"; do
    if [ ! -f "$installed_hook_file" ]; then
      printf 'codex-plugin-surface-smoke: installed cache is missing %s\n' "$installed_hook_file" >&2
      exit 1
    fi
  done

  jq -e '
    .commands == [] and
    .skills == "./adapters/codex/skills/" and
    .hooks == "./hooks/codex/hooks.json"
  ' "$INSTALLED_MANIFEST" >/dev/null
  cmp -s "$ARTIFACT_ROOT/.codex-plugin/plugin.json" "$INSTALLED_MANIFEST"
  cmp -s "$ARTIFACT_ROOT/hooks/codex/hooks.json" "$INSTALLED_HOOKS"
  cmp -s "$ARTIFACT_ROOT/adapters/codex/hooks/dispatcher.mjs" "$INSTALLED_DISPATCHER"
  cmp -s "$ARTIFACT_ROOT/adapters/codex/hooks/repo-policy.mjs" "$INSTALLED_POLICY"
}

env CODEX_HOME="$SMOKE_HOME" "$CODEX_BIN" plugin marketplace add "$ARTIFACT_ROOT" --json > "$MARKETPLACE_JSON"
MARKETPLACE_NAME="$(jq -er '.marketplaceName' "$MARKETPLACE_JSON")"
env CODEX_HOME="$SMOKE_HOME" "$CODEX_BIN" plugin add "tmb@$MARKETPLACE_NAME" --json > "$INSTALL_JSON"

INSTALLED_PATH="$(jq -er '.installedPath' "$INSTALL_JSON")"
validate_installed_cache

# Codex caches by marketplace/plugin/version. A same-version add is not a
# refresh contract, so exercise the only supported local recovery ceremony:
# remove, prove the stale cache path disappeared, then install and compare.
if ! find "$INSTALLED_HOOKS" -type f -links 1 -print -quit | grep -Fxq "$INSTALLED_HOOKS"; then
  printf 'codex-plugin-surface-smoke: refusing to corrupt an aliased installed Hook: %s\n' "$INSTALLED_HOOKS" >&2
  exit 1
fi
ARTIFACT_HOOK_OID_BEFORE="$(git hash-object "$ARTIFACT_ROOT/hooks/codex/hooks.json")"
printf '{"hooks":{}}\n' > "$INSTALLED_HOOKS"
if [ "$(git hash-object "$ARTIFACT_ROOT/hooks/codex/hooks.json")" != "$ARTIFACT_HOOK_OID_BEFORE" ]; then
  printf 'codex-plugin-surface-smoke: corrupting the cache changed the source artifact\n' >&2
  exit 1
fi
env CODEX_HOME="$SMOKE_HOME" "$CODEX_BIN" plugin remove "tmb@$MARKETPLACE_NAME" --json >/dev/null
if [ -e "$INSTALLED_PATH" ]; then
  printf 'codex-plugin-surface-smoke: plugin remove left the stale cache path active: %s\n' "$INSTALLED_PATH" >&2
  exit 1
fi
env CODEX_HOME="$SMOKE_HOME" "$CODEX_BIN" plugin add "tmb@$MARKETPLACE_NAME" --json > "$INSTALL_JSON"
INSTALLED_PATH="$(jq -er '.installedPath' "$INSTALL_JSON")"
validate_installed_cache

HOOK_DIGEST="$(jq -er '.hooks.PreToolUse[0].hooks[0].command | capture("--policy-sha256 (?<digest>[a-f0-9]{64})").digest' "$INSTALLED_HOOKS")"
HOOK_TIMEOUT="$(jq -er '.hooks.PreToolUse[0].hooks[0].timeout' "$INSTALLED_HOOKS")"
if [ "$HOOK_TIMEOUT" -ne 5 ]; then
  printf 'codex-plugin-surface-smoke: installed Hook timeout is %s, expected 5\n' "$HOOK_TIMEOUT" >&2
  exit 1
fi

HOOK_PROJECT="$SMOKE_HOME/hook-project"
mkdir -p "$HOOK_PROJECT"
git -C "$HOOK_PROJECT" init -q -b main
HOOK_INPUT_BASE="$(jq -nc --arg cwd "$HOOK_PROJECT" '{
  cwd: $cwd,
  hook_event_name: "PreToolUse",
  model: "gpt-test",
  permission_mode: "bypassPermissions",
  session_id: "installed-cache-smoke",
  tool_use_id: "installed-cache-tool",
  transcript_path: null,
  turn_id: "installed-cache-turn"
}')"
ALLOW_INPUT="$(jq -c '. + {tool_name:"Read",tool_input:{file_path:"README.md"}}' <<< "$HOOK_INPUT_BASE")"
DENY_INPUT="$(jq -c '. + {tool_name:"Bash",tool_input:{command:"touch blocked"}}' <<< "$HOOK_INPUT_BASE")"
ALLOW_OUTPUT="$(env -u NODE_PATH PLUGIN_ROOT="$INSTALLED_PATH" node "$INSTALLED_DISPATCHER" --policy-sha256 "$HOOK_DIGEST" <<< "$ALLOW_INPUT")"
if [ -n "$ALLOW_OUTPUT" ]; then
  printf 'codex-plugin-surface-smoke: installed Hook emitted output for an allow decision\n' >&2
  exit 1
fi
DENY_OUTPUT="$(env -u NODE_PATH PLUGIN_ROOT="$INSTALLED_PATH" node "$INSTALLED_DISPATCHER" --policy-sha256 "$HOOK_DIGEST" <<< "$DENY_INPUT")"
jq -e '.hookSpecificOutput.permissionDecision == "deny" and (.hookSpecificOutput.permissionDecisionReason | startswith("TMB-CODEX-HOOK:"))' <<< "$DENY_OUTPUT" >/dev/null
if [ -e "$HOOK_PROJECT/blocked" ]; then
  printf 'codex-plugin-surface-smoke: denied Hook probe produced a side effect\n' >&2
  exit 1
fi

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
printf '  Codex Hook: installed-cache dispatcher digest %s, timeout 5s\n' "$HOOK_DIGEST"
printf '  Claude commands/ and skills/: regular files and Skill directories preserved\n'
printf '  source-command-* migrations: absent\n'
