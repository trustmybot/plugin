/**
 * TypeScript port of scripts/hooks/require-feature-branch-active.sh (GH 1692):
 * a swe spawn for task_id=<N> is denied until the task's branch_id exists in
 * its repo. bro pre-creates the branch without checking it out; swe's
 * worktree owns it. TMB_ALLOW_BRANCH_MISMATCH=1 bypasses the gate. No
 * resolvable DB or no tasks row allows; a DB read failure denies.
 */
import { posix } from 'node:path';
import { ALLOW } from './gate.js';
import { dbPath, gateRead, GATE_READ_ERROR, haveSqlite, sqlInt, sqlQuote, stripTrailingNewlines } from './lib/db.js';
import { gitOk, isDir } from './lib/git.js';
import { jqAlternatives } from './lib/jq.js';
import { normalizeRole } from './lib/role.js';
import { denyPreToolUse, denyUnreadable } from './rework-limit.js';
export const GATE_NAME = 'require-feature-branch-active';
/** `echo "$text" | cut -d'|' -f<n>` as a `$(...)` capture holds it. */
function cutField(text, n) {
    const lines = text.split('\n').map((line) => (line.includes('|') ? (line.split('|')[n - 1] ?? '') : line));
    return stripTrailingNewlines(lines.join('\n'));
}
function resolveRepo(db, taskId, repo, env) {
    const workspaceRoot = posix.dirname(posix.dirname(posix.dirname(db)));
    if (repo !== '') {
        const found = gateRead(db, `SELECT path FROM repos WHERE name = '${sqlQuote(repo)}' LIMIT 1;`, env);
        if (found === GATE_READ_ERROR)
            return denyUnreadable(GATE_NAME, env);
        const abs = found.split('\n')[0] || `${workspaceRoot}/${repo}`;
        if (isDir(`${abs}/.git`))
            return abs;
        return denyPreToolUse(`BLOCKED: cannot resolve repo for task ${taskId}. tasks.repo=${repo} does not point to a git repo at ${abs}. Verify the path is correct.`);
    }
    const single = gateRead(db, 'SELECT CASE WHEN (SELECT COUNT(*) FROM repos) = 1 THEN (SELECT path FROM repos LIMIT 1) END;', env);
    if (single === GATE_READ_ERROR)
        return denyUnreadable(GATE_NAME, env);
    const abs = single || workspaceRoot;
    if (isDir(`${abs}/.git`))
        return abs;
    return denyPreToolUse(`BLOCKED: cannot resolve repo for task ${taskId}. tasks.repo IS NULL and no single registered repo could be resolved. For a multi-repo workspace, set the task's repo (task_create repo=<name>) so it maps to a repos row.`);
}
export const requireFeatureBranchActive = async (payload, env) => {
    if ((env.TMB_ALLOW_BRANCH_MISMATCH ?? '0') === '1')
        return ALLOW;
    if (normalizeRole(jqAlternatives(payload, [['tool_input', 'subagent_type']])) !== 'swe')
        return ALLOW;
    const rawId = /task_id=([0-9]+)/.exec(jqAlternatives(payload, [['tool_input', 'prompt']]))?.[1] ?? '';
    const taskId = sqlInt(rawId);
    if (taskId === '')
        return ALLOW;
    const db = dbPath(env);
    if (db === null || db === '' || !haveSqlite(env))
        return ALLOW;
    const row = gateRead(db, `SELECT branch_id, repo, parent_branch_id FROM tasks WHERE id=${taskId};`, env);
    if (row === GATE_READ_ERROR)
        return denyUnreadable(GATE_NAME, env);
    if (row === '')
        return ALLOW;
    const expected = cutField(row, 1);
    const repoAbs = resolveRepo(db, rawId, cutField(row, 2), env);
    if (typeof repoAbs !== 'string')
        return repoAbs;
    if (await gitOk(repoAbs, ['show-ref', '--verify', '--quiet', `refs/heads/${expected}`], env, 'inherit'))
        return ALLOW;
    const base = cutField(row, 3) || '<base>';
    const baseRef = await gitOk(repoAbs, ['remote', 'get-url', 'origin'], env) ? `origin/${base}` : base;
    return denyPreToolUse(`BLOCKED: SWE spawn for task ${rawId} needs branch ${expected} to exist first — bro pre-creates it ("git -C ${repoAbs} branch ${expected} ${baseRef}") and stays on ${base}; SWE's worktree owns the branch.`);
};
//# sourceMappingURL=require-feature-branch-active.js.map