import { TrajectoryDB } from '../db.js';
// tempDB returns an in-memory DB. By default it pre-seeds a
// `deep_scan_completed` audit row so the world-model-cold gate on
// task_create_batch clears for tests that don't exercise scan_run. Tests
// targeting the gate itself should pass `seedScan: false` to omit the seed.
export function tempDB(opts = {}) {
    const db = new TrajectoryDB(':memory:');
    if (opts.seedScan !== false) {
        db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
       VALUES (-1, NULL, 'bro', 'deep_scan_completed', 'test fixture: gate cleared', '{}', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
    }
    return db;
}
// seedReviewerObservation writes the row the reviewer-identity-observe hook
// writes when a pr-reviewer subagent calls validation_record, so a test's
// validation_record call finds a reviewer identity to stamp.
export function seedReviewerObservation(db, taskId, attemptN, opts = {}) {
    const issueId = db.get('SELECT issue_id FROM tasks WHERE id = ?', [Number(taskId)])?.issue_id ?? -1;
    const content = JSON.stringify({
        task_id: Number(taskId),
        attempt_n: attemptN,
        session_id: opts.sessionId ?? 'main-session',
        agent_id: opts.agentId ?? 'reviewer0agent01',
        tool_use_id: opts.toolUseId === undefined ? 'toolu_test0000000001' : opts.toolUseId,
        observed_at: opts.observedAt ?? new Date().toISOString(),
        consumed: 0,
    });
    const res = db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
     VALUES (?, NULL, 'hook:reviewer-identity-observe', 'reviewer_identity_observed', 'test fixture: reviewer observed', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`, [issueId, content]);
    return Number(res.lastInsertRowid);
}
//# sourceMappingURL=helpers.js.map