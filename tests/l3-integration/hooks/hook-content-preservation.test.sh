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
# __VOLATILE__ token. The golden stores the same masked form. Any stable
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

# mask_session_start_prescan: strip the per-session volatile values.
# Volatile = lines after a label colon that contain numbers, paths, hashes.
mask_session_start_prescan() {
  local input="$1"
  printf '%s\n' "$input" \
    | sed \
        -e 's/Plugin version:.*/Plugin version: __VOLATILE__/' \
        -e 's/Top-level dirs:.*/Top-level dirs: __VOLATILE__/' \
        -e 's/Stacks detected:.*/Stacks detected: __VOLATILE__/' \
        -e 's/Architecture docs:.*/Architecture docs: __VOLATILE__/' \
        -e 's/World model:.*/World model: __VOLATILE__/' \
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
        -e '/^  🧪/d'
}

# mask_activation_routine: strip pending issue id + objective.
mask_activation_routine() {
  local input="$1"
  printf '%s\n' "$input" \
    | sed 's/pending=#[0-9][0-9]*:.*/pending=__VOLATILE__/'
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
        -e 's/⛔ //'
}

# ---------------------------------------------------------------------------
# Test setup: minimal DBs / stubs for each hook
# ---------------------------------------------------------------------------

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

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

# ---------------------------------------------------------------------------
# 1. session-start-prescan
# ---------------------------------------------------------------------------

test_case "session-start-prescan: masked token multiset matches golden"
PRESCAN_OUT=$(TRAJECTORY_DB_PATH="$PRESCAN_DB" bash "$PLUGIN_ROOT/scripts/hooks/session-start-prescan.sh" 2>/dev/null | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || echo "")
if [ -z "$PRESCAN_OUT" ]; then
  _fail "session-start-prescan produced no output"
else
  PRESCAN_MASKED=$(mask_session_start_prescan "$PRESCAN_OUT")
  PRESCAN_GOLDEN=$(cat "$FIXTURES/session-start-prescan.golden.txt")
  assert_token_multiset_eq "$PRESCAN_MASKED" "$PRESCAN_GOLDEN" "session-start-prescan stable tokens"
fi

# ---------------------------------------------------------------------------
# 2. activation-routine
# ---------------------------------------------------------------------------

test_case "activation-routine: masked token multiset matches golden"
AR_OUT=$(echo '{"prompt":"@bro status","transcript_path":""}' \
  | TRAJECTORY_DB_PATH="$AR_DB" bash "$PLUGIN_ROOT/scripts/hooks/activation-routine.sh" 2>/dev/null \
  | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || echo "")
if [ -z "$AR_OUT" ]; then
  _fail "activation-routine produced no output"
else
  AR_MASKED=$(mask_activation_routine "$AR_OUT")
  AR_GOLDEN=$(cat "$FIXTURES/activation-routine.golden.txt")
  assert_token_multiset_eq "$AR_MASKED" "$AR_GOLDEN" "activation-routine stable tokens"
fi

# ---------------------------------------------------------------------------
# 3. mcp-health-check
# ---------------------------------------------------------------------------

test_case "mcp-health-check: masked token multiset matches golden"
MCP_OUT=$(PATH="$MCP_STUB_DIR:$PATH" bash "$PLUGIN_ROOT/scripts/hooks/mcp-health-check.sh" \
    <<< '{"hook_event_name":"SessionStart","session_id":"golden-test","source":"startup"}' \
    2>/dev/null \
  | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || echo "")
if [ -z "$MCP_OUT" ]; then
  _fail "mcp-health-check produced no output (expected Mode A warning)"
else
  MCP_MASKED=$(mask_mcp_health_check "$MCP_OUT")
  MCP_GOLDEN=$(cat "$FIXTURES/mcp-health-check.golden.txt")
  assert_token_multiset_eq "$MCP_MASKED" "$MCP_GOLDEN" "mcp-health-check stable tokens"
fi

summarize
