#!/usr/bin/env bash
# Content-preservation regression tests for reordered hook outputs.
#
# Guards against information loss disguised as a reorder (B14 incident: a
# hook refactor silently deleted recovery steps while only changing order).
# Each test masks volatile values in the live hook output and compares the
# resulting token multiset against a stored golden snapshot so future
# reorders cannot silently drop content.
#
# Masking contract: volatile lines (containing git hashes, numeric counts,
# file paths, issue IDs, commit messages) are replaced with a single
# __VOLATILE__ token, and every absolute path token (worktree, project, temp
# dir) with __PATH__, so the goldens hold no environment-specific value. The
# hooks run from a fixture project, never the ambient checkout or
# CLAUDE_PROJECT_DIR. The golden stores the same masked form. Any stable
# label that is dropped would appear in the golden but not in the masked
# live output — the multiset diff catches it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
. "$HERE/../../lib/content-preservation.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
FIXTURES="$HERE/fixtures"

# ---------------------------------------------------------------------------
# Masking helpers
# ---------------------------------------------------------------------------

# mask_paths: replace the fixture/plugin roots and any absolute path token
# (a word holding two or more slashes from the root) with __PATH__.
mask_paths() {
  sed \
    -e "s|$TMPDIR_ROOT|__PATH__|g" \
    -e "s|$PLUGIN_ROOT|__PATH__|g" \
    -e 's|/[^[:space:]/]*/[^[:space:]]*|__PATH__|g'
}

# mask_session_start_prescan: strip the per-session volatile values.
# Volatile = lines after a label colon that contain numbers, paths, hashes.
mask_session_start_prescan() {
  local input="$1"
  printf '%s\n' "$input" \
    | sed \
        -e 's/Plugin version:.*/Plugin version: __VOLATILE__/' \
        -e 's/Top-level dirs:.*/Top-level dirs: __VOLATILE__/' \
        -e 's/Stacks detected:.*/Stacks detected: __VOLATILE__/' \
        -e 's/World model:.*/World model: __VOLATILE__/' \
        -e 's/Trajectory DB:.*/Trajectory DB: __VOLATILE__/' \
        -e 's/Git branch:.*/Git branch: __VOLATILE__/' \
        -e 's/Open issues:.*/Open issues: __VOLATILE__/' \
        -e 's/Pending tasks:.*/Pending tasks: __VOLATILE__/' \
        -e 's/Last 5 commits:.*/Last 5 commits: __VOLATILE__/' \
        -e '/^  [0-9a-f]* /d' \
        -e '/^  ✨/d' \
        -e '/^  🐛/d' \
        -e '/^  ✍️/d' \
        -e '/^  🔧/d' \
        -e '/^  📦/d' \
        -e '/^  🧪/d' \
    | mask_paths
}

# mask_activation_routine: strip pending issue id + objective.
mask_activation_routine() {
  local input="$1"
  printf '%s\n' "$input" \
    | sed 's/pending=#[0-9][0-9]*:.*/pending=__VOLATILE__/' \
    | mask_paths
}

# mask_mcp_health_check: strip issue number refs, paths, version refs.
# Replaces the trailing DB:/plugin-source line (fully volatile) with a
# stable placeholder, and strips emoji + issue numbers.
mask_mcp_health_check() {
  local input="$1"
  printf '%s\n' "$input" \
    | sed \
        -e 's/(issue #[0-9][0-9]*)/__VOLATILE__/g' \
        -e 's|^DB:.*$|DB: __VOLATILE__|' \
        -e 's/tmb@[^ ]*/tmb@__VOLATILE__/g' \
        -e 's/🚨 //' \
        -e 's/⛔ //' \
    | mask_paths
}

# check_golden <masked> <golden-file> <label>: compare against the golden, or
# rewrite it when TMB_UPDATE_GOLDENS=1.
check_golden() {
  if [ "${TMB_UPDATE_GOLDENS:-0}" = "1" ]; then
    printf '%s\n' "$1" > "$2"
    _pass
    return
  fi
  assert_token_multiset_eq "$1" "$(cat "$2")" "$3"
}

# ---------------------------------------------------------------------------
# Test setup: minimal DBs / stubs for each hook
# ---------------------------------------------------------------------------

TMPDIR_ROOT=$(_t=${TMPDIR:-/tmp}; mktemp -d "${_t%/}/tmb-hook-content-preservation.XXXXXX")
# Sandbox HOME so hooks (mcp-health-check et al.) touch a throwaway state/log
# dir, never the developer's real ~/.claude/tmb.
export HOME="$TMPDIR_ROOT/home"
mkdir -p "$HOME"
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# Fixture project: a git repo with one tracked file. Every hook runs from it
# with CLAUDE_PROJECT_DIR pointing at it.
PROJECT="$TMPDIR_ROOT/project"
mkdir -p "$PROJECT"
printf 'fixture\n' > "$PROJECT/README.md"
git -C "$PROJECT" init -q -b main
git -C "$PROJECT" -c user.name=fixture -c user.email=fixture@example.invalid add README.md
git -C "$PROJECT" -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m 'fixture'
export CLAUDE_PROJECT_DIR="$PROJECT"
unset CLAUDE_PLUGIN_ROOT
cd "$PROJECT"

# --- session-start-prescan setup ---
PRESCAN_DB="$TMPDIR_ROOT/prescan.db"
sqlite3 "$PRESCAN_DB" "
  CREATE TABLE issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    objective TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO issues (objective, status) VALUES ('test issue', 'open');
  INSERT INTO tasks (issue_id, status) VALUES (1, 'pending');
"

# --- activation-routine setup ---
AR_DB="$TMPDIR_ROOT/activation.db"
sqlite3 "$AR_DB" "
  CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
  CREATE TABLE issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    objective TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO plugin_config (key, value_json) VALUES ('onboarded', 'true');
  INSERT INTO issues (objective, status) VALUES ('test issue', 'open');
"

# --- mcp-health-check setup: stub pgrep to return absent ---
MCP_STUB_DIR="$TMPDIR_ROOT/stubs"
mkdir -p "$MCP_STUB_DIR"
cat > "$MCP_STUB_DIR/pgrep" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
chmod +x "$MCP_STUB_DIR/pgrep"

LIVE_STUB_DIR="$TMPDIR_ROOT/live-stubs"
mkdir -p "$LIVE_STUB_DIR"
cat > "$LIVE_STUB_DIR/pgrep" <<'STUB'
#!/usr/bin/env bash
echo 99999
STUB
chmod +x "$LIVE_STUB_DIR/pgrep"

# ---------------------------------------------------------------------------
# 1. session-start-prescan
# ---------------------------------------------------------------------------

test_case "session-start-prescan: masked token multiset matches golden"
PRESCAN_OUT=$(TRAJECTORY_DB_PATH="$PRESCAN_DB" TMB_SKIP_AUTO_PRESCAN=1 bash "$PLUGIN_ROOT/scripts/hooks/session-start-prescan.sh" 2>/dev/null | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || echo "")
if [ -z "$PRESCAN_OUT" ]; then
  _fail "session-start-prescan produced no output"
else
  PRESCAN_MASKED=$(mask_session_start_prescan "$PRESCAN_OUT")
  check_golden "$PRESCAN_MASKED" "$FIXTURES/session-start-prescan.golden.txt" "session-start-prescan stable tokens"
fi

# ---------------------------------------------------------------------------
# 2. activation-routine
# ---------------------------------------------------------------------------

test_case "activation-routine: masked token multiset matches golden"
AR_OUT=$(echo '{"prompt":"@bro status","transcript_path":""}' \
  | PATH="$LIVE_STUB_DIR:$PATH" TRAJECTORY_DB_PATH="$AR_DB" bash "$PLUGIN_ROOT/scripts/hooks/activation-routine.sh" 2>/dev/null \
  | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || echo "")
if [ -z "$AR_OUT" ]; then
  _fail "activation-routine produced no output"
else
  AR_MASKED=$(mask_activation_routine "$AR_OUT")
  check_golden "$AR_MASKED" "$FIXTURES/activation-routine.golden.txt" "activation-routine stable tokens"
fi

# ---------------------------------------------------------------------------
# 3. mcp-health-check
# ---------------------------------------------------------------------------

test_case "mcp-health-check: masked token multiset matches golden"
MCP_OUT=$(PATH="$MCP_STUB_DIR:$PATH" TMB_MCP_HEALTH_INTERVAL_S=0.05 bash "$PLUGIN_ROOT/scripts/hooks/mcp-health-check.sh" \
    <<< '{"hook_event_name":"SessionStart","session_id":"golden-test","source":"startup"}' \
    2>/dev/null \
  | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || echo "")
if [ -z "$MCP_OUT" ]; then
  _fail "mcp-health-check produced no output (expected the soft not-detected note)"
else
  MCP_MASKED=$(mask_mcp_health_check "$MCP_OUT")
  check_golden "$MCP_MASKED" "$FIXTURES/mcp-health-check.golden.txt" "mcp-health-check stable tokens"
fi

summarize
