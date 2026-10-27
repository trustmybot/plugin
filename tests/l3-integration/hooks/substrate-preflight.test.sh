#!/usr/bin/env bash
# Tests for scripts/hooks/substrate-preflight.sh — the SessionStart hook that
# emits a TMB DEGRADED banner when required host binaries are missing.
#
# Coverage:
#   1. Healthy host (all 4 present): exits 0, no output
#   2. Degraded: jq missing — emits TMB DEGRADED containing "jq"
#   3. Degraded: sqlite3 missing — emits TMB DEGRADED containing "sqlite3"
#   4. Degraded: multiple binaries missing — all named in one message
#   5. Output is valid JSON when degraded
#   6. Schema: hookSpecificOutput.hookEventName = "SessionStart"
#   7. Self-contained: banner produced even when jq is the missing binary
#   8. No-remote path: offline note emitted when remotes have no url
#   9. No-remote path: offline note absent when a remote url exists
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/substrate-preflight.sh"
HOOK_IMPL="${TMB_HOOK_TEST_IMPL:-bash}"
[ "$HOOK_IMPL" != ts ] || HOOK="$PLUGIN_ROOT/tests/lib/ts-hooks/substrate-preflight.sh"
[ "$HOOK_IMPL" != ts ] || export TMB_TEST_NODE="$(command -v node)"

STUB_DIR=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-substrate-preflight.XXXXXX")
trap 'rm -rf "$STUB_DIR"' EXIT

_make_stub_dir_with() {
  local dir
  dir=$(mktemp -d "$STUB_DIR/tmb-substrate-preflight.XXXXXX")
  for bin in "$@"; do
    local real
    real=$(command -v "$bin" 2>/dev/null || true)
    if [ -n "$real" ]; then
      ln -s "$real" "$dir/$bin"
    fi
  done
  printf '%s' "$dir"
}

run_hook_with_path() {
  local path="$1"
  local db="${2:-}"
  if [ -n "$db" ]; then
    echo '{}' | TRAJECTORY_DB_PATH="$db" PATH="$path" /bin/bash "$HOOK" 2>/dev/null || true
  else
    echo '{}' | PATH="$path" /bin/bash "$HOOK" 2>/dev/null || true
  fi
}

run_hook() {
  local db="${1:-}"
  if [ -n "$db" ]; then
    echo '{}' | TRAJECTORY_DB_PATH="$db" /bin/bash "$HOOK" 2>/dev/null || true
  else
    echo '{}' | /bin/bash "$HOOK" 2>/dev/null || true
  fi
}

# Fixture DBs for no-remote tests. Post-#987 the offline note resolves from
# repo_remotes rows (sole source of truth); a single registered repo lets
# tmb_repo_remotes resolve via the single-repo fallback regardless of cwd.
_repos_schema="CREATE TABLE repos (
  name TEXT PRIMARY KEY, path TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  last_scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
  target_branch TEXT, branching_model TEXT, protected_branches TEXT
);
CREATE TABLE repo_remotes (
  repo TEXT NOT NULL REFERENCES repos(name) ON DELETE CASCADE ON UPDATE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github','gitlab','other')),
  url TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repo, name)
);"

_DB_DIR=$(mktemp -d "$STUB_DIR/tmb-substrate-preflight.XXXXXX")
DB_NO_REMOTE="$_DB_DIR/no-remote.db"
sqlite3 "$DB_NO_REMOTE" "
  $_repos_schema
  INSERT INTO repos (name, path) VALUES
    ('repo', '/tmp/repo');
  INSERT INTO repo_remotes (repo, name, provider, url, is_primary) VALUES
    ('repo', 'origin', 'github', '', 1);
"

DB_WITH_REMOTE="$_DB_DIR/with-remote.db"
sqlite3 "$DB_WITH_REMOTE" "
  $_repos_schema
  INSERT INTO repos (name, path) VALUES
    ('repo', '/tmp/repo');
  INSERT INTO repo_remotes (repo, name, provider, url, is_primary) VALUES
    ('repo', 'origin', 'github', 'https://github.com/org/repo.git', 1);
"

# ============================================================================
# Case 1 — Healthy host: all 4 present, silent exit 0
# ============================================================================
test_case "healthy host: exits 0 with no output"
out=$(run_hook "$DB_WITH_REMOTE")
assert_eq "" "$out" "no output when all binaries present and remote configured"

test_case "healthy host: exit code is 0"
exit_code=0
echo '{}' | TRAJECTORY_DB_PATH="$DB_WITH_REMOTE" /bin/bash "$HOOK" >/dev/null 2>&1 || exit_code=$?
assert_eq "0" "$exit_code" "exit code"

# ============================================================================
# Case 2 — jq missing: emits TMB DEGRADED mentioning jq
# ============================================================================
test_case "jq missing: emits TMB DEGRADED"
stub2=$(_make_stub_dir_with sqlite3 git node)
out2=$(run_hook_with_path "$stub2" "")
assert_contains "$out2" "TMB DEGRADED" "DEGRADED banner present"

test_case "jq missing: banner names jq"
assert_contains "$out2" "jq" "jq named in banner"

# ============================================================================
# Case 3 — sqlite3 missing: emits TMB DEGRADED mentioning sqlite3
# ============================================================================
test_case "sqlite3 missing: emits TMB DEGRADED"
stub3=$(_make_stub_dir_with jq git node)
out3=$(run_hook_with_path "$stub3" "")
assert_contains "$out3" "TMB DEGRADED" "DEGRADED banner present"

test_case "sqlite3 missing: banner names sqlite3"
assert_contains "$out3" "sqlite3" "sqlite3 named in banner"

# ============================================================================
# Case 4 — multiple binaries missing: all named in one message
# ============================================================================
test_case "multiple missing: both jq and git named"
stub4=$(_make_stub_dir_with sqlite3 node)
out4=$(run_hook_with_path "$stub4" "")
assert_contains "$out4" "jq" "jq named when multiple missing"
assert_contains "$out4" "git" "git named when multiple missing"

# ============================================================================
# Case 5 — degraded output is valid JSON
# ============================================================================
test_case "degraded output is valid JSON"
if echo "$out2" | jq . >/dev/null 2>&1; then
  _pass
else
  _fail "degraded stdout failed jq parse — output was: $out2"
fi

# ============================================================================
# Case 6 — schema: hookEventName = "SessionStart"
# ============================================================================
test_case "schema: hookEventName is SessionStart"
ev=$(echo "$out2" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null || echo "MISSING")
assert_eq "SessionStart" "$ev" "hookSpecificOutput.hookEventName"

test_case "schema: additionalContext is a string"
ctx_type=$(echo "$out2" | jq -r '.hookSpecificOutput.additionalContext | type' 2>/dev/null || echo "MISSING")
assert_eq "string" "$ctx_type" "additionalContext type"

# ============================================================================
# Case 7 — self-contained: banner produced even when jq is the missing binary
#          (hook must not depend on jq to emit its own JSON output)
# ============================================================================
test_case "self-contained: TMB DEGRADED emitted when jq is absent"
assert_contains "$out2" "TMB DEGRADED" "banner produced without jq on PATH"

test_case "self-contained: output is non-empty when jq is absent"
if [ -n "$out2" ]; then
  _pass
else
  _fail "output was empty — hook depends on jq for its own output"
fi

# ============================================================================
# Case 8 — no-remote path: offline note emitted when remotes have no url
# ============================================================================
test_case "no-remote: offline note emitted when remotes have no url"
out8=$(run_hook "$DB_NO_REMOTE")
assert_contains "$out8" "operating locally" "offline note in output"

test_case "no-remote: offline note names remote/push ops skipped"
assert_contains "$out8" "remote/push ops are skipped" "ops-skipped text present"

test_case "no-remote: output is valid JSON"
if printf '%s' "$out8" | jq . >/dev/null 2>&1; then
  _pass
else
  _fail "no-remote output failed jq parse — got: $out8"
fi

test_case "no-remote: hookEventName is SessionStart"
ev8=$(printf '%s' "$out8" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null || echo "MISSING")
assert_eq "SessionStart" "$ev8" "hookEventName"

# ============================================================================
# Case 9 — no-remote path: offline note absent when a remote url exists
# ============================================================================
test_case "with-remote: offline note absent when a url is configured"
out9=$(run_hook "$DB_WITH_REMOTE")
assert_eq "" "$out9" "no output when remote configured"

# ============================================================================
# repo_remotes (v35): a registered repo with no rows is local-only
# ============================================================================
test_case "registered repo with no repo_remotes rows: offline note emitted"
DB_ZERO_ROWS="$_DB_DIR/zero-rows.db"
sqlite3 "$DB_ZERO_ROWS" "$_repos_schema INSERT INTO repos (name, path) VALUES ('repo', '/tmp/repo');"
out_zr=$(run_hook "$DB_ZERO_ROWS")
assert_contains "$out_zr" "operating locally" "no remote rows → offline note"

# ============================================================================
# Extra: both degraded AND no-remote → includes both notes
# Use PATH=/usr/bin:/bin where node is absent but jq/sqlite3/git are present.
# This gives us a degraded state while keeping system binaries for the hook.
# ============================================================================
test_case "degraded + no-remote: both DEGRADED and offline note in output"
out_dr=$(echo '{}' | TRAJECTORY_DB_PATH="$DB_NO_REMOTE" PATH="/usr/bin:/bin" /bin/bash "$HOOK" 2>/dev/null || true)
assert_contains "$out_dr" "TMB DEGRADED" "DEGRADED still present"
assert_contains "$out_dr" "operating locally" "offline note also present"

summarize
