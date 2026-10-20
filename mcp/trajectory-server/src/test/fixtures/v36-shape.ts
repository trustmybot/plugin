import assert from 'node:assert/strict';
import type { TrajectoryDB } from '../../db.js';
import { tableDdl } from './v29-shape.js';
import { assertV35Shape } from './v35-shape.js';

/**
 * Every v36 DDL item (plus all of v29–v35), asserted identically on fresh and
 * migrated DBs. The schema_version stamp is asserted by v37-shape.ts.
 */
export function assertV36Shape(db: TrajectoryDB): void {
  assertV35Shape(db);

  const runCols = db.all<{ name: string; type: string; notnull: number; pk: number }>('PRAGMA table_info(verification_runs)');
  assert.deepEqual(
    runCols.map((c) => [c.name, c.type, c.notnull, c.pk]),
    [
      ['id', 'INTEGER', 0, 1],
      ['task_id', 'INTEGER', 1, 0],
      ['commit_sha', 'TEXT', 1, 0],
      ['source', 'TEXT', 1, 0],
      ['started_at', 'TEXT', 1, 0],
      ['finished_at', 'TEXT', 0, 0],
      ['exit_code', 'INTEGER', 0, 0],
      ['budget_s', 'INTEGER', 1, 0],
      ['timed_out', 'INTEGER', 1, 0],
      ['created_at', 'TEXT', 1, 0],
    ],
    'verification_runs columns',
  );
  const runDdl = tableDdl(db, 'verification_runs').replace(/\s+/g, ' ');
  assert.match(runDdl, /source TEXT NOT NULL CHECK \(source IN \('gate','manual'\)\)/, 'verification_runs.source CHECK');
  assert.match(runDdl, /timed_out INTEGER NOT NULL DEFAULT 0 CHECK \(timed_out IN \(0,1\)\)/, 'verification_runs.timed_out CHECK');
  assert.deepEqual(
    db
      .all<{ table: string; from: string; to: string; on_delete: string }>('PRAGMA foreign_key_list(verification_runs)')
      .map((f) => [f.table, f.from, f.to, f.on_delete]),
    [['tasks', 'task_id', 'id', 'CASCADE']],
    'verification_runs.task_id → tasks(id) ON DELETE CASCADE',
  );
  assert.deepEqual(
    db.all<{ name: string }>('PRAGMA index_info(idx_verification_runs_task_commit)').map((c) => c.name),
    ['task_id', 'commit_sha', 'finished_at'],
    'idx_verification_runs_task_commit on (task_id, commit_sha, finished_at)',
  );

  const cmdCols = db.all<{ name: string; type: string; notnull: number; pk: number }>('PRAGMA table_info(verification_run_commands)');
  assert.deepEqual(
    cmdCols.map((c) => [c.name, c.type, c.notnull, c.pk]),
    [
      ['run_id', 'INTEGER', 1, 1],
      ['ordinal', 'INTEGER', 1, 2],
      ['command', 'TEXT', 1, 0],
      ['exit_code', 'INTEGER', 0, 0],
      ['elapsed_s', 'REAL', 0, 0],
      ['output_tail', 'TEXT', 0, 0],
    ],
    'verification_run_commands columns and PRIMARY KEY (run_id, ordinal)',
  );
  assert.deepEqual(
    db
      .all<{ table: string; from: string; to: string; on_delete: string }>('PRAGMA foreign_key_list(verification_run_commands)')
      .map((f) => [f.table, f.from, f.to, f.on_delete]),
    [['verification_runs', 'run_id', 'id', 'CASCADE']],
    'verification_run_commands.run_id → verification_runs(id) ON DELETE CASCADE',
  );
}
