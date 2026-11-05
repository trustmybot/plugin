/**
 * TypeScript port of query-task.sh's tmb_effort_defaults (GH 1692). The
 * server's twin is resolveEffortDefaults in src/tools/config.ts.
 */
import { gateRead, GATE_READ_ERROR, sqlInt } from './db.js';

const configuredEffort = (key: string, fallback: string): string =>
  `COALESCE((SELECT v FROM (SELECT CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$') END AS v
                               FROM plugin_config WHERE key = '${key}')
               WHERE v IN ('low','medium','high')), '${fallback}')`;

/**
 * tmb_effort_defaults <db>: "<swe_default_effort>|<reviewer_effort>" from
 * plugin_config, an unset key or a value other than low|medium|high reading as
 * medium; __ERR__ when the read fails.
 */
export function effortDefaults(db: string, env: NodeJS.ProcessEnv = process.env): string {
  return gateRead(
    db,
    `SELECT ${configuredEffort('swe_default_effort', 'medium')} || '|' || ${configuredEffort('reviewer_effort', 'medium')};`,
    env,
  );
}

export interface ReviewerEffort {
  readonly effort: string;
  readonly source: 'assigned' | 'config';
}

/**
 * The effort task <taskId>'s code-reviewer spawn runs at (GH 1955): the effort
 * of its newest reviewer_effort_assigned row (bro_atomic_close writes it), else
 * plugin_config.reviewer_effort (medium when unset). A newest row whose effort
 * is not low|medium|high, or no task id, reads as the config; null when the
 * read fails.
 */
export function reviewerEffortFor(db: string, taskId: string, env: NodeJS.ProcessEnv = process.env): ReviewerEffort | null {
  const id = sqlInt(taskId);
  const assigned =
    id === ''
      ? 'NULL'
      : `(SELECT 'assigned|' || v FROM (SELECT CASE WHEN json_valid(content_json) THEN json_extract(content_json, '$.effort') END AS v
                                          FROM audit
                                         WHERE event_type = 'reviewer_effort_assigned'
                                           AND CASE WHEN json_valid(content_json) THEN json_extract(content_json, '$.task_id') END = ${id}
                                         ORDER BY id DESC LIMIT 1)
           WHERE v IN ('low','medium','high'))`;
  const out = gateRead(db, `SELECT COALESCE(${assigned}, 'config|' || ${configuredEffort('reviewer_effort', 'medium')});`, env);
  if (out === GATE_READ_ERROR) return null;
  const [source, effort] = out.trim().split('|');
  if ((source !== 'assigned' && source !== 'config') || effort === undefined || effort === '') return null;
  return { effort, source };
}
