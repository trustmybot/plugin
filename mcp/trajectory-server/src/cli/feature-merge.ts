/**
 * `cli.js feature-merge` (GH 2225): bro lands a closed agile task on its
 * feature branch, the task's parent_branch_id, locally and with no PR.
 *
 *   node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" feature-merge <task_id>
 *
 * Every precondition must hold, else the command exits non-zero with the
 * branches and the task row unchanged:
 *   - the task is closed with workflow_mode 'agile' (else exit 3);
 *   - its parent_branch_id is set; it is neither the repo's target branch
 *     (repos.target_branch, else the remote default) nor one of its
 *     protected_branches; it names a local branch; no worktree has that
 *     branch checked out; and the task has verification[] (else exit 4).
 * When the feature tip is an ancestor of commit_sha, the feature branch
 * fast-forwards to commit_sha. Otherwise commit_sha is rebased onto the
 * feature tip in a temporary worktree and verification[] runs there, recorded
 * as a verification_runs row, as `cli.js integrate` does (TaskRebase). On a
 * pass the feature branch and the task branch (when it still exists) move to
 * the rebased SHA in one git ref transaction, then tasks.commit_sha moves to
 * it and a bro review_queued row names it, so the task stays queued for the
 * grouped review (AGILE_QUEUED_SQL) at its new commit.
 * Every exit-0 run writes one bro feature_branch_merged audit row; when that
 * DB write fails the refs are moved back and the command exits 4.
 * The command never pushes: bro pushes the feature branch through the guarded
 * `git push`.
 * stdout carries only the SHA now at the feature tip; progress and failures go to stderr.
 * Exit 0 = merged, 1 = verification failed, 2 = conflict or patch drift,
 * 3 = not a closed agile task, 4 = usage error or a precondition not met.
 */
import { type AuditEventType, isAuditEventWritableBy } from '../audit-events.js';
import { nowIso } from '../hooks/lib/audit.js';
import { dbPath, GATE_READ_ERROR, gateRead, sqlInt, sqlQuote } from '../hooks/lib/db.js';
import { commandSubstitution } from '../hooks/lib/project-env.js';
import type { CliIo } from './fallback-db.js';
import { Exit, runTaskRebase, TaskRebase } from './integrate.js';

interface RefMove {
  ref: string;
  from: string;
  to: string;
}

interface BroAuditRow {
  eventType: AuditEventType;
  summary: string;
  content: object;
  now: string;
  /** The SQL condition the INSERT ... SELECT runs under. */
  guard: string;
}

class FeatureMerge extends TaskRebase {
  private featureBranch = '';
  private featureTip = '';

  constructor(env: NodeJS.ProcessEnv, io: CliIo) {
    super(env, io, 'feature-merge');
  }

  /** Applies <moves> as one `git update-ref --stdin` transaction, each guarded on its old value. */
  private moveRefs(moves: readonly RefMove[], message: string): boolean {
    const lines = moves.map(({ ref, from, to }) => `update ${ref} ${to} ${from}`);
    return this.git(this.repoRoot, ['update-ref', '-m', message, '--stdin'], { input: `${lines.join('\n')}\n` }).ok;
  }

  private undo(moves: readonly RefMove[]): boolean {
    return this.moveRefs(
      moves.map(({ ref, from, to }) => ({ ref, from: to, to: from })),
      `cli.js feature-merge: undo task ${this.taskId}`,
    );
  }

  /** One bro audit row as an INSERT ... SELECT guarded by <guard>; bro writes it as the review_queued rows of bro_atomic_close are. */
  private broAuditSql({ eventType, summary, content, now, guard }: BroAuditRow): string {
    if (!isAuditEventWritableBy(eventType, 'bro')) this.die(4, `audit event ${eventType} does not list bro as a writer`);
    const issue = sqlInt(this.issueId);
    return (
      'INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, repo, created_at) ' +
      `SELECT ${issue}, '${sqlQuote(this.branch)}', 'bro', '${eventType}', '${sqlQuote(summary)}', '${sqlQuote(JSON.stringify(content))}', ` +
      `(SELECT repo FROM issues WHERE id = ${issue}), '${now}' WHERE ${guard};`
    );
  }

  /**
   * The one transaction that records the merge: the feature_branch_merged row
   * and, for a rebase, tasks.commit_sha moved to <sha> (only while it still
   * names the task's old commit) with a review_queued row for <sha>. Each
   * insert is guarded on the statement before it changing one row, so it is
   * all or none, and the final changes() is 1 only when all of it applied.
   */
  private mergeSql(sha: string, rebased: boolean): string {
    const now = nowIso();
    const taskId = Number(this.taskId);
    const merged = this.broAuditSql({
      eventType: 'feature_branch_merged',
      summary: `task ${this.taskId} merged into ${this.featureBranch} at ${sha}`,
      content: { task_id: taskId, feature_branch: this.featureBranch, commit_sha: sha, rebased },
      now,
      guard: rebased ? 'changes() = 1' : '1',
    });
    const queued = this.broAuditSql({
      eventType: 'review_queued',
      summary: `Task ${this.taskId} rebased onto ${this.featureBranch}, queued for review`,
      content: { task_id: taskId, commit_sha: sha },
      now,
      guard: 'changes() = 1',
    });
    return rebased
      ? `UPDATE tasks SET commit_sha = '${sqlQuote(sha)}', updated_at = '${now}' WHERE id = ${this.taskId} AND commit_sha = '${sqlQuote(this.commitSha)}';
${queued}
${merged}
SELECT changes();`
      : `${merged}
SELECT changes();`;
  }

  /** Moves <moves>, records the merge and prints <sha>; on a failed DB write the refs move back and the run exits 4. */
  private land(sha: string, rebased: boolean, moves: readonly RefMove[]): number {
    const sql = this.mergeSql(sha, rebased);
    if (!this.moveRefs(moves, `cli.js feature-merge: task ${this.taskId} into ${this.featureBranch}`)) {
      this.die(4, `git update-ref of ${moves.map((m) => m.ref).join(', ')} failed; ${this.featureBranch} and the DB are unchanged`);
    }
    const r = this.record(sql);
    if (!r.ok || commandSubstitution(r.stdout) !== '1') {
      const undone = this.undo(moves) ? 'moved back' : `left at ${sha}, and moving them back failed`;
      this.die(4, `recording the merge of task ${this.taskId} failed; the refs are ${undone}`);
    }
    this.say(`${this.featureBranch} -> ${sha}${rebased ? ` (verification run #${this.runId} passed)` : ' (fast-forward)'}`);
    this.io.out(`${sha}\n`);
    return 0;
  }

  async run(argv: readonly string[]): Promise<number> {
    if (argv.length !== 1) this.die(4, 'usage: cli.js feature-merge <task_id>');
    this.taskId = sqlInt(argv[0]);
    if (this.taskId === '') this.die(4, `task_id must be a number, got '${argv[0]}'`);
    const db = dbPath(this.env);
    if (db === null) this.die(4, 'no trajectory DB resolved (set TRAJECTORY_DB_PATH or CLAUDE_PROJECT_DIR)');
    this.db = db;

    const row = gateRead(
      db,
      `SELECT 'task' || char(10) || status || char(10) || COALESCE(workflow_mode, '') || char(10) || COALESCE(repo, '') || char(10) || COALESCE(branch_id, '') || char(10) || COALESCE(commit_sha, '') || char(10) || issue_id || char(10) || COALESCE(parent_branch_id, '')
  FROM tasks WHERE id = ${this.taskId};`,
      this.env,
    );
    if (row === GATE_READ_ERROR) this.die(4, `trajectory DB read failed: ${db}`);
    if (row === '') this.die(4, `no task ${this.taskId}`);
    const [, status = '', mode = '', taskRepo = '', branch = '', commitSha = '', issueId = '', parent = ''] = row.split('\n');
    if (status !== 'closed' || mode !== 'agile') {
      this.die(3, `task ${this.taskId} is not a closed agile task (status '${status}', workflow_mode '${mode}')`);
    }
    this.branch = branch;
    this.issueId = issueId;
    if (branch === '') this.die(4, `task ${this.taskId} has no branch_id`);
    if (commitSha === '') this.die(4, `task ${this.taskId} has no commit_sha`);
    if (parent === '') this.die(4, `task ${this.taskId} has no parent_branch_id, so no feature branch`);
    this.featureBranch = parent;
    this.base = parent;
    this.baseLabel = parent;

    await this.resolveRepo(taskRepo);
    await this.sharedBaseTarget(parent, 'feature branch');
    const featureRef = `refs/heads/${parent}`;
    if (!this.hasRef(featureRef)) this.die(4, `feature branch '${parent}' does not exist in ${this.repoRoot}`);
    const holder = this.branchHolder(parent);
    if (holder !== '') this.die(4, `feature branch '${parent}' is checked out at ${holder}; switch that worktree off it and run cli.js feature-merge again`);
    const commands = this.verificationCommands();

    this.commitSha = this.revParse(this.repoRoot, `${commitSha}^{commit}`);
    if (this.commitSha === '') this.die(4, `commit_sha of task ${this.taskId} is not a commit in ${this.repoRoot}`);
    this.featureTip = this.revParse(this.repoRoot, `${featureRef}^{commit}`);
    this.baseSha = this.featureTip;

    if (this.g(['merge-base', '--is-ancestor', this.featureTip, this.commitSha]).ok) {
      return this.land(this.commitSha, false, [{ ref: featureRef, from: this.featureTip, to: this.commitSha }]);
    }

    if (!this.branchMovable()) throw new Exit(4);
    const taskTip = this.tip;
    const { newSha } = await this.rebaseAndVerify(commands);

    if (!this.branchMovable()) this.die(4, `verification passed (run #${this.runId}) but ${branch} cannot be moved; the rebased commit is ${newSha}`);
    if (this.tip !== taskTip) this.die(4, `${branch} moved during the merge (${taskTip} -> ${this.tip}); left as is`);
    const nowHolder = this.branchHolder(parent);
    if (nowHolder !== '') this.die(4, `verification passed (run #${this.runId}) but ${parent} is now checked out at ${nowHolder}; the rebased commit is ${newSha}`);
    const nowTip = this.revParse(this.repoRoot, `${featureRef}^{commit}`);
    if (nowTip !== this.featureTip) this.die(4, `${parent} moved during the merge (${this.featureTip} -> ${nowTip}); left as is`);

    const moves: RefMove[] = [{ ref: featureRef, from: this.featureTip, to: newSha }];
    if (taskTip !== '') moves.push({ ref: `refs/heads/${branch}`, from: taskTip, to: newSha });
    return this.land(newSha, true, moves);
  }
}

export async function featureMerge(argv: readonly string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  return runTaskRebase(new FeatureMerge(env, io), argv);
}
