import assert from 'node:assert/strict';
import type { TrajectoryDB } from '../../db.js';
import { tableDdl } from './v29-shape.js';
import { assertV32Shape } from './v32-shape.js';

const V33_AGENT_RUNS_COLUMNS = ['root_dir', 'model', 'host', 'exit_reason'];

/** Every v33 DDL item (plus all of v29–v32), asserted identically on fresh and migrated DBs. */
export function assertV33Shape(db: TrajectoryDB): void {
  const meta = db.get<{ schema_version: number }>('SELECT schema_version FROM plugin_meta LIMIT 1');
  assert.equal(meta!.schema_version, 33, 'schema_version must be 33');

  assertV32Shape(db);

  const cols = db.all<{ name: string; type: string; notnull: number; dflt_value: unknown }>('PRAGMA table_info(agent_runs)');
  for (const name of V33_AGENT_RUNS_COLUMNS) {
    const col = cols.find((c) => c.name === name);
    assert.ok(col, `agent_runs.${name} must exist at v33`);
    assert.equal(col.type, 'TEXT', `agent_runs.${name} is TEXT`);
    assert.equal(col.notnull, 0, `agent_runs.${name} is nullable`);
    assert.equal(col.dflt_value, null, `agent_runs.${name} has no default`);
  }

  const ddl = tableDdl(db, 'agent_runs').replace(/\s+/g, ' ');
  assert.match(ddl, /host TEXT CHECK \(host IN \('claude','codex'\)\)/, 'agent_runs.host CHECK');
  assert.match(
    ddl,
    /exit_reason TEXT CHECK \(exit_reason IN \('completed','failed','escalated','swept_orphan','swept_stale','issue_closed'\)\)/,
    'agent_runs.exit_reason CHECK',
  );
  assert.match(
    ddl,
    /usage_source TEXT CHECK \(usage_source IN \('transcript','subagent_stop','unmeasured','backfill'\)\)/,
    'agent_runs.usage_source admits backfill',
  );

  const prices = db.get<{ value_json: string }>(`SELECT value_json FROM plugin_config WHERE key = 'model_prices'`);
  assert.ok(prices, 'plugin_config.model_prices is seeded');
}
