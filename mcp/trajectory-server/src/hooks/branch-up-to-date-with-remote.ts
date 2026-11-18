/**
 * PreToolUse gate (GH 1692): `git worktree add <path> <branch>` on a registered repo is denied while
 * <branch> is behind origin/<pr_target>, after one bounded fetch of
 * <pr_target>. No origin, no such branch or no origin/<pr_target> passes, and
 * TMB_ALLOW_STALE_BRANCH=1 bypasses. A git statement whose subcommand is not
 * literal text (gitSubcommandOf, GH 2641) is denied when the DB resolves.
 *
 * An agile task's branch is measured against its parent feature branch
 * instead (GH 2225): origin/<parent> after one bounded fetch, else the local
 * parent, so no origin does not pass it. A branch the DB records as a
 * feature branch (recordedFeatureBranch) passes, since it gathers merged
 * tasks and catches up with the target through `cli.js feature-branch sync`,
 * never by being recreated; the target branch itself is never admitted so.
 *
 * A command tree-sitter-bash cannot parse is denied with git-guards'
 * PARSE_REASON when the DB resolves. The payload is read with no jq on PATH,
 * and the DB through node:sqlite with no sqlite3 CLI on PATH.
 */
import { ALLOW, type Gate, type GateResult } from './gate.js';
import { PARSE_FIX, PARSE_REASON } from './git-guards.js';
import { denyResult } from './lib/deny.js';
import { ambiguousSubcommandReason, cmdStatements, gitBesideExpansion, gitSubcommandOf, prefilterPasses, stmtRepoRoot } from './cmd-analysis/index.js';
import { dbPath, denyDbUnavailable, GATE_READ_ERROR, gateRead, haveSqlite, sqlQuote, stripTrailingNewlines } from './lib/db.js';
import { gitOk, gitOut, gitRun } from './lib/git.js';
import { agileParentRef, gateResolveWorkflowMode, normalizeBase, recordedFeatureBranch } from './lib/git-refs.js';
import { jqCapture, jqInput } from './lib/jq-raw.js';
import { repoNameForRoot } from './lib/repo.js';
import { payloadCwdOf, statementRows } from './lib/statement-rows.js';

export const GATE_NAME = 'branch-up-to-date-with-remote';

const CREATES_BRANCH = [' -b ', ' -B ', ' --create-branch '];
const UNKNOWN_FIX = { allowed: 'git -C <path> worktree add <path> <branch>, the subcommand written literally' };

/** `$(git … rev-list --count … 2>/dev/null || echo "?")`. */
async function behindCount(root: string, range: string, env: NodeJS.ProcessEnv): Promise<string> {
  const r = await gitRun(root, ['rev-list', '--count', range], env);
  return stripTrailingNewlines(r.code === 0 ? r.stdout : `${r.stdout}?\n`);
}

export const branchUpToDateWithRemote: Gate = async (payload, env) => {
  const input = jqInput(payload);
  if (jqCapture(input, ['tool_name']) !== 'Bash') return ALLOW;
  if ((env.TMB_ALLOW_STALE_BRANCH ?? '') === '1') return ALLOW;
  const command = jqCapture(input, ['tool_input', 'command']);
  if (command === '' || (!prefilterPasses(command, (text) => text.includes('worktree')) && !gitBesideExpansion(command))) return ALLOW;

  const cwd = payloadCwdOf(input, env);
  const listed = await cmdStatements(command, cwd, env);
  if (!listed.ok) return dbPath(env) !== null && haveSqlite(env) ? denyResult(PARSE_REASON, PARSE_FIX) : ALLOW;
  const rows = statementRows(listed.statements);
  const subs = rows.map((row) => gitSubcommandOf(row));
  const unknown = rows[subs.indexOf(undefined)];
  if (unknown) {
    if (dbPath(env) === null || !haveSqlite(env)) return ALLOW;
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
  if (wtSub === '') return ALLOW;
  if (CREATES_BRANCH.some((flag) => ` ${wtSub} `.includes(flag))) return ALLOW;

  const branch = wtSub.slice(wtSub.lastIndexOf(' ') + 1);
  if (branch === '') return ALLOW;

  const root = await stmtRepoRoot(wtDir, cwd, env);
  if (root === '') return ALLOW;
  const db = dbPath(env, (line) => process.stderr.write(`${line}\n`));
  if (db === null) return ALLOW;
  if (!haveSqlite(env)) return ALLOW;

  const repoName = repoNameForRoot(db, root, env);
  const repo = sqlQuote(repoName);
  const row = gateRead(db, `SELECT 'repo|' || COALESCE(target_branch, '') FROM repos WHERE name = '${repo}' LIMIT 1;`, env);
  if (row === GATE_READ_ERROR) return { stdout: `${denyDbUnavailable(GATE_NAME, env)}\n`, code: 0 };
  if (row === '') return ALLOW;
  const targetBranch = row.startsWith('repo|') ? row.slice(5) : row;
  const prTarget = targetBranch || 'main';

  if (!await gitOk(root, ['rev-parse', '--verify', branch], env)) return ALLOW;
  if (branch !== prTarget) {
    const featureBranch = recordedFeatureBranch(db, repo, branch, env);
    if (featureBranch === GATE_READ_ERROR) return { stdout: `${denyDbUnavailable(GATE_NAME, env)}\n`, code: 0 };
    if (featureBranch) return ALLOW;
  }
  const hasOrigin = await gitOut(root, ['remote', 'get-url', 'origin'], env) !== '';
  const agileBase = await agileTaskBase(db, root, repoName, branch, targetBranch, hasOrigin, env);
  if (agileBase === GATE_READ_ERROR) return { stdout: `${denyDbUnavailable(GATE_NAME, env)}\n`, code: 0 };
  if (agileBase !== null) return await behindDeny(root, branch, agileBase, env);
  if (!hasOrigin) return ALLOW;
  await fetchBounded(root, prTarget, env);
  if (!await gitOk(root, ['rev-parse', '--verify', `origin/${prTarget}`], env)) return ALLOW;
  return await behindDeny(root, branch, `origin/${prTarget}`, env);
};

async function fetchBounded(root: string, branch: string, env: NodeJS.ProcessEnv): Promise<void> {
  await gitRun(root, ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=5', 'fetch', 'origin', branch, '--quiet'], env);
}

/**
 * The base of an agile task on <branch> (GH 2225): its parent feature branch's ref as
 * agileParentRef resolves it, after one bounded fetch of that branch when origin exists;
 * null for any other task, which keeps origin/<pr_target>; GATE_READ_ERROR when the DB
 * does not read.
 */
async function agileTaskBase(
  db: string,
  root: string,
  repoName: string,
  branch: string,
  targetBranch: string,
  hasOrigin: boolean,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const workflowMode = gateResolveWorkflowMode(db, repoName, env);
  if (workflowMode === GATE_READ_ERROR) return GATE_READ_ERROR;
  if (workflowMode !== 'agile') return null;
  const parent = gateRead(
    db,
    `SELECT COALESCE(parent_branch_id, '') FROM tasks
      WHERE branch_id = '${sqlQuote(branch)}' AND (repo = '${sqlQuote(repoName)}' OR COALESCE(repo, '') = '')
      ORDER BY id DESC LIMIT 1;`,
    env,
  );
  if (parent === GATE_READ_ERROR) return GATE_READ_ERROR;
  if (parent === '') return null;
  if (hasOrigin) await fetchBounded(root, await normalizeBase(root, parent, env), env);
  return await agileParentRef(root, targetBranch, parent, workflowMode, env);
}

/** The deny while <branch> is behind <baseRef>, else ALLOW. */
async function behindDeny(root: string, branch: string, baseRef: string, env: NodeJS.ProcessEnv): Promise<GateResult> {
  if (await gitOk(root, ['merge-base', '--is-ancestor', baseRef, branch], env)) return ALLOW;
  const behind = await behindCount(root, `${branch}..${baseRef}`, env);
  const fetch = baseRef.startsWith('origin/') ? `git fetch origin ${baseRef.slice('origin/'.length)} && ` : '';
  return denyResult(
    `BLOCKED: branch '${branch}' is behind ${baseRef} by ${behind} commit(s). bro must rebase the task branch onto the latest ${baseRef} (or recreate it) before SWE attaches a worktree. This catches stale-local-main bugs where the worktree starts from yesterday's commit and conflicts on push. Bypass: TMB_ALLOW_STALE_BRANCH=1 (e.g. offline work).`,
    { allowed: `git branch -D ${branch} && ${fetch}git branch ${branch} ${baseRef}, then the same worktree add` },
  );
}
