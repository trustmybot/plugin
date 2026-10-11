import assert from 'node:assert/strict';
import type { TrajectoryDB } from '../../db.js';
import { assertV30Shape } from './v30-shape.js';

const V31_DROPPED_AGENT_RUNS_COLUMNS = ['tokens_total', 'usage_baseline_json'];

/**
 * Every v31 DDL item (plus all of v29/v30), asserted identically on fresh and
 * migrated DBs. The schema_version stamp is asserted by v32-shape.ts.
 */
export function assertV31Shape(db: TrajectoryDB): void {
  assertV30Shape(db);

  const runCols = db.all<{ name: string }>('PRAGMA table_info(agent_runs)').map((c) => c.name);
  for (const name of V31_DROPPED_AGENT_RUNS_COLUMNS) {
    assert.ok(!runCols.includes(name), `agent_runs.${name} must be dropped at v31`);
  }
}
