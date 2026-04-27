#!/usr/bin/env bash
# A/B prompt-eval helpers (#131). Builds on flow-helpers.sh — adds variant
# isolation (per-arm plugin tree with overrides), per-arm scoring, and
# scenario-aware run IDs.
#
# Required env: PLUGIN_ROOT (the source plugin dir). Sourced by run-ab.sh.

set -uo pipefail

# l6_make_arm_plugin <arm_overrides_dir> — copies $PLUGIN_ROOT to a temp dir
# and overlays arm-specific overrides on top. Echoes the temp dir path.
#
# Overrides directory mirrors the plugin tree layout:
#   arms/A/CLAUDE.md            -> overrides plugin/CLAUDE.md
#   arms/A/skills/foo/SKILL.md  -> overrides plugin/skills/foo/SKILL.md
# rsync -a is used so directory structure is preserved.
l6_make_arm_plugin() {
  local arm_overrides="$1"
  local arm_plugin
  arm_plugin=$(mktemp -d -t tmb-arm-plugin-XXXX)
  # Exclude node_modules from rsync — we'll symlink them after for speed.
  # Without symlinks the MCP server can't import @modelcontextprotocol/sdk
  # and silently fails to start (0-byte trajectory.db, bro reports 'no MCP').
  rsync -a --exclude='.git' --exclude='node_modules' "$PLUGIN_ROOT/" "$arm_plugin/"
  # Symlink the heavy node_modules from the source. Both the root one and the
  # MCP server's nested one (if they exist).
  if [ -d "$PLUGIN_ROOT/node_modules" ]; then
    ln -sfn "$PLUGIN_ROOT/node_modules" "$arm_plugin/node_modules"
  fi
  if [ -d "$PLUGIN_ROOT/mcp/trajectory-server/node_modules" ]; then
    ln -sfn "$PLUGIN_ROOT/mcp/trajectory-server/node_modules" "$arm_plugin/mcp/trajectory-server/node_modules"
  fi
  if [ -d "$arm_overrides" ]; then
    rsync -a "$arm_overrides/" "$arm_plugin/"
  fi
  echo "$arm_plugin"
}

# l6_smoke_arm_plugin <arm_plugin_dir> — verifies the arm_plugin can spawn
# the MCP trajectory server and respond to tools/list. Fail-fast guard so
# A/B doesn't burn tokens against an arm_plugin where MCP is silently broken
# (the failure mode that bug #131-A produced — empty trajectory.db, bro
# reports 'no MCP', 10 wasted claude calls).
#
# Returns 0 if MCP responds with a tool definition list within 10 seconds,
# 1 otherwise. On failure, prints diagnostic to stderr.
l6_smoke_arm_plugin() {
  local arm_plugin="$1"
  local mcp_entry="$arm_plugin/mcp/trajectory-server/dist/index.js"
  if [ ! -f "$mcp_entry" ]; then
    printf "  ✗ smoke: MCP entrypoint missing at %s\n" "$mcp_entry" >&2
    return 1
  fi

  # Send a tools/list JSON-RPC request and check for a response with tools.
  # 10s timeout is generous — actual response is typically <1s.
  local req='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"ab-smoke","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

  local resp
  resp=$(printf '%s\n' "$req" | timeout 10 node --experimental-sqlite "$mcp_entry" 2>&1 || true)

  if echo "$resp" | grep -q '"tools"'; then
    return 0
  fi

  printf "  ✗ smoke: MCP did not respond with a tools list. Output:\n" >&2
  printf '%s\n' "$resp" | head -10 | sed 's/^/      /' >&2
  return 1
}

# l6_setup_scenario_state <project_dir> <scenario_dir> — applies fixture +
# setup_files from scenario.json before claude runs. Each scenario can declare:
#   - "fixture": "<name>"  → l6_seed_db with that fixture (e.g. "onboarding-named")
#   - "setup_files": [{"path": "<rel-path>", "content": "<text>"}]
#                    → write each file in the scratch project before claude runs
# Both are optional. Defaults: no fixture (empty DB), no setup files.
l6_setup_scenario_state() {
  local project="$1" scenario_dir="$2"
  local config="$scenario_dir/scenario.json"
  [ -f "$config" ] || return 0

  local fixture
  fixture=$(jq -r '.fixture // empty' "$config")
  if [ -n "$fixture" ]; then
    l6_seed_db "$project" "$fixture"
  fi

  # setup_files: array of {path, content}
  local count
  count=$(jq -r '.setup_files | length // 0' "$config")
  local i=0
  while [ "$i" -lt "$count" ]; do
    local rel content
    rel=$(jq -r ".setup_files[$i].path" "$config")
    content=$(jq -r ".setup_files[$i].content" "$config")
    mkdir -p "$(dirname "$project/$rel")"
    printf '%s' "$content" > "$project/$rel"
    i=$((i + 1))
  done

  # If setup_files were created, commit them so the scratch repo is "clean"
  # — flows that test git-clean behavior depend on this.
  if [ "$count" -gt 0 ]; then
    (cd "$project" && git add . && git commit -qm "scenario setup files" 2>/dev/null || true)
  fi
}

# l6_run_arm <project_dir> <arm_plugin_dir> <prompt> — runs claude -p against
# the arm-specific plugin. Echoes claude output to stderr (same as l6_run_claude
# in flow-helpers.sh), masks exit code so scoring proceeds regardless.
l6_run_arm() {
  local dir="$1" arm_plugin="$2" prompt="$3"
  (
    cd "$dir" || exit 1
    export TMB_DEBUG_TRAJECTORY=1
    export CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN}"
    echo "  ── claude (arm) start ──" >&2
    echo "  cwd: $dir" >&2
    echo "  arm plugin-dir: $arm_plugin" >&2
    echo "  prompt: $prompt" >&2
    timeout 180 claude --plugin-dir "$arm_plugin" --dangerously-skip-permissions -p "$prompt" 2>&1 \
      | sed 's/^/  [arm] /' >&2 || true
    echo "  ── claude (arm) end ──" >&2
  )
}

# l6_score_with_arm <project_dir> <flow_name> <scorer_dir> <run_id> <arm_name>
# <scenario_name> — runs the same scorers as l6_score_flow but tags every
# eval_results row with arm + scenario. Returns 0 only if all scorers pass.
l6_score_with_arm() {
  local project="$1" flow="$2" scorer_dir="$3" run_id="$4" arm="$5" scenario="$6"
  local fail=0
  local db="$project/.claude/tmb/trajectory.db"

  # Run the existing scorers first (they write rows with arm='control').
  l6_score_outcome              "$project" "$flow" "$scorer_dir" "$run_id" || fail=$((fail + 1))
  l6_score_trajectory_required  "$project" "$flow" "$scorer_dir" "$run_id" || fail=$((fail + 1))
  l6_score_trajectory_forbidden "$project" "$flow" "$scorer_dir" "$run_id" || fail=$((fail + 1))
  l6_score_cost                 "$project" "$flow" "$scorer_dir" "$run_id" || fail=$((fail + 1))

  # Re-tag the rows just written for THIS run_id with the arm + scenario.
  # The scorer functions in lib/scorers.sh write arm='control' by default;
  # this UPDATE is the cheapest way to retag without rewriting the scorers.
  sqlite3 "$db" "UPDATE eval_results SET arm = '$arm', scenario = '$scenario' WHERE run_id = '$run_id';" 2>/dev/null || true

  return "$fail"
}

# l6_cleanup_arm_plugin <arm_plugin_dir> — removes the temp arm plugin.
l6_cleanup_arm_plugin() {
  local dir="$1"
  [ "${L5_KEEP_ARTIFACTS:-0}" = "1" ] && return 0
  [ -n "$dir" ] && [ -d "$dir" ] && rm -rf "$dir"
}
