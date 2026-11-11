/**
 * `cli.js integrate` (GH 1518, GH 1692): bro's post-review rebase of a task's
 * branch onto a moved base.
 *
 *   node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" integrate <task_id> <base>
 *
 * Run by bro from the main checkout, after bro's own verify and the code-reviewer
 * pass; on exit 0 bro pushes the printed SHA, because the pass carries over
 * to it (GH 2082).
 * The task's repo, branch_id, commit_sha and verification[] come from the
 * trajectory DB (TRAJECTORY_DB_PATH, else CLAUDE_PROJECT_DIR, else a walk
 * up from cwd).
 *   1. No passing review for the task's commit_sha (HAS_PASS_SQL: the newest
 *      verdict is a pass and one pass is at or after that commit's review
 *      anchor, REVIEW_ANCHOR_AT_SQL) → exit 3. A head integrate made keeps the
 *      anchor it carried, so a second integrate needs no new review unless a
 *      verdict since says otherwise.
 *   2. <base> is resolved to a sha (GH 2198). A local branch with an upstream
 *      has that upstream fetched; the local ref is used when it equals the
 *      upstream or is a fast-forward ahead of it, else the upstream is (one
 *      stderr line names both). A remote-tracking ref of a configured remote is
 *      fetched, then resolved. Any other base resolves as given, unfetched. A
 *      failed fetch, or one past 60 s (TMB_INTEGRATE_FETCH_TIMEOUT_MS overrides
 *      it, GH 2632) → exit 4, branch and DB unchanged. Every later step uses
 *      the resolved sha. That sha already an ancestor of commit_sha → print
 *      commit_sha, exit 0; nothing is recorded.
 *   3. A temporary worktree <repo>/.claude/worktrees/integrate-<task_id>.XXXXXX,
 *      detached at commit_sha, runs `git -c merge.renames=false rebase <base>`
 *      (no rename detection, GH 2356). A conflict is aborted
 *      → exit 2, branch and DB unchanged.
 *   4. The `git patch-id --stable` lists of the commits a rebase picks from
 *      commit_sha and from <rebased> (`rev-list --cherry-pick --right-only
 *      <base>...<sha>`: a commit whose patch is already in <base>, such as a
 *      squash-merged parent branch's, is skipped), both over every path, must
 *      match, else exit 2. No rebased commit left means the task's patch is
 *      already in <base> → exit 2.
 *      Each tracked dir holding a lockfile is an install root for the package
 *      dirs nearest beneath it. A root whose lockfile or any package.json in
 *      its group differs from the main checkout's byte for byte gets the
 *      lockfile's frozen install, run in that root (GH 3003); every other
 *      tracked package dir gets the main checkout's untracked node_modules
 *      linked in entry by entry (GH 1541). The first failed install → exit 1
 *      with the root, the command and its output tail on stderr, branch unmoved.
 *      When the worktree holds .config/tmb/worktree-setup.json (GH 2054), its
 *      commands run first; a failure → exit 1 with the failing command and its
 *      output tail on stderr, nothing recorded, branch unmoved.
 *      verification[] runs in the temporary worktree and is recorded as a
 *      verification_runs row (source manual, commit_sha = the rebased SHA).
 *      A failure → exit 1, branch unmoved. A pass moves refs/heads/<branch_id>
 *      to the rebased SHA, then, in one transaction, sets tasks.commit_sha to
 *      it (only while it still names the reviewed SHA) and writes a
 *      task_integrated audit row (task_id, reviewed_sha, review_anchor_at,
 *      commit_sha, base, run_id), the review anchor HAS_PASS_SQL reads. Its
 *      review_anchor_at is the anchor the reviewed SHA's pass was judged
 *      against, so that pass covers the integrated head (Gerrit's
 *      TRIVIAL_REBASE copyCondition: same patch-ids, passing run); then it
 *      prints the SHA. When that
 *      write fails the branch has moved but the task row still names the
 *      reviewed SHA → exit 4, and code-reviewer-preflight denies a review of
 *      the rebased SHA (sha_mismatch).
 *   5. The temporary worktree is removed on every exit. A run still open when
 *      the command exits (INT → 130, TERM → 143, or the failure it exits with)
 *      is finished with that exit code and its running command is killed; a
 *      finished run is not rewritten. A SIGKILL leaves the run open until a
 *      later run start sweeps it (exit 137) once it is past its budget + 60 s.
 * The branch is moved only when no worktree has it checked out and it still
 * points at commit_sha, or at a rebase of it with a passing recorded run.
 * The git-push-guard gate denies a push of a rebased task commit without such a run.
 *
 * Each verification command is bounded by what is left of the budget,
 * plugin_config.verification_timeout_s (default 900 s; TMB_VERIFICATION_TIMEOUT_S
 * overrides it), capped at 1800 s.
 * stdout carries only the SHA; progress and failures go to stderr.
 * Exit 0 = integrated, 1 = verification failed, 2 = conflict or patch drift,
 * 3 = no passing review, 4 = usage error or a precondition not met.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditSql, dbWrite, nowIso } from '../hooks/lib/audit.js';
import { dbPath, GATE_READ_ERROR, gateRead, sqliteRo, sqlInt, sqlQuote } from '../hooks/lib/db.js';
import { isDir } from '../hooks/lib/git.js';
import { keysInOrder } from '../hooks/lib/jq-key-order.js';
import { jsonStream } from '../hooks/lib/jq.js';
import { commandSubstitution, posixDirname } from '../hooks/lib/project-env.js';
import { repoGitRoot, repoPathByName, repoSinglePath } from '../hooks/lib/repo.js';
import { runCommandSql, runFinishSql, runStartSql } from '../hooks/lib/verification-runs.js';
import { joinToolchainPath, parseBudget, toolchainDirs } from '../hooks/swe-verification-gate.js';
import { HAS_PASS_SQL, REVIEW_ANCHOR_AT_SQL } from '../review-sql.js';
import { prepareWorktreeDeps } from '../utils/worktree-deps.js';
import { describeSetupFailure, runWorktreeSetup } from '../utils/worktree-setup.js';
import type { CliIo } from './fallback-db.js';

const FINISH_ATTEMPTS = 3;
const TAIL_LINES = 20;
const TIMED_OUT_CODE = 124;
const FETCH_TIMEOUT_MS = 60_000;
const RECORD_ENV = { TMB_DB_WRITE_TIMEOUT_MS: '5000', TMB_DB_WRITE_RUN_BUDGET_MS: '10000' } as const;
const MAX_BUFFER = 256 * 1024 * 1024;
const signals: Readonly<Record<string, number>> = osConstants.signals;

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
  timedOut: boolean;
}

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

function sleepS(seconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

/** `jq -r '.[]? | select(type == "string" and length > 0)'`; null when the input does not parse. */
function verificationCommands(json: string): string | null {
  const { values, complete } = jsonStream(json);
  if (!complete) return null;
  const out: string[] = [];
  for (const value of values) {
    if (value === null || typeof value !== 'object') continue;
    const items = Array.isArray(value) ? value : keysInOrder(value).map((k) => (value as Record<string, unknown>)[k]);
    for (const item of items) if (typeof item === 'string' && item !== '') out.push(item);
  }
  return commandSubstitution(out.join('\n'));
}

function lastLines(text: string, n: number): string {
  return text === '' ? '' : text.split('\n').slice(-n).join('\n');
}

class Integration {
  private db = '';
  private taskId = '';
  private issueId = '';
  private base = '';
  private branch = '';
  private reviewedSha = '';
  private reviewAnchorAt = '';
  private commitSha = '';
  private baseSha = '';
  private baseLabel = '';
  private repoRoot = '';
  private tip = '';
  private wt = '';
  private runId = '';
  private runOpen = false;
  private child: ChildProcess | null = null;
  private scratch = '';

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly io: CliIo,
  ) {}

  private say(text: string): void {
    this.io.err(`integrate: ${text}\n`);
  }

  private die(code: number, text: string): never {
    this.say(text);
    throw new Exit(code);
  }

  private git(dir: string, args: readonly string[], opts: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): GitResult {
    const r = spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: opts.env ?? this.env,
      input: opts.input,
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
      timeout: opts.timeoutMs,
    });
    const timedOut = r.error !== undefined && 'code' in r.error && r.error.code === 'ETIMEDOUT';
    return { ok: r.status === 0, out: commandSubstitution(r.stdout ?? ''), err: r.stderr ?? '', timedOut };
  }

  /** A git command whose output goes to stderr, as the .sh's `>&2`. */
  private gitLoud(dir: string, args: readonly string[], env?: NodeJS.ProcessEnv): boolean {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: env ?? this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.io.err(`${r.stdout ?? ''}${r.stderr ?? ''}`);
    return r.status === 0;
  }

  private g(args: readonly string[]): GitResult {
    return this.git(this.repoRoot, args);
  }

  private revParse(dir: string, rev: string): string {
    const r = this.git(dir, ['rev-parse', '--verify', '-q', rev]);
    return r.ok ? r.out : '';
  }

  private record(sql: string): { ok: boolean; stdout: string } {
    const r = dbWrite(this.db, sql, { caller: 'integrate', env: { ...this.env, ...RECORD_ENV } });
    if (!r.ok && r.error !== '') this.io.err(`${r.error}\n`);
    return { ok: r.ok, stdout: r.stdout };
  }

  /** Points tasks.commit_sha at <newSha> and writes its task_integrated anchor, both or neither; false when the task moved off the reviewed SHA. */
  private recordIntegrated(newSha: string): boolean {
    const now = nowIso();
    const content = JSON.stringify({
      task_id: Number(this.taskId),
      reviewed_sha: this.reviewedSha,
      review_anchor_at: this.reviewAnchorAt,
      commit_sha: newSha,
      base: this.base,
      run_id: Number(this.runId),
    });
    const audit = auditSql(
      {
        issueId: this.issueId,
        branchId: this.branch,
        fromNode: 'hook:integrate',
        eventType: 'task_integrated',
        summary: `task ${this.taskId} integrated onto ${this.base}: ${this.reviewedSha} -> ${newSha}`,
        contentJson: content,
      },
      'changes() = 1',
      { caller: 'integrate', env: this.env, now },
    );
    if (audit.code !== 0) {
      this.io.err(`${audit.error}\n`);
      return false;
    }
    const r = this.record(
      `UPDATE tasks SET commit_sha = '${sqlQuote(newSha)}', updated_at = '${now}' WHERE id = ${this.taskId} AND commit_sha = '${sqlQuote(this.reviewedSha)}';
${audit.sql}
SELECT changes();`,
    );
    return r.ok && commandSubstitution(r.stdout) === '1';
  }

  private finish(rc: number, timedOut: 0 | 1): boolean {
    for (let attempt = 1; attempt <= FINISH_ATTEMPTS; attempt += 1) {
      const s = runFinishSql('integrate', this.runId, rc, timedOut);
      if (s.code !== 0) {
        this.io.err(`${s.error}\n`);
        return false;
      }
      if (this.record(s.sql).ok) {
        this.runOpen = false;
        return true;
      }
      sleepS(attempt);
    }
    return false;
  }

  private recordCommand(ordinal: number, command: string, rc: number, elapsed: number, output: string): boolean {
    const s = runCommandSql('integrate', this.runId, ordinal, command, rc, String(elapsed), output, this.env);
    if (s.code !== 0) {
      this.io.err(`${s.error}\n`);
      return false;
    }
    return this.record(s.sql).ok;
  }

  /** Finishes a run left open, kills its command and removes the temporary worktree; safe to call twice. */
  cleanup(code: number): void {
    if (this.child?.pid !== undefined && this.child.exitCode === null && this.child.signalCode === null) {
      try {
        process.kill(-this.child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    if (this.runOpen) {
      const rc = code === 0 ? 1 : code;
      if (!this.finish(rc, 0)) this.say(`run #${this.runId} finish write failed on exit ${rc}`);
    }
    if (this.scratch !== '') rmSync(this.scratch, { recursive: true, force: true });
    this.scratch = '';
    if (this.wt === '') return;
    if (!this.g(['worktree', 'remove', '--force', this.wt]).ok) {
      rmSync(this.wt, { recursive: true, force: true });
      this.g(['worktree', 'prune']);
    }
    this.wt = '';
  }

  /** Runs <cmd> in the worktree, output captured, killed with its process group after <seconds>. */
  private execute(cmd: readonly string[], seconds: number, env: NodeJS.ProcessEnv): Promise<{ rc: number; fired: boolean; out: string }> {
    if (this.scratch === '') this.scratch = mkdtempSync(join(this.env.TMPDIR || tmpdir(), 'tmb-integrate-'));
    const outPath = join(this.scratch, 'out');
    return new Promise((done) => {
      const fd = openSync(outPath, 'w');
      let fired = false;
      let settled = false;
      const settle = (rc: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child = null;
        let out = '';
        try {
          out = commandSubstitution(readFileSync(outPath, 'utf8'));
        } catch {
          /* no output */
        }
        rmSync(outPath, { force: true });
        done({ rc, fired, out });
      };
      const child = spawn(cmd[0], cmd.slice(1), { cwd: this.wt, env: { ...env, PWD: this.wt }, stdio: ['ignore', fd, fd], detached: true });
      this.child = child;
      closeSync(fd);
      const timer = setTimeout(() => {
        fired = true;
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, seconds * 1000);
      child.on('error', () => settle(127));
      child.on('exit', (code, signal) => {
        if (fired) settle(TIMED_OUT_CODE);
        else settle(code ?? 128 + (signal !== null ? (signals[signal] ?? 0) : 0));
      });
    });
  }

  private branchHolder(): string {
    let wt = '';
    for (const line of this.g(['worktree', 'list', '--porcelain']).out.split('\n')) {
      if (line.startsWith('worktree ')) wt = line.slice('worktree '.length);
      if (line === `branch refs/heads/${this.branch}`) return wt;
    }
    return '';
  }

  /** True when no worktree holds the branch and its tip is commit_sha, a verified rebase of it, or absent; sets tip. */
  private branchMovable(): boolean {
    const holder = this.branchHolder();
    if (holder !== '') {
      this.say(`${this.branch} is checked out at ${holder}; remove that worktree (or switch it off the branch) and run cli.js integrate again`);
      return false;
    }
    this.tip = this.revParse(this.repoRoot, `refs/heads/${this.branch}^{commit}`);
    if (this.tip === '' || this.tip === this.commitSha) return true;
    const runs = gateRead(
      this.db,
      `SELECT COUNT(*) FROM verification_runs
    WHERE task_id = ${this.taskId} AND commit_sha = '${sqlQuote(this.tip)}' AND exit_code = 0 AND timed_out = 0;`,
      this.env,
    );
    if (runs === '' || runs === GATE_READ_ERROR || runs === '0') {
      this.say(`${this.branch} is at ${this.tip}, which is neither task ${this.taskId}'s reviewed commit nor a verified integration of it; refusing to move it`);
      return false;
    }
    return true;
  }

  private fetchBase(remote: string, branch: string): void {
    const override = Number(this.env.TMB_INTEGRATE_FETCH_TIMEOUT_MS);
    const timeoutMs = Number.isInteger(override) && override > 0 ? override : FETCH_TIMEOUT_MS;
    const r = this.git(this.repoRoot, ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=5', 'fetch', '-q', remote, branch], {
      env: { ...this.env, GIT_TERMINAL_PROMPT: '0' },
      timeoutMs,
    });
    if (r.timedOut) {
      this.die(4, `fetch of base '${this.base}' (${remote} ${branch}) timed out after ${timeoutMs} ms; ${this.branch} and the DB are unchanged`);
    }
    if (!r.ok) {
      this.die(4, `fetch of base '${this.base}' (${remote} ${branch}) failed; ${this.branch} and the DB are unchanged: ${r.err.trim()}`);
    }
  }

  private hasRef(ref: string): boolean {
    return this.g(['show-ref', '--verify', '-q', ref]).ok;
  }

  /** The base sha: a local branch with an upstream is fetched and loses to its upstream unless equal or ahead; a remote-tracking ref is fetched; anything else resolves as given. Sets baseLabel. */
  private resolveBase(): string {
    this.baseLabel = this.base;
    const local = `refs/heads/${this.base}`;
    if (this.hasRef(local)) {
      const upstream = this.g(['rev-parse', '--symbolic-full-name', `${this.base}@{upstream}`]);
      const remote = this.g(['config', '--get', `branch.${this.base}.remote`]).out;
      const merge = this.g(['config', '--get', `branch.${this.base}.merge`]).out;
      if (!upstream.ok || upstream.out === '' || remote === '' || merge === '') return this.revParse(this.repoRoot, `${local}^{commit}`);
      if (remote !== '.') this.fetchBase(remote, merge.replace(/^refs\/heads\//, ''));
      const localSha = this.revParse(this.repoRoot, `${local}^{commit}`);
      const upstreamSha = this.revParse(this.repoRoot, `${upstream.out}^{commit}`);
      if (upstreamSha === '' || localSha === upstreamSha || this.g(['merge-base', '--is-ancestor', upstreamSha, localSha]).ok) return localSha;
      this.say(`${local} (${localSha}) is behind or diverged from ${upstream.out} (${upstreamSha}); rebasing onto ${upstream.out}`);
      this.baseLabel = upstream.out.replace(/^refs\/remotes\//, '');
      return upstreamSha;
    }
    const tracking = `refs/remotes/${this.base}`;
    if (this.hasRef(tracking)) {
      const remote = this.g(['remote'])
        .out.split('\n')
        .filter((name) => name !== '' && this.base.startsWith(`${name}/`))
        .sort((a, b) => b.length - a.length)[0];
      if (remote !== undefined) this.fetchBase(remote, this.base.slice(remote.length + 1));
      return this.revParse(this.repoRoot, `${tracking}^{commit}`);
    }
    return this.revParse(this.repoRoot, `${this.base}^{commit}`);
  }

  private rebasePicks(sha: string): string {
    return this.git(this.wt, ['rev-list', '--reverse', '--no-merges', '--cherry-pick', '--right-only', `${this.baseSha}...${sha}`]).out;
  }

  private patchIds(sha: string): string {
    const picks = this.rebasePicks(sha);
    const diff = spawnSync('git', ['-C', this.wt, 'diff-tree', '--stdin', '-p', '-r', '--root'], {
      encoding: 'utf8',
      env: this.env,
      input: picks === '' ? '' : `${picks}\n`,
      maxBuffer: MAX_BUFFER,
    });
    const ids = this.git(this.wt, ['patch-id', '--stable'], { input: diff.stdout ?? '' });
    return commandSubstitution(
      ids.out
        .split('\n')
        .map((line) => line.split(' ')[0])
        .join('\n'),
    );
  }

  async run(argv: readonly string[]): Promise<number> {
    if (argv.length !== 2) this.die(4, 'usage: cli.js integrate <task_id> <base>');
    this.taskId = sqlInt(argv[0]);
    this.base = argv[1];
    if (this.taskId === '') this.die(4, `task_id must be a number, got '${argv[0]}'`);
    if (this.base === '') this.die(4, 'base is empty');
    const db = dbPath(this.env);
    if (db === null) this.die(4, 'no trajectory DB resolved (set TRAJECTORY_DB_PATH or CLAUDE_PROJECT_DIR)');
    this.db = db;

    const row = gateRead(
      db,
      `SELECT 'task' || char(10) || COALESCE(repo, '') || char(10) || COALESCE(branch_id, '') || char(10) || COALESCE(commit_sha, '') || char(10) || issue_id || char(10) || COALESCE(${REVIEW_ANCHOR_AT_SQL}, '') || char(10) || ${HAS_PASS_SQL}
  FROM tasks t WHERE t.id = ${this.taskId};`,
      this.env,
    );
    if (row === GATE_READ_ERROR) this.die(4, `trajectory DB read failed: ${db}`);
    if (row === '') this.die(4, `no task ${this.taskId}`);
    const [, taskRepo = '', branch = '', commitSha = '', issueId = '', reviewAnchorAt = '', hasPass = ''] = row.split('\n');
    this.reviewAnchorAt = reviewAnchorAt;
    this.branch = branch;
    this.issueId = issueId;
    this.reviewedSha = commitSha;
    if (branch === '') this.die(4, `task ${this.taskId} has no branch_id`);
    if (commitSha === '') this.die(3, `task ${this.taskId} has no commit_sha, so no reviewed commit`);
    if (hasPass !== '1') this.die(3, `task ${this.taskId} has no passing code-reviewer verdict for commit ${commitSha}`);

    const wsRoot = posixDirname(posixDirname(posixDirname(db)));
    const repoDir =
      taskRepo !== '' ? repoPathByName(db, taskRepo, this.env) || `${wsRoot}/${taskRepo}` : repoSinglePath(db, this.env) || wsRoot;
    this.repoRoot = await repoGitRoot(repoDir, this.env);
    if (this.repoRoot === '' || !isDir(repoDir)) this.die(4, `task ${this.taskId}'s repo is not a git checkout: ${repoDir || '<unresolved>'}`);

    this.commitSha = this.revParse(this.repoRoot, `${commitSha}^{commit}`);
    if (this.commitSha === '') this.die(4, `commit_sha of task ${this.taskId} is not a commit in ${this.repoRoot}`);
    this.baseSha = this.resolveBase();
    if (this.baseSha === '') this.die(4, `base '${this.base}' is not a commit in ${this.repoRoot}`);

    if (this.g(['merge-base', '--is-ancestor', this.baseSha, this.commitSha]).ok) {
      this.say(`${this.baseLabel} is already an ancestor of task ${this.taskId}'s commit; nothing to rebase`);
      this.io.out(`${this.commitSha}\n`);
      return 0;
    }

    const verification = gateRead(db, `SELECT COALESCE(verification, '[]') FROM tasks WHERE id = ${this.taskId};`, this.env);
    if (verification === GATE_READ_ERROR) this.die(4, `trajectory DB read failed: ${db}`);
    const commands = verificationCommands(verification);
    if (commands === null) this.die(4, `task ${this.taskId}'s verification[] is not a JSON array`);
    if (commands === '') this.die(4, `task ${this.taskId} has no verification[]; there is nothing to re-verify the rebased commit with`);

    if (!this.branchMovable()) throw new Exit(4);

    try {
      mkdirSync(`${this.repoRoot}/.claude/worktrees`, { recursive: true });
    } catch {
      this.die(4, `cannot create ${this.repoRoot}/.claude/worktrees`);
    }
    try {
      this.wt = mkdtempSync(`${this.repoRoot}/.claude/worktrees/integrate-${this.taskId}.`);
    } catch {
      this.die(4, 'cannot create a temporary worktree dir');
    }
    if (!this.gitLoud(this.repoRoot, ['worktree', 'add', '-q', '--detach', this.wt, this.commitSha])) {
      try {
        rmdirSync(this.wt);
      } catch {
        /* not empty or gone */
      }
      this.wt = '';
      this.die(4, 'git worktree add failed');
    }

    this.say(`rebasing task ${this.taskId} (${this.commitSha}) onto ${this.baseLabel} (${this.baseSha}) in ${this.wt}`);
    if (!this.gitLoud(this.wt, ['-c', 'merge.renames=false', 'rebase', '-q', this.baseSha], { ...this.env, GIT_EDITOR: 'true' })) {
      this.git(this.wt, ['rebase', '--abort']);
      this.die(2, `rebase of task ${this.taskId} onto ${this.baseLabel} conflicted; aborted, ${branch} and the DB are unchanged`);
    }
    const newSha = this.revParse(this.wt, 'HEAD');
    if (newSha === '') this.die(4, 'cannot read the rebased HEAD');

    const toolchainPath = joinToolchainPath(toolchainDirs(this.env, this.wt), this.env.PATH ?? '');
    const budgetRaw =
      this.env.TMB_VERIFICATION_TIMEOUT_S ||
      sqliteRo(db, "SELECT json_extract(value_json, '$') FROM plugin_config WHERE key = 'verification_timeout_s';", this.env);
    const timeoutS = parseBudget(budgetRaw).timeoutS;

    if (this.rebasePicks(newSha) === '') {
      this.die(2, `task ${this.taskId}'s patch is already in ${this.baseLabel}; nothing to integrate, ${branch} and the DB are unchanged`);
    }
    if (this.patchIds(this.commitSha) !== this.patchIds(newSha)) {
      this.die(
        2,
        `the rebase changed task ${this.taskId}'s source patches (patch-id of ${this.baseLabel}..reviewed differs from ${this.baseLabel}..rebased); ${branch} and the DB are unchanged`,
      );
    }

    const deps = await prepareWorktreeDeps(this.repoRoot, this.wt, { env: { ...this.env, PATH: toolchainPath } });
    for (const s of deps.skipped) this.io.err(`worktree-deps: ${s.dir}: ${s.reason}\n`);
    if (deps.install_error !== undefined) {
      this.io.err(`${deps.install_error}\n`);
      this.die(1, `worktree setup failed on ${newSha}; no verification run recorded, ${branch} unmoved`);
    }

    const setup = await runWorktreeSetup(this.wt, { env: { ...this.env, PATH: toolchainPath } });
    if (setup.error !== undefined) {
      this.io.err(`${describeSetupFailure(setup)}\n`);
      this.die(1, `worktree setup failed on ${newSha}; no verification run recorded, ${branch} unmoved`);
    }

    const started = this.record(runStartSql(this.taskId, newSha, timeoutS, 'manual'));
    this.runId = started.ok ? commandSubstitution(started.stdout) : '';
    if (this.runId === '') this.die(4, `could not record a verification run for ${newSha}; ${branch} unmoved`);
    this.runOpen = true;

    const commandEnv = { ...this.env, ...RECORD_ENV, PATH: toolchainPath };
    const lines = commands.split('\n');
    const total = lines.filter((line) => line !== '').length;
    const startS = nowS();
    for (const [i, cmd] of lines.entries()) {
      const ordinal = i + 1;
      const remaining = timeoutS - (nowS() - startS);
      if (remaining <= 0) {
        this.recordCommand(ordinal, cmd, TIMED_OUT_CODE, 0, 'budget spent before the command started');
        if (!this.finish(TIMED_OUT_CODE, 1)) this.say(`run #${this.runId} finish write failed`);
        this.die(1, `verification budget (${timeoutS}s) spent before command ${ordinal}/${total}: ${cmd}; recorded as run #${this.runId}; ${branch} unmoved`);
      }
      const cmdStart = nowS();
      const { rc, fired, out } = await this.execute(['bash', '-c', cmd], remaining, commandEnv);
      const elapsed = nowS() - cmdStart;
      const tail = lastLines(out, TAIL_LINES);
      const timedOut: 0 | 1 = rc === TIMED_OUT_CODE && fired ? 1 : 0;
      if (!this.recordCommand(ordinal, cmd, rc, elapsed, tail)) this.say(`run #${this.runId}: command ${ordinal} row not recorded`);
      if (rc !== 0) {
        if (!this.finish(rc, timedOut)) this.say(`run #${this.runId} finish write failed`);
        this.say(`verification failed on ${newSha}: command ${ordinal}/${total} exited ${rc} after ${elapsed}s: ${cmd}`);
        this.io.err(`${tail}\n`);
        this.die(1, `recorded as run #${this.runId}; ${branch} unmoved`);
      }
    }

    if (!this.finish(0, 0)) {
      this.die(4, `run #${this.runId} passed but its finish write failed, so the push guard will not count it; ${branch} unmoved`);
    }

    const oldTip = this.tip;
    if (!this.branchMovable()) {
      this.die(4, `verification passed (run #${this.runId}) but ${branch} cannot be moved; the rebased commit is ${newSha}`);
    }
    if (this.tip !== oldTip) this.die(4, `${branch} moved during integration (${oldTip} -> ${this.tip}); left as is`);
    if (!this.g(['update-ref', '-m', `cli.js integrate: task ${this.taskId} onto ${this.base}`, `refs/heads/${branch}`, newSha, this.tip]).ok) {
      this.die(4, `git update-ref of ${branch} failed; the rebased commit is ${newSha} (run #${this.runId})`);
    }
    if (!this.recordIntegrated(newSha)) {
      this.die(
        4,
        `${branch} moved to ${newSha} (run #${this.runId} passed), but recording it on task ${this.taskId} failed; tasks.commit_sha still names the reviewed ${this.reviewedSha}, so code-reviewer-preflight denies a review of ${newSha} until it is recorded`,
      );
    }
    this.say(`${branch} -> ${newSha} (verification run #${this.runId} passed)`);
    this.io.out(`${newSha}\n`);
    return 0;
  }
}

export async function integrate(argv: readonly string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const integration = new Integration(env, io);
  const onExit = (code: number): void => integration.cleanup(code);
  process.on('exit', onExit);
  let code = 1;
  try {
    code = await integration.run(argv);
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    code = e.code;
  } finally {
    process.off('exit', onExit);
    integration.cleanup(code);
  }
  return code;
}
