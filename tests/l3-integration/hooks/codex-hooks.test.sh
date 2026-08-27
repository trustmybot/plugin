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

run_hook() {
  PLUGIN_ROOT="$PLUGIN_ROOT" node "$DISPATCHER" --policy-sha256 "$DIGEST" <<< "$1"
}

assert_deny() {
  local output="$1"
  assert_eq "deny" "$(jq -er '.hookSpecificOutput.permissionDecision' <<< "$output")" "deny decision"
  assert_contains "$output" "TMB-CODEX-HOOK:" "stable denial reason"
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

test_case "persistent receiver and follow-up stdin surfaces are denied"
input="$(make_input "$LINKED" "exec_command" '{"cmd":"bash","tty":true}')"
assert_deny "$(run_hook "$input")"
input="$(make_input "$LINKED" "write_stdin" '{"session_id":42,"chars":"git push\n"}')"
assert_deny "$(run_hook "$input")"

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
MANIFEST_COMMAND="$(jq -er '.hooks.PreToolUse[0].hooks[0].command' "$MANIFEST")"
input="$(make_input "$PRIMARY" "Read" '{"file_path":"src/tracked.txt"}')"
shadow_output="$(cd "$PRIMARY" && PATH="$STUB_BIN:/usr/bin:/bin" PLUGIN_ROOT="$PLUGIN_ROOT" /bin/sh -c "$MANIFEST_COMMAND" <<< "$input")"
assert_eq "" "$shadow_output" "repository PATH node does not intercept the dispatcher"
assert_eq "false" "$([ -e "$NODE_SHADOW_MARKER" ] && echo true || echo false)" "repository PATH node was not executed"
nested_shadow_output="$(cd "$PRIMARY/src" && PATH="$STUB_BIN:/usr/bin:/bin" PLUGIN_ROOT="$PLUGIN_ROOT" /bin/sh -c "$MANIFEST_COMMAND" <<< "$input")"
assert_eq "" "$nested_shadow_output" "repository-root Node shim is rejected from a nested cwd"
assert_eq "false" "$([ -e "$NODE_SHADOW_MARKER" ] && echo true || echo false)" "nested cwd did not execute the repository Node shim"
MANAGED_BIN="$FIXTURE/.asdf/shims"
mkdir -p "$MANAGED_BIN"
MANAGED_NODE_MARKER="$FIXTURE/version-managed-node-ran"
printf '#!/usr/bin/env sh\nif [ "$1" = "-p" ]; then\n  printf "%%s\\n" "%s"\n  touch "%s"\n  exit 0\nfi\nexit 91\n' \
  "$(command -v node)" "$MANAGED_NODE_MARKER" > "$MANAGED_BIN/node"
chmod +x "$MANAGED_BIN/node"
managed_output="$(cd "$PRIMARY" && PATH="$MANAGED_BIN:/usr/bin:/bin" PLUGIN_ROOT="$PLUGIN_ROOT" /bin/sh -c "$MANIFEST_COMMAND" <<< "$input")"
assert_eq "" "$managed_output" "version-managed Node resolves to its real executable"
assert_eq "true" "$([ -e "$MANAGED_NODE_MARKER" ] && echo true || echo false)" "version-managed Node launcher was consulted"
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
mkdir -p "$SPACE_PLUGIN/adapters/codex/hooks"
cp "$DISPATCHER" "$SPACE_PLUGIN/adapters/codex/hooks/dispatcher.mjs"
cp "$PLUGIN_ROOT/adapters/codex/hooks/repo-policy.mjs" "$SPACE_PLUGIN/adapters/codex/hooks/repo-policy.mjs"
input="$(make_input "$PRIMARY" "Read" '{"file_path":"src/tracked.txt"}')"
space_output="$(PLUGIN_ROOT="$SPACE_PLUGIN" /bin/sh -c "$MANIFEST_COMMAND" <<< "$input")"
assert_eq "" "$space_output" "quoted plugin root loads the dispatcher"

summarize
