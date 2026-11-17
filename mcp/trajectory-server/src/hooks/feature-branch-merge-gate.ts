/**
 * PreToolUse(Bash) gate (GH 2225), born in TypeScript: an agile feature
 * branch is proposed for merge only once the grouped review has settled every
 * task merged onto it. It judges only the statements prCreateOf recognises
 * as opening a PR or MR. The head is the one the statement names (`--head` /
 * `-H`, glab's `--source-branch` / `-s`, a `gh api` `head=` field or a graphql
 * `headRefName`), else the branch checked out in the statement's dir, resolved
 * as git-guards resolves it. A head is a feature branch when some task's parent_branch_id
 * names it and a bro feature_branch_merged row names it as feature_branch; the
 * statement is denied while a task such a row names for that branch, in the
 * repo the statement runs in, is pending review (AGILE_PENDING_REVIEW_SQL, the
 * set review_queue lists): queued and unsettled, or reopened since its fold.
 * Everything else is allowed: another command, a head that is no feature
 * branch, a head that cannot be told, and a missing DB or sqlite.
 */
import { statSync } from 'node:fs';
import { ALLOW, type Gate, type GateResult } from './gate.js';
import { cmdStatements, cwdState, payloadCwd, prefilterPasses } from './cmd-analysis/index.js';
import { dbPath, haveSqlite, sqliteRo, sqlQuote, stripTrailingNewlines } from './lib/db.js';
import { gitOut, isDir } from './lib/git.js';
import { repoGitRoot, repoNameForRoot } from './lib/repo.js';
import { denyResult } from './lib/deny.js';
import { jqAlternatives } from './lib/jq.js';
import { type PrCreate, prCreateOf } from './lib/pr-create.js';
import { AGILE_PENDING_REVIEW_SQL, featureBranchTaskSql } from '../review-sql.js';

export const GATE_NAME = 'feature-branch-merge-gate';

const NEEDS_GATE = /(^|[^A-Za-z0-9_.-])(gh|glab)([ \t\n\v\f\r]|$)/;

/** The head <create> names; gh's `owner:branch` form names the branch after the colon, which git refnames never hold. */
function namedHead(create: PrCreate): string {
  return create.head.slice(create.head.lastIndexOf(':') + 1);
}

async function checkedOutBranch(dir: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const resolved = dir === '-' ? await cwdState(cwd, env, { unresolved: true }) : dir;
  if (resolved === '-' || resolved === '?' || !isDir(resolved)) return '';
  return await gitOut(resolved, ['branch', '--show-current'], env);
}

/** The repos.name of the repo the statement runs in, "" when none is registered; any checkout of it names the same repo. */
async function statementRepo(db: string, dir: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const where = dir === '-' || dir === '?' ? cwd : dir;
  return repoNameForRoot(db, await repoGitRoot(where, env), env);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The ids of the tasks still pending review on feature branch <head> of repo <repo>, empty when <head>
 * is no feature branch. An empty <repo> (the statement's repo is not registered) matches every repo.
 */
export function queuedFeatureTasks(db: string, head: string, repo: string, env: NodeJS.ProcessEnv): number[] {
  const branch = `'${sqlQuote(head)}'`;
  const out = sqliteRo(
    db,
    `SELECT t.id FROM tasks t
      WHERE EXISTS (SELECT 1 FROM tasks p WHERE p.parent_branch_id = ${branch})
        AND ${featureBranchTaskSql('t', branch, repo === '' ? 'NULL' : `'${sqlQuote(repo)}'`)} AND ${AGILE_PENDING_REVIEW_SQL}
      ORDER BY t.id;`,
    env,
  );
  return out.split('\n').filter((line) => /^[0-9]+$/.test(line)).map(Number);
}

function queuedDeny(head: string, taskIds: readonly number[]): GateResult {
  const ids = taskIds.join(', ');
  return denyResult(
    `BLOCKED: feature branch ${head} carries agile task(s) ${ids} still queued for the grouped review, so it cannot be proposed for merge yet. ` +
      `Either have a code-reviewer record a passing review_batch_record on tasks ${ids} at the branch head, ` +
      `or ask the Human whether to merge without that review and, on a Yes, record it with review_waive_record(feature_branch='${head}', human_answer=<their answer, verbatim>).`,
    { allowed: 'the same PR or MR command, once review_batch_record passed or review_waive_record recorded the Human\'s waiver' },
  );
}

export const featureBranchMergeGate: Gate = async (payload, env) => {
  const command = stripTrailingNewlines(jqAlternatives(payload, [['tool_input', 'command']]).replace(/\0/g, ''));
  if (!prefilterPasses(command, (text) => NEEDS_GATE.test(text))) return ALLOW;
  const db = dbPath(env) ?? '';
  if (db === '' || !isFile(db) || !haveSqlite(env)) return ALLOW;
  const cwd = payloadCwd(payload, env);
  const listed = await cmdStatements(command, cwd, env);
  if (!listed.ok) return ALLOW;
  for (const { dir, stmt } of listed.statements) {
    const create = prCreateOf(stmt);
    if (create === null) continue;
    const head = namedHead(create) ||(await checkedOutBranch(dir, cwd, env));
    if (head === '') continue;
    const queued = queuedFeatureTasks(db, head, await statementRepo(db, dir, cwd, env), env);
    if (queued.length > 0) return queuedDeny(head, queued);
  }
  return ALLOW;
};
