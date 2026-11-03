/**
 * PreToolUse gate (GH 1692), the port of scripts/hooks/swe-scope-fence.sh: on
 * an Edit, Write, MultiEdit or NotebookEdit by a swe, a target inside the
 * task's worktree but outside its typed files[] gets an additionalContext
 * note, once per path per task. It never denies: bro_atomic_close judges
 * scope on the task's own diff.
 *
 * The task and worktree are the caller's own (agentContext: the task_id in
 * its spawn transcript, then tasks.repo, repos.path and the derived worktree;
 * never the cwd, GH 1550). A relative target joins the payload cwd, and both
 * the target and the worktree are canonical (symlinks followed) before the
 * prefix test. Silent for another role, an unresolved context, no DB, an
 * empty files[], a DB read error, a target outside the worktree or inside
 * files[], and a path already noted.
 *
 * Unlike the .sh, it needs neither jq nor the sqlite3 CLI, so without them it
 * still notes a write outside files[] where the .sh stayed silent (decision
 * 703).
 */
import { ALLOW } from './gate.js';
import { agentContext, pathCanonical } from './lib/agent-context.js';
import { dbPath, haveSqlite } from './lib/db.js';
import { jqCompact } from './lib/jq.js';
import { jqAlt, jqGet, jqInput, jqRaw, JqUnindexable } from './lib/jq-raw.js';
import { shellCapture } from './lib/lint-shell.js';
import { normalizeRole } from './lib/role.js';
import { ScopeFence } from './lib/scope-fence.js';
export const GATE_NAME = 'swe-scope-fence';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/**
 * `$(printf '%s' "$INPUT" | jq -r '.<a> // .<b> // … // ""')`, or `// empty`
 * when `orEmpty`: one line per value of the stream. The paths run left to
 * right up to the first truthy one; a value a path reached on the way cannot
 * index prints nothing (jq errors on it and moves on).
 */
export function jqFirst(input, paths, orEmpty = false) {
    const lines = [];
    for (const value of input.values) {
        let picked = null;
        try {
            for (const path of paths) {
                picked = jqAlt(jqGet(value, ...path), null);
                if (picked !== null)
                    break;
            }
            if (picked === null && !orEmpty)
                picked = '';
        }
        catch (e) {
            if (e instanceof JqUnindexable)
                continue;
            throw e;
        }
        if (picked !== null)
            lines.push(jqRaw(picked));
    }
    return shellCapture(lines.join('\n'));
}
/** `${path#"${worktree%/}"/}` when <path> lies under <worktree>, else null. */
export function worktreeRelative(path, worktree) {
    const prefix = `${worktree.endsWith('/') ? worktree.slice(0, -1) : worktree}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}
export function scopeNote(note) {
    return `${jqCompact({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `TMB: ${note}` } })}\n`;
}
export const sweScopeFence = (payload, env) => {
    const captured = shellCapture(payload);
    const input = jqInput(`${captured}\n`);
    if (!EDIT_TOOLS.has(jqFirst(input, [['tool_name']])))
        return ALLOW;
    const role = normalizeRole(jqFirst(input, [['agent_type'], ['subagent_type'], ['tool_input', 'subagent_type']], true));
    if (role !== 'swe')
        return ALLOW;
    const target = jqFirst(input, [['tool_input', 'file_path'], ['tool_input', 'notebook_path']]);
    if (target === '')
        return ALLOW;
    const db = dbPath(env);
    if (db === null || !haveSqlite(env))
        return ALLOW;
    const ctx = agentContext(captured, db, env);
    if (ctx.code !== 0)
        return ALLOW;
    const fence = new ScopeFence(env);
    fence.load(db, ctx.taskId);
    if (fence.state !== 'ok')
        return ALLOW;
    const cwd = jqFirst(input, [['cwd']], true) || env.PWD || process.cwd();
    const abs = shellCapture(pathCanonical(target.startsWith('/') ? target : `${cwd}/${target}`));
    const rel = worktreeRelative(abs, shellCapture(pathCanonical(ctx.worktree)));
    if (rel === null || fence.allows(rel))
        return ALLOW;
    const note = fence.note(ctx.taskId, rel);
    return note === '' ? ALLOW : { stdout: scopeNote(note), code: 0 };
};
//# sourceMappingURL=swe-scope-fence.js.map