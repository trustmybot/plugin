/**
 * `cli.js feature-branch` (GH 2225): bro cuts, syncs, drops and cleans up an
 * agile milestone feature branch with one command each.
 *
 *   node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" feature-branch cut <name> [--repo <repo>]
 *   node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" feature-branch sync <name> [--repo <repo>]
 *   node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" feature-branch drop <name> [--repo <repo>] [--delete-branch]
 *   node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" feature-branch cleanup <name> [--repo <repo>]
 *
 * The repo is --repo, else the registered repo cwd is in, else the sole
 * registered repo. Its target is repos.target_branch, else the remote
 * default; with an origin remote that target is fetched once (bounded, as
 * `cli.js integrate` fetches) and origin/<target> is the base, else the local
 * <target> is. <name> must pass `git check-ref-format --branch` and be neither
 * the target nor one of repos.protected_branches.
 *
 * cut creates refs/heads/<name> at the base; a ref already there is refused.
 * sync merges the base into <name> with a merge commit made in a temporary
 * detached worktree, then moves <name> with an update-ref guarded on its old
 * tip, so every prior feature commit stays reachable; a <name> the base is
 * already under is left as is. A <name> checked out in any worktree is
 * refused, as `cli.js feature-merge` refuses it; a conflict aborts the merge
 * and lists the conflicting paths.
 *
 * drop cancels the branch: in one transaction every task of the repo merged
 * onto <name> and still pending the grouped review moves to cancelled, and
 * one bro feature_branch_dropped audit row names them. It is refused while a
 * task of the branch (merged onto it, or whose parent_branch_id names it) is
 * live, and for a <name> that is neither a local branch nor carries a task.
 * <name> stays unless --delete-branch is passed; then it is deleted, guarded
 * on its tip, before the DB write and restored when that write fails.
 *
 * cleanup deletes <name> once its milestone PR merged: refused while <name>
 * is checked out in a worktree or, with an origin, while origin/<name> still
 * exists after a bounded `git fetch --prune origin`. It writes no DB.
 *
 * Only drop writes the DB, and nothing pushes: bro pushes the branch through
 * the guarded `git push`. stdout carries only the SHA the branch is (or, once
 * deleted, was) at; progress and failures go to stderr. The temporary worktree
 * is removed on every exit.
 * Exit 0 = done, 2 = merge conflict (branch unchanged),
 * 4 = usage error or a precondition not met (no ref created, moved or
 * deleted, and the DB unchanged).
 */
import { type AuditEventType, isAuditEventWritableBy } from '../audit-events.js';
import { nowIso } from '../hooks/lib/audit.js';
import { dbPath, GATE_READ_ERROR, gateRead, sqlQuote } from '../hooks/lib/db.js';
import { commandSubstitution, shellPwd } from '../hooks/lib/project-env.js';
import { repoGitRoot, repoNameForRoot } from '../hooks/lib/repo.js';
import { AGILE_PENDING_REVIEW_SQL, featureBranchTaskSql } from '../review-sql.js';
import { sqlText, taskStatusMoveSql } from '../task-status.js';
import { LIVE, sqlList } from '../task-states.js';
import type { CliIo } from './fallback-db.js';
import { runTaskRebase, TaskRebase } from './integrate.js';

const USAGE = 'usage: cli.js feature-branch <cut|sync|drop|cleanup> <name> [--repo <repo>] [--delete-branch (drop only)]';
const ACTIONS: readonly string[] = ['cut', 'sync', 'drop', 'cleanup'];
const LIVE_STATUSES = `(${sqlList(LIVE)})`;
const DROPPED_EVENT: AuditEventType = 'feature_branch_dropped';
const FETCH_TIMEOUT_MS = 60_000;

interface Args {
  action: string;
  name: string;
  repo: string;
  deleteBranch: boolean;
}

class FeatureBranch extends TaskRebase {
  private baseRef = '';

  constructor(env: NodeJS.ProcessEnv, io: CliIo) {
    super(env, io, 'feature-branch');
  }

  private parseArgs(argv: readonly string[]): Args {
    const positional: string[] = [];
    let repo = '';
    let deleteBranch = false;
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === '--repo') {
        repo = argv[i + 1] ?? '';
        if (repo === '') this.die(4, USAGE);
        i += 1;
      } else if (argv[i] === '--delete-branch') {
        deleteBranch = true;
      } else {
        positional.push(argv[i]);
      }
    }
    const [action = '', name = ''] = positional;
    if (positional.length !== 2 || !ACTIONS.includes(action)) this.die(4, USAGE);
    if (deleteBranch && action !== 'drop') this.die(4, USAGE);
    return { action, name, repo, deleteBranch };
  }

  /** Exit 4 unless <name> is a valid branch name as written; `--branch` would expand `@{-1}` to another branch. */
  private checkName(name: string): void {
    const r = this.git(this.repoRoot, ['check-ref-format', '--branch', name]);
    if (!r.ok || r.out !== name) this.die(4, `'${name}' is not a valid branch name`);
  }

  /** Fetches <target> once when origin exists and sets baseRef to origin/<target>, else the local <target>; returns its sha. */
  private resolveBaseSha(target: string): string {
    if (this.hasOrigin()) {
      this.fetchBase('origin', target);
      this.baseRef = `origin/${target}`;
    } else {
      this.baseRef = target;
    }
    const sha = this.revParse(this.repoRoot, `${this.baseRef}^{commit}`);
    if (sha === '') this.die(4, `${this.baseRef} does not resolve in ${this.repoRoot}`);
    return sha;
  }

  private hasOrigin(): boolean {
    return this.g(['remote', 'get-url', 'origin']).ok;
  }

  private cut(name: string, baseSha: string): number {
    const created = this.git(this.repoRoot, ['update-ref', '-m', `cli.js feature-branch: cut ${name} at ${this.baseRef}`, `refs/heads/${name}`, baseSha, '']);
    if (!created.ok) this.die(4, `git update-ref of refs/heads/${name} failed; no branch created: ${created.err.trim()}`);
    this.say(`${name} -> ${baseSha} (cut at ${this.baseRef})`);
    this.io.out(`${baseSha}\n`);
    return 0;
  }

  private sync(name: string, baseSha: string): number {
    const ref = `refs/heads/${name}`;
    const tip = this.revParse(this.repoRoot, `${ref}^{commit}`);
    if (this.g(['merge-base', '--is-ancestor', baseSha, tip]).ok) {
      this.say(`${name} already contains ${this.baseRef} (${baseSha})`);
      this.io.out(`${tip}\n`);
      return 0;
    }

    this.openTempWorktree(name.replaceAll('/', '-'), tip);
    this.say(`merging ${this.baseRef} (${baseSha}) into ${name} (${tip}) in ${this.wt}`);
    const message = `Merge ${this.baseRef} into ${name}`;
    if (!this.gitLoud(this.wt, ['merge', '--no-ff', '--no-edit', '-m', message, baseSha], { ...this.env, GIT_EDITOR: 'true' })) {
      const conflicted = this.git(this.wt, ['diff', '--name-only', '--diff-filter=U']).out;
      this.git(this.wt, ['merge', '--abort']);
      if (conflicted === '') this.die(4, `merging ${this.baseRef} into ${name} failed; ${name} is unchanged`);
      this.die(2, `merging ${this.baseRef} into ${name} conflicted; aborted, ${name} is unchanged. Conflicting paths:\n${conflicted}`);
    }
    const merged = this.revParse(this.wt, 'HEAD');
    if (merged === '') this.die(4, 'cannot read the merge commit');

    const holder = this.branchHolder(name);
    if (holder !== '') this.die(4, `${name} is now checked out at ${holder}; the merge commit is ${merged}, ${name} is unchanged`);
    const moved = this.git(this.repoRoot, ['update-ref', '-m', `cli.js feature-branch: sync ${name} with ${this.baseRef}`, ref, merged, tip]);
    if (!moved.ok) this.die(4, `${name} moved during the sync, or update-ref failed; left as is, the merge commit is ${merged}: ${moved.err.trim()}`);
    this.say(`${name} -> ${merged} (merged ${this.baseRef})`);
    this.io.out(`${merged}\n`);
    return 0;
  }

  /** A task <alias> of this repo on <name>: merged onto it by feature-merge, or headed there by its parent_branch_id. */
  private onBranchSql(alias: string, name: string): string {
    const branch = `'${sqlQuote(name)}'`;
    const repo = `'${sqlQuote(this.repoName)}'`;
    return `${alias}.repo = ${repo} AND (${featureBranchTaskSql(alias, branch, repo)} OR ${alias}.parent_branch_id = ${branch})`;
  }

  /** A task t of this repo merged onto <name> and still pending the grouped review. */
  private queuedSql(name: string): string {
    const repo = `'${sqlQuote(this.repoName)}'`;
    return `t.repo = ${repo} AND ${featureBranchTaskSql('t', `'${sqlQuote(name)}'`, repo)} AND ${AGILE_PENDING_REVIEW_SQL}`;
  }

  private noLiveTaskSql(name: string): string {
    return `NOT EXISTS (SELECT 1 FROM tasks l WHERE ${this.onBranchSql('l', name)} AND l.status IN ${LIVE_STATUSES})`;
  }

  /** The count of tasks on <name> and the ids of its live ones; exit 4 when the DB read fails. */
  private branchTasks(name: string): { total: number; live: string } {
    const row = gateRead(
      this.db,
      `SELECT 'tasks' || char(10) || COUNT(*) || char(10) || COALESCE(group_concat(CASE WHEN l.status IN ${LIVE_STATUSES} THEN l.id END, ' '), '')
  FROM (SELECT l.id, l.status FROM tasks l WHERE ${this.onBranchSql('l', name)} ORDER BY l.id) l;`,
      this.env,
    );
    if (row === GATE_READ_ERROR || row === '') this.die(4, `trajectory DB read failed: ${this.db}`);
    const [, total = '0', live = ''] = row.split('\n');
    return { total: Number(total), live };
  }

  /**
   * One transaction: the feature_branch_dropped row naming the queued tasks,
   * then those tasks moved to cancelled, each guarded on no live task being on
   * the branch. Prints whether the row was written, then its content_json.
   */
  private dropSql(name: string): string {
    if (!isAuditEventWritableBy(DROPPED_EVENT, 'bro')) this.die(4, `audit event ${DROPPED_EVENT} does not list bro as a writer`);
    const now = nowIso();
    const branch = sqlQuote(name);
    const repo = sqlQuote(this.repoName);
    const issue = `COALESCE((SELECT t.issue_id FROM tasks t WHERE ${this.queuedSql(name)} ORDER BY t.id LIMIT 1),
    (SELECT l.issue_id FROM tasks l WHERE ${this.onBranchSql('l', name)} ORDER BY l.id LIMIT 1), -1)`;
    const taskIds = `(SELECT json_group_array(id) FROM (SELECT t.id FROM tasks t WHERE ${this.queuedSql(name)} ORDER BY t.id))`;
    // The row this drop writes, found again after the event inserts move last_insert_rowid().
    const droppedRow = `(SELECT MAX(a.id) FROM audit a WHERE a.event_type = 'feature_branch_dropped' AND a.branch_id = '${branch}' AND a.created_at = '${now}')`;
    const cancelQueued = taskStatusMoveSql({
      status: 'cancelled',
      event: 'branch_dropped',
      cause: 'feature_branch_dropped',
      role: 'bro',
      record: { kind: 'audit', id: sqlText(droppedRow) },
      key: `feature-branch-drop:${name}:${now}`,
      at: now,
      alias: 't',
      set: { updated_at: now },
      where: `${this.queuedSql(name)} AND ${this.noLiveTaskSql(name)}`,
    });
    return `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, repo, created_at)
  SELECT ${issue}, '${branch}', 'bro', '${DROPPED_EVENT}', '${sqlQuote(`feature branch ${name} dropped; its queued tasks cancelled`)}',
    json_object('feature_branch', '${branch}', 'repo', '${repo}', 'task_ids', json(${taskIds})), '${repo}', '${now}'
  WHERE ${this.noLiveTaskSql(name)};
SELECT changes();
${cancelQueued};
SELECT content_json FROM audit WHERE id = ${droppedRow};`;
  }

  private drop(name: string, deleteBranch: boolean): number {
    if (this.repoName === '') this.die(4, `${this.repoRoot} is not a registered repo; its tasks cannot be matched`);
    const ref = `refs/heads/${name}`;
    const tip = this.revParse(this.repoRoot, `${ref}^{commit}`);
    const { total, live } = this.branchTasks(name);
    if (tip === '' && total === 0) this.die(4, `feature branch '${name}' is unknown in ${this.repoName}: no local branch and no task on it`);
    if (live !== '') this.die(4, `feature branch '${name}' has live tasks (${live}); settle them first, nothing was dropped`);

    const deleting = deleteBranch && tip !== '';
    if (deleting) {
      const holder = this.branchHolder(name);
      if (holder !== '') this.die(4, `feature branch '${name}' is checked out at ${holder}; switch that worktree off it and run cli.js feature-branch drop again`);
      const deleted = this.git(this.repoRoot, ['update-ref', '-m', `cli.js feature-branch: drop ${name}`, '-d', ref, tip]);
      if (!deleted.ok) this.die(4, `git update-ref -d of ${ref} failed; ${name} and the DB are unchanged: ${deleted.err.trim()}`);
    }

    const r = this.record(this.dropSql(name));
    const [written = '', content = ''] = commandSubstitution(r.stdout).split('\n');
    if (!r.ok || written !== '1') {
      const restored = !deleting || this.git(this.repoRoot, ['update-ref', '-m', `cli.js feature-branch: restore ${name}`, ref, tip, '']).ok;
      const branchState = restored ? `${name} is unchanged` : `${name} was deleted at ${tip} and restoring it failed`;
      this.die(4, `recording the drop of '${name}' failed${r.ok ? ' (a task of the branch went live)' : ''}; ${branchState}, the DB is unchanged`);
    }
    const ids = (JSON.parse(content) as { task_ids: number[] }).task_ids;
    this.say(`dropped ${name}; cancelled ${ids.length === 0 ? 'no task' : `task(s) ${ids.join(', ')}`}; ${deleting ? `deleted ${name}` : `${name} kept`}`);
    if (tip !== '') this.io.out(`${tip}\n`);
    return 0;
  }

  /** Exit 4 while origin/<name> still exists after one bounded prune fetch of origin. */
  private checkRemoteCopyGone(name: string): void {
    const override = Number(this.env.TMB_INTEGRATE_FETCH_TIMEOUT_MS);
    const timeoutMs = Number.isInteger(override) && override > 0 ? override : FETCH_TIMEOUT_MS;
    const r = this.git(this.repoRoot, ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=5', 'fetch', '-q', '--prune', 'origin'], {
      env: { ...this.env, GIT_TERMINAL_PROMPT: '0' },
      timeoutMs,
    });
    if (r.timedOut) this.die(4, `fetch of origin timed out after ${timeoutMs} ms; ${name} is unchanged`);
    if (!r.ok) this.die(4, `fetch of origin failed; ${name} is unchanged: ${r.err.trim()}`);
    if (this.hasRef(`refs/remotes/origin/${name}`)) {
      this.die(4, `origin/${name} still exists, so its milestone PR has not merged; ${name} is unchanged`);
    }
  }

  private removeMerged(name: string): number {
    const ref = `refs/heads/${name}`;
    const tip = this.revParse(this.repoRoot, `${ref}^{commit}`);
    if (tip === '') this.die(4, `feature branch '${name}' does not exist in ${this.repoRoot}`);
    const holder = this.branchHolder(name);
    if (holder !== '') this.die(4, `feature branch '${name}' is checked out at ${holder}; switch that worktree off it and run cli.js feature-branch cleanup again`);
    if (this.hasOrigin()) this.checkRemoteCopyGone(name);
    const deleted = this.git(this.repoRoot, ['update-ref', '-m', `cli.js feature-branch: cleanup ${name}`, '-d', ref, tip]);
    if (!deleted.ok) this.die(4, `git update-ref -d of ${ref} failed; ${name} is unchanged: ${deleted.err.trim()}`);
    this.say(`deleted ${name} (was ${tip})`);
    this.io.out(`${tip}\n`);
    return 0;
  }

  async run(argv: readonly string[]): Promise<number> {
    const { action, name, repo, deleteBranch } = this.parseArgs(argv);
    const db = dbPath(this.env);
    if (db === null) this.die(4, 'no trajectory DB resolved (set TRAJECTORY_DB_PATH or CLAUDE_PROJECT_DIR)');
    this.db = db;
    const cwdRoot = repo === '' ? await repoGitRoot(shellPwd(this.env), this.env) : '';
    await this.resolveRepo(repo || (cwdRoot === '' ? '' : repoNameForRoot(db, cwdRoot, this.env)));

    this.checkName(name);
    this.branch = name;
    const target = await this.sharedBaseTarget(name, 'feature branch');
    this.base = target;
    if (action === 'drop') return this.drop(name, deleteBranch);
    if (action === 'cleanup') return this.removeMerged(name);
    const exists = this.hasRef(`refs/heads/${name}`);
    if (action === 'cut' && exists) this.die(4, `branch '${name}' already exists in ${this.repoRoot}`);
    if (action === 'sync') {
      if (!exists) this.die(4, `feature branch '${name}' does not exist in ${this.repoRoot}`);
      const holder = this.branchHolder(name);
      if (holder !== '') this.die(4, `feature branch '${name}' is checked out at ${holder}; switch that worktree off it and run cli.js feature-branch sync again`);
    }
    const baseSha = this.resolveBaseSha(target);
    return action === 'cut' ? this.cut(name, baseSha) : this.sync(name, baseSha);
  }
}

export async function featureBranch(argv: readonly string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  return runTaskRebase(new FeatureBranch(env, io), argv);
}
