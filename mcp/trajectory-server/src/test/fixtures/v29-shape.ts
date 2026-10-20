import assert from 'node:assert/strict';
import type { TrajectoryDB } from '../../db.js';

export const V29_INDEXES = [
  'idx_tasks_issue_branch',
  'idx_tasks_status',
  'idx_tasks_commit_sha',
  'idx_issues_status',
  'idx_issues_gh_iid',
  'idx_agent_runs_open',
  'idx_pr_review_runs_task',
  'idx_discussions_issue_created',
];

const V29_CHECKS: Array<[string, string]> = [
  ['tasks', "status IN ('pending','running','needs_validation','completed','closed','failed','escalated')"],
  ['issues', "status IN ('open','closed')"],
  ['validation_attempts', "verdict IN ('pass','fail','escalate')"],
  ['discussions', "kind IN ('intent','question','answer','decision','note','analysis')"],
  ['milestones', "state IN ('open','closed')"],
  ['pr_review_runs', 'pr_number > 0'],
  ['pr_review_runs', "repo <> ''"],
  ['pr_review_runs', 'UNIQUE (pr_number, repo)'],
];

const V29_DROPPED_COLUMNS: Array<[string, string]> = [
  ['tasks', 'attempts'],
  ['issues', 'remote_iid'],
  ['agents', 'status'],
  ['pr_review_runs', 'verdict'],
  ['pr_review_runs', 'attempt_n'],
];

export function tableDdl(db: TrajectoryDB, table: string): string {
  const row = db.get<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    [table],
  );
  assert.ok(row, `${table} must exist`);
  return row.sql.replace(/\s+/g, ' ');
}

export function indexNames(db: TrajectoryDB): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
    .map((r) => r.name);
}

/**
 * Every v29 DDL item, asserted identically on fresh and migrated DBs. Later
 * versions keep all of them; the schema_version stamp is asserted by the
 * current version's shape (v30-shape.ts).
 */
export function assertV29Shape(db: TrajectoryDB): void {
  for (const [table, check] of V29_CHECKS) {
    assert.ok(tableDdl(db, table).includes(check), `${table} DDL must carry ${check}`);
  }

  for (const [table, column] of V29_DROPPED_COLUMNS) {
    const cols = db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
    assert.ok(!cols.includes(column), `${table}.${column} must be dropped`);
  }

  const mcp = db
    .all<{ name: string; notnull: number; dflt_value: string | null }>('PRAGMA table_info(validation_attempts)')
    .find((c) => c.name === 'mcp_available');
  assert.ok(mcp, 'validation_attempts.mcp_available must exist');
  assert.equal(mcp.notnull, 1, 'mcp_available must be NOT NULL');
  assert.equal(mcp.dflt_value, null, 'mcp_available must carry no DEFAULT');

  const indexes = indexNames(db);
  for (const name of V29_INDEXES) {
    assert.ok(indexes.includes(name), `index ${name} must exist`);
  }
  assert.ok(!indexes.includes('idx_pr_review_runs_audit'), 'idx_pr_review_runs_audit must be gone');
  assert.ok(!indexes.includes('idx_pr_review_runs_pr'), 'the partial idx_pr_review_runs_pr must be gone');
  const openIdx = db.get<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_runs_open'",
  );
  assert.ok(/WHERE completed_at IS NULL/.test(openIdx!.sql), 'idx_agent_runs_open must be partial on open rows');

  const triggers = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'discussions'")
    .map((r) => r.name)
    .sort();
  assert.deepEqual(triggers, ['discussions_ad', 'discussions_ai', 'discussions_au'], 'discussions FTS triggers must exist');

  const system = db.get<{ id: number; objective: string }>('SELECT id, objective FROM issues WHERE id = -1');
  assert.equal(system?.objective, 'system', 'the id=-1 system issue must exist');

  const residue = db.get<{ key: string }>("SELECT key FROM plugin_config WHERE key = 'tmb_default_repo'");
  assert.equal(residue, undefined, 'tmb_default_repo must be gone');

  const now = new Date().toISOString();
  assert.throws(
    () =>
      db.run(
        `INSERT INTO tasks (issue_id, branch_id, description, status, created_at, updated_at) VALUES (-1, 'fix/bad-status', 'd', 'open', ?, ?)`,
        [now, now],
      ),
    /CHECK/,
    'tasks.status CHECK must reject an unknown status',
  );
  assert.throws(
    () =>
      db.run(
        `INSERT INTO pr_review_runs (pr_number, repo, last_fetched_at) VALUES (0, 'owner/repo', ?)`,
        [now],
      ),
    /CHECK/,
    'pr_review_runs must reject the pr_number=0 sentinel',
  );
}
