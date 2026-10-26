/**
 * The target-to-task helpers of scripts/hooks/lib/query-task.sh and
 * cmd-analysis.sh (GH 1692): tmb_worktree_root_for_target,
 * tmb_sql_like_escape, tmb_task_by_slug, tmb_resolve_task_id_for_target and
 * tmb_path_digest.
 */
import { createHash } from 'node:crypto';
import { pathCanonical } from './agent-context.js';
import { dbPath, haveSqlite, sqlInt, sqliteRo, sqlQuote, stripTrailingNewlines, taskIdFromTranscript } from './db.js';
import { gitOut } from './git.js';
import { jqAlternatives } from './jq.js';
import { posixBasename } from './project-env.js';
const WORKTREE_MARK = '/.claude/worktrees/';
const WORKTREE_ROOT = /^(.*\/.claude\/worktrees\/[^/]+).*$/;
/** tmb_worktree_root_for_target <path>: the innermost .claude/worktrees/<slug> dir the path names, or "". */
export function worktreeRootForTarget(target) {
    if (!target.includes(WORKTREE_MARK))
        return '';
    return stripTrailingNewlines(target
        .split('\n')
        .map((line) => line.replace(WORKTREE_ROOT, '$1'))
        .join('\n'));
}
/** tmb_sql_like_escape <value>: \, % and _ backslash-escaped, single quotes doubled. */
export function sqlLikeEscape(value) {
    return value.replace(/[\\%_]/g, '\\$&').replace(/'/g, "''");
}
/**
 * tmb_task_by_slug <db> <slug> <column>: <column> (id or branch_id) of the
 * newest task whose branch_id ends in /<slug>; several matches warn on stderr.
 */
export function taskBySlug(db, slug, column = 'id', env = process.env) {
    if (db === '' || slug === '')
        return '';
    const rows = sqliteRo(db, `SELECT id || '|' || branch_id FROM tasks WHERE branch_id LIKE '%/${sqlLikeEscape(slug)}' ESCAPE '\\' ORDER BY id DESC;`, env);
    if (rows === '')
        return '';
    const lines = rows.split('\n');
    const count = lines.filter((l) => l !== '').length;
    if (count > 1) {
        const branches = lines.map((l) => (l.includes('|') ? l.split('|')[1] : l)).join(',');
        process.stderr.write(`tmb: worktree slug "${slug}" matches ${count} tasks (${branches}); using the newest\n`);
    }
    const first = lines[0];
    const bar = first.indexOf('|');
    if (column === 'id')
        return bar < 0 ? first : first.slice(0, bar);
    return bar < 0 ? first : first.slice(bar + 1);
}
/**
 * tmb_resolve_task_id_for_target <target> <input_json> [<db>]: the task of the
 * worktree <target> lies in, by its checked-out branch, then by its slug, then
 * the task_id=<N> of the payload's agent_transcript_path; "" when none.
 */
export function resolveTaskIdForTarget(target, input, db = '', env = process.env) {
    const resolved = db !== '' ? db : (dbPath(env) ?? '');
    const wt = worktreeRootForTarget(target);
    let task = '';
    if (resolved !== '' && haveSqlite(env) && wt !== '') {
        const branch = gitOut(wt, ['rev-parse', '--abbrev-ref', 'HEAD'], env);
        if (branch !== '' && branch !== 'HEAD') {
            task = sqlInt(sqliteRo(resolved, `
        SELECT id FROM tasks
         WHERE branch_id = '${sqlQuote(branch)}'
         ORDER BY id DESC
         LIMIT 1;
      `, env));
        }
        if (task === '')
            task = sqlInt(taskBySlug(resolved, stripTrailingNewlines(posixBasename(wt)), 'id', env));
    }
    if (task === '' && input !== '') {
        task = taskIdFromTranscript(stripTrailingNewlines(jqAlternatives(input, [['agent_transcript_path']])));
    }
    return task;
}
/** tmb_path_digest <path>: the sha256 hex of the canonical path. */
export function pathDigest(path) {
    return createHash('sha256').update(stripTrailingNewlines(pathCanonical(path)), 'utf8').digest('hex');
}
//# sourceMappingURL=target-task.js.map