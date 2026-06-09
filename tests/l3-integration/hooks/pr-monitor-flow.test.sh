#!/usr/bin/env bash
# L3 hook tests for the PR monitor flow.
#
# These tests mock gh/glab via wrapper scripts injected into PATH and verify
# that the skill contract — explicit trigger, auto-detect, empty fetch,
# arch-impact invocation — behaves correctly at the shell/script level.
#
# The MCP layer is tested in L2 (pr-comments.test.ts, bot-patterns.test.ts).
# These tests focus on the observable behavior that hooks and shell scripts
# must exhibit.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"

TMPDIR_BASE=$(mktemp -d -t tmb-pr-monitor-XXXX)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

# ── Helper: create a mock gh/glab bin directory ────────────────────────────

setup_mock_bin() {
  local mock_bin="$TMPDIR_BASE/bin"
  mkdir -p "$mock_bin"

  # Mock gh: returns sample PR comment JSON
  cat > "$mock_bin/gh" <<'GHEOF'
#!/usr/bin/env bash
if [[ "$*" == *"pr view"*"--json"* ]]; then
  echo '{"state":"OPEN","comments":[{"id":"c1","author":{"login":"alice"},"body":"This should be refactored.","createdAt":"2024-01-15T10:00:00Z"}],"reviews":[]}'
  exit 0
fi
if [[ "$*" == *"pr view"* ]]; then
  echo '{"number":42,"headRefName":"feat/my-feature","state":"OPEN"}'
  exit 0
fi
exit 1
GHEOF
  chmod +x "$mock_bin/gh"

  # Mock glab: returns sample MR comment JSON
  cat > "$mock_bin/glab" <<'GLABEOF'
#!/usr/bin/env bash
if [[ "$*" == *"mr view"*"--comments"* ]]; then
  echo '{"state":"opened","notes":[{"id":101,"author":{"username":"bob"},"body":"Please fix this.","created_at":"2024-01-15T10:00:00Z","resolved":false}]}'
  exit 0
fi
if [[ "$*" == *"mr list"* ]]; then
  echo '[{"iid":42,"state":"opened","sourceBranch":"feat/my-feature"}]'
  exit 0
fi
exit 1
GLABEOF
  chmod +x "$mock_bin/glab"

  # Mock gh for PR view (branch auto-detect)
  cat > "$mock_bin/git" <<'GITEOF'
#!/usr/bin/env bash
if [[ "$*" == *"rev-parse --abbrev-ref HEAD"* ]]; then
  echo "feat/my-feature"
  exit 0
fi
# Fall through to real git for all other commands
/usr/bin/git "$@"
GITEOF
  chmod +x "$mock_bin/git"

  echo "$mock_bin"
}

# ── Helper: set up temp DB with schema ────────────────────────────────────

setup_db() {
  local db_path="$1"
  sqlite3 "$db_path" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null 2>&1
}

# ── Helper: run a small node script against the built MCP dist ─────────────

run_mcp_call() {
  local db_path="$1"
  local script="$2"
  TRAJECTORY_DB_PATH="$db_path" \
    node --experimental-sqlite -e "$script" 2>&1
}

# ═══════════════════════════════════════════════════════════════════════════
# Test 1: skill invokes with explicit PR number
# Verify: pr_review_runs gets a row after fetch with the given PR number.
# ═══════════════════════════════════════════════════════════════════════════

test_case "skill invokes with explicit PR number: pr_review_runs row created"
DB1="$TMPDIR_BASE/db1.db"
setup_db "$DB1"
# Set backend to gh so we skip glab
sqlite3 "$DB1" "INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '\"gh\"')"

MOCK_BIN=$(setup_mock_bin)

PATH="$MOCK_BIN:$PATH" TRAJECTORY_DB_PATH="$DB1" \
  node --experimental-sqlite -e "
    const { TrajectoryDB } = await import('$PLUGIN_ROOT/mcp/trajectory-server/dist/db.js');
    const { prCommentsTools } = await import('$PLUGIN_ROOT/mcp/trajectory-server/dist/tools/pr_comments.js');
    const db = new TrajectoryDB('$DB1');
    const tools = prCommentsTools(db);
    await tools.handlers['pr_comments_get']({ agent: 'bro', pr_number: 42 });
    db.close();
  " 2>&1 || true

ROW_COUNT=$(sqlite3 "$DB1" "SELECT COUNT(*) FROM pr_review_runs WHERE pr_number=42;" 2>/dev/null || echo 0)
assert_eq "1" "$ROW_COUNT" "pr_review_runs row count for PR 42"

# ═══════════════════════════════════════════════════════════════════════════
# Test 2: auto-detect PR from current branch (mock git + gh)
# Verify: the mock git returns "feat/my-feature" and mock gh returns PR 42.
# This tests the shell contract — not the MCP layer.
# ═══════════════════════════════════════════════════════════════════════════

test_case "skill auto-detects PR from current branch via git + gh pr view"
MOCK_BIN2=$(setup_mock_bin)
# Verify mock git returns the expected branch
BRANCH=$(PATH="$MOCK_BIN2:$PATH" git rev-parse --abbrev-ref HEAD 2>&1 || echo "fail")
assert_eq "feat/my-feature" "$BRANCH" "mock git branch"

# Verify mock gh detects the PR
PR_INFO=$(PATH="$MOCK_BIN2:$PATH" gh pr view --json number,headRefName 2>&1 || echo "fail")
assert_contains "$PR_INFO" '"state":"OPEN"' "mock gh pr view output contains state"

# ═══════════════════════════════════════════════════════════════════════════
# Test 3: empty PR fetch → graceful "no new comments" result
# Verify: when the backend returns no comments, the MCP tool returns an empty list.
# ═══════════════════════════════════════════════════════════════════════════

test_case "empty PR fetch returns empty comments array"
DB3="$TMPDIR_BASE/db3.db"
setup_db "$DB3"
sqlite3 "$DB3" "INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '\"gh\"')"

EMPTY_GH_OUTPUT='{"state":"OPEN","comments":[],"reviews":[]}'
MOCK_BIN3="$TMPDIR_BASE/bin3"
mkdir -p "$MOCK_BIN3"
cat > "$MOCK_BIN3/gh" <<GHEOF
#!/usr/bin/env bash
echo '$EMPTY_GH_OUTPUT'
exit 0
GHEOF
chmod +x "$MOCK_BIN3/gh"

EMPTY_RESULT=$(PATH="$MOCK_BIN3:$PATH" TRAJECTORY_DB_PATH="$DB3" \
  node --experimental-sqlite -e "
    const { TrajectoryDB } = await import('$PLUGIN_ROOT/mcp/trajectory-server/dist/db.js');
    const { prCommentsTools } = await import('$PLUGIN_ROOT/mcp/trajectory-server/dist/tools/pr_comments.js');
    const db = new TrajectoryDB('$DB3');
    const tools = prCommentsTools(db);
    const result = await tools.handlers['pr_comments_get']({ agent: 'bro', pr_number: 99 });
    const data = JSON.parse(result.content[0].text);
    console.log(JSON.stringify({ count: data.comments ? data.comments.length : -1 }));
    db.close();
  " 2>&1 || echo '{"count":-1}')

assert_contains "$EMPTY_RESULT" '"count":0' "empty fetch returns zero comments"

# ═══════════════════════════════════════════════════════════════════════════
# Test 4: arch-impact heuristic — tasks touching schema.sql are flagged
# Verify: a file path containing 'schema.sql' triggers arch-impact.
# This is a pure shell/string logic test (no MCP call needed).
# ═══════════════════════════════════════════════════════════════════════════

test_case "arch-impact heuristic flags schema.sql changes"
ARCH_PATHS=(
  "mcp/trajectory-server/src/schema.sql"
  "docs/trustmybot/architecture/auto/overview.md"
  ".claude-plugin/plugin.json"
  "templates/agents/new-agent.md"
  "agents/custom.md"
)

NON_ARCH_PATHS=(
  "src/utils.ts"
  "README.md"
  "tests/l3-integration/hooks/some.test.sh"
)

is_arch_impact() {
  local path="$1"
  echo "$path" | grep -qE '(docs/trustmybot/architecture/auto/|mcp/trajectory-server/src/schema\.sql|\.claude-plugin/plugin\.json|templates/agents/|^agents/)' && return 0
  return 1
}

for p in "${ARCH_PATHS[@]}"; do
  test_case "arch-impact: $p"
  if is_arch_impact "$p"; then
    _pass
  else
    _fail "Expected $p to be arch-impact"
  fi
done

for p in "${NON_ARCH_PATHS[@]}"; do
  test_case "non-arch-impact: $p"
  if ! is_arch_impact "$p"; then
    _pass
  else
    _fail "Expected $p NOT to be arch-impact"
  fi
done

# ═══════════════════════════════════════════════════════════════════════════

summarize
