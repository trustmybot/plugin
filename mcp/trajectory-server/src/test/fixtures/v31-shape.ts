import assert from 'node:assert/strict';
import type { TrajectoryDB } from '../../db.js';
import { assertV30Shape } from './v30-shape.js';

const V31_DROPPED_AGENT_RUNS_COLUMNS = ['tokens_total', 'usage_baseline_json'];

/** Every v31 DDL item (plus all of v29/v30), asserted identically on fresh and migrated DBs. */
export function assertV31Shape(db: TrajectoryDB): void {
  const meta = db.get<{ schema_version: number }>('SELECT schema_version FROM plugin_meta LIMIT 1');
  assert.equal(meta!.schema_version, 31, 'schema_version must be 31');

  assertV30Shape(db);

  const runCols = db.all<{ name: string }>('PRAGMA table_info(agent_runs)').map((c) => c.name);
  for (const name of V31_DROPPED_AGENT_RUNS_COLUMNS) {
    assert.ok(!runCols.includes(name), `agent_runs.${name} must be dropped at v31`);
  }
}
