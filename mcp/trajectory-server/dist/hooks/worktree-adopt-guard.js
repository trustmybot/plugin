/**
 * PreToolUse(task_provision, task_reopen, task_retry) gate (GH 2032), born in
 * TypeScript: a session running in a linked git worktree adopts that worktree
 * for its task, and no other session adopts one.
 *
 * An allowlist. The session root is CLAUDE_PROJECT_DIR, else the payload cwd;
 * it is in a linked worktree when its `git rev-parse --git-dir` differs from
 * its `--git-common-dir` (a non-git dir or a git failure is not linked). The
 * gate admits only:
 *   - a call without adopt_worktree from a root not in a linked worktree;
 *   - a call whose adopt_worktree realpath is the root's linked-worktree top
 *     level.
 * Every other call is denied, naming the worktree that may be adopted, if any.
 */
import { realpathSync } from 'node:fs';
import { ALLOW } from './gate.js';
import { gitRun, isDir } from './lib/git.js';
import { denyResult as deny } from './lib/deny.js';
import { claudeProjectDir } from './lib/project-env.js';
export const GATE_NAME = 'worktree-adopt-guard';
export const ADOPT_TOOLS = ['task_provision', 'task_reopen', 'task_retry'];
function realpath(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return null;
    }
}
async function gitLine(dir, args, env) {
    const r = await gitRun(dir, args, env);
    const out = r.stdout.replace(/\n+$/, '');
    return r.code === 0 && out !== '' ? out : null;
}
/** The realpath of the linked worktree <root> sits in, or null when <root> is a main checkout, not in git, or git fails. */
export async function linkedWorktreeTop(root, env = process.env) {
    if (root === '' || !isDir(root))
        return null;
    const gitDir = await gitLine(root, ['rev-parse', '--path-format=absolute', '--git-dir'], env);
    const commonDir = await gitLine(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env);
    if (gitDir === null || commonDir === null)
        return null;
    const realGitDir = realpath(gitDir);
    const realCommonDir = realpath(commonDir);
    if (realGitDir === null || realCommonDir === null || realGitDir === realCommonDir)
        return null;
    const top = await gitLine(root, ['rev-parse', '--show-toplevel'], env);
    return top === null ? null : realpath(top);
}
function sessionRoot(payload, env) {
    const projectDir = claudeProjectDir(env);
    if (projectDir !== '')
        return projectDir;
    return typeof payload.cwd === 'string' ? payload.cwd : '';
}
export const worktreeAdoptGuard = async (raw, env) => {
    let payload;
    try {
        payload = JSON.parse(raw);
    }
    catch {
        return deny('BLOCKED: worktree-adopt-guard could not read the hook payload, so it cannot tell which worktree this session may adopt.', 'policy');
    }
    const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
    const tool = ADOPT_TOOLS.find((t) => toolName.endsWith(`trajectory-server__${t}`));
    if (tool === undefined)
        return ALLOW;
    const root = sessionRoot(payload, env);
    const top = await linkedWorktreeTop(root, env);
    const arg = payload.tool_input?.adopt_worktree;
    if (arg === undefined || arg === null) {
        if (top === null)
            return ALLOW;
        return deny(`BLOCKED: this session runs in the linked worktree '${top}', so its task adopts that worktree instead of a new ` +
            `<repo>/.claude/worktrees/<slug>.`, { allowed: `the same ${tool} call with adopt_worktree: '${top}'` });
    }
    const asked = typeof arg === 'string' ? arg : JSON.stringify(arg);
    const real = typeof arg === 'string' && arg.startsWith('/') ? realpath(arg) : null;
    if (top !== null && real === top)
        return ALLOW;
    if (top !== null) {
        return deny(`BLOCKED: adopt_worktree '${asked}' is not this session's worktree. A session adopts only the linked worktree it runs in.`, { allowed: `the same ${tool} call with adopt_worktree: '${top}'` });
    }
    return deny(`BLOCKED: adopt_worktree '${asked}' is refused: this session's root '${root}' is not in a linked git worktree ` +
        '(a main checkout or no git repo), so no worktree may be adopted from it.', { allowed: `the same ${tool} call without adopt_worktree, which creates <repo>/.claude/worktrees/<slug>` });
};
//# sourceMappingURL=worktree-adopt-guard.js.map