#!/usr/bin/env bash
# Public-seam integration tests for the zero-dependency Codex dispatcher.

set -euo pipefail

export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=commit.gpgsign
export GIT_CONFIG_VALUE_0=false
export GIT_CONFIG_KEY_1=core.hooksPath
export GIT_CONFIG_VALUE_1=/dev/null

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
DISPATCHER="$PLUGIN_ROOT/adapters/codex/hooks/dispatcher.mjs"
MANIFEST="$PLUGIN_ROOT/hooks/codex/hooks.json"
DIGEST="$(jq -er '.hooks.PreToolUse[0].hooks[0].command | capture("--policy-sha256 (?<digest>[a-f0-9]{64})").digest' "$MANIFEST")"

FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/tmb-codex-hooks-l3.XXXXXX")"
PRIMARY="$FIXTURE/repo"
LINKED="$FIXTURE/linked"
mkdir -p "$PRIMARY/src"
printf 'seed\n' > "$PRIMARY/src/tracked.txt"
git -C "$PRIMARY" init -q -b main
git -C "$PRIMARY" config user.name "TMB Hook Test"
git -C "$PRIMARY" config user.email "tmb-hook@example.invalid"
git -C "$PRIMARY" add src/tracked.txt
git -C "$PRIMARY" commit -q -m seed
git -C "$PRIMARY" worktree add -q -b feat/codex-hook-test "$LINKED"

cleanup() {
  case "$FIXTURE" in
    "${TMPDIR:-/tmp}"/tmb-codex-hooks-l3.*) rm -rf -- "$FIXTURE" ;;
    *) printf 'codex-hooks.test: refusing unexpected cleanup path %s\n' "$FIXTURE" >&2 ;;
  esac
}
trap cleanup EXIT

make_input() {
  local cwd="$1"
  local tool_name="$2"
  local tool_input="$3"
  jq -nc \
    --arg cwd "$cwd" \
    --arg tool_name "$tool_name" \
    --argjson tool_input "$tool_input" \
    '{
      cwd: $cwd,
      hook_event_name: "PreToolUse",
      model: "gpt-test",
      permission_mode: "bypassPermissions",
      session_id: "l3-session",
      tool_input: $tool_input,
      tool_name: $tool_name,
      tool_use_id: "l3-tool",
      transcript_path: null,
      turn_id: "l3-turn"
    }'
}

make_exec_input() {
  local cwd="$1"
  local command="$2"
  local overrides="${3-}"
  local fields source
  if [ -z "$overrides" ]; then overrides='{}'; fi
  fields="$(jq -nc --arg cmd "$command" --arg workdir "$cwd" --argjson overrides "$overrides" \
    '{cmd:$cmd,workdir:$workdir,shell:"/bin/sh",login:false,tty:false} + $overrides | with_entries(select(.value != null))')"
  source="text(JSON.stringify(await tools.exec_command($fields)));"
  make_input "$cwd" "functions.exec" "$(jq -nc --arg source "$source" '$source')"
}

make_restricted_command() {
  node --input-type=module - "$1" "$2" "${3:-$PLUGIN_ROOT}" <<'NODE'
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [cwd, command, pluginRoot] = process.argv.slice(2);
const { makeRestrictedCommand } = await import(pathToFileURL(resolve(pluginRoot, "adapters/codex/hooks/repo-policy.mjs")));
process.stdout.write(makeRestrictedCommand(command, realpathSync(cwd), { pluginRoot }));
NODE
}

make_restricted_input() {
  make_exec_input "$1" "$(make_restricted_command "$1" "$2" "${3:-$PLUGIN_ROOT}")" "${4-}"
}

tamper_restricted_command() {
  node --input-type=module - "$@" <<'NODE'
import { realpathSync } from "node:fs";
const [command, tamper, cwd, otherCwd] = process.argv.slice(2);
const quote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const changed = {
  path: () => command.replace(/'PATH=[^']*'/u, "'PATH=/nonexistent'"),
  environment: () => command.replace("'-i'", "'-i' 'NODE_OPTIONS=--import=/tmp/fixture-preload.mjs'"),
  runner: () => command.replace("/restricted-runner.mjs", "/dispatcher.mjs"),
  digest: () => command.replace(/'[a-f0-9]{64}'/u, `'${"0".repeat(64)}'`),
  cwd: () => command.replace(quote(realpathSync(cwd)), quote(realpathSync(otherCwd))),
}[tamper]();
if (changed === command) throw new Error(`fixture did not tamper with ${tamper}`);
process.stdout.write(changed);
NODE
}

run_hook() {
  PLUGIN_ROOT="$PLUGIN_ROOT" node "$DISPATCHER" --policy-sha256 "$DIGEST" <<< "$1"
}

assert_deny() {
  local output="$1"
  assert_eq "deny" "$(jq -er '.hookSpecificOutput.permissionDecision' <<< "$output")" "deny decision"
  assert_contains "$output" "TMB-CODEX-HOOK:" "stable denial reason"
}

assert_restricted_allow() {
  local output="$1"
  local label="$2"
  if [ "$(uname -s)" = "Darwin" ]; then
    assert_eq "" "$output" "$label"
  else
    assert_deny "$output"
    assert_contains "$output" "requires the qualified macOS sandbox" "unsupported host stays closed"
  fi
}

assert_inner_deny() {
  local output="$1"
  local reason="$2"
  assert_deny "$output"
  if [ "$(uname -s)" = "Darwin" ]; then
    assert_contains "$output" "$reason" "reviewed inner command denial"
  else
    assert_contains "$output" "requires the qualified macOS sandbox" "unsupported host stays closed"
  fi
}

test_case "primary read-only tool is silent"
input="$(make_input "$PRIMARY" "Read" '{"file_path":"src/tracked.txt"}')"
assert_eq "" "$(run_hook "$input")" "Read is allowed with empty stdout"

test_case "primary write alternatives fail closed under bypassPermissions"
sentinel_before="$(shasum -a 256 "$PRIMARY/src/tracked.txt" | awk '{print $1}')"
tree_before="$(git -C "$PRIMARY" write-tree)"
for command in \
  "sed -i '' 's/seed/changed/' src/tracked.txt" \
  "tee src/tracked.txt" \
  "printf changed > src/tracked.txt" \
  "python -c 'open(\"src/tracked.txt\", \"w\").write(\"x\")'" \
  "bash -c 'touch src/new.txt'" \
  "git add src/tracked.txt" \
  "gh issue create --title changed"; do
  input="$(make_input "$PRIMARY" "Bash" "$(jq -nc --arg command "$command" '{command:$command}')")"
  assert_deny "$(run_hook "$input")"
done
assert_eq "$sentinel_before" "$(shasum -a 256 "$PRIMARY/src/tracked.txt" | awk '{print $1}')" "primary sentinel hash unchanged"
assert_eq "$tree_before" "$(git -C "$PRIMARY" write-tree)" "primary Git index tree unchanged"
if [ -e "$PRIMARY/src/new.txt" ]; then
  alternate_side_effect="present"
else
  alternate_side_effect="absent"
fi
assert_eq "absent" "$alternate_side_effect" "no alternate write side effect"

test_case "persistent receivers stay denied while lifecycle control is bounded"
input="$(make_input "$LINKED" "exec_command" '{"cmd":"bash","tty":true}')"
assert_deny "$(run_hook "$input")"
for lifecycle_input in \
  '{"session_id":42}' \
  '{"session_id":42,"chars":""}' \
  '{"session_id":42,"chars":"\u0003"}'; do
  input="$(make_input "$LINKED" "write_stdin" "$lifecycle_input")"
  assert_eq "" "$(run_hook "$input")" "bounded lifecycle input is allowed"
done
input="$(make_input "$LINKED" "write_stdin" '{"session_id":42,"chars":"git push\n"}')"
assert_deny "$(run_hook "$input")"

test_case "diagnostic orchestration and exact TMB recovery stay reachable"
input="$(make_input "$PRIMARY" "functions.exec" '"text(JSON.stringify(await tools.exec_command({\"cmd\":\"pwd\",\"login\":false})));"')"
assert_eq "" "$(run_hook "$input")" "statically audited read-only orchestration is allowed"
input="$(make_input "$PRIMARY" "functions.exec" '"text(JSON.stringify(await tools.exec_command({\"cmd\":\"touch blocked\",\"login\":false})));"')"
assert_deny "$(run_hook "$input")"
input="$(make_input "$PRIMARY" "functions.exec" '"text(true);"')"
assert_deny "$(run_hook "$input")"
input="$(make_input "$PRIMARY" "mcp__codex_app__read_thread_terminal" '{}')"
assert_eq "" "$(run_hook "$input")" "read-only terminal diagnostic is allowed"
input="$(make_input "$PRIMARY" "mcp__codex_app__uninstall_plugin" '{"plugin":"tmb@trustmybot-local"}')"
assert_eq "" "$(run_hook "$input")" "exact TMB uninstall recovery is allowed"
input="$(make_input "$PRIMARY" "mcp__codex_app__uninstall_plugin" '{"plugin":"another-plugin"}')"
assert_deny "$(run_hook "$input")"
input="$(make_input "$PRIMARY" "Bash" '{"command":"git push origin HEAD"}')"
assert_deny "$(run_hook "$input")"

test_case "restricted feature-branch delivery is state-gated"
input="$(make_restricted_input "$PRIMARY" "git switch -c codex/from-main")"
assert_restricted_allow "$(run_hook "$input")" "protected branch can create a feature branch recovery path"
input="$(make_restricted_input "$PRIMARY" "git checkout -b feat/from-main")"
assert_restricted_allow "$(run_hook "$input")" "Claude-compatible checkout -b feature creation is allowed"
for command in \
  "git add -- src/tracked.txt" \
  "git commit -m changed" \
  "git commit -m \"fix contributor's test\"" \
  "git push -u origin feat/codex-hook-test"; do
  input="$(make_restricted_input "$LINKED" "$command")"
  assert_restricted_allow "$(run_hook "$input")" "$command is allowed on the current feature branch"
done
for command in \
  "git add ." \
  "git commit --amend -m changed" \
  "git push --force origin feat/codex-hook-test" \
  "git merge main"; do
  case "$command" in
    "git add .") reason="git add requires explicit file paths after --" ;;
    "git commit"*) reason="without amend or bypass flags" ;;
    "git push"*) reason="without force or extra refspecs" ;;
    *) reason="outside the bounded feature-branch delivery lane" ;;
  esac
  input="$(make_restricted_input "$LINKED" "$command")"
  assert_inner_deny "$(run_hook "$input")" "$reason"
done

test_case "Git queries, validation, and forge reads require the installed runner"
TRUSTED_FORGE_BIN="$FIXTURE/trusted-forge-bin"
FORGE_MARKER="$FIXTURE/forge-executed"
mkdir -p "$TRUSTED_FORGE_BIN"
printf '#!/bin/sh\nprintf "unexpected\\n" > "%s"\nexit 0\n' "$FORGE_MARKER" > "$TRUSTED_FORGE_BIN/gh"
chmod +x "$TRUSTED_FORGE_BIN/gh"
previous_host_path="${TMB_CODEX_HOOK_HOST_PATH-}"
previous_host_path_set="${TMB_CODEX_HOOK_HOST_PATH+set}"
export TMB_CODEX_HOOK_HOST_PATH="$TRUSTED_FORGE_BIN:$PATH"
for command in \
  "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null status --short" \
  "git add -- src/tracked.txt" \
  "node --test src/tracked.txt" \
  "gh pr view 1183 --json number,title"; do
  input="$(make_input "$LINKED" "Bash" "$(jq -nc --arg command "$command" '{command:$command}')")"
  output="$(run_hook "$input")"
  assert_deny "$output"
  assert_contains "$output" "require the installed restricted runner" "$command raw denial reaches the execution boundary"
  input="$(make_exec_input "$LINKED" "$command")"
  output="$(run_hook "$input")"
  assert_deny "$output"
  assert_contains "$output" "require the installed restricted runner" "$command nested raw denial reaches the execution boundary"
  input="$(make_restricted_input "$LINKED" "$command")"
  assert_restricted_allow "$(run_hook "$input")" "$command uses the installed runner"
done
for command in "node --test --watch src/tracked.txt" "gh pr view 1183 --web"; do
  case "$command" in
    node*) reason="outside reviewed reads, contained patches, validation, or delivery" ;;
    *) reason="forge" ;;
  esac
  input="$(make_restricted_input "$LINKED" "$command")"
  assert_inner_deny "$(run_hook "$input")" "$reason"
done
assert_eq "false" "$([ -e "$FORGE_MARKER" ] && echo true || echo false)" "Hook admission does not execute the forge fixture"
if [ "$previous_host_path_set" = set ]; then
  export TMB_CODEX_HOOK_HOST_PATH="$previous_host_path"
else
  unset TMB_CODEX_HOOK_HOST_PATH
fi

test_case "restricted runner transport rejects altered shell controls and identity"
restricted_command="$(make_restricted_command "$LINKED" "git push origin feat/codex-hook-test")"
for overrides in \
  '{"shell":null}' '{"shell":"/bin/bash"}' \
  '{"login":null}' '{"login":true}' \
  '{"tty":null}' '{"tty":true}' \
  '{"workdir":null}' "$(jq -nc --arg workdir "$PRIMARY" '{workdir:$workdir}')"; do
  input="$(make_exec_input "$LINKED" "$restricted_command" "$overrides")"
  assert_deny "$(run_hook "$input")"
done
for tool_name in Bash exec_command; do
  if [ "$tool_name" = Bash ]; then
    fields="$(jq -nc --arg command "$restricted_command" '{command:$command}')"
  else
    fields="$(jq -nc --arg cmd "$restricted_command" --arg workdir "$LINKED" '{cmd:$cmd,workdir:$workdir,shell:"/bin/sh",login:false,tty:false}')"
  fi
  input="$(make_input "$LINKED" "$tool_name" "$fields")"
  assert_deny "$(run_hook "$input")"
done
for tamper in path environment runner digest cwd; do
  changed_command="$(tamper_restricted_command "$restricted_command" "$tamper" "$LINKED" "$PRIMARY")"
  input="$(make_exec_input "$LINKED" "$changed_command")"
  assert_deny "$(run_hook "$input")"
done
input="$(make_exec_input "$LINKED" "$restricted_command" '{"sandbox_permissions":"require_escalated","justification":"Run the pinned restricted runner for this fixture."}')"
assert_restricted_allow "$(run_hook "$input")" "outer sandbox request preserves the pinned runner boundary"
input="$(make_exec_input "$LINKED" "pwd" '{"sandbox_permissions":"require_escalated"}')"
output="$(run_hook "$input")"
assert_deny "$output"
assert_contains "$output" "outer sandbox escalation is accepted only for the exact pinned restricted runner" "raw diagnostics cannot request outer sandbox escalation"

test_case "linked apply_patch is contained to the canonical worktree"
valid_patch='*** Begin Patch
*** Update File: src/tracked.txt
@@
-seed
+changed
*** End Patch'
input="$(make_input "$LINKED" "apply_patch" "$(jq -nc --arg command "$valid_patch" '{command:$command}')")"
assert_eq "" "$(run_hook "$input")" "in-root linked patch is allowed"

for blocked_patch in \
  $'*** Begin Patch\n*** Add File: ../outside.txt\n+x\n*** End Patch' \
  $'*** Begin Patch\n*** Add File: .git/config\n+x\n*** End Patch' \
  $'*** Begin Patch\n*** Add File: .codex/hooks.json\n+x\n*** End Patch'; do
  input="$(make_input "$LINKED" "apply_patch" "$(jq -nc --arg command "$blocked_patch" '{command:$command}')")"
  assert_deny "$(run_hook "$input")"
done

test_case "malformed input and digest drift deny"
assert_deny "$(printf '{bad-json' | node "$DISPATCHER" --policy-sha256 "$DIGEST")"
assert_deny "$(run_hook "$(make_input "$PRIMARY" "Bash" '{}')")"
assert_deny "$(printf '%s' "$(make_input "$PRIMARY" "Read" '{}')" | node "$DISPATCHER" --policy-sha256 "$(printf '0%.0s' {1..64})")"

test_case "manifest uses a sanitized Node lookup and falls back closed"
STUB_BIN="$PRIMARY/stub-bin"
mkdir -p "$STUB_BIN"
NODE_SHADOW_MARKER="$FIXTURE/node-shadow-ran"
printf '#!/usr/bin/env sh\ntouch "%s"\nexit 0\n' "$NODE_SHADOW_MARKER" > "$STUB_BIN/node"
chmod +x "$STUB_BIN/node"
# A later host PATH candidate must work without a system Node installation.
# The wrapper marker proves the launcher used this candidate, not a fallback.
TRUSTED_NODE_BIN="$FIXTURE/trusted host/.nvm/versions/node/vfixture/bin"
TRUSTED_NODE_MARKER="$FIXTURE/trusted-node-ran"
mkdir -p "$TRUSTED_NODE_BIN"
printf '#!/bin/sh\nprintf "selected\\n" > "%s"\nexec "%s" "$@"\n' \
  "$TRUSTED_NODE_MARKER" "$(node -p 'process.execPath')" > "$TRUSTED_NODE_BIN/node"
chmod +x "$TRUSTED_NODE_BIN/node"
MANIFEST_COMMAND="$(jq -er '.hooks.PreToolUse[0].hooks[0].command' "$MANIFEST")"
input="$(make_input "$PRIMARY" "Read" '{"file_path":"src/tracked.txt"}')"
shadow_output="$(cd "$PRIMARY" && PATH="$STUB_BIN:$TRUSTED_NODE_BIN:/usr/bin:/bin" PLUGIN_ROOT="$PLUGIN_ROOT" /bin/sh -c "$MANIFEST_COMMAND" <<< "$input")"
assert_eq "" "$shadow_output" "repository PATH node does not intercept the dispatcher"
assert_eq "false" "$([ -e "$NODE_SHADOW_MARKER" ] && echo true || echo false)" "repository PATH node was not executed"
assert_eq "true" "$([ -e "$TRUSTED_NODE_MARKER" ] && echo true || echo false)" "later external version-managed Node was selected"
rm "$TRUSTED_NODE_MARKER"
nested_shadow_output="$(cd "$PRIMARY/src" && PATH="$STUB_BIN:$TRUSTED_NODE_BIN:/usr/bin:/bin" PLUGIN_ROOT="$PLUGIN_ROOT" /bin/sh -c "$MANIFEST_COMMAND" <<< "$input")"
assert_eq "" "$nested_shadow_output" "repository-root Node shim is rejected from a nested cwd"
assert_eq "false" "$([ -e "$NODE_SHADOW_MARKER" ] && echo true || echo false)" "nested cwd did not execute the repository Node shim"
assert_eq "true" "$([ -e "$TRUSTED_NODE_MARKER" ] && echo true || echo false)" "nested cwd selected the later external Node"
blocked_input="$(make_input "$PRIMARY" "Bash" '{"command":"touch src/node-shadow-bypass"}')"
blocked_shadow_output="$(cd "$PRIMARY" && PATH="$STUB_BIN:$TRUSTED_NODE_BIN:/usr/bin:/bin" PLUGIN_ROOT="$PLUGIN_ROOT" /bin/sh -c "$MANIFEST_COMMAND" <<< "$blocked_input")"
assert_deny "$blocked_shadow_output"
rm "$TRUSTED_NODE_MARKER"
relative_shadow_output="$(cd "$PRIMARY" && PATH="stub-bin:$TRUSTED_NODE_BIN:/usr/bin:/bin" PLUGIN_ROOT="$PLUGIN_ROOT" /bin/sh -c "$MANIFEST_COMMAND" <<< "$input")"
assert_eq "" "$relative_shadow_output" "relative PATH entry does not hide the later external Node"
assert_eq "false" "$([ -e "$NODE_SHADOW_MARKER" ] && echo true || echo false)" "relative repository Node was not executed"
assert_eq "true" "$([ -e "$TRUSTED_NODE_MARKER" ] && echo true || echo false)" "relative PATH entry was skipped before selecting external Node"

test_case "manifest routes once when Hook PWD cannot attest the payload cwd"
OTHER_REPO="$FIXTURE/other-repo"
mkdir -p "$OTHER_REPO"
git -C "$OTHER_REPO" init -q -b main
other_repo_output="$(cd "$OTHER_REPO" && PLUGIN_ROOT="$PLUGIN_ROOT" /bin/sh -c "$MANIFEST_COMMAND" <<< "$input")"
assert_eq "" "$other_repo_output" "different checkout PWD routes to payload cwd resolution"
outside_repo_output="$(cd "$FIXTURE" && PLUGIN_ROOT="$PLUGIN_ROOT" /bin/sh -c "$MANIFEST_COMMAND" <<< "$input")"
assert_eq "" "$outside_repo_output" "non-repository PWD routes to payload cwd resolution"
outside_repo_pwd_input="$(make_input "$PRIMARY" "Bash" '{"command":"pwd"}')"
outside_repo_pwd_output="$(cd "$FIXTURE" && PLUGIN_ROOT="$PLUGIN_ROOT" /bin/sh -c "$MANIFEST_COMMAND" <<< "$outside_repo_pwd_input")"
assert_eq "" "$outside_repo_pwd_output" "worker resolves the branch-backed payload cwd for a safe shell command"
outside_repo_write_input="$(make_input "$PRIMARY" "Bash" '{"command":"touch src/pwd-bypass"}')"
outside_repo_write_output="$(cd "$FIXTURE" && PLUGIN_ROOT="$PLUGIN_ROOT" /bin/sh -c "$MANIFEST_COMMAND" <<< "$outside_repo_write_input")"
assert_deny "$outside_repo_write_output"
assert_eq "false" "$([ -e "$PRIMARY/src/pwd-bypass" ] && echo true || echo false)" "worker keeps primary writes denied"

MANAGED_BIN="$FIXTURE/.asdf/shims"
mkdir -p "$MANAGED_BIN"
MANAGED_NODE_MARKER="$FIXTURE/version-managed-node-ran"
printf '#!/usr/bin/env sh\nif [ "$1" = "-p" ]; then\n  printf "%%s\\n" "%s"\n  touch "%s"\n  exit 0\nfi\nexit 91\n' \
  "$TRUSTED_NODE_BIN/node" "$MANAGED_NODE_MARKER" > "$MANAGED_BIN/node"
chmod +x "$MANAGED_BIN/node"
rm "$TRUSTED_NODE_MARKER"
managed_output="$(cd "$PRIMARY" && PATH="$STUB_BIN:$MANAGED_BIN:/usr/bin:/bin" PLUGIN_ROOT="$PLUGIN_ROOT" /bin/sh -c "$MANIFEST_COMMAND" <<< "$input")"
assert_eq "" "$managed_output" "version-managed Node resolves to its real executable"
assert_eq "true" "$([ -e "$MANAGED_NODE_MARKER" ] && echo true || echo false)" "version-managed Node launcher was consulted"
assert_eq "true" "$([ -e "$TRUSTED_NODE_MARKER" ] && echo true || echo false)" "version-managed Node executed its trusted external target"
assert_eq "false" "$([ -e "$NODE_SHADOW_MARKER" ] && echo true || echo false)" "repository Node preceding the version manager was not executed"
UNTRUSTED_TARGET_BIN="$FIXTURE/unsafe-target/.asdf/shims"
mkdir -p "$UNTRUSTED_TARGET_BIN"
printf '#!/bin/sh\nprintf "%%s\\n" "%s"\n' "$STUB_BIN/node" > "$UNTRUSTED_TARGET_BIN/node"
chmod +x "$UNTRUSTED_TARGET_BIN/node"
rm "$TRUSTED_NODE_MARKER"
untrusted_target_output="$(cd "$PRIMARY" && PATH="$UNTRUSTED_TARGET_BIN:$TRUSTED_NODE_BIN:/usr/bin:/bin" PLUGIN_ROOT="$PLUGIN_ROOT" /bin/sh -c "$MANIFEST_COMMAND" <<< "$input")"
assert_eq "" "$untrusted_target_output" "version manager returning an unsafe target falls through to a trusted Node"
assert_eq "false" "$([ -e "$NODE_SHADOW_MARKER" ] && echo true || echo false)" "version manager did not execute its repository target"
assert_eq "true" "$([ -e "$TRUSTED_NODE_MARKER" ] && echo true || echo false)" "unsafe version-manager target did not prevent later trusted Node selection"
HANGING_BIN="$FIXTURE/.local/share/mise/shims"
mkdir -p "$HANGING_BIN"
HANGING_NODE_PID="$FIXTURE/hanging-node.pid"
HANGING_CHILD_PID="$FIXTURE/hanging-node-child.pid"
printf '#!/usr/bin/env sh\ntrap "" TERM\nprintf "%%s\\n" "$$" > "%s"\n/bin/sleep 10 &\nSLEEP_PID=$!\nprintf "%%s\\n" "$SLEEP_PID" > "%s"\nwait "$SLEEP_PID"\n' \
  "$HANGING_NODE_PID" "$HANGING_CHILD_PID" > "$HANGING_BIN/node"
chmod +x "$HANGING_BIN/node"
started_millis="$(node -e 'process.stdout.write(String(Date.now()))')"
hanging_output="$(cd "$PRIMARY" && PATH="$HANGING_BIN:/usr/bin:/bin" PLUGIN_ROOT="$PLUGIN_ROOT" /bin/sh -c "$MANIFEST_COMMAND" <<< "$input")"
elapsed_millis="$(( $(node -e 'process.stdout.write(String(Date.now()))') - started_millis ))"
assert_deny "$hanging_output"
if [ "$elapsed_millis" -ge 4800 ]; then
  _fail "manifest launcher watchdog exceeded its pre-host-timeout budget (${elapsed_millis}ms)"
else
  _pass
fi
for pid_file in "$HANGING_NODE_PID" "$HANGING_CHILD_PID"; do
  assert_eq "true" "$([ -s "$pid_file" ] && echo true || echo false)" "hanging launcher recorded its process tree"
  process_gone=false
  process_id="$(cat "$pid_file")"
  for _ in {1..20}; do
    if ! /bin/kill -0 "$process_id" 2>/dev/null; then
      process_gone=true
      break
    fi
    /bin/sleep 0.05
  done
  assert_eq "true" "$process_gone" "launcher watchdog terminated process $process_id"
done
TERM_ZERO_BIN="$FIXTURE/external-node-bin"
mkdir -p "$TERM_ZERO_BIN"
TERM_ZERO_NODE_PID="$FIXTURE/term-zero-node.pid"
TERM_ZERO_CHILD_PID="$FIXTURE/term-zero-node-child.pid"
printf '#!/usr/bin/env sh\nprintf "%%s\\n" "$$" > "%s"\ntrap "exit 0" TERM\n/bin/sleep 10 &\nSLEEP_PID=$!\nprintf "%%s\\n" "$SLEEP_PID" > "%s"\nwait "$SLEEP_PID"\n' \
  "$TERM_ZERO_NODE_PID" "$TERM_ZERO_CHILD_PID" > "$TERM_ZERO_BIN/node"
chmod +x "$TERM_ZERO_BIN/node"
started_millis="$(node -e 'process.stdout.write(String(Date.now()))')"
term_zero_output="$(cd "$PRIMARY" && PATH="$TERM_ZERO_BIN:/usr/bin:/bin" PLUGIN_ROOT="$PLUGIN_ROOT" /bin/sh -c "$MANIFEST_COMMAND" <<< "$input")"
elapsed_millis="$(( $(node -e 'process.stdout.write(String(Date.now()))') - started_millis ))"
assert_deny "$term_zero_output"
if [ "$elapsed_millis" -ge 4800 ]; then
  _fail "manifest launcher watchdog lost a TERM-triggered zero exit (${elapsed_millis}ms)"
else
  _pass
fi
for pid_file in "$TERM_ZERO_NODE_PID" "$TERM_ZERO_CHILD_PID"; do
  assert_eq "true" "$([ -s "$pid_file" ] && echo true || echo false)" "TERM-zero launcher recorded its process tree"
  process_gone=false
  process_id="$(cat "$pid_file")"
  for _ in {1..20}; do
    if ! /bin/kill -0 "$process_id" 2>/dev/null; then
      process_gone=true
      break
    fi
    /bin/sleep 0.05
  done
  assert_eq "true" "$process_gone" "launcher watchdog terminated TERM-zero process $process_id"
done
fallback_output="$(PATH="/nonexistent" PLUGIN_ROOT="$PLUGIN_ROOT" /bin/sh -c "$MANIFEST_COMMAND" </dev/null 2>/dev/null)"
assert_deny "$fallback_output"

test_case "manifest quotes installed plugin roots containing spaces"
SPACE_PLUGIN="$FIXTURE/plugin root"
for relative_path in \
  adapters/codex/hooks/dispatcher.mjs \
  adapters/codex/hooks/repo-policy.mjs \
  adapters/codex/hooks/branch-policy.mjs \
  adapters/codex/hooks/forge-binding.mjs \
  adapters/codex/hooks/restricted-runner.mjs \
  adapters/codex/hooks/restricted-profile.mjs \
  adapters/codex/tool-names.mjs \
  hooks/codex/hooks.json \
  .codex-plugin/plugin.json; do
  mkdir -p "$SPACE_PLUGIN/$(dirname "$relative_path")"
  cp "$PLUGIN_ROOT/$relative_path" "$SPACE_PLUGIN/$relative_path"
done
input="$(make_input "$PRIMARY" "Read" '{"file_path":"src/tracked.txt"}')"
space_output="$(cd "$PRIMARY" && PLUGIN_ROOT="$SPACE_PLUGIN" /bin/sh -c "$MANIFEST_COMMAND" <<< "$input")"
assert_eq "" "$space_output" "quoted plugin root loads the dispatcher"
input="$(make_restricted_input "$LINKED" "git switch -c codex/installed-space" "$SPACE_PLUGIN")"
space_output="$(cd "$LINKED" && PLUGIN_ROOT="$SPACE_PLUGIN" /bin/sh -c "$MANIFEST_COMMAND" <<< "$input")"
assert_restricted_allow "$space_output" "quoted plugin root resolves its pinned runner and branch-policy helper"

summarize
