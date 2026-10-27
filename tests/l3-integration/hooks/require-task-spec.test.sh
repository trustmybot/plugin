#!/usr/bin/env bash
# Tests for scripts/hooks/require-task-spec.sh (DB-backed form)
# Hook contract: block SWE spawns unless the prompt cites a valid
# task_id=<N> whose row in tasks table is pending, or running with no live swe
# agent_runs row (an unbound row older than 90 s is not live), AND has a non-empty spec_body. A pending task whose repo is a git
# work tree must also have its branch checked out in a linked worktree. A schema-touching (a .sql file, a schema.* basename,
# a migrations/migration/migrate directory, db.ts) or column-adding task also needs Writer: + Populated: lines or a Nullable: line,
# unless a spec_shape_gate_waived audit row with from_node = 'bro' names the task
# (written per task by task_create_batch / task_provision with waive_spec_shape,
# or by bro through audit_append). See plugin CHANGELOG for history.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/require-task-spec.sh"
HOOK_IMPL="${TMB_HOOK_TEST_IMPL:-bash}"
[ "$HOOK_IMPL" != ts ] || HOOK="$PLUGIN_ROOT/tests/lib/ts-hooks/require-task-spec.sh"
. "$HERE/fixtures/wal-no-holder.sh"

# Fixture: isolated TRAJECTORY_DB_PATH + a tasks table with known rows
TMPDIR=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-require-task-spec.XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT
PROJECT_DIR="$TMPDIR/project"
mkdir -p "$PROJECT_DIR"
export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
DB="$TMPDIR/trajectory.db"
export TRAJECTORY_DB_PATH="$DB"

sqlite3 "$DB" "
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    spec_body TEXT,
    files TEXT,
    issue_id INTEGER,
    branch_id TEXT
  );
  CREATE TABLE issues (id INTEGER PRIMARY KEY, repo TEXT);
  CREATE TABLE audit (id INTEGER PRIMARY KEY, issue_id INTEGER, branch_id TEXT, from_node TEXT, event_type TEXT, summary TEXT, content_json TEXT, repo TEXT, created_at TEXT);
  INSERT INTO issues VALUES (1, 'plugin');
  CREATE TABLE agent_runs (
    id INTEGER PRIMARY KEY,
    task_id INTEGER,
    agent_type TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    spawn_id TEXT
  );
  INSERT INTO tasks (id, status, spec_body) VALUES (1, 'pending',     'Do the thing.');
  INSERT INTO tasks (id, status, spec_body) VALUES (2, 'pending',     '');
  INSERT INTO tasks (id, status, spec_body) VALUES (3, 'running',     'Reopened, no live swe.');
  INSERT INTO tasks (id, status, spec_body) VALUES (4, 'completed',   'Already done.');
  INSERT INTO tasks (id, status, spec_body) VALUES (5, 'in_progress', 'Mid-flight.');
  INSERT INTO tasks (id, status, spec_body) VALUES (6, 'running',     'swe still working.');
  INSERT INTO tasks (id, status, spec_body) VALUES (7, 'closed',      'Closed.');
  INSERT INTO tasks (id, status, spec_body) VALUES (8, 'running',     'Spawn recorded, never started.');
  INSERT INTO tasks (id, status, spec_body) VALUES (9, 'running',     'Spawn recorded just now.');
  INSERT INTO agent_runs VALUES (10, 3, 'swe', '2026-10-01T00:00:00.000Z', '2026-10-01T01:00:00.000Z', 'agent-10');
  INSERT INTO agent_runs VALUES (11, 3, 'bro', '2026-10-01T00:00:00.000Z', NULL, NULL);
  INSERT INTO agent_runs VALUES (12, 6, 'swe', '2026-10-11T09:00:00.000Z', NULL, 'agent-12');
  INSERT INTO agent_runs VALUES (13, 8, 'swe', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 minutes'), NULL, 'tool_use:toolu_13');
  INSERT INTO agent_runs VALUES (14, 9, 'swe', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minutes'), NULL, 'tool_use:toolu_14');
"
sqlite3 "$DB" <<'SQL'
INSERT INTO tasks VALUES (20, 'pending', '## Success Criteria
- the column exists', '["mcp/trajectory-server/src/schema.sql","mcp/trajectory-server/src/db.ts"]', 1, 'feat/col');
INSERT INTO tasks VALUES (21, 'pending', '## Success Criteria
- `Writer: task_update_status`
- `Populated: bash tests/lib/assert-sql.sh db.copy "SELECT count(*) FROM tasks WHERE x IS NOT NULL" 1 --op ge`', '["migrations/031.sql"]', 1, 'feat/col2');
INSERT INTO tasks VALUES (22, 'pending', '## Success Criteria
Nullable: only set for legacy rows', '["mcp/trajectory-server/src/schema.sql"]', 1, 'feat/col3');
INSERT INTO tasks VALUES (23, 'pending', '## Success Criteria
- the column exists', '["src/schema.sql"]', 1, 'feat/col4');
INSERT INTO tasks VALUES (24, 'pending', '## Success Criteria
- README typo fixed', '["README.md","scripts/"]', 1, 'docs/typo');
INSERT INTO tasks VALUES (25, 'pending', 'Add a new column ended_at.
## Success Criteria
Writer: bro_atomic_close', '["src/handlers.ts"]', 1, 'feat/col5');
INSERT INTO tasks VALUES (26, 'pending', 'Touch the loader.', '["mcp/trajectory-server/src/DB.ts"]', 1, 'feat/dodge1');
INSERT INTO tasks VALUES (27, 'pending', 'ADD  COLUMN ended_at to tasks.', '["src/handlers.ts"]', 1, 'feat/dodge2');
INSERT INTO tasks VALUES (28, 'pending', 'ADD' || char(10) || 'COLUMN ended_at to tasks.', '["src/handlers.ts"]', 1, 'feat/dodge3');
INSERT INTO tasks VALUES (29, 'pending', 'Add a new' || char(9) || 'field to the result.', '["src/handlers.ts"]', 1, 'feat/dodge4');
INSERT INTO tasks VALUES (30, 'pending', 'Add a new-column for metering.', '["src/handlers.ts"]', 1, 'feat/dodge5');
INSERT INTO tasks VALUES (31, 'pending', 'Ship it.', '["db/Migrations/040.sql"]', 1, 'feat/dodge6');
INSERT INTO tasks VALUES (36, 'pending', 'ADD' || char(160) || 'COLUMN ended_at to tasks.', '["src/handlers.ts"]', 1, 'feat/dodge7');
INSERT INTO tasks VALUES (37, 'pending', 'Add a new' || char(8239) || 'field and a new' || char(12288) || 'tool.', '["src/handlers.ts"]', 1, 'feat/dodge8');
INSERT INTO tasks VALUES (32, 'pending', '## Success Criteria
1. Writer: task_update_status
2. Populated: bash tests/lib/assert-sql.sh db.copy "SELECT count(*) FROM tasks" 1 --op ge', '["src/schema.sql"]', 1, 'feat/num');
INSERT INTO tasks VALUES (33, 'pending', '## Success Criteria
- Writer: task_update_status
- Populated: bash tests/lib/assert-sql.sh db.copy "SELECT count(*) FROM tasks" 1 --op ge', '["src/schema.sql"]', 1, 'feat/bullet');
INSERT INTO tasks VALUES (34, 'pending', '## Success Criteria
- Writer:
- Populated: bash tests/lib/assert-sql.sh db.copy "SELECT count(*) FROM tasks" 1 --op ge', '["src/schema.sql"]', 1, 'feat/empty');
INSERT INTO tasks VALUES (35, 'pending', '## Success Criteria
- `Writer: `
- Nullable:', '["src/schema.sql"]', 1, 'feat/empty2');
INSERT INTO tasks VALUES (60, 'pending', 'Ship it.', '["prisma/schema.prisma"]', 1, 'feat/shape60');
INSERT INTO tasks VALUES (61, 'pending', 'Ship it.', '["db/migrate/20240101_x.rb"]', 1, 'feat/shape61');
INSERT INTO tasks VALUES (62, 'pending', 'Ship it.', '["sql/seed.sql"]', 1, 'feat/shape62');
INSERT INTO tasks VALUES (63, 'pending', 'Ship it.', '["src/db.ts"]', 1, 'feat/shape63');
INSERT INTO tasks VALUES (64, 'pending', 'Ship it.', '["docs/migrations-guide.md"]', 1, 'feat/shape64');
INSERT INTO tasks VALUES (65, 'pending', 'Ship it.', '["app/schematics/x.ts"]', 1, 'feat/shape65');
INSERT INTO tasks VALUES (66, 'pending', 'Ship it.', '["src/mydb.ts"]', 1, 'feat/shape66');
SQL

make_repo() {
  git init -q -b main "$1"
  git -C "$1" -c user.name=t -c user.email=t@t.t commit -q --allow-empty -m base
}
make_repo "$TMPDIR/gitapp"
git -C "$TMPDIR/gitapp" branch fix/has-wt
git -C "$TMPDIR/gitapp" branch fix/no-wt
git -C "$TMPDIR/gitapp" worktree add -q "$TMPDIR/gitapp/.claude/worktrees/has-wt" fix/has-wt
make_repo "$TMPDIR/mainapp"
git -C "$TMPDIR/mainapp" checkout -q -b fix/on-main
sqlite3 "$DB" "
  ALTER TABLE tasks ADD COLUMN repo TEXT;
  CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL);
  INSERT INTO repos VALUES ('gitapp', '$TMPDIR/gitapp');
  INSERT INTO repos VALUES ('mainapp', '$TMPDIR/mainapp');
  INSERT INTO tasks (id, status, spec_body, branch_id, repo) VALUES (70, 'pending', 'Do the thing.', 'fix/no-wt', 'gitapp');
  INSERT INTO tasks (id, status, spec_body, branch_id, repo) VALUES (71, 'pending', 'Do the thing.', 'fix/has-wt', 'gitapp');
  INSERT INTO tasks (id, status, spec_body, branch_id, repo) VALUES (72, 'pending', 'Do the thing.', 'fix/on-main', 'mainapp');
  INSERT INTO tasks (id, status, spec_body, branch_id, repo) VALUES (73, 'pending', 'Do the thing.', 'fix/anywhere', NULL);
  INSERT INTO tasks (id, status, spec_body, branch_id, repo) VALUES (74, 'running', 'Do the thing.', 'fix/no-wt', 'gitapp');
"

swe_input() {
  jq -n --arg p "$1" '{tool_input:{subagent_type:"swe",prompt:$p}}'
}

non_swe_input() {
  jq -n --arg p "$1" '{tool_input:{subagent_type:"architect",prompt:$p}}'
}

run_hook() {
  echo "$1" | bash "$HOOK" 2>&1 || true
}

run_hook_env() {
  local input="$1" env_var="$2" env_val="$3"
  echo "$input" | env "$env_var=$env_val" bash "$HOOK" 2>&1 || true
}

test_case "non-SWE agent passes through without any gating"
out=$(run_hook "$(non_swe_input 'no task_id here at all')")
assert_eq "" "$out" "hook output for non-SWE"

test_case "SWE without task_id token in prompt is blocked"
out=$(run_hook "$(swe_input 'please do the thing')")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
assert_contains "$out" "SWE spawn requires task_id" "reason cites missing task_id"

test_case "SWE with task_id for nonexistent row is blocked"
out=$(run_hook "$(swe_input 'task_id=9999 please do the thing')")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
assert_contains "$out" "does not exist in the tasks table" "reason cites missing row"

test_case "SWE with task_id referencing a completed task is blocked"
out=$(run_hook "$(swe_input 'task_id=4 please do the thing')")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
assert_contains "$out" "status=completed" "reason cites wrong status"

test_case "SWE with task_id referencing an in_progress task is blocked"
out=$(run_hook "$(swe_input 'task_id=5 please do the thing')")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
assert_contains "$out" "status=in_progress" "reason cites wrong status"

test_case "SWE with pending task that has empty spec_body is blocked"
out=$(run_hook "$(swe_input 'task_id=2 please do the thing')")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
assert_contains "$out" "has empty spec_body" "reason cites missing body"

test_case "SWE with pending task and non-empty body passes silently"
out=$(run_hook "$(swe_input 'task_id=1 please do the thing')")
assert_eq "" "$out" "silent pass"

test_case "SWE with colon-form 'task_id: N' passes silently (separator-agnostic parser)"
out=$(run_hook "$(swe_input 'task_id: 1
please do the thing')")
assert_eq "" "$out" "silent pass for colon form"

test_case "SWE on a running task with no open swe run passes silently"
out=$(run_hook "$(swe_input 'task_id=3 please do the thing')")
assert_eq "" "$out" "silent pass"

test_case "SWE on a running task with a live swe run is blocked, naming the run"
out=$(run_hook "$(swe_input 'task_id=6 please do the thing')")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
assert_contains "$out" "live swe run: agent_runs 12" "reason names the live run"

test_case "SWE on a running task whose only open run is unbound and older than 90 s passes silently"
out=$(run_hook "$(swe_input 'task_id=8 please do the thing')")
assert_eq "" "$out" "a spawn that never started does not block a respawn"

test_case "SWE on a running task with a fresh unbound spawn row is blocked"
out=$(run_hook "$(swe_input 'task_id=9 please do the thing')")
assert_contains "$out" "live swe run: agent_runs 14" "a just-recorded spawn is live"

test_case "SWE on a closed task is blocked"
out=$(run_hook "$(swe_input 'task_id=7 please do the thing')")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
assert_contains "$out" "status=closed" "reason cites the status"

test_case "hook carries no 'open' task-status literal"
if grep -nE "[\"']open[\"']" "$HOOK"; then
  echo "FAIL: require-task-spec.sh still names an 'open' status"; exit 1
fi

test_case "when prompt has multiple task_id tokens, first wins"
out=$(run_hook "$(swe_input 'task_id=1 and also task_id=4')")
assert_eq "" "$out" "first token is valid -> passes"

test_case "unresolved trajectory DB (project not onboarded) allows the spawn"
out=$(run_hook_env "$(swe_input 'task_id=1')" "TRAJECTORY_DB_PATH" "$TMPDIR/nonexistent.db")
assert_eq "" "$out" "unresolved DB → silent allow"

test_case "unreadable trajectory DB denies with the unavailable reason"
printf 'not a sqlite database' > "$TMPDIR/corrupt.db"
out=$(run_hook_env "$(swe_input 'task_id=1')" "TRAJECTORY_DB_PATH" "$TMPDIR/corrupt.db")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
assert_contains "$out" "trajectory DB unavailable" "reason cites the unavailable DB"

WAL_PROJ="$TMPDIR/wal-project"
mkdir -p "$WAL_PROJ/.claude/tmb"
sqlite3 "$DB" ".backup '$WAL_PROJ/.claude/tmb/trajectory.db'"
# The WAL cases log the sqlite3 CLI's invocations, so the TS gate reads through it.
[ "$HOOK_IMPL" != ts ] || export TMB_HOOKS_SQLITE=cli
wal_gate_cases "require-task-spec" "$HOOK" "$WAL_PROJ/.claude/tmb/trajectory.db" "$WAL_PROJ" \
  "$(swe_input 'task_id=2 please do the thing')" "has empty spec_body" "does not exist in the tasks table"
unset TMB_HOOKS_SQLITE

test_case "schema-touching task without Writer:/Populated: is blocked, naming both lines"
out=$(run_hook "$(swe_input 'task_id=20 please do the thing')")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
assert_contains "$out" "missing a Writer: and Populated: line" "reason names the missing lines"

test_case "schema-touching task with Writer: and Populated: passes silently"
out=$(run_hook "$(swe_input 'task_id=21 please do the thing')")
assert_eq "" "$out" "silent pass"

test_case "schema-touching task with a Nullable: line passes silently"
out=$(run_hook "$(swe_input 'task_id=22 please do the thing')")
assert_eq "" "$out" "silent pass"

test_case "spec_body adding a new column with Writer: only is blocked, naming Populated:"
out=$(run_hook "$(swe_input 'task_id=25 please do the thing')")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
assert_contains "$out" "missing a Populated: line" "reason names the missing Populated: line"

for dodge in "26:files[] names DB.ts" "27:ADD  COLUMN" "28:ADD<newline>COLUMN" "29:new<tab>field" "30:new-column" "31:files[] names Migrations/" "36:ADD<nbsp>COLUMN" "37:new<narrow nbsp>field"; do
  test_case "spec-shape trigger is whitespace- and case-proof: ${dodge#*:} without the lines is blocked"
  out=$(run_hook "$(swe_input "task_id=${dodge%%:*} please do the thing")")
  assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
  assert_contains "$out" "missing a Writer: and Populated: line" "reason names the missing lines"
done

test_case "numbered-list Writer:/Populated: lines pass silently"
out=$(run_hook "$(swe_input 'task_id=32 please do the thing')")
assert_eq "" "$out" "silent pass"

test_case "bulleted Writer:/Populated: lines pass silently"
out=$(run_hook "$(swe_input 'task_id=33 please do the thing')")
assert_eq "" "$out" "silent pass"

test_case "an empty Writer: value does not count"
out=$(run_hook "$(swe_input 'task_id=34 please do the thing')")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
assert_contains "$out" "missing a Writer: line" "reason names the empty Writer: line"

test_case "an empty Nullable: value and a backticked empty Writer: do not count"
out=$(run_hook "$(swe_input 'task_id=35 please do the thing')")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
assert_contains "$out" "missing a Writer: and Populated: line" "reason names both lines"

test_case "the deny tells bro the audit_append waiver call for this task"
out=$(run_hook "$(swe_input 'task_id=23 please do the thing')")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny before any waiver"
assert_contains "$out" 'audit_append(event_type=\"spec_shape_gate_waived\"' "reason names the audit_append call"
assert_contains "$out" 'issue_id=1, branch_id=\"feat/col4\"' "reason names the task's issue and branch"
assert_contains "$out" '\"task_id\":23,\"gate\":\"spec_shape\"' "reason names the content_json keys"

test_case "a waiver row for another task, another gate or a short reason does not allow"
sqlite3 "$DB" "
  INSERT INTO audit (issue_id, from_node, event_type, summary, content_json) VALUES
    (1, 'bro', 'spec_shape_gate_waived', 'other task', '{\"task_id\":20,\"gate\":\"spec_shape\",\"reason\":\"column dropped next task\"}'),
    (1, 'bro', 'spec_shape_gate_waived', 'batch waiver', '{\"task_id\":23,\"reason\":\"column dropped next task\"}'),
    (1, 'bro', 'spec_shape_gate_waived', 'short', '{\"task_id\":23,\"gate\":\"spec_shape\",\"reason\":\"short\"}');"
out=$(run_hook "$(swe_input 'task_id=23 please do the thing')")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"

test_case "an otherwise valid waiver row written by code-reviewer does not allow"
sqlite3 "$DB" "INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json) VALUES
  (1, 'feat/col4', 'code-reviewer', 'spec_shape_gate_waived', 'waive', '{\"task_id\":\"23\",\"gate\":\"spec_shape\",\"reason\":\"column is dropped again in the next task\"}');"
out=$(run_hook "$(swe_input 'task_id=23 please do the thing')")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"

test_case "a bro-recorded spec_shape_gate_waived row for the task allows, and the hook writes nothing"
sqlite3 "$DB" "INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json) VALUES
  (1, 'feat/col4', 'bro', 'spec_shape_gate_waived', 'waive', '{\"task_id\":\"23\",\"gate\":\"spec_shape\",\"reason\":\"column is dropped again in the next task\"}');"
before=$(sqlite3 "$DB" "SELECT count(*) FROM audit;")
out=$(run_hook "$(swe_input 'task_id=23 please do the thing')")
assert_eq "" "$out" "waived spawn passes silently"
after=$(sqlite3 "$DB" "SELECT count(*) FROM audit;")
assert_eq "$before" "$after" "no audit row written by the hook"

test_case "non-schema task without the lines passes silently"
out=$(run_hook "$(swe_input 'task_id=24 please do the thing')")
assert_eq "" "$out" "silent pass"

for id in 60 61 62 63; do
  test_case "generic schema shape task $id without Writer:/Populated: is blocked"
  out=$(run_hook "$(swe_input "task_id=$id please do the thing")")
  assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
done

for id in 64 65 66; do
  test_case "non-schema lookalike path task $id passes silently"
  out=$(run_hook "$(swe_input "task_id=$id please do the thing")")
  assert_eq "" "$out" "silent pass"
done

test_case "pending task in a git repo with no linked worktree is blocked with the task_reopen next step"
out=$(run_hook "$(swe_input 'task_id=70 please do the thing')")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
assert_contains "$out" "task_reopen(task_id=70" "reason spells the task_reopen call"
assert_contains "$out" "fix/no-wt" "reason names the branch"
assert_contains "$out" "$TMPDIR/gitapp/.claude/worktrees/no-wt" "reason names the expected worktree path"
assert_not_contains "$out" "switch the main checkout" "no main-checkout advice"

test_case "pending task whose branch is checked out in a linked worktree passes silently"
out=$(run_hook "$(swe_input 'task_id=71 please do the thing')")
assert_eq "" "$out" "linked worktree allows"

test_case "pending task whose branch is checked out in the main checkout is blocked with switch-back advice"
out=$(run_hook "$(swe_input 'task_id=72 please do the thing')")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
assert_contains "$out" "switch the main checkout back" "reason says to switch the main checkout back"
assert_contains "$out" "task_reopen(task_id=72" "reason spells the task_reopen call"

test_case "pending task whose project dir is not a git work tree passes silently"
out=$(run_hook "$(swe_input 'task_id=73 please do the thing')")
assert_eq "" "$out" "non-git project dir is not gated"

test_case "running task with no worktree is not gated"
out=$(run_hook "$(swe_input 'task_id=74 please do the thing')")
assert_eq "" "$out" "running task allowed"

test_case "GH 1553: a relative repos.path resolves against the project root, not the DB's dir"
WS_DB="$TMPDIR/ws/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$WS_DB")"
sqlite3 "$DB" ".backup '$WS_DB'"
make_repo "$TMPDIR/ws/relapp"
sqlite3 "$WS_DB" "
  INSERT INTO repos VALUES ('relapp', 'relapp');
  INSERT INTO tasks (id, status, spec_body, branch_id, repo) VALUES (75, 'pending', 'Do the thing.', 'fix/rel-no-wt', 'relapp');
"
out=$(run_hook_env "$(swe_input 'task_id=75 please do the thing')" "TRAJECTORY_DB_PATH" "$WS_DB")
assert_contains "$out" '"permissionDecision":"deny"' "the relative repo is gated as a git work tree"
assert_contains "$out" "$TMPDIR/ws/relapp/.claude/worktrees/rel-no-wt" "reason names the worktree under <project>/relapp"

# Real server writers against a real trajectory DB: the rows task_create_batch
# and audit_append write are the rows the hook reads.
SERVER_DB="$TMPDIR/server.db"
SERVER_IDS=$(TRAJECTORY_DB_PATH="$SERVER_DB" DIST="$PLUGIN_ROOT/mcp/trajectory-server/dist" node --experimental-sqlite --no-warnings --input-type=module -e '
const dist = process.env.DIST;
const { TrajectoryDB } = await import(`${dist}/db.js`);
const { taskTools } = await import(`${dist}/tools/tasks.js`);
const { auditTools } = await import(`${dist}/tools/audit.js`);
const { resetEmbeddingModelForTests } = await import(`${dist}/embeddings/model.js`);
resetEmbeddingModelForTests(() => new Promise(() => {}));
const db = new TrajectoryDB(process.env.TRAJECTORY_DB_PATH);
db.run("INSERT INTO issues (objective, status, created_at, updated_at) VALUES (?, ?, ?, ?)", ["spec waiver", "open", new Date().toISOString(), new Date().toISOString()]);
const issueId = db.get("SELECT MAX(id) AS id FROM issues").id;
const spec = "Add a new column ended_at to tasks.\n## Success Criteria\n- SC1: the column exists";
const gates = {
  waive_scope_gate: true, waive_scope_gate_reason: "not under test here",
  waive_branch_gate: true, waive_branch_gate_reason: "not under test here",
  waive_intent_gate: true, waive_intent_gate_reason: "not under test here",
  waive_decision_gate: true, waive_decision_gate_reason: "not under test here",
  waive_registry_gate: true, waive_registry_gate_reason: "not under test here",
};
const batch = async (extra, branches) => {
  const r = await taskTools(db).handlers.task_create_batch({
    agent: "bro", issue_id: String(issueId), ...gates, ...extra,
    tasks: branches.map((b) => ({ branch_id: b, description: b, spec_body: spec })),
  });
  if (r.isError) throw new Error(r.content[0].text);
  const out = JSON.parse(r.content[0].text);
  return (out.tasks ?? out).map((t) => t.id);
};
const waived = await batch({ waive_spec_shape: true, waive_spec_shape_reason: "column lands with its writer in the next task" }, ["feat/w-a", "feat/w-b"]);
const [plain, manual] = await batch({}, ["feat/plain", "feat/manual"]);
const a = await auditTools(db).handlers.audit_append({
  agent: "bro", issue_id: issueId, branch_id: "feat/manual", from_node: "bro",
  event_type: "spec_shape_gate_waived", summary: "manual waiver",
  content_json: JSON.stringify({ task_id: manual, gate: "spec_shape", reason: "column lands with its writer in the next task" }),
});
if (a.isError) throw new Error(a.content[0].text);
db.close();
console.log([...waived, plain, manual].join(" "));
process.exit(0);
')
read -r WAIVED_A WAIVED_B PLAIN_ID MANUAL_ID <<< "$SERVER_IDS"
# The server closed the DB: WAL mode, no -shm/-wal, nothing holds it open.
wal_detach "$SERVER_DB"

test_case "task_create_batch(waive_spec_shape) opens the gate for every task it created with no second write"
for id in "$WAIVED_A" "$WAIVED_B"; do
  out=$(run_hook_env "$(swe_input "task_id=$id please do the thing")" "TRAJECTORY_DB_PATH" "$SERVER_DB")
  assert_eq "" "$out" "task $id spawns without a manual audit row"
done
assert_eq "2" "$(sqlite3 "$SERVER_DB" "SELECT count(*) FROM audit WHERE event_type = 'spec_shape_gate_waived' AND json_extract(content_json, '\$.source') = 'task_create_batch';")" "one row per waived task"

test_case "a task created without the waiver and missing Writer:/Populated: is still denied"
out=$(run_hook_env "$(swe_input "task_id=$PLAIN_ID please do the thing")" "TRAJECTORY_DB_PATH" "$SERVER_DB")
assert_contains "$out" '"permissionDecision":"deny"' "permissionDecision deny"
assert_contains "$out" "missing a Writer: and Populated: line" "reason names the missing lines"

test_case "a manual audit_append waiver row still opens the gate"
out=$(run_hook_env "$(swe_input "task_id=$MANUAL_ID please do the thing")" "TRAJECTORY_DB_PATH" "$SERVER_DB")
assert_eq "" "$out" "manual waiver passes silently"

summarize
