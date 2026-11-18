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
 *     branch checked out; and the task has verification[] (else exit 4),
 *     except that a no-code task (no_code_class set) needs it only to rebase.
 * When the feature tip is an ancestor of commit_sha, the feature branch
 * fast-forwards to commit_sha. Otherwise commit_sha is rebased onto the
 * feature tip in a temporary worktree and verification[] runs there, recorded
 * as a verification_runs row, then the close lints run on the rebased SHA,
 * recorded as a lint_runs row (source integrate), as `cli.js integrate` does
 * (TaskRebase); a failing lint exits 1 with the feature branch unmoved. On a
 * pass tasks.commit_sha moves to the rebased SHA and, when the task had no
 * passing review (HAS_PASS_SQL), a bro review_queued row names it, so the task
 * stays queued for the grouped review (AGILE_QUEUED_SQL) at its new commit.
 * On either path the feature branch moves and the task branch is deleted in
 * one git ref transaction, each ref guarded on its old value. A task branch
 * that no longer exists is skipped; one checked out in a worktree is left in
 * place with a note on stderr; one at a commit that is neither commit_sha nor
 * a verified integration of it stops the run with exit 4 before any ref moves.
 * tasks.branch_id and the audit rows keep the branch name.
 * Every exit-0 run writes one bro feature_branch_merged audit row; when that
 * DB write fails the refs are moved back, the task branch restored, and the
 * command exits 4.
 * The command never pushes: bro pushes the feature branch through the guarded
 * `git push`.
 * stdout carries only the SHA now at the feature tip; progress and failures go to stderr.
 * Exit 0 = merged, 1 = verification or a close lint failed, 2 = conflict or patch drift,
 * 3 = not a closed agile task, 4 = usage error or a precondition not met.
 */
import { type AuditEventType, isAuditEventWritableBy } from '../audit-events.js';
import { nowIso } from '../hooks/lib/audit.js';
import { describeFailures, lintBaseSha, runCloseLints, runLabel, taskNoCodeClass } from '../hooks/lib/close-lints.js';
import { dbPath, GATE_READ_ERROR, gateRead, sqlInt, sqlQuote } from '../hooks/lib/db.js';
import { commandSubstitution } from '../hooks/lib/project-env.js';
import { HAS_PASS_SQL } from '../review-sql.js';
import { isStoredAgile } from '../stored-mode.js';
import { DONE, inGroup } from '../task-states.js';
import type { CliIo } from './fallback-db.js';
import { Exit, runTaskRebase, TaskRebase, type VerifiedRebase } from './integrate.js';

/** A guarded ref change: <from> '' creates the ref, <to> '' deletes it. */
interface RefMove {
  ref: string;
  from: string;
  to: string;
}

/** The task branch as the fold finds it: <holder> is the worktree that has it checked out, '' when none. */
interface TaskBranchState {
  tip: string;
  holder: string;
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
  /** Whether the task had a passing review (HAS_PASS_SQL) at its commit when the run read it. */
  private hasPass = false;

  constructor(env: NodeJS.ProcessEnv, io: CliIo) {
    super(env, io, 'feature-merge');
  }

  /** Applies <moves> as one `git update-ref --stdin` transaction, each guarded on its old value. */
  private moveRefs(moves: readonly RefMove[], message: string): boolean {
    const lines = moves.map(({ ref, from, to }) => {
      if (to === '') return `delete ${ref} ${from}`;
      if (from === '') return `create ${ref} ${to}`;
      return `update ${ref} ${to} ${from}`;
    });
    return this.git(this.repoRoot, ['update-ref', '-m', message, '--stdin'], { input: `${lines.join('\n')}\n` }).ok;
  }

  private undo(moves: readonly RefMove[]): boolean {
    return this.moveRefs(
      moves.map(({ ref, from, to }) => ({ ref, from: to, to: from })),
      `cli.js feature-merge: undo task ${this.taskId}`,
    );
  }

  /**
   * Reads the task branch. A checked-out branch is reported, not judged, since
   * the fold leaves it in place; an unheld one must be absent, at commit_sha or
   * at a verified integration of it, else the run exits 4.
   */
  private taskBranchState(): TaskBranchState {
    const holder = this.branchHolder();
    if (holder !== '') return { tip: this.revParse(this.repoRoot, `refs/heads/${this.branch}^{commit}`), holder };
    if (!this.branchMovable()) throw new Exit(4);
    return { tip: this.tip, holder: '' };
  }

  /** The delete of the task branch, or none when it is absent or checked out (said on stderr). */
  private taskBranchDeletes({ tip, holder }: TaskBranchState): RefMove[] {
    if (holder !== '') {
      this.say(`${this.branch} is checked out at ${holder}, so it is left in place; delete it once that worktree is off it`);
      return [];
    }
    return tip === '' ? [] : [{ ref: `refs/heads/${this.branch}`, from: tip, to: '' }];
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
   * names the task's old commit) with a review_queued row for <sha> unless the
   * task had a pass. Each insert is guarded on the statement before it
   * changing one row, so it is all or none, and the final changes() is 1 only
   * when all of it applied.
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
${this.hasPass ? '' : queued}
${merged}
SELECT changes();`
      : `${merged}
SELECT changes();`;
  }

  /**
   * Runs the close lints on the rebased SHA in the temporary worktree with what
   * verification left of the budget, recorded as a lint_runs row, as `cli.js
   * integrate` does; a lint that fails or cannot run exits 1 before any ref moves.
   */
  private async lintRebased({ newSha, timeoutS, startS, toolchainPath }: VerifiedRebase): Promise<void> {
    const lintBase = (await lintBaseSha(this.wt, this.db, this.taskId, newSha, this.env)) || this.baseSha;
    const left = timeoutS - (Math.floor(Date.now() / 1000) - startS);
    const lints = await runCloseLints(this.wt, newSha, lintBase, left, { ...this.env, PATH: toolchainPath }, {
      db: this.db,
      taskId: this.taskId,
      source: 'integrate',
    });
    if (typeof lints === 'string') this.die(1, `close lints did not run on ${newSha}: ${lints}; ${this.featureBranch} unmoved`);
    if (lints.exitCode !== 0) {
      this.io.err(`${describeFailures(lints)}\n`);
      this.die(1, `close lints failed on ${newSha} (${runLabel(lints)}); ${this.featureBranch} unmoved`);
    }
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
      `SELECT 'task' || char(10) || status || char(10) || COALESCE(workflow_mode, '') || char(10) || COALESCE(repo, '') || char(10) || COALESCE(branch_id, '') || char(10) || COALESCE(commit_sha, '') || char(10) || issue_id || char(10) || COALESCE(parent_branch_id, '') || char(10) || ${HAS_PASS_SQL}
  FROM tasks t WHERE t.id = ${this.taskId};`,
      this.env,
    );
    if (row === GATE_READ_ERROR) this.die(4, `trajectory DB read failed: ${db}`);
    if (row === '') this.die(4, `no task ${this.taskId}`);
    const [, status = '', mode = '', taskRepo = '', branch = '', commitSha = '', issueId = '', parent = '', hasPass = ''] = row.split('\n');
    this.hasPass = hasPass === '1';
    if (!inGroup(DONE, status) || !isStoredAgile(mode)) {
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
    const noCodeClass = taskNoCodeClass(db, this.taskId, this.env);
    if (noCodeClass === GATE_READ_ERROR) this.die(4, `trajectory DB read failed: ${db}`);
    // A fast-forward re-verifies nothing, so a no-code task reads verification[] only once it has to rebase.
    const isNoCode = noCodeClass !== '';
    const codeCommands = isNoCode ? '' : this.verificationCommands();

    this.commitSha = this.revParse(this.repoRoot, `${commitSha}^{commit}`);
    if (this.commitSha === '') this.die(4, `commit_sha of task ${this.taskId} is not a commit in ${this.repoRoot}`);
    this.featureTip = this.revParse(this.repoRoot, `${featureRef}^{commit}`);
    this.baseSha = this.featureTip;

    const taskBranch = this.taskBranchState();
    if (this.g(['merge-base', '--is-ancestor', this.featureTip, this.commitSha]).ok) {
      return this.land(this.commitSha, false, [{ ref: featureRef, from: this.featureTip, to: this.commitSha }, ...this.taskBranchDeletes(taskBranch)]);
    }

    const verified = await this.rebaseAndVerify(isNoCode ? this.verificationCommands() : codeCommands);
    await this.lintRebased(verified);
    const { newSha } = verified;

    const nowTaskBranch = this.taskBranchState();
    if (nowTaskBranch.tip !== taskBranch.tip || nowTaskBranch.holder !== taskBranch.holder) {
      this.die(4, `${branch} moved or changed worktree during the merge (${taskBranch.tip || 'absent'} -> ${nowTaskBranch.tip || 'absent'}); left as is, the rebased commit is ${newSha}`);
    }
    const nowHolder = this.branchHolder(parent);
    if (nowHolder !== '') this.die(4, `verification passed (run #${this.runId}) but ${parent} is now checked out at ${nowHolder}; the rebased commit is ${newSha}`);
    const nowTip = this.revParse(this.repoRoot, `${featureRef}^{commit}`);
    if (nowTip !== this.featureTip) this.die(4, `${parent} moved during the merge (${this.featureTip} -> ${nowTip}); left as is`);

    return this.land(newSha, true, [{ ref: featureRef, from: this.featureTip, to: newSha }, ...this.taskBranchDeletes(nowTaskBranch)]);
  }
}

export async function featureMerge(argv: readonly string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  return runTaskRebase(new FeatureMerge(env, io), argv);
}
