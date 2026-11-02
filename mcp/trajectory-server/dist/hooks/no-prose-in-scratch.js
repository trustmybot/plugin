/**
 * PreToolUse gate (GH 2089), born in TypeScript: plans, decisions, specs and
 * drafts live in the trajectory DB, so a prose file (prose-files.ts) is denied
 * in the places an agent keeps scratch work, for every agent identity.
 *
 * A denylist (decision 862): prose anywhere else is a deliverable. The zones:
 *   - .claude/<plugin>/scratch/, always, even inside a git repo, where a
 *     single-repo project keeps it gitignored;
 *   - /tmp (which holds the session scratchpad) and the effective $TMPDIR,
 *     unless the target's nearest existing ancestor is in a git worktree.
 * Paths are compared canonically (macOS /private/tmp, /var/folders).
 *
 * Bash is judged by the targets writePaths finds, less the ones an `rm`
 * statement removes, and by `gh issue|pr create|edit|comment` reading its body
 * from a file. UNRESOLVED lines are containment-guard's; a cap line is denied
 * by the gates that already deny it. On those, and on a command that does not
 * parse, this gate allows. A cap line ends the gate before cmdStatements runs,
 * since that has no work cap of its own (GH 2229).
 *
 * TMB_ALLOW_PROSE_SCRATCH=1 in the environment lifts the whole gate.
 */
import { ALLOW } from './gate.js';
import { isProseFile } from '../prose-files.js';
import { harnessTmp, runTmpdir } from './containment-guard.js';
import { cmdStatements, ghMutation, ghMutationFrom, isCapLine, payloadCwd, writePaths } from './cmd-analysis/index.js';
import { pathCanonical } from './lib/agent-context.js';
import { stripTrailingNewlines } from './lib/db.js';
import { jqAlternatives, jqCompact } from './lib/jq.js';
import { pluginName, posixBasename, posixDirname, TMB_STATE_HOST_DIR } from './lib/project-env.js';
import { repoGitRoot } from './lib/repo.js';
export const GATE_NAME = 'no-prose-in-scratch';
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const BODY_FILE_WRITES = new Set(['issue create', 'issue edit', 'issue comment', 'pr create', 'pr edit', 'pr comment']);
const REDIRECT = /(^|[ \t])(\d*|&)(>>?|>\||<)[ \t]*\S+/g;
const BODY_FILE_REASON = 'BLOCKED: this gh command reads its body from a file, and a body file is prose standing in for the trajectory DB. Pass the text with --body, or with --body-file - on stdin.';
function proseReason(target) {
    return `BLOCKED: prose file in a scratch location: ${target}. Plans, decisions, specs and drafts live in the trajectory DB: issue_create or issue_update_description for an issue and its plan; discussion_append with kind decision, analysis or note; task_update_spec or task_create_batch for a task spec. Command output belongs in a .log file.`;
}
function capture(text) {
    return stripTrailingNewlines(text.replace(/\0/g, ''));
}
function field(input, ...paths) {
    return capture(jqAlternatives(input, paths));
}
function deny(reason) {
    const decision = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
    return { stdout: `${jqCompact(decision)}\n`, code: 0 };
}
function under(path, dir) {
    return path.startsWith(`${dir.endsWith('/') ? dir.slice(0, -1) : dir}/`);
}
function inScratchFolder(canonical, env) {
    return canonical.includes(`/${TMB_STATE_HOST_DIR}/${pluginName(env)}/scratch/`);
}
function tmpRoots(tmpdir) {
    const roots = [capture(pathCanonical('/tmp'))];
    if (!/^\/./s.test(tmpdir))
        return roots;
    const canonical = capture(pathCanonical(tmpdir));
    return canonical === '/' ? roots : [...roots, canonical];
}
/** Whether <path>, absolute, is a prose file in a zone. */
async function deniedProse(path, tmpdir, env) {
    if (!isProseFile(path))
        return false;
    const canonical = capture(pathCanonical(path));
    if (inScratchFolder(canonical, env))
        return true;
    if (!tmpRoots(tmpdir).some((root) => under(canonical, root)))
        return false;
    return (await repoGitRoot(posixDirname(canonical), env)) === '';
}
function effectiveTmpdir(input, toolName, env) {
    const uid = process.getuid?.() ?? 0;
    return runTmpdir(input, toolName, env, uid, harnessTmp(uid));
}
function words(stmt) {
    return (stmt.split('\n')[0] ?? '').split(/[ \t]+/).filter((w) => w !== '');
}
/** Whether a `gh` body write in <stmt> takes --body-file or -F with a value other than `-`. */
function readsBodyFile(stmt) {
    if (!BODY_FILE_WRITES.has(ghMutation(stmt)))
        return false;
    const w = words(stmt);
    const gh = w.findIndex((word, k) => posixBasename(word) === 'gh' && BODY_FILE_WRITES.has(ghMutationFrom(w.slice(k))));
    if (gh < 0)
        return false;
    for (let k = gh + 1; k < w.length; k++) {
        const flag = w[k];
        if (flag === '--')
            return false;
        if (flag === '--body-file' || flag === '-F') {
            if (k + 1 < w.length && w[k + 1] !== '-')
                return true;
            k += 1;
            continue;
        }
        const attached = /^(?:--body-file=|-F=?)(.+)$/s.exec(flag);
        if (attached && attached[1] !== '-')
            return true;
    }
    return false;
}
function isRm(stmt) {
    return posixBasename(words(stmt)[0] ?? '') === 'rm';
}
/** <lines> less one occurrence per target an `rm` statement removes, so a write to a path removed earlier in the command stays. */
async function withoutRmTargets(lines, statements, cwd, env) {
    const kept = [...lines];
    for (const { dir, stmt } of statements) {
        if (!isRm(stmt))
            continue;
        const removed = await writePaths(stmt.replace(REDIRECT, ''), { cwd: dir.startsWith('/') ? dir : cwd, env });
        for (const target of removed) {
            const at = kept.indexOf(target);
            if (at >= 0)
                kept.splice(at, 1);
        }
    }
    return kept;
}
async function bashRule(input, env) {
    const command = field(input, ['tool_input', 'command']);
    if (command === '')
        return ALLOW;
    const tmpdir = effectiveTmpdir(input, 'Bash', env);
    const runEnv = tmpdir === (env.TMPDIR ?? '') ? env : { ...env, TMPDIR: tmpdir };
    const cwd = payloadCwd(input, env);
    const lines = capture((await writePaths(command, { cwd, env: runEnv })).join('\n')).split('\n');
    if (lines.some(isCapLine))
        return ALLOW;
    const prose = lines.filter((line) => line !== '' && !line.startsWith('UNRESOLVED:') && isProseFile(line));
    if (prose.length === 0 && !/\bgh\b/.test(command))
        return ALLOW;
    const listed = await cmdStatements(command, cwd, env);
    if (!listed.ok)
        return ALLOW;
    if (listed.statements.some(({ stmt }) => readsBodyFile(stmt)))
        return deny(BODY_FILE_REASON);
    for (const path of await withoutRmTargets(prose, listed.statements, cwd, runEnv)) {
        if (await deniedProse(path, tmpdir, env))
            return deny(proseReason(path));
    }
    return ALLOW;
}
async function fileRule(input, toolName, env) {
    const target = field(input, ['tool_input', 'file_path'], ['tool_input', 'notebook_path']);
    if (target === '')
        return ALLOW;
    const path = target.startsWith('/') ? target : `${payloadCwd(input, env)}/${target}`;
    return (await deniedProse(path, effectiveTmpdir(input, toolName, env), env)) ? deny(proseReason(target)) : ALLOW;
}
export const noProseInScratch = async (payload, env) => {
    if ((env.TMB_ALLOW_PROSE_SCRATCH ?? '0') === '1')
        return ALLOW;
    const toolName = field(payload, ['tool_name']);
    if (toolName === 'Bash')
        return await bashRule(payload, env);
    return FILE_TOOLS.has(toolName) ? await fileRule(payload, toolName, env) : ALLOW;
};
//# sourceMappingURL=no-prose-in-scratch.js.map