/**
 * UserPromptSubmit and PostToolUse(trajectory-server) gate (GH 2205): tells bro
 * about a finding of liveness-probe during an active turn, as additionalContext.
 * Shell findings read the snapshot liveness-sentinel writes at Stop, so this
 * works headless too. A state file throttles it to one probe per 5 minutes per
 * session before any DB read. It shares the once-marker with liveness-sentinel,
 * so each finding is reported once across both. Acts only for bro; never denies;
 * no DB or a read or claim failure is silent.
 */
import { ALLOW } from './gate.js';
import { dbPath, haveSqlite } from './lib/db.js';
import { jqAlternatives, jqCompact } from './lib/jq.js';
import { agentRole } from './lib/role.js';
import { claimLivenessFinding, findingReport, livenessSessionsDir, readSnapshot, readStateFile, sweep, writeStateFile } from './liveness-probe.js';
import { safeSessionId } from './plugin-hooks-marker.js';
export const GATE_NAME = 'liveness-alert';
export const THROTTLE_MS = 5 * 60_000;
export const THROTTLE_SUFFIX = '.liveness-throttle';
function throttled(lastProbe, now) {
    if (lastProbe === null)
        return false;
    const since = now.getTime() - Number(lastProbe);
    return since >= 0 && since < THROTTLE_MS;
}
export function makeLivenessAlert(clock = () => new Date()) {
    return (payload, env) => {
        if (agentRole(payload) !== 'bro')
            return ALLOW;
        const sessionId = safeSessionId(payload);
        const sessionsDir = sessionId === '' ? null : livenessSessionsDir(env);
        if (sessionsDir === null)
            return ALLOW;
        const now = clock();
        const throttleFile = `${sessionId}${THROTTLE_SUFFIX}`;
        if (throttled(readStateFile(sessionsDir, throttleFile), now))
            return ALLOW;
        writeStateFile(sessionsDir, throttleFile, String(now.getTime()));
        const db = dbPath(env);
        if (db === null || !haveSqlite(env))
            return ALLOW;
        const transcriptPath = jqAlternatives(payload, [['transcript_path']]);
        const found = sweep(db, { now, sessionId, transcriptPath, tasks: readSnapshot(sessionsDir, sessionId) }, env);
        if (found === null || found.findings.length === 0)
            return ALLOW;
        const claimed = claimLivenessFinding(db, found.findings, now, env, GATE_NAME);
        if (claimed === null || claimed.length === 0)
            return ALLOW;
        const event = jqAlternatives(payload, [['hook_event_name']]) || 'UserPromptSubmit';
        return { stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: event, additionalContext: findingReport(claimed) } })}\n`, code: 0 };
    };
}
export const livenessAlert = makeLivenessAlert();
//# sourceMappingURL=liveness-alert.js.map