/**
 * PermissionDenied(Agent) hook (GH 1692), the port of
 * scripts/hooks/swe-spawn-rollback.sh: when auto mode refuses a swe spawn that
 * record-swe-spawn.sh already prepared, one transaction moves the task back to
 * pending (when it is running and no other swe run of it is open) and closes
 * the open tool_use:<tool_use_id> row as swept_orphan, usage_source
 * unmeasured when unset and duration_ms its window when unmeasured. A row
 * bound to an agent id is never matched.
 *
 * Fail-open: it never blocks, prints nothing, and a failed write leaves the DB
 * unchanged. Unlike the .sh, it needs neither jq nor the sqlite3 CLI, so it
 * rolls the spawn back on a machine without them where the .sh skipped it
 * (decision 703).
 */
import { ALLOW } from './gate.js';
import { dbWrite, nowIso } from './lib/audit.js';
import { dbPath, haveSqlite, sqlQuote } from './lib/db.js';
import { jqAlternatives, jqIndex, jqLiteralNumbers, jsonStream, jsonValues } from './lib/jq.js';
import { commandSubstitution, jqRawText } from './lib/project-env.js';
import { normalizeRole } from './lib/role.js';
export const GATE_NAME = 'swe-spawn-rollback';
/** db-write.sh's TMB_RUN_NO_USAGE_SQL: a run row with no token usage. */
export const RUN_NO_USAGE_SQL = 'COALESCE(tokens_in, 0) = 0 AND COALESCE(tokens_out, 0) = 0 AND COALESCE(cache_read_tokens, 0) = 0 AND COALESCE(cache_creation_tokens, 0) = 0';
/** db-write.sh's TMB_RUN_UNMEASURED_SQL, a SET-clause item. */
export const RUN_UNMEASURED_SQL = `usage_source = COALESCE(usage_source, CASE WHEN ${RUN_NO_USAGE_SQL} THEN 'unmeasured' END)`;
/**
 * `$(jq -r '.tool_use_id // empty') || exit 0`: the lines jq prints, numbers
 * as their literals; null when jq would exit non-zero.
 */
export function toolUseId(input) {
    if (!jsonStream(input).complete)
        return null;
    const lines = [];
    for (const value of jsonValues(input, jqLiteralNumbers)) {
        let v;
        try {
            v = jqIndex(value, 'tool_use_id');
        }
        catch {
            return null;
        }
        if (v !== null && v !== undefined && v !== false)
            lines.push(jqRawText(v));
    }
    return commandSubstitution(lines.join('\n'));
}
export function rollbackSql(id, now) {
    const safeSpawnId = sqlQuote(`tool_use:${id}`);
    return `
UPDATE tasks SET status = 'pending', updated_at = '${now}'
 WHERE status = 'running'
   AND id = (SELECT task_id FROM agent_runs
              WHERE agent_type = 'swe' AND spawn_id = '${safeSpawnId}' AND completed_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM agent_runs o
                    WHERE o.task_id = tasks.id AND o.agent_type = 'swe' AND o.completed_at IS NULL
                      AND o.spawn_id IS NOT '${safeSpawnId}');
UPDATE agent_runs
   SET completed_at = '${now}',
       exit_reason = 'swept_orphan',
       ${RUN_UNMEASURED_SQL},
       duration_ms = CASE WHEN duration_ms = 0
                          THEN COALESCE(CAST(ROUND((julianday('${now}') - julianday(started_at)) * 86400000) AS INTEGER), 0)
                          ELSE duration_ms END
 WHERE agent_type = 'swe' AND spawn_id = '${safeSpawnId}' AND completed_at IS NULL;`;
}
export const sweSpawnRollback = (payload, env) => {
    try {
        const input = commandSubstitution(payload);
        if (normalizeRole(commandSubstitution(jqAlternatives(input, [['tool_input', 'subagent_type']]))) !== 'swe')
            return ALLOW;
        const id = toolUseId(input);
        if (id === null || id === '')
            return ALLOW;
        const db = dbPath(env);
        if (db === null || !haveSqlite(env))
            return ALLOW;
        dbWrite(db, rollbackSql(id, nowIso()), { caller: GATE_NAME, env });
    }
    catch {
        /* fail-open */
    }
    return ALLOW;
};
//# sourceMappingURL=swe-spawn-rollback.js.map