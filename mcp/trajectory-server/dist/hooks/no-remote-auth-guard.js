/**
 * PreToolUse gate (GH 1692): an interactive `gh auth login` / `glab auth login` is denied when the repo's
 * remotes rows carry no URL, as it would hang with no TTY or network while
 * TMB works locally.
 *
 * A command tree-sitter-bash cannot parse is denied with git-guards'
 * PARSE_REASON when the DB resolves. The payload is read with no jq on PATH,
 * and the DB through node:sqlite with no sqlite3 CLI on PATH.
 */
import { ALLOW } from './gate.js';
import { PARSE_FIX, PARSE_REASON } from './git-guards.js';
import { denyResult } from './lib/deny.js';
import { cmdStatements, prefilterPasses, stmtRepoRoot } from './cmd-analysis/index.js';
import { dbPath, haveSqlite } from './lib/db.js';
import { jqCapture, jqGet, jqInput, jqRaw, JqUnindexable } from './lib/jq-raw.js';
import { shellCapture } from './lib/lint-shell.js';
import { repoRemotes } from './lib/repo.js';
import { payloadCwdOf, statementRows } from './lib/statement-rows.js';
export const GATE_NAME = 'no-remote-auth-guard';
const AUTH_LOGIN = [
    ['gh', 'gh auth login'],
    ['glab', 'glab auth login'],
];
/** `printf '%s' <remotes> | jq -r '[.[]|select(.url!=null and .url!="")]|length>0'`, up to jq's first error. */
export function hasRemoteUrl(remotesJson) {
    const lines = [];
    for (const value of jqInput(remotesJson).values) {
        if (value === null || typeof value !== 'object')
            break;
        let n = 0;
        try {
            for (const item of Object.values(value)) {
                const url = jqGet(item, 'url');
                if (url !== null && url !== '')
                    n++;
            }
        }
        catch (e) {
            if (e instanceof JqUnindexable)
                break;
            throw e;
        }
        lines.push(jqRaw(n > 0));
    }
    return shellCapture(lines.join('\n'));
}
export const noRemoteAuthGuard = async (payload, env) => {
    const input = jqInput(payload);
    const command = jqCapture(input, ['tool_input', 'command'], true);
    if (command === '' || !prefilterPasses(command, (text) => text.includes('login')))
        return ALLOW;
    const cwd = payloadCwdOf(input, env);
    const listed = await cmdStatements(command, cwd, env);
    if (!listed.ok)
        return dbPath(env) !== null && haveSqlite(env) ? denyResult(PARSE_REASON, PARSE_FIX) : ALLOW;
    let tool = '';
    let matchedDir = '';
    for (const { dir, stmt } of statementRows(listed.statements)) {
        const hit = AUTH_LOGIN.find(([, login]) => stmt === login || stmt.startsWith(`${login} `));
        if (hit) {
            [tool] = hit;
            matchedDir = dir;
            break;
        }
    }
    if (tool === '')
        return ALLOW;
    const db = dbPath(env);
    if (db === null)
        return ALLOW;
    if (!haveSqlite(env))
        return ALLOW;
    const remotes = repoRemotes(db, await stmtRepoRoot(matchedDir, cwd, env), env);
    if (remotes === '')
        return ALLOW;
    if (hasRemoteUrl(remotes) !== 'false')
        return ALLOW;
    return denyResult(`BLOCKED: no remote URL is configured, so TMB runs locally and an interactive '${tool} auth login' would hang with no TTY. Continue the task locally; remote and push steps wait until the Human adds a remote with /onboard.`, { allowed: 'continue the task locally, with no auth login, remote or push step' });
};
//# sourceMappingURL=no-remote-auth-guard.js.map