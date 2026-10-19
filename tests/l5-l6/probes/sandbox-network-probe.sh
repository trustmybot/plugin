#!/usr/bin/env bash
# Headless sandbox network probe (GH 1252).
#
# Measures which of TMB's remote commands still work under Claude Code's Bash
# sandbox, in two settings.local.json setups:
#   A — the filesystem-only block /onboard wrote before GH 1252
#   B — A plus TMB's sandbox.network.allowedDomains allow-list
# Each setup runs one `claude -p --model haiku` session in a fresh temp project
# (git init'd, origin = https://github.com/trustmybot/plugin.git) that runs
# every probe command in its own Bash call. Exit codes are read from the
# session's tool results, not from the model's prose. A Bash call that set
# dangerouslyDisableSandbox is reported as `unsandboxed`, never as a pass.
# The `host` column runs the same commands outside Claude Code as a control.
#
# Usage: bash tests/l5-l6/probes/sandbox-network-probe.sh [--keep]
# Needs claude, jq, git, gh, npm, bun. Auth: CLAUDE_CODE_OAUTH_TOKEN or
# ANTHROPIC_API_KEY in the environment, else the plugin checkout's .env.
# The push is `--dry-run`: it updates no ref.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
ORIGIN_URL="https://github.com/trustmybot/plugin.git"
CMD_TIMEOUT=120
SESSION_TIMEOUT=600
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

# shellcheck disable=SC1091
. "$PLUGIN_ROOT/tests/l5-l6/lib/timeout-shim.sh"

COMMANDS=(
  "gh api user --jq .login"
  "git ls-remote origin HEAD"
  "git push --dry-run origin HEAD:refs/heads/tmb-probe-noop"
  "npm view is-number version"
  "bun add is-number"
)

TMB_DOMAINS='["github.com","api.github.com","*.githubusercontent.com","registry.npmjs.org"]'

for tool in claude jq git gh npm bun; do
  command -v "$tool" >/dev/null 2>&1 || { echo "sandbox-network-probe: $tool not on PATH" >&2; exit 2; }
done

load_auth() {
  [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ] && return 0
  local common env_file
  common="$(git -C "$PLUGIN_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || common=""
  for env_file in "$PLUGIN_ROOT/.env" "${common%/.git}/.env"; do
    if [ -f "$env_file" ]; then
      set -a
      # shellcheck disable=SC1090
      . "$env_file"
      set +a
      return 0
    fi
  done
}
load_auth

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tmb-sandbox-net-probe.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
# shellcheck disable=SC2329
cleanup() { if [ "$KEEP" = 1 ]; then echo "kept: $WORK" >&2; else rm -rf "$WORK"; fi; }
trap cleanup EXIT

# A temp project that is its own git repo: in a non-repo dir git walks up.
make_project() {
  local dir="$1"
  mkdir -p "$dir/.claude"
  git init -q -b main "$dir"
  git -C "$dir" config user.email "probe@tmb.invalid"
  git -C "$dir" config user.name "TMB probe"
  git -C "$dir" remote add origin "$ORIGIN_URL"
  echo probe >"$dir/README.md"
  git -C "$dir" add README.md
  git -C "$dir" commit -qm probe
}

cache_dir() {
  if [ -n "${TMB_MODEL_CACHE_DIR:-}" ]; then echo "$TMB_MODEL_CACHE_DIR"
  elif [ -n "${HF_HOME:-}" ]; then echo "$HF_HOME"
  else echo "$HOME/.cache/huggingface"; fi
}

write_settings() {
  local dir="$1" setup="$2"
  local fs
  fs="$(jq -n --arg p "$dir" --arg c "$(cache_dir)" '{enabled: true, filesystem: {allowWrite: [$p, $c]}}')"
  if [ "$setup" = B ]; then
    fs="$(jq --argjson d "$TMB_DOMAINS" '. + {network: {allowedDomains: $d}}' <<<"$fs")"
  fi
  jq -n --argjson s "$fs" '{sandbox: $s}' >"$dir/.claude/settings.local.json"
}

prompt_for() {
  local i=1 c
  printf '%s\n' "You are a network probe. Run each command below with the Bash tool, one Bash call per command, in order, exactly as written (the text between the backticks, verbatim). Do not retry, do not change a command, and never set dangerouslyDisableSandbox. After all five, print one line per command: RESULT <n> <exit code>."
  for c in "${COMMANDS[@]}"; do
    # shellcheck disable=SC2016
    printf '%d. `%s; echo "TMB_PROBE_%d_EXIT=$?"`\n' "$i" "$c" "$i"
    i=$((i + 1))
  done
}

# Per command: the exit code from the transcript, or unsandboxed / not-run.
parse_transcript() {
  local transcript="$1" i id code escaped
  for i in $(seq 1 "${#COMMANDS[@]}"); do
    id="$(jq -r --arg m "TMB_PROBE_${i}_EXIT" '
      select(.type == "assistant") | .message.content[]?
      | select(.type == "tool_use" and .name == "Bash" and ((.input.command // "") | contains($m)))
      | .id' "$transcript" 2>/dev/null | tail -1)"
    if [ -z "$id" ]; then echo "not-run"; continue; fi
    escaped="$(jq -r --arg id "$id" '
      select(.type == "assistant") | .message.content[]?
      | select(.type == "tool_use" and .id == $id) | (.input.dangerouslyDisableSandbox // false)' "$transcript" 2>/dev/null | tail -1)"
    if [ "$escaped" = true ]; then echo "unsandboxed"; continue; fi
    code="$(jq -r --arg id "$id" '
      select(.type == "user") | .message.content[]?
      | select(type == "object" and .type == "tool_result" and .tool_use_id == $id)
      | (.content | if type == "array" then map(.text? // "") | join("\n") else tostring end)' "$transcript" 2>/dev/null \
      | grep -o "TMB_PROBE_${i}_EXIT=[0-9]*" | tail -1 | cut -d= -f2)"
    echo "${code:-no-exit}"
  done
}

run_setup() {
  local setup="$1" dir="$WORK/$1"
  make_project "$dir"
  write_settings "$dir" "$setup"
  (cd "$dir" && _l5_timeout "$SESSION_TIMEOUT" claude -p --model haiku \
    --setting-sources local --strict-mcp-config --no-session-persistence \
    --allowedTools Bash --permission-mode dontAsk \
    --output-format stream-json --verbose "$(prompt_for)") >"$WORK/$setup.jsonl" 2>"$WORK/$setup.stderr"
  parse_transcript "$WORK/$setup.jsonl" >"$WORK/$setup.result"
}

run_host() {
  local dir="$WORK/host" c
  make_project "$dir"
  for c in "${COMMANDS[@]}"; do
    (cd "$dir" && _l5_timeout "$CMD_TIMEOUT" bash -c "$c" >/dev/null 2>&1)
    echo $?
  done >"$WORK/host.result"
}

cell() { if [ "$1" = 0 ]; then echo pass; else echo "FAIL ($1)"; fi; }

run_host
run_setup A
run_setup B

echo "Claude Code $(claude --version 2>/dev/null | awk '{print $1}'), $(date +%Y-%m-%d)"
echo
echo "| Command | host | A: filesystem only | B: A + allowedDomains |"
echo "|---|---|---|---|"
b_failed=0
for i in $(seq 1 "${#COMMANDS[@]}"); do
  h="$(sed -n "${i}p" "$WORK/host.result")"
  a="$(sed -n "${i}p" "$WORK/A.result")"
  b="$(sed -n "${i}p" "$WORK/B.result")"
  [ "$b" = 0 ] || b_failed=1
  echo "| \`${COMMANDS[$((i - 1))]}\` | $(cell "$h") | $(cell "$a") | $(cell "$b") |"
done
echo
if [ "$b_failed" = 0 ]; then echo "B: every command passed"; else echo "B: at least one command failed"; fi
exit "$b_failed"
