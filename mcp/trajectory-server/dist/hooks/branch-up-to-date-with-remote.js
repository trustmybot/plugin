/**
 * PreToolUse gate (GH 1692): `git worktree add <path> <branch>` on a registered repo is denied while
 * <branch> is behind origin/<pr_target>, after one bounded fetch of
 * <pr_target>. No origin, no such branch or no origin/<pr_target> passes, and
 * TMB_ALLOW_STALE_BRANCH=1 bypasses. A git statement whose subcommand is not
 * literal text (gitSubcommandOf, GH 2641) is denied when the DB resolves.
 *
 * A command tree-sitter-bash cannot parse is denied with git-guards'
 * PARSE_REASON when the DB resolves. The payload is read with no jq on PATH,
 * and the DB through node:sqlite with no sqlite3 CLI on PATH.
 */
import { ALLOW } from './gate.js';
import { PARSE_FIX, PARSE_REASON } from './git-guards.js';
import { denyResult } from './lib/deny.js';
import { ambiguousSubcommandReason, cmdStatements, gitBesideExpansion, gitSubcommandOf, prefilterPasses, stmtRepoRoot } from './cmd-analysis/index.js';
import { dbPath, denyDbUnavailable, GATE_READ_ERROR, gateRead, haveSqlite, sqlQuote, stripTrailingNewlines } from './lib/db.js';
import { gitOk, gitOut, gitRun } from './lib/git.js';
import { jqCapture, jqInput } from './lib/jq-raw.js';
import { repoNameForRoot } from './lib/repo.js';
import { payloadCwdOf, statementRows } from './lib/statement-rows.js';
export const GATE_NAME = 'branch-up-to-date-with-remote';
const CREATES_BRANCH = [' -b ', ' -B ', ' --create-branch '];
const UNKNOWN_FIX = { allowed: 'git -C <path> worktree add <path> <branch>, the subcommand written literally' };
/** `$(git … rev-list --count … 2>/dev/null || echo "?")`. */
async function behindCount(root, range, env) {
    const r = await gitRun(root, ['rev-list', '--count', range], env);
    return stripTrailingNewlines(r.code === 0 ? r.stdout : `${r.stdout}?\n`);
}
export const branchUpToDateWithRemote = async (payload, env) => {
    const input = jqInput(payload);
    if (jqCapture(input, ['tool_name']) !== 'Bash')
        return ALLOW;
    if ((env.TMB_ALLOW_STALE_BRANCH ?? '') === '1')
        return ALLOW;
    const command = jqCapture(input, ['tool_input', 'command']);
    if (command === '' || (!prefilterPasses(command, (text) => text.includes('worktree')) && !gitBesideExpansion(command)))
        return ALLOW;
    const cwd = payloadCwdOf(input, env);
    const listed = await cmdStatements(command, cwd, env);
    if (!listed.ok)
        return dbPath(env) !== null && haveSqlite(env) ? denyResult(PARSE_REASON, PARSE_FIX) : ALLOW;
    const rows = statementRows(listed.statements);
    const subs = rows.map((row) => gitSubcommandOf(row));
    const unknown = rows[subs.indexOf(undefined)];
    if (unknown) {
        if (dbPath(env) === null || !haveSqlite(env))
            return ALLOW;
        return denyResult(ambiguousSubcommandReason(unknown.src ?? unknown.stmt, 'adds a worktree'), UNKNOWN_FIX);
    }
    let wtDir = '';
    let wtSub = '';
    for (const [i, { dir }] of rows.entries()) {
        const sub = subs[i] ?? '';
        if (sub.startsWith('worktree add ')) {
            wtDir = dir;
            wtSub = sub;
            break;
        }
    }
    if (wtSub === '')
        return ALLOW;
    if (CREATES_BRANCH.some((flag) => ` ${wtSub} `.includes(flag)))
        return ALLOW;
    const branch = wtSub.slice(wtSub.lastIndexOf(' ') + 1);
    if (branch === '')
        return ALLOW;
    const root = await stmtRepoRoot(wtDir, cwd, env);
    if (root === '')
        return ALLOW;
    const db = dbPath(env, (line) => process.stderr.write(`${line}\n`));
    if (db === null)
        return ALLOW;
    if (!haveSqlite(env))
        return ALLOW;
    const repo = sqlQuote(repoNameForRoot(db, root, env));
    const row = gateRead(db, `SELECT 'repo|' || COALESCE(target_branch, '') FROM repos WHERE name = '${repo}' LIMIT 1;`, env);
    if (row === GATE_READ_ERROR)
        return { stdout: `${denyDbUnavailable(GATE_NAME, env)}\n`, code: 0 };
    if (row === '')
        return ALLOW;
    const prTarget = (row.startsWith('repo|') ? row.slice(5) : row) || 'main';
    if (!await gitOk(root, ['rev-parse', '--verify', branch], env))
        return ALLOW;
    if (await gitOut(root, ['remote', 'get-url', 'origin'], env) === '')
        return ALLOW;
    await gitRun(root, ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=5', 'fetch', 'origin', prTarget, '--quiet'], env);
    if (!await gitOk(root, ['rev-parse', '--verify', `origin/${prTarget}`], env))
        return ALLOW;
    if (await gitOk(root, ['merge-base', '--is-ancestor', `origin/${prTarget}`, branch], env))
        return ALLOW;
    const behind = await behindCount(root, `${branch}..origin/${prTarget}`, env);
    return denyResult(`BLOCKED: branch '${branch}' is behind origin/${prTarget} by ${behind} commit(s). bro must rebase the task branch onto the latest origin/${prTarget} (or recreate it) before SWE attaches a worktree. This catches stale-local-main bugs where the worktree starts from yesterday's commit and conflicts on push. Bypass: TMB_ALLOW_STALE_BRANCH=1 (e.g. offline work).`, { allowed: `git branch -D ${branch} && git fetch origin ${prTarget} && git branch ${branch} origin/${prTarget}, then the same worktree add` });
};
//# sourceMappingURL=branch-up-to-date-with-remote.js.map