/**
 * TypeScript port of query-task.sh's tmb_effort_defaults (GH 1692). The
 * server's twin is resolveEffortDefaults in src/tools/config.ts.
 */
import { gateRead } from './db.js';
const configuredEffort = (key, fallback) => `COALESCE((SELECT v FROM (SELECT CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$') END AS v
                               FROM plugin_config WHERE key = '${key}')
               WHERE v IN ('low','medium','high')), '${fallback}')`;
/**
 * tmb_effort_defaults <db>: "<swe_default_effort>|<reviewer_effort>" from
 * plugin_config, an unset key or a value other than low|medium|high reading as
 * medium and high; __ERR__ when the read fails.
 */
export function effortDefaults(db, env = process.env) {
    return gateRead(db, `SELECT ${configuredEffort('swe_default_effort', 'medium')} || '|' || ${configuredEffort('reviewer_effort', 'high')};`, env);
}
//# sourceMappingURL=effort.js.map