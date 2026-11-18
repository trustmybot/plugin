/**
 * PostToolUse(Bash) hook (GH 2584): after a command whose statements run
 * `git fetch`, `git pull`, `git push`, `git merge`, `git rebase`, `git reset`,
 * `git checkout`, `git switch`, `gh pr merge`, `glab mr merge` or
 * `gh repo sync`, each touched repo whose repos.indexed_commit is not the
 * commit its index target (origin/<target branch>, else HEAD) resolves to gets
 * a detached `run-scan.mjs <root> hook <repo>` child that reindexes it with
 * trigger 'hook'. A forge command moves the remote only, so its child fetches
 * origin/<target branch> first (`--fetch`), unless the role is swe or
 * code-reviewer. Heredoc bodies and quoted text never match; any other command
 * exits before any git or DB call.
 *
 * Advisory: it prints nothing and always exits 0. Bypass: TMB_SKIP_AUTO_RESCAN=1.
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveIndexTarget } from '../utils/index-target.js';
import { cmdStatements, gitSubcommand, prefilterPasses, stmtRepoRoot } from './cmd-analysis/index.js';
import { ALLOW } from './gate.js';
import { dbPath, dbProjectRoot, haveSqlite, projectRoot, sqliteRo, sqlQuote } from './lib/db.js';
import { jqInput } from './lib/jq-raw.js';
import { mergeFailed, readMergePayload } from './lib/merge.js';
import { installRoot, posixDirname } from './lib/project-env.js';
import { repoNameForRoot } from './lib/repo.js';
import { CODE_REVIEWER_ROLE, agentRole } from './lib/role.js';
import { payloadCwdOf } from './lib/statement-rows.js';
export const GATE_NAME = 'ref-move-reindex';
const MAY_MOVE = /\b(fetch|pull|push|merge|rebase|reset|checkout|switch|sync)\b/;
const GIT_MOVES = new Set(['fetch', 'pull', 'push', 'merge', 'rebase', 'reset', 'checkout', 'switch']);
const FORGE_MOVES = new Set(['gh pr merge', 'glab mr merge', 'gh repo sync']);
const NO_FETCH_ROLES = new Set(['swe', CODE_REVIEWER_ROLE]);
export function moveOf(stmt) {
    const sub = gitSubcommand(stmt).split(' ')[0] ?? '';
    if (GIT_MOVES.has(sub))
        return 'git';
    const [a, b, c] = stmt.split(/\s+/);
    return FORGE_MOVES.has(`${a} ${b} ${c}`) ? 'forge' : null;
}
function readRepoStamp(db, root, env) {
    const name = repoNameForRoot(db, root, env);
    if (name === '')
        return null;
    const row = sqliteRo(db, `SELECT 'repo|' || COALESCE(indexed_commit, '') || '|' || COALESCE(target_branch, '') FROM repos WHERE name = '${sqlQuote(name)}' LIMIT 1;`, env);
    if (!row.startsWith('repo|'))
        return null;
    const [indexed = '', branch = ''] = row.slice(5).replace(/\n+$/, '').split('|');
    return { name, indexed_commit: indexed, target_branch: branch };
}
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
function runScanScript(env) {
    const root = installRoot(posixDirname(fileURLToPath(import.meta.url))) ?? env.CLAUDE_PLUGIN_ROOT ?? '';
    return root === '' ? '' : `${root}/scripts/maintenance/run-scan.mjs`;
}
function launchDetached(args, db, env) {
    if (env.NODE_TEST_CONTEXT)
        return;
    const script = runScanScript(env);
    if (script === '' || !isFile(script))
        return;
    const cwd = dbProjectRoot(db) || projectRoot(env) || (args[0] ?? '');
    if (cwd === '')
        return;
    const child = spawn(process.execPath, ['--experimental-sqlite', script, ...args], {
        cwd,
        detached: true,
        stdio: 'ignore',
        env: { ...env, TRAJECTORY_DB_PATH: db },
    });
    child.on('error', () => undefined);
    child.unref();
}
export const REAL_SEAMS = {
    statements: cmdStatements,
    repoRoot: stmtRepoRoot,
    repoStamp: readRepoStamp,
    targetCommit: (root, branch) => resolveIndexTarget(root, () => branch || null)?.commit ?? null,
    launch: launchDetached,
};
export function refMoveReindexWith(seams) {
    return async (payload, env) => {
        try {
            const { input, toolName, command, response } = readMergePayload(payload);
            if (toolName !== 'Bash' || !prefilterPasses(command, (text) => MAY_MOVE.test(text)))
                return ALLOW;
            if ((env.TMB_SKIP_AUTO_RESCAN ?? '') === '1' || mergeFailed(response))
                return ALLOW;
            const bare = await seams.statements(command, '', env);
            if (!bare.ok)
                return ALLOW;
            const moves = bare.statements.map(({ stmt }) => moveOf(stmt));
            if (moves.every((m) => m === null))
                return ALLOW;
            const db = dbPath(env);
            if (db === null || !haveSqlite(env))
                return ALLOW;
            const cwd = payloadCwdOf(jqInput(payload), env);
            const listed = await seams.statements(command, cwd, env);
            if (!listed.ok)
                return ALLOW;
            const fetchAllowed = !NO_FETCH_ROLES.has(agentRole(input));
            const roots = new Map();
            for (const [i, statement] of listed.statements.entries()) {
                const move = moves[i] ?? moveOf(statement.stmt);
                if (move === null)
                    continue;
                const root = await seams.repoRoot(statement.dir, cwd, env);
                if (root === '')
                    continue;
                roots.set(root, (roots.get(root) ?? false) || (move === 'forge' && fetchAllowed));
            }
            for (const [root, fetch] of roots) {
                const stamp = seams.repoStamp(db, root, env);
                if (stamp === null)
                    continue;
                if (!fetch) {
                    const target = seams.targetCommit(root, stamp.target_branch);
                    if (target === null || target === stamp.indexed_commit)
                        continue;
                }
                seams.launch([root, 'hook', stamp.name, ...(fetch ? ['--fetch'] : [])], db, env);
            }
        }
        catch {
            /* advisory: a reindex that cannot start leaves the next read to catch up */
        }
        return ALLOW;
    };
}
export const refMoveReindex = refMoveReindexWith(REAL_SEAMS);
//# sourceMappingURL=ref-move-reindex.js.map