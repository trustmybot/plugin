#!/usr/bin/env bash
# Tests for scripts/hooks/consultant-persistence-gate.sh.
# Hook contract: SubagentStop for TMB consultant agents. When a consultant
# stops without having persisted at least one discussion row on the most recent
# open issue, block with {"decision":"block","reason":"..."} containing a
# recovery message teaching discussion_append usage.
# Silent no-op for backbone roles (bro/swe/pr-reviewer), non-TMB agents,
# absent DB, and when stop_hook_active is set.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/consultant-persistence-gate.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# ---- Fixture: trajectory DB with agents, issues, discussions tables ----------

DB="$TMPDIR/trajectory.db"
sqlite3 "$DB" "
  CREATE TABLE agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('backbone','consultant')),
    scope TEXT NOT NULL CHECK (scope IN ('global','template','project-local')),
    file_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    objective TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT,
    remote_iid INTEGER,
    remote_kind TEXT,
    gh_iid INTEGER,
    gl_iid INTEGER
  );
  CREATE TABLE discussions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL REFERENCES issues(id),
    author TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'note',
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO agents (name, kind, scope, file_path) VALUES
    ('swe',          'backbone',   'global',   'agents/swe.md'),
    ('pr-reviewer',  'backbone',   'global',   'agents/pr-reviewer.md'),
    ('architect',    'consultant', 'template', 'templates/agents/architect.md'),
    ('cto',          'consultant', 'template', 'templates/agents/cto.md');
  INSERT INTO issues (id, objective, status, created_at, updated_at)
    VALUES (1, 'test issue', 'open', datetime('now'), datetime('now'));
"
export TRAJECTORY_DB_PATH="$DB"

run_hook() {
  local input="$1"
  echo "$input" | bash "$HOOK" 2>&1 || true
}

consultant_input() {
  local name="$1"
  jq -n --arg name "$name" '{subagent_type: $name}'
}

# ========================================================
# Case 1: consultant with zero discussion rows → block with recovery message
# ========================================================

test_case "consultant with zero discussion rows → block JSON with recovery text"
out=$(run_hook "$(consultant_input "architect")")
assert_eq "block" "$(echo "$out" | jq -r '.decision // empty')" "decision is block"
assert_contains "$out" "discussion_append" "recovery message mentions discussion_append"
assert_contains "$out" "architect" "recovery message includes agent name"
assert_contains "$out" "issue_id=1" "recovery message includes issue_id"

# ========================================================
# Case 2: consultant with an existing discussion row → pass through
# ========================================================

sqlite3 "$DB" "
  INSERT INTO discussions (issue_id, author, kind, body, created_at)
    VALUES (1, 'architect', 'analysis', 'My analysis here.', datetime('now'));
"

test_case "consultant with existing discussion row → pass through (no output)"
out=$(run_hook "$(consultant_input "architect")")
assert_eq "" "$out" "no output when discussion row exists"
assert_eq "" "$(echo "$out" | jq -r '.decision // empty' 2>/dev/null || true)" "no decision field on pass-through"

# ========================================================
# Case 3: swe → pass-through (backbone role)
# ========================================================

test_case "swe subagent → pass-through (backbone role)"
out=$(run_hook "$(consultant_input "swe")")
assert_eq "" "$out" "no output for swe"

# ========================================================
# Case 3b: pr-reviewer → pass-through (backbone role)
# ========================================================

test_case "pr-reviewer subagent → pass-through (backbone role)"
out=$(run_hook "$(jq -n '{subagent_type: "pr-reviewer"}')")
assert_eq "" "$out" "no output for pr-reviewer"

# ========================================================
# Case 3c: bro → pass-through (backbone role not in agents table as backbone)
# Note: bro is explicitly named in the backbone guard even if not in agents table
# ========================================================

test_case "bro subagent → pass-through (explicitly guarded)"
out=$(run_hook "$(jq -n '{subagent_type: "bro"}')")
assert_eq "" "$out" "no output for bro"

# ========================================================
# Case 4: no DB → pass-through
# ========================================================

test_case "no DB → pass-through (silent)"
out=$(TRAJECTORY_DB_PATH="/tmp/does-not-exist-tmb-gate-test.db" bash "$HOOK" <<< "$(consultant_input "architect")" 2>&1 || true)
assert_eq "" "$out" "no output when DB absent"

# ========================================================
# Case 5: stop_hook_active set → pass-through
# ========================================================

test_case "stop_hook_active=true → pass-through"
out=$(run_hook "$(jq -n '{subagent_type: "architect", stop_hook_active: true}')")
assert_eq "" "$out" "no output when stop_hook_active is set"

# ========================================================
# Case 6: tmb: prefixed agent_type → normalized correctly (cto consultant, no discussion)
# ========================================================

test_case "tmb:cto prefixed agent_type → normalized and blocked (no discussion rows)"
out=$(run_hook "$(jq -n '{agent_type: "tmb:cto"}')")
assert_eq "block" "$(echo "$out" | jq -r '.decision // empty')" "decision is block for tmb:cto"
assert_contains "$out" "discussion_append" "recovery message for tmb:cto"
assert_contains "$out" "cto" "agent name appears in recovery"

# ========================================================
# Case 7: unknown agent (not in agents table) → pass-through
# ========================================================

test_case "unknown agent not in agents table → pass-through"
out=$(run_hook "$(consultant_input "some-external-agent")")
assert_eq "" "$out" "no output for agent not in agents table"

# ========================================================
# Case 8: consultant with discussion on a DIFFERENT issue → still blocked on open issue
# ========================================================

sqlite3 "$DB" "
  INSERT INTO issues (id, objective, status, created_at, updated_at)
    VALUES (2, 'second issue', 'open', datetime('now', '+1 second'), datetime('now', '+1 second'));
"

test_case "cto with no discussion on most-recent open issue → blocked (even if has discussion on older issue)"
sqlite3 "$DB" "
  INSERT INTO discussions (issue_id, author, kind, body, created_at)
    VALUES (1, 'cto', 'analysis', 'Analysis on old issue.', datetime('now'));
"
out=$(run_hook "$(consultant_input "cto")")
assert_eq "block" "$(echo "$out" | jq -r '.decision // empty')" "decision is block when discussion on non-current issue"
assert_contains "$out" "discussion_append" "blocked when discussion is on older issue, not most-recent"
assert_contains "$out" "issue_id=2" "recovery references the most-recent open issue"

# ========================================================
# Case 9: consultant with discussion on the most-recent open issue → pass through
# ========================================================

sqlite3 "$DB" "
  INSERT INTO discussions (issue_id, author, kind, body, created_at)
    VALUES (2, 'cto', 'analysis', 'Analysis on current issue.', datetime('now'));
"

test_case "cto with discussion on most-recent open issue → pass through"
out=$(run_hook "$(consultant_input "cto")")
assert_eq "" "$out" "no output when discussion row exists on most-recent issue"

summarize
