/**
 * The target-to-task helpers of scripts/hooks/lib/query-task.sh and
 * cmd-analysis.sh (GH 1692): tmb_worktree_root_for_target,
 * tmb_resolve_task_id_for_target and tmb_path_digest.
 */
import { createHash } from 'node:crypto';
import { pathCanonical } from './agent-context.js';
import { dbPath, haveSqlite, sqlInt, sqliteRo, sqlQuote, stripTrailingNewlines, taskBySlug, taskIdFromTranscript } from './db.js';
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
        if (task === '') {
            const slug = stripTrailingNewlines(posixBasename(wt));
            task = sqlInt(taskBySlug(resolved, slug, 'id', '', env, (line) => process.stderr.write(`${line}\n`)));
        }
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