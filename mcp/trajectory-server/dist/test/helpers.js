import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const SCAN_PIN_KEYS = ['TMB_FORBID_LIVE_SYNC', 'TRAJECTORY_DB_PATH', 'TMB_SCAN_MCP_JSON'];
// pinScanEnv is the one way a test that forks scripts/scan.sh (directly or via
// scan_run) reaches a DB: it sets TMB_FORBID_LIVE_SYNC=1, points
// TRAJECTORY_DB_PATH at an empty per-file temp DB and TMB_SCAN_MCP_JSON at an
// empty mcpServers fixture, so scan.sh never walks up to the project's live
// trajectory DB nor reads ~/.claude.json. Child processes inherit the pin.
export function pinScanEnv() {
    const saved = {};
    for (const k of SCAN_PIN_KEYS)
        saved[k] = process.env[k];
    const dir = mkdtempSync(join(tmpdir(), 'tmb-scan-pin-'));
    const dbPath = join(dir, 'trajectory.db');
    const mcpJsonPath = join(dir, 'mcp-servers.json');
    writeFileSync(dbPath, '');
    writeFileSync(mcpJsonPath, '{}');
    process.env['TMB_FORBID_LIVE_SYNC'] = '1';
    process.env['TRAJECTORY_DB_PATH'] = dbPath;
    process.env['TMB_SCAN_MCP_JSON'] = mcpJsonPath;
    return {
        dbPath,
        mcpJsonPath,
        restore() {
            for (const k of SCAN_PIN_KEYS) {
                if (saved[k] === undefined)
                    delete process.env[k];
                else
                    process.env[k] = saved[k];
            }
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
// runGraphScript runs an ES-module body in a child node process (kuzu's native
// destructor can segfault at exit on Node 24/macOS, which must not fail the
// parent suite). `$DIST` in the body is replaced with the dist/ root; the body
// reports by printing one JSON line, which is parsed and returned.
export function runGraphScript(body, timeoutMs = 60000) {
    const distRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
    const script = body.split('$DIST').join(distRoot);
    let stdout = '';
    try {
        stdout = execFileSync(process.execPath, ['--experimental-sqlite', '--input-type=module'], {
            input: script,
            encoding: 'utf8',
            timeout: timeoutMs,
            env: process.env,
        });
    }
    catch (e) {
        const se = e;
        stdout = se.stdout ?? '';
        if (!stdout.trim()) {
            throw new Error(`graph script failed (exit ${se.status}): ${se.stderr?.slice(0, 1500) ?? ''}`);
        }
    }
    const line = stdout.trim().split('\n').reverse().find((l) => l.startsWith('{'));
    if (!line)
        throw new Error(`graph script printed no JSON: ${stdout.slice(0, 500)}`);
    return JSON.parse(line);
}
//# sourceMappingURL=helpers.js.map