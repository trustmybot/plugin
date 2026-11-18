/**
 * SessionStart and UserPromptSubmit gate (GH 3275): closes the tasks whose PR
 * was merged on the forge, a merge close-issue-on-merge never sees because no
 * Bash call of the session ran it. For each repo holding a live task with a
 * branch, one `gh pr list --state merged` (bounded to 10 s) lists the newest
 * merged PRs; a PR whose head is a live branch and that merged after the
 * branch's newest live task was created is recorded through recordMerge, the
 * same transaction close-issue-on-merge writes. A branch reused for new work
 * after its PR merged keeps its tasks.
 *
 * Advisory and fail-open: with no live branch it spawns nothing, and gh
 * missing, failing, timing out or printing anything but a JSON array writes
 * nothing for that repo, so the next turn retries. It prints nothing on stdout
 * and always allows. Bypass: TMB_DISABLE_CLOSE_FORGE_MERGED=1.
 */
import { spawn } from 'node:child_process';
import { ALLOW, type Gate, type GateResult } from './gate.js';
import { recordMerge } from './close-issue-on-merge.js';
import { dbPath, haveSqlite, repoPathAbs, sqliteRo } from './lib/db.js';
import { deadlineSignal, noteSpawn, spawnLimit } from './lib/deadline.js';
import { isDir } from './lib/git.js';
import { commandOnPath } from './lib/host.js';
import { repoResolvePath } from './lib/repo.js';
import { LIVE, statusIn } from '../task-states.js';

export const GATE_NAME = 'close-forge-merged';

const GH_TIMEOUT_MS = 10_000;
const PR_LIST_ARGS = ['pr', 'list', '--state', 'merged', '--json', 'headRefName,number,mergedAt,body,closingIssuesReferences', '--limit', '100'] as const;

interface LiveBranch {
  branch: string;
  /** created_at of the branch's newest live task, as epoch ms. */
  newestTaskMs: number;
}

export interface ForgePr {
  head: string;
  mergedMs: number;
  json: string;
}

/**
 * The live branches by repo name ("" when neither the task nor its issue
 * names one). Git refs hold no control characters, so a tab splits the row.
 */
function liveBranchesByRepo(db: string, env: NodeJS.ProcessEnv): Map<string, LiveBranch[]> {
  const rows = sqliteRo(
    db,
    `SELECT t.branch_id || char(9) || COALESCE(t.repo, i.repo, '') || char(9)
            || COALESCE(CAST(MAX(ROUND((julianday(t.created_at) - 2440587.5) * 86400000)) AS INTEGER), '')
       FROM tasks t LEFT JOIN issues i ON i.id = t.issue_id
      WHERE ${statusIn('t', LIVE)} AND t.branch_id <> ''
      GROUP BY t.branch_id, COALESCE(t.repo, i.repo, '')
      ORDER BY 1;`,
    env,
  );
  const byRepo = new Map<string, LiveBranch[]>();
  for (const row of rows.split('\n')) {
    const [branch, repo, createdMs] = row.split('\t');
    // A task whose created_at does not parse cannot be shown to predate a merge.
    if (!branch || !/^-?[0-9]+$/.test(createdMs ?? '')) continue;
    const list = byRepo.get(repo) ?? [];
    list.push({ branch, newestTaskMs: Number(createdMs) });
    byRepo.set(repo, list);
  }
  return byRepo;
}

function repoDir(db: string, repo: string, env: NodeJS.ProcessEnv): string {
  const path = repoResolvePath(db, repo, env);
  if (path === '') return '';
  const abs = repoPathAbs(db, path);
  return isDir(abs) ? abs : '';
}

/** `gh <args>`'s stdout in <cwd>, bounded to 10 s and the gate's deadline; null when it fails to start, exits non-zero or is cut off. */
async function ghStdout(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const limit = spawnLimit(GH_TIMEOUT_MS);
  const signal = limit === null ? undefined : limit.byDeadline ? deadlineSignal() : AbortSignal.timeout(limit.timeout);
  if (signal?.aborted) {
    noteSpawn(limit, { error: Object.assign(new Error('gh timed out'), { code: 'ETIMEDOUT' }), signal: null });
    return null;
  }
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let failure: Error | undefined;
    let done = false;
    const finish = (code: number | null, killedBy: NodeJS.Signals | null): void => {
      if (done) return;
      done = true;
      noteSpawn(limit, { error: failure, signal: killedBy });
      resolve(failure || killedBy !== null || code !== 0 ? null : Buffer.concat(chunks).toString('utf8'));
    };
    try {
      const child = spawn('gh', args, { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], signal });
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stdout.on('error', () => undefined);
      child.on('error', (err) => {
        child.stdout.destroy();
        if (err.name !== 'AbortError') {
          failure = err;
          finish(null, null);
          return;
        }
        // The abort runs outside the gate's deadline scope; 'close', which follows the kill, runs inside it and notes the cut.
        failure = Object.assign(new Error('gh timed out'), { code: 'ETIMEDOUT' });
      });
      child.on('close', (code, killedBy) => finish(code, killedBy));
    } catch (err) {
      // Some exec failures (EPERM from a sandbox, for one) throw here rather than emit 'error'.
      failure = err instanceof Error ? err : new Error(String(err));
      finish(null, null);
    }
  });
}

/** The merged PRs of `gh pr list` output, oldest merge first; null when it is no JSON array. */
export function mergedPrs(stdout: string): ForgePr[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const prs: ForgePr[] = [];
  for (const pr of parsed as unknown[]) {
    if (pr === null || typeof pr !== 'object') continue;
    const { headRefName, mergedAt } = pr as { headRefName?: unknown; mergedAt?: unknown };
    const mergedMs = typeof mergedAt === 'string' ? Date.parse(mergedAt) : Number.NaN;
    if (typeof headRefName !== 'string' || headRefName === '' || Number.isNaN(mergedMs)) continue;
    prs.push({ head: headRefName, mergedMs, json: JSON.stringify(pr) });
  }
  return prs.sort((a, b) => a.mergedMs - b.mergedMs);
}

async function closeRepo(db: string, dir: string, branches: readonly LiveBranch[], env: NodeJS.ProcessEnv): Promise<void> {
  const stdout = await ghStdout(PR_LIST_ARGS, dir, env);
  const prs = stdout === null ? null : mergedPrs(stdout);
  if (prs === null) return;
  const newest = new Map<string, number>();
  for (const b of branches) newest.set(b.branch, Math.max(b.newestTaskMs, newest.get(b.branch) ?? b.newestTaskMs));
  for (const pr of prs) {
    const createdMs = newest.get(pr.head);
    if (createdMs === undefined || pr.mergedMs <= createdMs) continue;
    recordMerge({ db, head: pr.head, prJson: pr.json, repoDir: dir, env, closedBy: GATE_NAME });
  }
}

async function closeForgeMergedRun(env: NodeJS.ProcessEnv): Promise<void> {
  const db = dbPath(env);
  if (db === null || !haveSqlite(env)) return;
  const byRepo = liveBranchesByRepo(db, env);
  if (byRepo.size === 0 || !commandOnPath('gh', env)) return;
  const byDir = new Map<string, LiveBranch[]>();
  for (const [repo, branches] of byRepo) {
    const dir = repoDir(db, repo, env);
    if (dir !== '') byDir.set(dir, [...(byDir.get(dir) ?? []), ...branches]);
  }
  for (const [dir, branches] of byDir) await closeRepo(db, dir, branches, env);
}

export const closeForgeMerged: Gate = async (_payload, env): Promise<GateResult> => {
  if ((env.TMB_DISABLE_CLOSE_FORGE_MERGED ?? '0') === '1') return ALLOW;
  try {
    await closeForgeMergedRun(env);
  } catch {
    /* advisory: every path allows */
  }
  return ALLOW;
};
