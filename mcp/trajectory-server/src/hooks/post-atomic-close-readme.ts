/**
 * PostToolUse hook on bro_atomic_close (GH 1692), the port of
 * scripts/hooks/post-atomic-close-readme.sh: for each directory the closed
 * task's commit touched whose README.md is missing or stale, a non-blocking
 * additionalContext nudge and one `readme_staleness_surfaced` audit row. The
 * world model summarizes each directory from its README.md, so bro decides
 * whether to refresh it. An error response, an unresolvable task, commit or
 * repo, or nothing stale prints nothing. Bypass:
 * TMB_DISABLE_README_STALENESS_HOOK=1.
 *
 * The verdict comes from git alone, read in the closed commit's tree
 * (GH 2044, GH 1792), where the .sh read the main checkout's files and their
 * mtimes: a README.md absent from the commit's tree is missing; one the
 * commit itself changes is fresh; any other is older than the commit. A
 * directory with a `dist` path segment is skipped. So a README the commit
 * adds or edits, on a branch the main checkout has not checked out, is no
 * longer flagged. Unlike the .sh, it needs neither jq nor the sqlite3 CLI
 * (decision 703).
 */
import { ALLOW, type GateResult, type Gate } from './gate.js';
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

export interface ClosedTask {
  commitSha: string;
  repo: string;
  issueId: string;
  branchId: string;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function cut(text: string): [string, string] {
  const bar = text.indexOf('|');
  return bar < 0 ? [text, text] : [text.slice(0, bar), text.slice(bar + 1)];
}

/** The .sh's `${row%%|*}` / `${row#*|}` split of `commit_sha|repo|issue_id|branch_id`. */
export function parseTaskRow(row: string): ClosedTask {
  const [commitSha, rest1] = cut(row);
  const [repo, rest2] = cut(rest1);
  const [issueId, branchId] = cut(rest2);
  return { commitSha, repo, issueId, branchId };
}

/** The dir of each changed path as `${f%/*}` gives it, `.` for the repo root. */
export function touchedDirs(paths: readonly string[], env: NodeJS.ProcessEnv): string[] {
  return sortUnique(
    paths.map((f) => {
      const slash = f.lastIndexOf('/');
      return slash < 0 ? ROOT_DIR : f.slice(0, slash);
    }),
    env,
  );
}

export function isDistDir(dir: string): boolean {
  return dir.split('/').includes('dist');
}

/**
 * One line per touched dir whose README.md is missing from <sha>'s tree or
 * present there but not among the commit's own changed paths; dist dirs skipped.
 */
export async function staleDirs(repoPath: string, sha: string, repo: string, paths: readonly string[], env: NodeJS.ProcessEnv): Promise<string[]> {
  const changed = new Set(paths);
  const out: string[] = [];
  for (const dir of touchedDirs(paths, env)) {
    if (isDistDir(dir)) continue;
    const readme = dir === ROOT_DIR ? 'README.md' : `${dir}/README.md`;
    const label = dir === ROOT_DIR ? (repo === '' ? '<repo root>' : `${repo}/`) : dir;
    if (!await gitOk(repoPath, ['cat-file', '-e', `${sha}:${readme}`], env)) out.push(`${label} (no README.md)`);
    else if (!changed.has(readme)) out.push(`${label} (README.md older than the commit)`);
  }
  return out;
}

export function nudgeReason(taskId: string, sha: string, stale: string): string {
  return `📝 README-staleness check (task ${taskId}, commit ${sha.slice(0, 7)}): the world model derives each directory's summary from that dir's README.md, so a stale README degrades world_model_get / world_model_search for that dir.

The commit touched directories whose README.md is missing or older than the commit:
${stale}

For each, consider updating the directory's README.md so the next /scan picks up an accurate summary. This is a judgment call — skip it when the change doesn't alter what the README describes.`;
}

async function resolveRepoPath(db: string, repo: string, env: NodeJS.ProcessEnv): Promise<string> {
  let path = repoResolvePath(db, repo, env);
  if (path === '' && repo === '') path = posixDirname(posixDirname(posixDirname(db)));
  if (path !== '' && !await gitOk(path, ['rev-parse', '--git-dir'], env)) path = '';
  return path;
}

async function surface(payload: string, env: NodeJS.ProcessEnv): Promise<GateResult> {
  if (env[BYPASS_ENV] === '1') return ALLOW;
  const input = jqInput(payload);
  if (!ATOMIC_CLOSE_TOOL.test(jqCapture(input, ['tool_name']))) return ALLOW;
  if (jqCapture(input, ['tool_response', 'is_error']) === 'true') return ALLOW;
  const taskId = sqlInt(jqCapture(input, ['tool_input', 'task_id']));
  if (taskId === '') return ALLOW;

  const db = dbPath(env);
  if (db === null || !isFile(db) || !haveSqlite(env)) return ALLOW;
  const row = sqliteRo(
    db,
    `SELECT COALESCE(commit_sha,'') || '|' || COALESCE(repo,'') || '|' || COALESCE(issue_id,'') || '|' || COALESCE(branch_id,'') FROM tasks WHERE id = ${taskId};`,
    env,
  );
  if (row === '') return ALLOW;
  const task = parseTaskRow(row);
  if (!/^[0-9a-fA-F]+$/.test(task.commitSha)) return ALLOW;

  const repoPath = await resolveRepoPath(db, task.repo, env);
  if (repoPath === '') return ALLOW;
  if (!await gitOk(repoPath, ['cat-file', '-e', `${task.commitSha}^{commit}`], env)) return ALLOW;
  const paths = (await gitOut(repoPath, ['show', '--name-only', '--pretty=format:', task.commitSha], env))
    .split('\n')
    .filter((line) => line !== '');
  if (paths.length === 0) return ALLOW;

  const stale = await staleDirs(repoPath, task.commitSha, task.repo, paths, env);
  if (stale.length === 0) return ALLOW;
  const staleText = stale.join('\n');
  const staleLines = staleText.split('\n');

  const w = auditAppend(
    db,
    {
      issueId: sqlInt(task.issueId) || '-1',
      branchId: task.branchId,
      fromNode: `hook:${GATE_NAME}`,
      eventType: 'readme_staleness_surfaced',
      summary: `task ${taskId}: README may be stale in ${staleLines.filter((line) => line !== '').length} dir(s) after ${task.commitSha.slice(0, 7)}`,
      contentJson: jqCompact({ task_id: jqNumber(taskId), commit_sha: task.commitSha, stale: staleLines }),
    },
    { env, caller: GATE_NAME },
  );
  if (!w.ok) process.stderr.write(`${w.error}\n`);
  const out = jqCompact({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudgeReason(taskId, task.commitSha, staleText) } });
  return { stdout: `${w.stdout}${out}\n`, code: 0 };
}

export const postAtomicCloseReadme: Gate = async (payload, env): Promise<GateResult> => {
  try {
    return await surface(payload, env);
  } catch {
    return ALLOW;
  }
};
