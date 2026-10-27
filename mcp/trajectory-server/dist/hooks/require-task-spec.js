/**
 * TypeScript port of scripts/hooks/require-task-spec.sh (GH 1692): a swe
 * spawn needs task_id=<N> in its prompt naming a tasks row that is pending, or
 * running with no live swe agent_runs row, with a spec_body. A pending task
 * also needs its branch in a linked worktree of its repo, and a task touching
 * schema, migrations or db.ts, or whose spec adds a column, field, tool or
 * table, needs a Writer: + Populated: pair or a Nullable: line unless a
 * spec_shape_gate_waived audit row names it. No resolvable DB allows; a DB
 * read failure denies.
 */
import { ALLOW } from './gate.js';
import { branchSlug, dbPath, gateRead, GATE_READ_ERROR, haveSqlite, repoPathAbs, sqlInt, stripTrailingNewlines, } from './lib/db.js';
import { gitOut } from './lib/git.js';
import { jqAlternatives } from './lib/jq.js';
import { jqRawText } from './lib/project-env.js';
import { normalizeRole } from './lib/role.js';
import { denyPreToolUse, denyUnreadable } from './rework-limit.js';
export const GATE_NAME = 'require-task-spec';
/** The digits of the first `task_id=<N>` or `task_id: <N>` in a spawn prompt, or "". */
export function promptTaskId(prompt) {
    return /task_id[=:][ \t\v\f\r]*([0-9]+)/.exec(prompt)?.[1] ?? '';
}
const CONTRACT_FILE = /(\.sql$|(^|\/)schema\.[^/]*$|(^|\/)(migrations|migration|migrate)\/|(^|\/)db\.ts$)/i;
const UNICODE_SPACE_POINTS = [
    0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x200b, 0x2028,
    0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];
const UNICODE_SPACES = new RegExp(`[${String.fromCodePoint(...UNICODE_SPACE_POINTS)}]`, 'g');
const CONTRACT_BODY = /(add +column|new[ _-]+(column|tool|field|table))/i;
function needsContract(body, files) {
    if (files.split('\n').some((f) => CONTRACT_FILE.test(f)))
        return true;
    return CONTRACT_BODY.test(body.replace(UNICODE_SPACES, ' ').replace(/[\n\r\t\v\f]/g, ' '));
}
function hasLine(body, label) {
    const line = new RegExp(`^[ \\t\\v\\f\\r>*+-]*([0-9]+[.)][ \\t\\v\\f\\r]+)?[\`*_]*${label}:[\`*_]*([^\\n]*)$`);
    return body.split('\n').some((l) => /[^ \t\v\f\r`*_]/.test(line.exec(l)?.[2] ?? ''));
}
/** `jq -r '.<key> // ""'` of a parsed row, as a `$(...)` capture holds it. */
function rawField(value) {
    return value === null || value === undefined || value === false ? '' : stripTrailingNewlines(jqRawText(value));
}
function deny(reason) {
    return denyPreToolUse(reason);
}
function worktreeState(repo, branch, env) {
    const ref = `branch refs/heads/${branch}`;
    let entry = 0;
    let main = false;
    let linked = false;
    for (const line of gitOut(repo, ['worktree', 'list', '--porcelain'], env).split('\n')) {
        if (line.startsWith('worktree '))
            entry += 1;
        if (line === ref) {
            if (entry === 1)
                main = true;
            else
                linked = true;
        }
    }
    return linked ? 'linked' : main ? 'main' : 'none';
}
function worktreeDeny(db, taskId, safeId, env) {
    const wt = gateRead(db, `SELECT json_object('branch', COALESCE(t.branch_id, ''),
      'path', COALESCE((SELECT path FROM repos WHERE name = t.repo), CASE WHEN COALESCE(t.repo, '') = '' AND (SELECT COUNT(*) FROM repos) = 1 THEN (SELECT path FROM repos LIMIT 1) END, ''))
    FROM tasks t WHERE t.id = ${safeId};`, env);
    if (wt === GATE_READ_ERROR)
        return denyUnreadable(GATE_NAME, env);
    let row;
    try {
        row = wt === '' ? {} : JSON.parse(wt);
    }
    catch {
        return denyUnreadable(GATE_NAME, env);
    }
    const branch = rawField(row.branch);
    const path = rawField(row.path);
    const repo = path === '' ? (env.CLAUDE_PROJECT_DIR ?? '') : repoPathAbs(db, path);
    if (repo === '' || branch === '')
        return null;
    if (gitOut(repo, ['rev-parse', '--is-inside-work-tree'], env) !== 'true')
        return null;
    const state = worktreeState(repo, branch, env);
    if (state === 'linked')
        return null;
    const expected = `${repo.replace(/\/$/, '')}/.claude/worktrees/${branchSlug(branch)}`;
    const sw = state === 'main'
        ? ` The main checkout currently has ${branch} checked out; switch the main checkout back to its base branch first (git cannot attach a branch that is checked out elsewhere).`
        : '';
    return deny(`BLOCKED: task_id=${taskId} is pending and branch ${branch} has no linked worktree (expected ${expected}).${sw} Call task_reopen(task_id=${taskId}, reason="<why>") to create the worktree, then respawn swe.`);
}
function specShapeVerdict(db, taskId, safeId, env) {
    const spec = gateRead(db, `SELECT json_object('body', COALESCE(spec_body, ''),
    'files', CASE WHEN json_valid(COALESCE(files, '')) THEN json(files) ELSE json('[]') END)
  FROM tasks WHERE id = ${safeId};`, env);
    if (spec === GATE_READ_ERROR)
        return denyUnreadable(GATE_NAME, env);
    let row;
    try {
        row = spec === '' ? {} : JSON.parse(spec);
    }
    catch {
        return denyUnreadable(GATE_NAME, env);
    }
    const body = rawField(row.body);
    const files = Array.isArray(row.files)
        ? stripTrailingNewlines(row.files.filter((f) => typeof f === 'string').join('\n'))
        : '';
    if (!needsContract(body, files))
        return ALLOW;
    if (hasLine(body, 'Nullable'))
        return ALLOW;
    const missing = [hasLine(body, 'Writer') ? '' : 'Writer:', hasLine(body, 'Populated') ? '' : 'Populated:']
        .filter((m) => m !== '')
        .join(' and ');
    if (missing === '')
        return ALLOW;
    const waived = gateRead(db, `SELECT count(*) FROM audit
  WHERE event_type = 'spec_shape_gate_waived' AND from_node = 'bro' AND json_valid(content_json)
    AND CAST(json_extract(content_json, '$.task_id') AS INTEGER) = ${safeId}
    AND json_extract(content_json, '$.gate') = 'spec_shape'
    AND length(trim(COALESCE(json_extract(content_json, '$.reason'), ''))) >= 10;`, env);
    if (waived === GATE_READ_ERROR)
        return denyUnreadable(GATE_NAME, env);
    if (Number(waived || '0') > 0)
        return ALLOW;
    let ref = gateRead(db, `SELECT COALESCE(issue_id, '<issue>') || '|' || COALESCE(branch_id, '<branch>') FROM tasks WHERE id = ${safeId};`, env);
    if (ref === GATE_READ_ERROR || ref === '')
        ref = '<issue>|<branch>';
    const bar = ref.indexOf('|');
    const issue = bar < 0 ? ref : ref.slice(0, bar);
    const branch = bar < 0 ? ref : ref.slice(bar + 1);
    return deny(`BLOCKED: task_id=${taskId} adds a column, field, tool, table or migration, and its spec_body is missing a ${missing} line. ` +
        'Under ## Success Criteria, name each new item with `Writer: <tool/hook/function>` and ' +
        '`Populated: <verification[] command proving a non-null sample or count > 0>`, or `Nullable: <reason>`; fix it with task_update_spec. ' +
        `To waive, bro first records audit_append(event_type="spec_shape_gate_waived", from_node="bro", issue_id=${issue}, branch_id="${branch}", ` +
        `summary=<why>, content_json={"task_id":${taskId},"gate":"spec_shape","reason":"<why, >= 10 chars>"}) and then respawns.`);
}
export const requireTaskSpec = (payload, env) => {
    if (normalizeRole(jqAlternatives(payload, [['tool_input', 'subagent_type']])) !== 'swe')
        return ALLOW;
    const taskId = promptTaskId(jqAlternatives(payload, [['tool_input', 'prompt']]));
    if (taskId === '') {
        return deny('BLOCKED: SWE spawn requires task_id=<N> in the prompt pointing at a row in the tasks table. Route through bro (bro plans, then spawns SWE with task_id).');
    }
    const db = dbPath(env, (line) => process.stderr.write(`${line}\n`));
    if (db === null || !haveSqlite(env))
        return ALLOW;
    const safeId = sqlInt(taskId);
    const row = gateRead(db, `SELECT status, LENGTH(COALESCE(spec_body, '')) FROM tasks WHERE id = ${safeId};`, env);
    if (row === GATE_READ_ERROR)
        return denyUnreadable(GATE_NAME, env);
    if (row === '')
        return deny(`BLOCKED: task_id=${taskId} does not exist in the tasks table.`);
    const fields = row.split(/[|\n]/);
    const status = fields[0] ?? '';
    const bodyLen = (fields[1] ?? '').trim();
    if (status === 'running') {
        const live = gateRead(db, `SELECT id || ' (started ' || COALESCE(started_at, '?') || ')' FROM agent_runs
    WHERE task_id = ${safeId} AND agent_type = 'swe' AND completed_at IS NULL
      AND NOT ((spawn_id IS NULL OR spawn_id GLOB 'tool_use:*')
               AND started_at IS NOT NULL AND started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 seconds'))
    ORDER BY id DESC LIMIT 1;`, env);
        if (live === GATE_READ_ERROR)
            return denyUnreadable(GATE_NAME, env);
        if (live !== '') {
            return deny(`BLOCKED: task_id=${taskId} is running with a live swe run: agent_runs ${live}. Wait for that swe to return; if it is gone, move the task to failed (task_update_status) and task_reopen it.`);
        }
    }
    if (status !== 'pending' && status !== 'running') {
        return deny(`BLOCKED: task_id=${taskId} has status=${status}, expected pending, or running with no live swe run. Reopen finished work with task_reopen.`);
    }
    if (/^-?[0-9]+$/.test(bodyLen || '0') && Number(bodyLen || '0') === 0) {
        return deny(`BLOCKED: task_id=${taskId} has empty spec_body. bro must populate spec_body via task_create_batch before SWE can execute.`);
    }
    if (status === 'pending') {
        const blocked = worktreeDeny(db, taskId, safeId, env);
        if (blocked !== null)
            return blocked;
    }
    return specShapeVerdict(db, taskId, safeId, env);
};
//# sourceMappingURL=require-task-spec.js.map