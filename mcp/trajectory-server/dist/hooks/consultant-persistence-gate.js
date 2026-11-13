/**
 * SubagentStop hook (#468, GH 1692): a TMB consultant (an agents
 * row of kind consultant) may stop only once it has written a discussion row
 * on any open issue since its spawn started (GH 2924): the spawn start is the
 * earliest timestamp in its own transcript, compared with julianday() so ISO
 * and space-separated stamps agree, and with no readable start a row on any
 * open issue counts. Otherwise the stop is blocked with a recovery message
 * teaching discussion_append on the newest open issue by created_at, the
 * issue discussion_append defaults to. It passes on stop_hook_active, an
 * unresolvable agent, the backbone roles, a non-consultant, an unresolved DB
 * and no open issue; a DB read error blocks with the DB-unavailable reason.
 * It needs neither jq nor the sqlite3 CLI.
 */
import { ALLOW } from './gate.js';
import { agentTranscript, transcriptStart } from './lib/agent-context.js';
import { DB_RETRY_FIX, dbPath, dbUnavailableReason, GATE_READ_ERROR, gateRead, haveSqlite, sqlInt, sqlQuote } from './lib/db.js';
import { blockResult } from './lib/deny.js';
import { jqAlternatives, jqFieldOr } from './lib/jq.js';
import { commandSubstitution } from './lib/project-env.js';
import { normalizeRole } from './lib/role.js';
export const GATE_NAME = 'consultant-persistence-gate';
const BACKBONE_ROLES = new Set(['bro', 'swe', 'code-reviewer']);
export function recoveryMessage() {
    return 'Consultant persistence gate: you must persist your analysis before returning.';
}
export function recoveryFix(agent, issueId) {
    return { allowed: `discussion_append(agent='${agent}', issue_id=${issueId}, author='${agent}', kind='analysis', body=<your analysis>), then return` };
}
/** The stopping agent's role: agent_type, else subagent_type, else tool_input.subagent_type, normalized. */
export function stoppingAgent(echoed) {
    return normalizeRole(commandSubstitution(jqAlternatives(echoed, [['agent_type'], ['subagent_type'], ['tool_input', 'subagent_type']])));
}
export function consultantPersistenceGate(payload, env) {
    const echoed = `${commandSubstitution(payload)}\n`;
    if (commandSubstitution(jqFieldOr(echoed, 'stop_hook_active', 'false')) === 'true')
        return ALLOW;
    const agent = stoppingAgent(echoed);
    if (agent === '' || BACKBONE_ROLES.has(agent))
        return ALLOW;
    const db = dbPath(env);
    if (db === null || db === '' || !haveSqlite(env))
        return ALLOW;
    const unavailable = () => blockResult(dbUnavailableReason(GATE_NAME, env), DB_RETRY_FIX);
    const safeAgent = sqlQuote(agent);
    const isConsultant = gateRead(db, `SELECT COUNT(*) FROM agents WHERE name='${safeAgent}' AND kind='consultant';`, env);
    if (isConsultant === GATE_READ_ERROR)
        return unavailable();
    if (isConsultant !== '1')
        return ALLOW;
    const newestOpen = gateRead(db, "SELECT id FROM issues WHERE status='open' AND id > 0 ORDER BY created_at DESC, id DESC LIMIT 1;", env);
    if (newestOpen === GATE_READ_ERROR)
        return unavailable();
    const issueId = sqlInt(newestOpen);
    if (issueId === '')
        return ALLOW;
    const spawnStart = transcriptStart(agentTranscript(echoed));
    const sinceSpawn = spawnStart === '' ? '' : ` AND julianday(d.created_at) >= julianday('${sqlQuote(spawnStart)}')`;
    const discussions = gateRead(db, `SELECT COUNT(*) FROM discussions d JOIN issues i ON i.id = d.issue_id WHERE d.author='${safeAgent}' AND i.status='open'${sinceSpawn};`, env);
    if (discussions === GATE_READ_ERROR)
        return unavailable();
    if (/^[0-9]+$/.test(discussions) && Number(discussions) >= 1)
        return ALLOW;
    return blockResult(recoveryMessage(), recoveryFix(agent, issueId));
}
//# sourceMappingURL=consultant-persistence-gate.js.map