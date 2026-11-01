/**
 * Stop `asyncRewake` entry (GH 2205): watches the session while bro is idle and
 * wakes bro on a finding of liveness-probe. Run directly as `node dist/hooks.js
 * liveness-sentinel`, because its exit 2 is a wake and not a deny: dispatch.sh
 * would replay it under its lock and audit a `hook_denied`.
 *
 * It writes the session's background task snapshot on every Stop. It arms only
 * under CLAUDE_CODE_SESSION_ATTENDED=1, since a pending asyncRewake blocks
 * `claude -p` until it ends. Armed, it writes a generation token (every Stop
 * spawns another instance; the newest wins) and polls every TMB_LIVENESS_POLL_S
 * seconds (default 60), exiting 0 when its token is superseded, its parent
 * changed or nothing of its session is left to watch. On a finding it claims the
 * once-marker and exits 2 with the report on stderr. No claim, no wake, so a DB
 * failure cannot loop.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ALLOW } from './gate.js';
import { dbPath, haveSqlite } from './lib/db.js';
import { jsonValues } from './lib/jq.js';
import { claimLivenessFinding, findingReport, livenessSessionsDir, readStateFile, sweep, writeSnapshot, writeStateFile } from './liveness-probe.js';
import { safeSessionId } from './plugin-hooks-marker.js';
export const GATE_NAME = 'liveness-sentinel';
export const POLL_ENV = 'TMB_LIVENESS_POLL_S';
export const DEFAULT_POLL_S = 60;
export const TOKEN_SUFFIX = '.liveness-token';
function pollMs(env) {
    const raw = env[POLL_ENV] ?? '';
    const seconds = /^[0-9]+$/.test(raw) && Number(raw) > 0 ? Number(raw) : DEFAULT_POLL_S;
    return seconds * 1000;
}
function payloadFields(payload) {
    const [value] = jsonValues(payload);
    const transcript = value?.transcript_path;
    return { backgroundTasks: value?.background_tasks, transcriptPath: typeof transcript === 'string' ? transcript : '' };
}
export function makeLivenessSentinel(clock = () => new Date()) {
    return async (payload, env) => {
        const sessionId = safeSessionId(payload);
        const sessionsDir = sessionId === '' ? null : livenessSessionsDir(env);
        if (sessionsDir === null)
            return ALLOW;
        const { backgroundTasks, transcriptPath } = payloadFields(payload);
        const tasks = writeSnapshot(sessionsDir, sessionId, backgroundTasks, clock());
        if (env.CLAUDE_CODE_SESSION_ATTENDED !== '1')
            return ALLOW;
        const db = dbPath(env);
        if (db === null || !haveSqlite(env))
            return ALLOW;
        const tokenFile = `${sessionId}${TOKEN_SUFFIX}`;
        const token = randomUUID();
        writeStateFile(sessionsDir, tokenFile, token);
        const parent = process.ppid;
        for (;;) {
            if (readStateFile(sessionsDir, tokenFile) !== token || process.ppid !== parent)
                return ALLOW;
            const now = clock();
            const found = sweep(db, { now, sessionId, transcriptPath, tasks }, env);
            if (found !== null) {
                if (found.findings.length > 0) {
                    const claimed = claimLivenessFinding(db, found.findings, now, env, GATE_NAME);
                    if (claimed === null || claimed.length === 0)
                        return ALLOW;
                    return { stdout: '', code: 2, stderr: `${findingReport(claimed)}\n` };
                }
                if (!found.watching)
                    return ALLOW;
            }
            await sleep(pollMs(env));
        }
    };
}
export const livenessSentinel = makeLivenessSentinel();
//# sourceMappingURL=liveness-sentinel.js.map