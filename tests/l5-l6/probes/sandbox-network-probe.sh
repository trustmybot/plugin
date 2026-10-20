#!/usr/bin/env bash
# Headless sandbox network probe (GH 1252, GH 1549).
#
# Measures which of TMB's remote commands still work under Claude Code's Bash
# sandbox, in two settings.local.json setups:
#   A — the filesystem-only block /onboard wrote before GH 1252
#   B — the block /onboard writes today, produced by writeProjectSandbox in the
#       committed dist (allow-list, cache env, macOS trust-service access)
# Each setup runs one `claude -p --model haiku` session in a fresh temp project
# (git init'd, origin = https://github.com/trustmybot/plugin.git) that runs
# every probe command in its own Bash call. Exit codes are read from the
# session's tool results, not from the model's prose. A Bash call that set
# dangerouslyDisableSandbox is reported as `unsandboxed`, never as a pass.
# The `host` column runs the same commands outside Claude Code as a control:
# a B row counts as failed only when the same command passes on the host.
#
# Usage: bash tests/l5-l6/probes/sandbox-network-probe.sh [--keep] [--check-recorded]
#   --check-recorded  exit 1 only when a B failure is not in this platform's
#                     SANDBOX_NETWORK_PROBES entry's failed (all count when the
#                     platform has no entry)
# Needs claude, jq, git, gh, npm, bun, node. Auth: CLAUDE_CODE_OAUTH_TOKEN or
# ANTHROPIC_API_KEY in the environment, else the plugin checkout's .env.
# The push is `--dry-run`: it updates no ref.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
SANDBOX_MODULE="$PLUGIN_ROOT/mcp/trajectory-server/dist/tools/onboard-sandbox.js"
ORIGIN_URL="https://github.com/trustmybot/plugin.git"
CMD_TIMEOUT=120
SESSION_TIMEOUT=600
KEEP=0
CHECK_RECORDED=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --check-recorded) CHECK_RECORDED=1 ;;
    *) echo "sandbox-network-probe: unknown argument $arg" >&2; exit 2 ;;
  esac
done

# shellcheck disable=SC1091
. "$PLUGIN_ROOT/tests/l5-l6/lib/timeout-shim.sh"

COMMANDS=(
  "gh api repos/trustmybot/plugin --jq .name"
  "git ls-remote origin HEAD"
  "git push --dry-run origin HEAD:refs/heads/tmb-probe-noop"
  "npm view is-number version"
  "bun add is-number"
)

[ -f "$SANDBOX_MODULE" ] || { echo "sandbox-network-probe: $SANDBOX_MODULE missing (build dist)" >&2; exit 2; }

for tool in claude jq git gh npm bun node; do
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

WORK="$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-sandbox-net-probe.XXXXXX")"
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

# B is what /onboard writes on yes: writeProjectSandbox from the committed dist,
# logging into the temp project.
write_settings() {
  local dir="$1" setup="$2"
  if [ "$setup" = A ]; then
    jq -n --arg p "$dir" --arg c "$(cache_dir)" \
      '{sandbox: {enabled: true, filesystem: {allowWrite: [$p, $c]}}}' >"$dir/.claude/settings.local.json"
    return
  fi
  # shellcheck disable=SC2016
  TRAJECTORY_DB_PATH="$dir/.claude/tmb/trajectory.db" node --input-type=module -e '
    const [mod, projectRoot, origin] = process.argv.slice(1);
    const { writeProjectSandbox } = await import(mod);
    const r = writeProjectSandbox({ projectRoot, remoteUrls: [origin], previous: null });
    if (!r.written) { console.error(`writeProjectSandbox: ${r.reason}`); process.exit(1); }
  ' "$SANDBOX_MODULE" "$dir" "$ORIGIN_URL" || { echo "sandbox-network-probe: could not write setup B" >&2; exit 2; }
}

recorded_probe() {
  # shellcheck disable=SC2016
  node --input-type=module -e '
    const { SANDBOX_NETWORK_PROBES } = await import(process.argv[1]);
    console.log(JSON.stringify(SANDBOX_NETWORK_PROBES[process.argv[2]] ?? null));
  ' "$SANDBOX_MODULE" "$1"
}

prompt_for() {
  local i=1 c
  printf '%s\n' "You are a network probe. Run each command below with the Bash tool, one Bash call per command, in order, exactly as written (the text between the backticks, verbatim). Do not retry, do not change a command, and never set dangerouslyDisableSandbox. After the last one, print one line per command: RESULT <n> <exit code>."
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

PLATFORM="$(node -p process.platform)"
echo "Claude Code $(claude --version 2>/dev/null | awk '{print $1}'), $PLATFORM, $(date +%Y-%m-%d)"
echo
echo "| Command | host | A: filesystem only | B: /onboard's block |"
echo "|---|---|---|---|"
b_failed=()
for i in $(seq 1 "${#COMMANDS[@]}"); do
  h="$(sed -n "${i}p" "$WORK/host.result")"
  a="$(sed -n "${i}p" "$WORK/A.result")"
  b="$(sed -n "${i}p" "$WORK/B.result")"
  b_cell="$(cell "$b")"
  if [ "$b" != 0 ]; then
    if [ "$h" = 0 ]; then b_failed+=("${COMMANDS[$((i - 1))]}"); else b_cell="$b_cell, not counted: host fails"; fi
  fi
  echo "| \`${COMMANDS[$((i - 1))]}\` | $(cell "$h") | $(cell "$a") | $b_cell |"
done
echo
failed_json="$(printf '%s\n' "${b_failed[@]+"${b_failed[@]}"}" | jq -R . | jq -sc 'map(select(length > 0))')"
echo "platform: $PLATFORM"
echo "B failed: $failed_json"
if [ "${#b_failed[@]}" = 0 ]; then echo "B: every command that passes on the host passed"; else echo "B: at least one command failed"; fi

if [ "$CHECK_RECORDED" = 1 ]; then
  recorded="$(recorded_probe "$PLATFORM")" || { echo "sandbox-network-probe: cannot read SANDBOX_NETWORK_PROBES" >&2; exit 2; }
  regressions="$(jq -nc --argjson rec "$recorded" --argjson now "$failed_json" '$now - ($rec.failed // [])')"
  echo "recorded ($PLATFORM): $recorded"
  if [ "$regressions" = "[]" ]; then
    echo "B: no regression against SANDBOX_NETWORK_PROBES.$PLATFORM"
    exit 0
  fi
  echo "B: regressed against SANDBOX_NETWORK_PROBES.$PLATFORM: $regressions"
  exit 1
fi
[ "${#b_failed[@]}" = 0 ]
