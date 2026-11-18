/**
 * PostToolUse hook on bro_atomic_close (GH 1692): for each directory the closed
 * task's commit touched whose README.md is missing or stale, a non-blocking
 * additionalContext nudge and one `readme_staleness_surfaced` audit row. The
 * world model summarizes each directory from its README.md, so bro decides
 * whether to refresh it. An error response, an unresolvable task, commit or
 * repo, or nothing stale prints nothing. Bypass:
 * TMB_DISABLE_README_STALENESS_HOOK=1.
 *
 * The verdict comes from git alone, read in the closed commit's tree
 * (GH 2044, GH 1792), not the main checkout's files and their mtimes: a
 * README.md absent from the commit's tree is missing; one the commit itself
 * changes is fresh; any other is older than the commit. So a README the
 * commit adds or edits, on a branch the main checkout has not checked out, is
 * not flagged. It needs neither jq nor the sqlite3 CLI.
 *
 * Scope (GH 1965): a directory with a path segment in plugin_config
 * `readme_nudge_skip_dirs` (a JSON array of segments; unset or not an array
 * of strings reads as DEFAULT_SKIP_DIRS) is skipped; a missing README is
 * reported only where the commit adds a file (renames count as adds); the
 * nudge lists at most NUDGE_DIR_CAP dirs, then `and N more`, while the audit
 * row keeps the full list.
 */
import { ALLOW } from './gate.js';
import { auditAppend } from './lib/audit.js';
import { dbPath, haveSqlite, sqlInt, sqliteRo } from './lib/db.js';
import { gitOk, gitOut } from './lib/git.js';
import { jqCompact } from './lib/jq.js';
import { jqCapture, jqInput, jqNumber } from './lib/jq-raw.js';
import { posixDirname } from './lib/project-env.js';
import { repoResolvePath } from './lib/repo.js';
import { sortUnique } from './lib/scope-fence.js';
import { statSync } from 'node:fs';
export const GATE_NAME = 'post-atomic-close-readme';
export const BYPASS_ENV = 'TMB_DISABLE_README_STALENESS_HOOK';
const ATOMIC_CLOSE_TOOL = /^mcp__[\s\S]*trajectory-server__bro_atomic_close$/;
const ROOT_DIR = '.';
export const SKIP_DIRS_KEY = 'readme_nudge_skip_dirs';
const SKIP_DIRS_SQL = `SELECT value_json FROM plugin_config WHERE key = '${SKIP_DIRS_KEY}';`;
export const DEFAULT_SKIP_DIRS = ['dist', 'build', 'changelog.d', 'fixtures', 'test', 'tests', '__tests__', 'node_modules'];
export const NUDGE_DIR_CAP = 10;
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
function cut(text) {
    const bar = text.indexOf('|');
    return bar < 0 ? [text, text] : [text.slice(0, bar), text.slice(bar + 1)];
}
/** The `${row%%|*}` / `${row#*|}` split of `commit_sha|repo|issue_id|branch_id`. */
export function parseTaskRow(row) {
    const [commitSha, rest1] = cut(row);
    const [repo, rest2] = cut(rest1);
    const [issueId, branchId] = cut(rest2);
    return { commitSha, repo, issueId, branchId };
}
/** The dir of each changed path as `${f%/*}` gives it, `.` for the repo root. */
export function touchedDirs(paths, env) {
    return sortUnique(paths.map((f) => {
        const slash = f.lastIndexOf('/');
        return slash < 0 ? ROOT_DIR : f.slice(0, slash);
    }), env);
}
export function isSkippedDir(dir, skipDirs) {
    return dir.split('/').some((segment) => skipDirs.includes(segment));
}
/** The skip segments from a plugin_config value_json; DEFAULT_SKIP_DIRS when empty, not JSON or not an array of strings. */
export function parseSkipDirs(valueJson) {
    try {
        const value = JSON.parse(valueJson);
        if (Array.isArray(value) && value.every((v) => typeof v === 'string'))
            return value;
    }
    catch {
        /* unset or malformed: the default */
    }
    return DEFAULT_SKIP_DIRS;
}
function readSkipDirs(db, env) {
    return parseSkipDirs(sqliteRo(db, SKIP_DIRS_SQL, env));
}
/** The dirs <stale> names, at most NUDGE_DIR_CAP of them, then `and N more`. */
export function cappedList(stale) {
    const shown = stale.slice(0, NUDGE_DIR_CAP);
    if (stale.length > NUDGE_DIR_CAP)
        shown.push(`and ${stale.length - NUDGE_DIR_CAP} more`);
    return shown.join('\n');
}
/**
 * One line per touched dir outside <skipDirs> whose README.md is missing from
 * <sha>'s tree while the commit adds a file there, or present there but not
 * among the commit's own changed paths.
 */
export async function staleDirs(repoPath, sha, repo, paths, added, skipDirs, env) {
    const changed = new Set(paths);
    const addedDirs = new Set(touchedDirs(added, env));
    const out = [];
    for (const dir of touchedDirs(paths, env)) {
        if (isSkippedDir(dir, skipDirs))
            continue;
        const readme = dir === ROOT_DIR ? 'README.md' : `${dir}/README.md`;
        const label = dir === ROOT_DIR ? (repo === '' ? '<repo root>' : `${repo}/`) : dir;
        if (!await gitOk(repoPath, ['cat-file', '-e', `${sha}:${readme}`], env)) {
            if (addedDirs.has(dir))
                out.push(`${label} (no README.md)`);
        }
        else if (!changed.has(readme))
            out.push(`${label} (README.md older than the commit)`);
    }
    return out;
}
export function nudgeReason(taskId, sha, stale) {
    return `📝 README-staleness check (task ${taskId}, commit ${sha.slice(0, 7)}): the world model derives each directory's summary from that dir's README.md, so a stale README degrades world_model_get / world_model_search for that dir.

The commit touched directories whose README.md is missing or older than the commit:
${stale}

For each, consider updating the directory's README.md so the next /scan picks up an accurate summary. This is a judgment call — skip it when the change doesn't alter what the README describes.`;
}
async function resolveRepoPath(db, repo, env) {
    let path = repoResolvePath(db, repo, env);
    if (path === '' && repo === '')
        path = posixDirname(posixDirname(posixDirname(db)));
    if (path !== '' && !await gitOk(path, ['rev-parse', '--git-dir'], env))
        path = '';
    return path;
}
async function surface(payload, env) {
    if (env[BYPASS_ENV] === '1')
        return ALLOW;
    const input = jqInput(payload);
    if (!ATOMIC_CLOSE_TOOL.test(jqCapture(input, ['tool_name'])))
        return ALLOW;
    if (jqCapture(input, ['tool_response', 'is_error']) === 'true')
        return ALLOW;
    const taskId = sqlInt(jqCapture(input, ['tool_input', 'task_id']));
    if (taskId === '')
        return ALLOW;
    const db = dbPath(env);
    if (db === null || !isFile(db) || !haveSqlite(env))
        return ALLOW;
    const row = sqliteRo(db, `SELECT COALESCE(commit_sha,'') || '|' || COALESCE(repo,'') || '|' || COALESCE(issue_id,'') || '|' || COALESCE(branch_id,'') FROM tasks WHERE id = ${taskId};`, env);
    if (row === '')
        return ALLOW;
    const task = parseTaskRow(row);
    if (!/^[0-9a-fA-F]+$/.test(task.commitSha))
        return ALLOW;
    const repoPath = await resolveRepoPath(db, task.repo, env);
    if (repoPath === '')
        return ALLOW;
    if (!await gitOk(repoPath, ['cat-file', '-e', `${task.commitSha}^{commit}`], env))
        return ALLOW;
    const paths = (await gitOut(repoPath, ['show', '--name-only', '--pretty=format:', task.commitSha], env))
        .split('\n')
        .filter((line) => line !== '');
    if (paths.length === 0)
        return ALLOW;
    const added = (await gitOut(repoPath, ['show', '--name-only', '--no-renames', '--diff-filter=A', '--pretty=format:', task.commitSha], env))
        .split('\n')
        .filter((line) => line !== '');
    const stale = await staleDirs(repoPath, task.commitSha, task.repo, paths, added, readSkipDirs(db, env), env);
    if (stale.length === 0)
        return ALLOW;
    const staleLines = stale.join('\n').split('\n');
    const w = auditAppend(db, {
        issueId: sqlInt(task.issueId) || '-1',
        branchId: task.branchId,
        fromNode: `hook:${GATE_NAME}`,
        eventType: 'readme_staleness_surfaced',
        summary: `task ${taskId}: README may be stale in ${staleLines.filter((line) => line !== '').length} dir(s) after ${task.commitSha.slice(0, 7)}`,
        contentJson: jqCompact({ task_id: jqNumber(taskId), commit_sha: task.commitSha, stale: staleLines }),
    }, { env, caller: GATE_NAME });
    if (!w.ok)
        process.stderr.write(`${w.error}\n`);
    const out = jqCompact({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudgeReason(taskId, task.commitSha, cappedList(stale)) } });
    return { stdout: `${w.stdout}${out}\n`, code: 0 };
}
export const postAtomicCloseReadme = async (payload, env) => {
    try {
        return await surface(payload, env);
    }
    catch {
        return ALLOW;
    }
};
//# sourceMappingURL=post-atomic-close-readme.js.map