/**
 * The hooks' effort defaults (GH 1692). The
 * server's twin is resolveEffortDefaults in src/tools/config.ts.
 */
import { REVIEWER_MODELS } from '../../tools/config.js';
import { gateRead, GATE_READ_ERROR, sqlInt } from './db.js';
const configuredEffort = (key, fallback) => `COALESCE((SELECT v FROM (SELECT CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$') END AS v
                               FROM plugin_config WHERE key = '${key}')
               WHERE v IN ('low','medium','high')), '${fallback}')`;
/**
 * tmb_effort_defaults <db>: "<swe_default_effort>|<reviewer_effort>" from
 * plugin_config, an unset key or a value other than low|medium|high reading as
 * medium; __ERR__ when the read fails.
 */
export function effortDefaults(db, env = process.env) {
    return gateRead(db, `SELECT ${configuredEffort('swe_default_effort', 'medium')} || '|' || ${configuredEffort('reviewer_effort', 'medium')};`, env);
}
const REVIEWER_MODEL_SQL_LIST = REVIEWER_MODELS.map((m) => `'${m}'`).join(',');
/**
 * The effort and model task <taskId>'s code-reviewer spawn runs at (GH 1955,
 * GH 2932): those of its newest reviewer_effort_assigned row (review_handoff
 * writes it; model null when the row names none), else
 * plugin_config.reviewer_effort (medium when unset) with no model. A newest
 * row whose effort is not low|medium|high or whose model is not a known
 * reviewer model, or no task id, reads as the config; null when the read
 * fails.
 */
export function reviewerEffortFor(db, taskId, env = process.env) {
    const id = sqlInt(taskId);
    const assigned = id === ''
        ? 'NULL'
        : `(SELECT 'assigned|' || v || '|' || COALESCE(m, '') FROM (
             SELECT CASE WHEN json_valid(content_json) THEN json_extract(content_json, '$.effort') END AS v,
                    CASE WHEN json_valid(content_json) THEN json_extract(content_json, '$.model') END AS m
               FROM audit
              WHERE event_type = 'reviewer_effort_assigned'
                AND CASE WHEN json_valid(content_json) THEN json_extract(content_json, '$.task_id') END = ${id}
              ORDER BY id DESC LIMIT 1)
           WHERE v IN ('low','medium','high') AND (m IS NULL OR m IN (${REVIEWER_MODEL_SQL_LIST})))`;
    const out = gateRead(db, `SELECT COALESCE(${assigned}, 'config|' || ${configuredEffort('reviewer_effort', 'medium')} || '|');`, env);
    if (out === GATE_READ_ERROR)
        return null;
    const [source, effort, model] = out.trim().split('|');
    if ((source !== 'assigned' && source !== 'config') || effort === undefined || effort === '')
        return null;
    return { effort, model: model ? model : null, source };
}
//# sourceMappingURL=effort.js.map