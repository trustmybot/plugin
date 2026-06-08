import { TrajectoryDB } from '../db.js';

// tempDB returns an in-memory DB. By default it pre-seeds a
// `deep_scan_completed` audit row so the world-model-cold gate on
// task_create_batch clears for tests that don't exercise scan_run. Tests
// targeting the gate itself should pass `seedScan: false` to omit the seed.
export function tempDB(opts: { seedScan?: boolean } = {}): TrajectoryDB {
  const db = new TrajectoryDB(':memory:');
  if (opts.seedScan !== false) {
    db.run(
      `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
       VALUES (-1, NULL, 'bro', 'deep_scan_completed', 'test fixture: gate cleared', '{}', datetime('now'))`,
    );
  }
  return db;
}
