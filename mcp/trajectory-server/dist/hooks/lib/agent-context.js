/**
 * TypeScript port of scripts/hooks/lib/agent-context.sh (GH 1692): the acting
 * agent's context from its identity and the trajectory DB, never from the
 * shared session cwd. Where the .sh exports TMB_CTX_*, these return them.
 */
import { existsSync, lstatSync, readlinkSync, statSync } from 'node:fs';
import { jqAlternatives } from './jq.js';
import { branchSlug, callerRun, dbPath, gateRead, GATE_READ_ERROR, projectRoot, realdir, repoPathAbs, sqlInt, taskIdFromTranscript, } from './db.js';
import { agentRole } from './role.js';
const MAX_LINK_HOPS = 40;
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
function isSymlink(path) {
    try {
        return lstatSync(path).isSymbolicLink();
    }
    catch {
        return false;
    }
}
/** tmb_agent_transcript <input_json>: the caller's own transcript file, or "". */
export function agentTranscript(input = '') {
    const own = jqAlternatives(input, [['agent_transcript_path']]);
    if (own !== '' && isFile(own))
        return own;
    const main = jqAlternatives(input, [['transcript_path']]);
    const id = jqAlternatives(input, [['agent_id']]);
    if (main === '' || id === '' || !/^[A-Za-z0-9_-]+$/.test(id))
        return '';
    const t = `${main.endsWith('.jsonl') ? main.slice(0, -'.jsonl'.length) : main}/subagents/agent-${id}.jsonl`;
    return isFile(t) ? t : '';
}
/** `IFS='|' read -r a b c d <<< row`: four fields, the last one taking the rest. */
function readFields(row, count) {
    let rest = row.split('\n')[0];
    const fields = [];
    for (let i = 0; i < count - 1; i += 1) {
        const bar = rest.indexOf('|');
        if (bar < 0) {
            fields.push(rest);
            rest = '';
            continue;
        }
        fields.push(rest.slice(0, bar));
        rest = rest.slice(bar + 1);
    }
    if (rest.endsWith('|') && !rest.slice(0, -1).includes('|'))
        rest = rest.slice(0, -1);
    fields.push(rest);
    return fields;
}
/** tmb_task_location <db> <task_id>: the task's repo, repo root and worktree. */
export function taskLocation(db, taskId, env = process.env) {
    const none = { repo: '', repoRoot: '', worktree: '' };
    const task = sqlInt(taskId);
    if (task === '')
        return { code: 1, ...none, missing: 'no task_id' };
    const fields = `COALESCE(t.branch_id, '') || '|' || COALESCE(t.repo, '') || '|'
           || COALESCE(r.name, '') || '|' || COALESCE(r.path, '')`;
    const from = `
      FROM tasks t
      LEFT JOIN repos r ON r.name = CASE
          WHEN COALESCE(t.repo, '') <> '' THEN t.repo
          WHEN (SELECT COUNT(*) FROM repos) = 1 THEN (SELECT name FROM repos)
        END
     WHERE t.id = ${task} LIMIT 1;`;
    // The recorded worktree (schema v54, GH 2032) leads the row hex-encoded, so a
    // '|' in it cannot shift the fields. A DB without the column (one the server
    // has not migrated yet) fails that read; the v53 query then keeps the slug path.
    let recordedHex = '';
    let row = gateRead(db, `SELECT hex(COALESCE(t.worktree_path, '')) || '|' || ${fields}${from}`, env);
    if (row === GATE_READ_ERROR) {
        row = gateRead(db, `SELECT ${fields}${from}`, env);
    }
    else if (row !== '') {
        const bar = row.indexOf('|');
        recordedHex = row.slice(0, bar);
        row = row.slice(bar + 1);
    }
    if (row === GATE_READ_ERROR) {
        return { code: 2, ...none, missing: `task ${task}: the trajectory DB read failed (tasks/repos)` };
    }
    if (row === '')
        return { code: 1, ...none, missing: `task ${task} has no tasks row` };
    const [branch, repo, name, rawPath] = readFields(row, 4);
    if (branch === '')
        return { code: 1, ...none, missing: `task ${task} has no branch_id` };
    if (name === '' || rawPath === '') {
        const missing = repo !== ''
            ? `task ${task}'s repo '${repo}' has no repos row with a path`
            : `task ${task} has no repo: tasks.repo is empty and the repos table does not hold exactly one row`;
        return { code: 1, ...none, missing };
    }
    const path = rawPath.startsWith('/') ? rawPath : realdir(repoPathAbs(db, rawPath));
    const repoRoot = path.endsWith('/') ? path.slice(0, -1) : path;
    const recorded = Buffer.from(recordedHex, 'hex').toString('utf8');
    return {
        code: 0,
        repo: name,
        repoRoot,
        worktree: recorded !== '' ? recorded : `${repoRoot}/.claude/worktrees/${branchSlug(branch)}`,
        missing: '',
    };
}
/**
 * tmb_agent_context <input_json> [<db>]: code 0 resolved (or not a swe), 1 a
 * swe whose context misses a piece (`missing` names it), 2 a DB read error,
 * 3 no trajectory DB.
 */
export function agentContext(input = '', db = '', env = process.env) {
    const role = agentRole(input);
    const blank = { taskId: '', repo: '', repoRoot: '', worktree: '', missing: '' };
    if (role !== 'swe')
        return { code: 0, role, ...blank, repoRoot: projectRoot(env) };
    const resolved = db !== '' ? db : (dbPath(env) ?? '');
    if (resolved === '') {
        return { code: 3, role, ...blank, missing: 'no trajectory DB resolves (TRAJECTORY_DB_PATH or CLAUDE_PROJECT_DIR)' };
    }
    const transcript = agentTranscript(input);
    let task = taskIdFromTranscript(transcript);
    if (task === '') {
        const run = callerRun(input, resolved, env);
        if (run === GATE_READ_ERROR)
            return { code: 2, role, ...blank, missing: 'the trajectory DB read failed (agent_runs)' };
        const bar = run.indexOf('|');
        task = sqlInt(bar < 0 ? run : run.slice(0, bar));
    }
    if (task === '') {
        const missing = transcript !== ''
            ? `no task_id: the spawn transcript ${transcript} carries no task_id=<N>`
            : 'no task_id: the payload names no spawn transcript (agent_transcript_path, or transcript_path plus agent_id) and no agent_runs row is bound to this agent_id';
        return { code: 1, role, ...blank, missing };
    }
    return { role, taskId: task, ...taskLocation(resolved, task, env) };
}
/** tmb_path_canonical <path>: an absolute path with symlinks and `..` resolved as far as it exists. */
export function pathCanonical(path = '') {
    if (!path.startsWith('/'))
        return path;
    let cur = '';
    let tail = '';
    let rest = path;
    let hops = 0;
    while (rest !== '') {
        rest = rest.startsWith('/') ? rest.slice(1) : rest;
        const slash = rest.indexOf('/');
        const part = slash < 0 ? rest : rest.slice(0, slash);
        rest = slash < 0 ? '' : rest.slice(slash + 1);
        if (part === '' || part === '.')
            continue;
        if (tail !== '') {
            tail = part === '..' ? tail.slice(0, Math.max(0, tail.lastIndexOf('/'))) : `${tail}/${part}`;
            continue;
        }
        if (part === '..') {
            cur = cur.slice(0, Math.max(0, cur.lastIndexOf('/')));
            continue;
        }
        const here = `${cur}/${part}`;
        if (isSymlink(here) && hops < MAX_LINK_HOPS) {
            hops += 1;
            const link = readlinkSync(here).replace(/\n+$/, '');
            if (link.startsWith('/'))
                cur = '';
            rest = `${link}/${rest}`;
            continue;
        }
        if (existsSync(here))
            cur = here;
        else
            tail = `/${part}`;
    }
    if (cur + tail === '')
        cur = '/';
    return `${cur}${tail}`;
}
/** tmb_ctx_in_worktree <path>: <path> (canonical) lies in <worktree> (canonical). */
export function ctxInWorktree(path, worktree) {
    if (worktree === '' || path === '')
        return false;
    const c = pathCanonical(path);
    const w = pathCanonical(worktree);
    if (c === w)
        return true;
    return c.startsWith(`${w.endsWith('/') ? w.slice(0, -1) : w}/`);
}
//# sourceMappingURL=agent-context.js.map