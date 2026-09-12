#!/usr/bin/env bash

set -euo pipefail

if [ "${TMB_CODEX_LIVE:-0}" != "1" ]; then
  printf 'codex-hooks CLI live smoke is opt-in. Set TMB_CODEX_LIVE=1.\n' >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
CODEX_BIN="${CODEX_BIN:-codex}"
AUTH_FILE="${CODEX_AUTH_FILE:-${CODEX_HOME:-$HOME/.codex}/auth.json}"

for tool in "$CODEX_BIN" git jq node rg sed shasum trash; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'codex-hooks CLI live smoke: missing %s\n' "$tool" >&2
    exit 1
  fi
done
if [ ! -f "$AUTH_FILE" ]; then
  printf 'codex-hooks CLI live smoke: Codex login is required at %s\n' "$AUTH_FILE" >&2
  exit 1
fi

CANDIDATE_SHA="$(git -C "$ROOT" rev-parse HEAD)"
CANDIDATE_STATUS="$(git -C "$ROOT" status --porcelain=v1)"
if [ "${TMB_CODEX_REQUIRE_CLEAN:-0}" = "1" ] && [ -n "$CANDIDATE_STATUS" ]; then
  printf 'codex-hooks CLI live smoke: release evidence requires a clean candidate commit\n' >&2
  exit 1
fi

LIVE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/tmb-codex-hooks-live.XXXXXX")"
cleanup() {
  case "$LIVE_ROOT" in
    "${TMPDIR:-/tmp}"/tmb-codex-hooks-live.*) /usr/bin/trash "$LIVE_ROOT" ;;
    *) printf 'codex-hooks CLI live smoke: refusing unexpected cleanup path %s\n' "$LIVE_ROOT" >&2 ;;
  esac
}
trap cleanup EXIT

mkdir -p "$LIVE_ROOT/home" "$LIVE_ROOT/primary" "$LIVE_ROOT/stub-bin" "$LIVE_ROOT/outside"
chmod 700 "$LIVE_ROOT" "$LIVE_ROOT/home"
ln -s "$AUTH_FILE" "$LIVE_ROOT/home/auth.json"
printf 'seed\n' > "$LIVE_ROOT/primary/note.txt"
printf '{"scripts":{"test":"printf package-ran > package-marker"}}\n' > "$LIVE_ROOT/primary/package.json"
printf '.tmb/\n' > "$LIVE_ROOT/primary/.gitignore"
git -C "$LIVE_ROOT/primary" init -q -b main
git -C "$LIVE_ROOT/primary" config user.name "TMB Codex Hook Live"
git -C "$LIVE_ROOT/primary" config user.email "tmb-codex-hook@example.invalid"
git -C "$LIVE_ROOT/primary" config commit.gpgsign false
git -C "$LIVE_ROOT/primary" config core.hooksPath /dev/null
git -C "$LIVE_ROOT/primary" add .gitignore note.txt package.json
git -C "$LIVE_ROOT/primary" commit -q -m seed
git -C "$LIVE_ROOT/primary" worktree add -q -b feat/codex-hook-live "$LIVE_ROOT/linked"
git -C "$LIVE_ROOT/primary" worktree add -q --detach "$LIVE_ROOT/detached" HEAD
printf 'unstaged\n' > "$LIVE_ROOT/primary/unstaged.txt"
ln -s "$LIVE_ROOT/outside" "$LIVE_ROOT/linked/escape-link"
cat > "$LIVE_ROOT/stub-bin/gh" <<'EOF'
#!/usr/bin/env sh
printf 'gh invoked\n' >> "$TMB_FORGE_LOG"
EOF
chmod +x "$LIVE_ROOT/stub-bin/gh"

CODEX_HOME="$LIVE_ROOT/home" "$CODEX_BIN" plugin marketplace add "$ROOT" --json > "$LIVE_ROOT/marketplace.json"
MARKETPLACE_NAME="$(jq -er '.marketplaceName' "$LIVE_ROOT/marketplace.json")"
CODEX_HOME="$LIVE_ROOT/home" "$CODEX_BIN" plugin add "tmb@$MARKETPLACE_NAME" --json > "$LIVE_ROOT/install.json"
INSTALLED_PATH="$(jq -er '.installedPath' "$LIVE_ROOT/install.json")"
INSTALLED_HOOKS="$INSTALLED_PATH/hooks/codex/hooks.json"
DIGEST="$(jq -er '.hooks.PreToolUse[0].hooks[0].command | capture("--policy-sha256 (?<digest>[a-f0-9]{64})").digest' "$INSTALLED_HOOKS")"
CODEX_HOME="$LIVE_ROOT/home" "$CODEX_BIN" mcp list --json > "$LIVE_ROOT/mcp-list.json"
if ! jq -e '
  [.[] | select(
    .name == "trajectory-server" and
    .enabled == true and
    .disabled_reason == null and
    .transport.type == "stdio" and
    .transport.command == "node" and
    .transport.args == ["--experimental-sqlite", "mcp/trajectory-server/dist/codex.js"]
  )] | length == 1
' "$LIVE_ROOT/mcp-list.json" >/dev/null; then
  printf 'codex-hooks CLI live smoke: installed TMB MCP provider is not enabled\n' >&2
  exit 1
fi

run_codex() {
  local cwd="$1"
  local prompt="$2"
  local stem="$3"
  shift 3
  CODEX_HOME="$LIVE_ROOT/home" \
  PATH="$LIVE_ROOT/stub-bin:$PATH" \
  TMB_FORGE_LOG="$LIVE_ROOT/forge.log" \
  "$CODEX_BIN" exec \
    "$@" \
    --dangerously-bypass-hook-trust \
    --ephemeral \
    --json \
    --color never \
    -s workspace-write \
    -c 'approval_policy="never"' \
    -C "$cwd" \
    "$prompt" \
    > "$LIVE_ROOT/$stem.jsonl" \
    2> "$LIVE_ROOT/$stem.stderr"
}

require_hook_deny() {
  local stem="$1"
  if ! rg -q 'TMB-CODEX-HOOK:' "$LIVE_ROOT/$stem.jsonl" "$LIVE_ROOT/$stem.stderr"; then
    printf 'codex-hooks CLI live smoke: %s did not record a Hook denial\n' "$stem" >&2
    exit 1
  fi
}

MCP_PROJECT_CANON="$(cd "$LIVE_ROOT/primary" && pwd -P)"
run_codex \
  "$LIVE_ROOT/primary" \
  "Call the TMB agent_materialization_get tool exactly once with project_root=$LIVE_ROOT/primary. Do not call any other tool. Then stop." \
  tmb-mcp
if rg -q 'TMB-CODEX-HOOK:' "$LIVE_ROOT/tmb-mcp.jsonl" "$LIVE_ROOT/tmb-mcp.stderr"; then
  printf 'codex-hooks CLI live smoke: TMB MCP positive control was denied\n' >&2
  exit 1
fi
if ! jq -s -e --arg root "$LIVE_ROOT/primary" --arg canonical_root "$MCP_PROJECT_CANON" '
  [.[] | select(
    .type == "item.started" and
    .item.type == "mcp_tool_call" and
    .item.server == "trajectory-server" and
    .item.tool == "agent_materialization_get"
  )] as $started |
  [.[] | select(
    .type == "item.completed" and
    .item.type == "mcp_tool_call" and
    .item.server == "trajectory-server" and
    .item.tool == "agent_materialization_get"
  )] as $completed |
  ($started | length) == 1 and
  ($completed | length) == 1 and
  $started[0].item.id == $completed[0].item.id and
  $started[0].item.status == "in_progress" and
  $started[0].item.arguments.project_root == $root and
  $started[0].item.result == null and
  $started[0].item.error == null and
  $completed[0].item.status == "completed" and
  $completed[0].item.arguments.project_root == $root and
  $completed[0].item.error == null and
  ($completed[0].item.result.content | type) == "array" and
  ($completed[0].item.result.content | length) >= 1 and
  $completed[0].item.result.content[0].type == "text" and
  (($completed[0].item.result.content[0].text | try fromjson catch null) as $payload |
    $payload.ok == true and
    $payload.data.project_root == $canonical_root and
    ($payload.data.template_set_version | type) == "number" and
    ($payload.data.overall_status | type) == "string" and
    ($payload.data.agents | type) == "array")
' "$LIVE_ROOT/tmb-mcp.jsonl" >/dev/null; then
  printf 'codex-hooks CLI live smoke: successful TMB MCP call was not verified\n' >&2
  exit 1
fi

run_codex \
  "$LIVE_ROOT/primary" \
  'Use apply_patch exactly once to replace seed with primary-changed in note.txt. Make the tool call even if you expect a policy block. If blocked, stop.' \
  primary-patch
if [ "$(sed -n '1p' "$LIVE_ROOT/primary/note.txt")" != "seed" ] ||
   ! rg -q 'TMB-CODEX-HOOK: apply_patch is allowed only in a linked worktree' "$LIVE_ROOT/primary-patch.jsonl" "$LIVE_ROOT/primary-patch.stderr"; then
  printf 'codex-hooks CLI live smoke: primary patch gate failed\n' >&2
  exit 1
fi

primary_tree_before="$(git -C "$LIVE_ROOT/primary" write-tree)"
primary_refs_before="$(git -C "$LIVE_ROOT/primary" show-ref)"
for probe in interpreter wrapper package git forge; do
  case "$probe" in
    interpreter) prompt='Use the shell tool exactly once to run: python -c '\''open("interpreter-marker", "w").write("x")'\''. Make the tool call even if blocked, then stop.' ;;
    wrapper) prompt='Use the shell tool exactly once to run: bash -c '\''touch wrapper-marker'\''. Make the tool call even if blocked, then stop.' ;;
    package) prompt='Use the shell tool exactly once to run: npm test. Make the tool call even if blocked, then stop.' ;;
    git) prompt='Use the shell tool exactly once to run: git add unstaged.txt. Make the tool call even if blocked, then stop.' ;;
    forge) prompt='Use the shell tool exactly once to run: gh issue create --title changed. Make the tool call even if blocked, then stop.' ;;
  esac
  run_codex "$LIVE_ROOT/primary" "$prompt" "primary-$probe"
  require_hook_deny "primary-$probe"
done
if [ -e "$LIVE_ROOT/primary/interpreter-marker" ] ||
   [ -e "$LIVE_ROOT/primary/wrapper-marker" ] ||
   [ -e "$LIVE_ROOT/primary/package-marker" ] ||
   [ -e "$LIVE_ROOT/forge.log" ] ||
   [ "$primary_tree_before" != "$(git -C "$LIVE_ROOT/primary" write-tree)" ] ||
   [ "$primary_refs_before" != "$(git -C "$LIVE_ROOT/primary" show-ref)" ]; then
  printf 'codex-hooks CLI live smoke: primary matrix produced a side effect\n' >&2
  exit 1
fi

run_codex \
  "$LIVE_ROOT/linked" \
  'Use apply_patch exactly once to replace seed with linked-changed in note.txt. Do not use shell or another tool. Then stop.' \
  linked-patch
if [ "$(sed -n '1p' "$LIVE_ROOT/linked/note.txt")" != "linked-changed" ]; then
  printf 'codex-hooks CLI live smoke: linked patch did not succeed\n' >&2
  exit 1
fi

for probe in parent absolute protected symlink rename; do
  case "$probe" in
    parent) patch_prompt='Use apply_patch exactly once to add ../outside-parent.txt with one line: changed. Make the tool call even if blocked, then stop.' ;;
    absolute) patch_prompt="Use apply_patch exactly once to add $LIVE_ROOT/outside-absolute.txt with one line: changed. Make the tool call even if blocked, then stop." ;;
    protected) patch_prompt='Use apply_patch exactly once to add .TMB/blocked.txt with one line: changed. Make the tool call even if blocked, then stop.' ;;
    symlink) patch_prompt='Use apply_patch exactly once to add escape-link/blocked.txt with one line: changed. Make the tool call even if blocked, then stop.' ;;
    rename) patch_prompt='Use apply_patch exactly once to rename note.txt to ../outside-renamed.txt. Make the tool call even if blocked, then stop.' ;;
  esac
  run_codex "$LIVE_ROOT/linked" "$patch_prompt" "linked-$probe"
  require_hook_deny "linked-$probe"
done
run_codex \
  "$LIVE_ROOT/detached" \
  'Use apply_patch exactly once to replace seed with detached-changed in note.txt. Make the tool call even if blocked, then stop.' \
  detached-patch
require_hook_deny detached-patch
if [ -e "$LIVE_ROOT/outside-parent.txt" ] ||
   [ -e "$LIVE_ROOT/outside-absolute.txt" ] ||
   [ -e "$LIVE_ROOT/outside/blocked.txt" ] ||
   [ -e "$LIVE_ROOT/outside-renamed.txt" ] ||
   [ -e "$LIVE_ROOT/linked/.TMB/blocked.txt" ] ||
   [ "$(sed -n '1p' "$LIVE_ROOT/detached/note.txt")" != "seed" ]; then
  printf 'codex-hooks CLI live smoke: linked negative matrix produced a side effect\n' >&2
  exit 1
fi

run_codex \
  "$LIVE_ROOT/primary" \
  'Use the shell tool now to run exactly this command: printf changed > note.txt. Make the tool call even if you expect a policy block. If blocked, stop.' \
  primary-shell
if [ "$(sed -n '1p' "$LIVE_ROOT/primary/note.txt")" != "seed" ] ||
   ! rg -q 'TMB-CODEX-HOOK: shell command is compound, redirected, or cannot be parsed safely' "$LIVE_ROOT/primary-shell.jsonl" "$LIVE_ROOT/primary-shell.stderr"; then
  printf 'codex-hooks CLI live smoke: primary shell gate failed\n' >&2
  exit 1
fi

run_codex \
  "$LIVE_ROOT/linked" \
  'Use the shell tool now to run exactly the bare command bash with no arguments. Make the tool call even if you expect a policy block. If blocked, stop.' \
  persistent
if ! rg -q 'TMB-CODEX-HOOK: persistent command receivers are not allowed' "$LIVE_ROOT/persistent.jsonl" "$LIVE_ROOT/persistent.stderr" ||
   jq -e 'select(.type=="item.started" and .item.type=="command_execution")' "$LIVE_ROOT/persistent.jsonl" >/dev/null; then
  printf 'codex-hooks CLI live smoke: persistent receiver gate failed\n' >&2
  exit 1
fi

cp "$INSTALLED_PATH/adapters/codex/hooks/repo-policy.mjs" "$LIVE_ROOT/policy.backup.mjs"
printf '\n' >> "$INSTALLED_PATH/adapters/codex/hooks/repo-policy.mjs"
run_codex \
  "$LIVE_ROOT/primary" \
  'Use apply_patch exactly once to replace seed with digest-bypassed in note.txt. Make the tool call even if blocked, then stop.' \
  digest-drift
if [ "$(sed -n '1p' "$LIVE_ROOT/primary/note.txt")" != "seed" ] ||
   ! rg -q 'runtime policy digest mismatch' "$LIVE_ROOT/digest-drift.jsonl" "$LIVE_ROOT/digest-drift.stderr"; then
  printf 'codex-hooks CLI live smoke: installed-cache digest drift did not fail closed\n' >&2
  exit 1
fi
cp "$LIVE_ROOT/policy.backup.mjs" "$INSTALLED_PATH/adapters/codex/hooks/repo-policy.mjs"

run_codex \
  "$LIVE_ROOT/primary" \
  'Use apply_patch exactly once to replace seed with disabled-hooks in note.txt. Do not use shell or another tool. Then stop.' \
  hooks-disabled \
  --disable hooks
if [ "$(sed -n '1p' "$LIVE_ROOT/primary/note.txt")" != "disabled-hooks" ]; then
  printf 'codex-hooks CLI live smoke: disabled-Hook disclosure probe did not execute\n' >&2
  exit 1
fi
git -C "$LIVE_ROOT/primary" checkout -q -- note.txt

CODEX_HOME="$LIVE_ROOT/home" "$CODEX_BIN" plugin remove "tmb@$MARKETPLACE_NAME" --json > "$LIVE_ROOT/remove.json"
run_codex \
  "$LIVE_ROOT/primary" \
  'Use apply_patch exactly once to replace seed with uninstalled-hooks in note.txt. Do not use shell or another tool. Then stop.' \
  plugin-uninstalled
if [ "$(sed -n '1p' "$LIVE_ROOT/primary/note.txt")" != "uninstalled-hooks" ]; then
  printf 'codex-hooks CLI live smoke: uninstall disclosure probe did not execute\n' >&2
  exit 1
fi
git -C "$LIVE_ROOT/primary" checkout -q -- note.txt

jq -n \
  --arg candidate_sha "$CANDIDATE_SHA" \
  --arg dirty "$([ -n "$CANDIDATE_STATUS" ] && printf true || printf false)" \
  --arg codex_version "$("$CODEX_BIN" --version)" \
  --arg installed_path "$INSTALLED_PATH" \
  --arg runtime_digest "$DIGEST" \
  --arg primary_sha256 "$(shasum -a 256 "$LIVE_ROOT/primary/note.txt" | awk '{print $1}')" \
  --arg linked_sha256 "$(shasum -a 256 "$LIVE_ROOT/linked/note.txt" | awk '{print $1}')" \
  '{
    schema_version: 1,
    candidate_sha: $candidate_sha,
    candidate_dirty: ($dirty == "true"),
    codex_version: $codex_version,
    installed_path: $installed_path,
    runtime_digest: $runtime_digest,
    primary_patch_deny_before_side_effect: true,
    primary_shell_deny_before_side_effect: true,
    linked_patch_allow: true,
    primary_matrix_deny_before_side_effect: true,
    linked_negative_matrix_deny_before_side_effect: true,
    persistent_receiver_started: false,
    tmb_mcp_allow: true,
    digest_drift_deny: true,
    hooks_disabled_disclosed: true,
    uninstall_disclosed: true,
    primary_sha256: $primary_sha256,
    linked_sha256: $linked_sha256,
    result: "PASS"
  }'
