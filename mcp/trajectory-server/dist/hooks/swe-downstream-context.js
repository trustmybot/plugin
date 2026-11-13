/**
 * PreToolUse(Write|Edit|MultiEdit|NotebookEdit) gate (GH 1990), born in
 * TypeScript, in its own registration (the `swe-downstream-context` part) so
 * it never joins the blocking edit group: on a swe's first edit of an indexed
 * file per run, in a task the downstream-context A/B has in its `on` arm, it
 * answers with additionalContext listing the direct downstream of that file's
 * symbols (lib/downstream.ts: callers and readers of the tables they write,
 * tests and the file itself excluded), up to MAX_REFS refs and MAX_CHARS
 * chars with the total shown, and writes one downstream_context_injected
 * row. The first call for a task enrolls it while the A/B is on.
 *
 * The task and worktree are the caller's own (agentContext, as
 * swe-scope-fence). Silent for another role or tool, no agent_id, the A/B off
 * or the task out of it or in the `off` arm, a target outside the worktree, a
 * file already noted this run, no indexed symbols or no downstream, and any
 * error: it never denies and always exits 0.
 */
import { ALLOW } from './gate.js';
import { agentContext, pathCanonical } from './lib/agent-context.js';
import { dbPath, haveSqlite } from './lib/db.js';
import { capSections, directDownstream, downstreamArm, downstreamLines, injectedBefore, recordInjected, symbolsInFile } from './lib/downstream.js';
import { jqCompact } from './lib/jq.js';
import { normalizeRole } from './lib/role.js';
import { worktreeRelative } from './swe-scope-fence.js';
export const GATE_NAME = 'swe-downstream-context';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
function str(value) {
    return typeof value === 'string' ? value : '';
}
function decideContext(payload, env) {
    let input;
    try {
        const parsed = JSON.parse(payload);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return ALLOW;
        input = parsed;
    }
    catch {
        return ALLOW;
    }
    if (!EDIT_TOOLS.has(str(input.tool_name)))
        return ALLOW;
    if (normalizeRole(str(input.agent_type)) !== 'swe')
        return ALLOW;
    const agentId = str(input.agent_id);
    if (agentId === '')
        return ALLOW;
    const toolInput = (input.tool_input ?? {});
    const target = str(toolInput.file_path) || str(toolInput.notebook_path);
    if (target === '')
        return ALLOW;
    const db = dbPath(env);
    if (db === null || !haveSqlite(env))
        return ALLOW;
    const ctx = agentContext(payload, db, env);
    if (ctx.code !== 0 || ctx.repo === '')
        return ALLOW;
    const taskId = Number(ctx.taskId);
    if (downstreamArm(db, GATE_NAME, taskId, env) !== 'on')
        return ALLOW;
    const cwd = str(input.cwd) || env.PWD || process.cwd();
    const abs = pathCanonical(target.startsWith('/') ? target : `${cwd}/${target}`);
    const rel = worktreeRelative(abs, pathCanonical(ctx.worktree));
    if (rel === null)
        return ALLOW;
    if (injectedBefore(db, { agent_id: agentId, path: rel }, env) !== false)
        return ALLOW;
    const symbols = symbolsInFile(db, ctx.repo, rel, env);
    if (!symbols || symbols.length === 0)
        return ALLOW;
    const ds = directDownstream(db, ctx.repo, symbols.map((s) => s.id), env, [rel]);
    if (!ds || ds.total === 0)
        return ALLOW;
    const { text, shown } = capSections(`TMB: direct downstream of ${rel} in the world model (GH 1990). Before you reshape a signature, return value or written table here, check each:`, [{ title: 'Callers and table readers, tests excluded', lines: downstreamLines(ds) }]);
    recordInjected(db, GATE_NAME, taskId, { role: 'swe', agent_id: agentId, path: rel, refs_shown: shown[0] ?? 0, refs_total: ds.total }, ['agent_id', 'path'], env);
    return { stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } })}\n`, code: 0 };
}
export const sweDownstreamContext = (payload, env) => {
    try {
        return decideContext(payload, env);
    }
    catch {
        return ALLOW;
    }
};
//# sourceMappingURL=swe-downstream-context.js.map