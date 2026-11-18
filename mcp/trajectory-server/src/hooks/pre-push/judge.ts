/**
 * The push gate's judge at git's own pre-push hook (GH 3281): admits or denies
 * an agent's push from the ref lines git hands the hook, judging a task branch
 * by its net diff against its base, not commit by commit.
 *
 * In the order docs/architecture/GIT.md "The push gate at git's own hook" draws:
 *   1. A push from outside an agent session (neither CLAUDECODE=1 nor a
 *      CLAUDE_CODE_SESSION_ID) is the Human's: admitted, the DB never read.
 *   2. A repo that is exempt is admitted (a stub until GH 3279's repo mode).
 *   Then each ref line:
 *   3. A remote ref on a protected branch is denied; any other delete is admitted.
 *   4. A branch some task names as branch_id is judged by that task's net diff.
 *   5. An agile feature branch other than the target is admitted.
 *   6. Any other ref is judged by the net diff of each task whose commit_sha
 *      its commits past the target's base hold, by id or by patch-id; none
 *      held, it is admitted.
 * The net diff of <sha> is the `git patch-id --stable` of
 * `git diff $(git merge-base <base> <sha>) <sha>`; a task's base is the agile
 * feature branch it records, else its repo's origin/<target>, else <target>.
 * A task admits its tip when its newest verdict is a pass, no non-carrying
 * task_integrated row (cli.js integrate exit 5) is as new as that pass, and
 * the pass's reviewed_sha has the tip's net diff. A pass with no reviewed_sha
 * (written before v65) admits only through HAS_PASS_SQL with tasks.commit_sha
 * the tip. Everything else denies, and so do a DB that does not read and a
 * git command that fails.
 */
import { spawnSync } from 'node:child_process';
import { dbPath, GATE_READ_ERROR, gateRead, sqlQuote } from '../lib/db.js';
import { agileParentRef, recordedFeatureBranch, resolveBaseRef } from '../lib/git-refs.js';
import { isExempt, repoDefaultBranch, repoGitRoot, repoNameForRoot } from '../lib/repo.js';
import { shaPrefixMatchSql, shaValuesCte } from '../lib/sha-prefix.js';
import { HAS_PASS_SQL } from '../../review-sql.js';

const MAX_BUFFER = 256 * 1024 * 1024;
/** A git command past this is killed and the push denied, so a hung git cannot hold the push open. */
const GIT_TIMEOUT_MS = 120_000;
const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const STORED_SHA = /^[0-9a-f]{7,64}$/;
const ZERO_SHA = /^0+$/;
const SHORT = 12;
/** Diff options that make a patch-id independent of the user's diff config, binary content included. */
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index'];


/** One line git writes to the pre-push hook's stdin. */
export interface PushRef {
  readonly localRef: string;
  readonly localSha: string;
  readonly remoteRef: string;
  readonly remoteSha: string;
}

export type Verdict = { readonly admit: true } | { readonly admit: false; readonly reason: string };

/** A deny raised anywhere in a judgement: a rule that denies, a DB that does not read, git failing. */
class Denied extends Error {}

interface Task {
  readonly id: number;
  readonly branch: string;
  readonly workflowMode: string;
  readonly parent: string;
}

interface Pass {
  readonly verdict: string;
  readonly reviewed_sha: string | null;
  readonly created_at: string;
}

/**
 * Whether the push comes from a Claude Code session, whose hooks pass these on
 * to git and so to its hooks; TMB_AGENT_SHELL is the mark the prepush-install
 * gate puts in the session's CLAUDE_ENV_FILE.
 */
export function isAgentSession(env: NodeJS.ProcessEnv): boolean {
  return env.CLAUDECODE === '1' || (env.CLAUDE_CODE_SESSION_ID ?? '') !== '' || env.TMB_AGENT_SHELL === '1';
}

/** git's stdin lines `<local-ref> <local-sha> <remote-ref> <remote-sha>`, or null when one is not that shape. */
export function parsePushRefs(stdin: string): PushRef[] | null {
  const refs: PushRef[] = [];
  for (const line of stdin.split('\n')) {
    if (line.trim() === '') continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) return null;
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    if (!/^[0-9a-f]+$/.test(localSha) || !/^[0-9a-f]+$/.test(remoteSha)) return null;
    refs.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return refs;
}

const short = (sha: string): string => sha.slice(0, SHORT);

const branchOf = (ref: string): string | null => (ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null);

class PushJudge {
  private readonly repoFilter: string;
  private readonly netDiffs = new Map<string, string>();

  constructor(
    private readonly dir: string,
    private readonly db: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly repo: string,
    private readonly target: string,
    private readonly protectedBranches: ReadonlySet<string>,
  ) {
    this.repoFilter = repo === '' ? '' : `AND (t.repo IS NULL OR t.repo = '${sqlQuote(repo)}')`;
  }

  private git(args: readonly string[], input?: Buffer | string): Buffer {
    const r = spawnSync('git', ['-C', this.dir, ...args], { env: this.env, input, maxBuffer: MAX_BUFFER, timeout: GIT_TIMEOUT_MS });
    if (r.status !== 0) {
      const detail = r.error?.message ?? r.stderr.toString('utf8').trim().split('\n')[0] ?? '';
      throw new Denied(`git ${args[0]} failed in ${this.dir}${detail === '' ? '' : `: ${detail}`}`);
    }
    return r.stdout;
  }

  private gitText(args: readonly string[], input?: Buffer | string): string {
    return this.git(args, input).toString('utf8').replace(/\n+$/, '');
  }

  /** The full commit SHA <rev> names, '' when it names none. */
  private commitOf(rev: string): string {
    const r = spawnSync('git', ['-C', this.dir, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { env: this.env, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
    return r.status === 0 ? r.stdout.trim() : '';
  }

  private read(sql: string): string {
    const out = gateRead(this.db, sql, this.env);
    if (out === GATE_READ_ERROR) throw new Denied(`the trajectory DB ${this.db} did not read`);
    return out;
  }

  /** The patch-id of the net diff of <sha> against <base>; '' for an empty diff. */
  private netDiff(base: string, sha: string): string {
    const key = `${base}\n${sha}`;
    const cached = this.netDiffs.get(key);
    if (cached !== undefined) return cached;
    const mergeBase = this.gitText(['merge-base', base, sha]);
    const diff = this.git(['diff', ...DIFF_FLAGS, mergeBase, sha]);
    const id = diff.length === 0 ? '' : this.gitText(['patch-id', '--stable'], diff).split(' ')[0];
    this.netDiffs.set(key, id);
    return id;
  }

  /** commit → patch-id for each non-merge commit `git log <args>` lists. */
  private patchIds(args: readonly string[], input?: string): Map<string, string> {
    const log = this.git(['log', '-p', '--no-merges', '--format=commit %H', ...DIFF_FLAGS, ...args], input);
    const ids = new Map<string, string>();
    if (log.length === 0) return ids;
    for (const line of this.gitText(['patch-id', '--stable'], log).split('\n')) {
      const [id, commit] = line.split(' ');
      if (id && commit) ids.set(commit, id);
    }
    return ids;
  }

  private task(id: number): Task {
    const row = this.read(
      `SELECT json_object('id', t.id, 'branch', t.branch_id, 'workflowMode', COALESCE(t.workflow_mode, ''), 'parent', COALESCE(t.parent_branch_id, '')) FROM tasks t WHERE t.id = ${id};`,
    );
    if (row === '') throw new Denied(`task ${id} is gone from the trajectory DB`);
    return JSON.parse(row) as Task;
  }

  /** The base a task's net diff is taken against: its agile feature branch, else the repo's target. */
  private async taskBase(task: Task): Promise<string> {
    const agile = task.workflowMode === 'agile' ? await agileParentRef(this.dir, this.target, task.parent, 'agile', this.env) : null;
    const base = agile ?? (await resolveBaseRef(this.dir, this.target, this.env));
    if (base === null) throw new Denied(`task ${task.id} (${task.branch}): no base resolves, neither origin/${this.target} nor ${this.target}`);
    return base;
  }

  /** Why <task>'s review does not cover <tip>, or null when it does. */
  private async taskShortfall(task: Task, tip: string): Promise<string | null> {
    const newest = this.read(
      `SELECT json_object('verdict', verdict, 'reviewed_sha', reviewed_sha, 'created_at', created_at) FROM validation_attempts WHERE task_id = ${task.id} ORDER BY id DESC LIMIT 1;`,
    );
    if (newest === '') return 'it has no review verdict';
    const pass = JSON.parse(newest) as Pass;
    if (pass.verdict !== 'pass') return `its newest verdict is ${pass.verdict}`;
    const uncarried = this.read(
      `SELECT COUNT(*) FROM audit a WHERE a.event_type = 'task_integrated' AND a.from_node = 'hook:integrate' AND json_valid(a.content_json)
        AND json_extract(a.content_json, '$.task_id') = ${task.id} AND json_type(a.content_json, '$.carried') = 'false'
        AND a.created_at >= '${sqlQuote(pass.created_at)}';`,
    );
    if (uncarried !== '0') return 'cli.js integrate rebased it after its newest pass and the pass did not carry, so the rebased tip needs a new review';
    if (pass.reviewed_sha === null) {
      const legacy = this.read(`SELECT ${HAS_PASS_SQL} AND ${shaPrefixMatchSql('t.commit_sha', `'${tip}'`)} FROM tasks t WHERE t.id = ${task.id};`);
      return legacy === '1' ? null : `its newest pass names no reviewed commit and its commit_sha is not the pushed tip ${short(tip)}`;
    }
    const reviewed = STORED_SHA.test(pass.reviewed_sha) ? this.commitOf(pass.reviewed_sha) : '';
    if (reviewed === '') return `its newest pass reviewed ${pass.reviewed_sha}, which names no commit in this repo`;
    if (reviewed === tip) return null;
    const base = await this.taskBase(task);
    if (this.netDiff(base, reviewed) === this.netDiff(base, tip)) return null;
    return `its newest pass reviewed ${short(reviewed)}, whose net diff against ${base} is not the pushed tip ${short(tip)}'s`;
  }

  private async judgeTasks(ref: PushRef, tip: string, taskIds: readonly number[]): Promise<void> {
    const misses: string[] = [];
    for (const id of taskIds) {
      const task = this.task(id);
      const why = await this.taskShortfall(task, tip);
      if (why !== null) misses.push(`  - task ${task.id} (${task.branch}): ${why}`);
    }
    if (misses.length > 0) {
      throw new Denied(`${ref.remoteRef} at ${short(tip)} is not covered by a passing review of its net diff:\n${misses.join('\n')}\n@bro review before push.`);
    }
  }

  /** The newest task of this repo whose branch_id is <branch>, else null. */
  private branchTask(branch: string): number | null {
    const id = this.read(`SELECT t.id FROM tasks t WHERE t.branch_id = '${sqlQuote(branch)}' ${this.repoFilter} ORDER BY t.id DESC LIMIT 1;`);
    return id === '' ? null : Number(id);
  }

  private isFeatureBranch(branch: string): boolean {
    if (branch === this.target) return false;
    const recorded = recordedFeatureBranch(this.db, sqlQuote(this.repo), branch, this.env);
    if (recorded === GATE_READ_ERROR) throw new Denied(`the trajectory DB ${this.db} did not read`);
    return recorded;
  }

  /** The ids of the tasks whose commit_sha a commit of <tip> past <base> is, or has the patch-id of. */
  private heldTasks(tip: string, base: string): number[] {
    const commits = this.gitText(['rev-list', tip, `^${base}`]).split('\n').filter((sha) => sha !== '');
    const values = shaValuesCte(commits);
    if (values === null) return [];
    const held = new Set<number>();
    const byId = this.read(`WITH ${values} SELECT DISTINCT t.id FROM tasks t, p WHERE ${shaPrefixMatchSql('t.commit_sha', 'p.sha')} ${this.repoFilter};`);
    for (const id of byId.split('\n')) if (id !== '') held.add(Number(id));

    const rows = this.read(
      `SELECT t.id || ' ' || lower(t.commit_sha) FROM tasks t WHERE length(t.commit_sha) >= 7 AND lower(t.commit_sha) NOT GLOB '*[^0-9a-f]*' ${this.repoFilter} ORDER BY t.id;`,
    );
    const taskShas = rows.split('\n').filter((row) => row !== '').map((row) => row.split(' ') as [string, string]);
    if (taskShas.length > 0) {
      const checked = this.gitText(['cat-file', '--batch-check=%(objectname) %(objecttype)'], `${taskShas.map(([, sha]) => sha).join('\n')}\n`).split('\n');
      const taskOf = new Map<string, number[]>();
      taskShas.forEach(([id], i) => {
        const [full, type] = (checked[i] ?? '').split(' ');
        if (type === 'commit') taskOf.set(full, [...(taskOf.get(full) ?? []), Number(id)]);
      });
      if (taskOf.size > 0) {
        const pushed = new Set(this.patchIds([tip, `^${base}`]).values());
        for (const [commit, id] of this.patchIds(['--no-walk=unsorted', '--stdin'], `${[...taskOf.keys()].join('\n')}\n`)) {
          if (pushed.has(id)) for (const taskId of taskOf.get(commit) ?? []) held.add(taskId);
        }
      }
    }
    return [...held].sort((a, b) => a - b);
  }

  async judge(ref: PushRef): Promise<void> {
    const branch = branchOf(ref.remoteRef);
    if (branch !== null && this.protectedBranches.has(branch)) throw new Denied(`${ref.remoteRef} is a protected branch of ${this.repo || 'this repo'}`);
    if (ZERO_SHA.test(ref.localSha)) return;
    const tip = this.commitOf(ref.localSha);
    if (!FULL_SHA.test(tip)) throw new Denied(`${ref.localRef} (${ref.localSha}) names no commit`);

    const taskId = branch === null ? null : this.branchTask(branch);
    if (taskId !== null) return await this.judgeTasks(ref, tip, [taskId]);
    if (branch !== null && this.isFeatureBranch(branch)) return;

    const base = await resolveBaseRef(this.dir, this.target, this.env);
    if (base === null) throw new Denied(`${ref.remoteRef}: no base resolves, neither origin/${this.target} nor ${this.target}`);
    const held = this.heldTasks(tip, base);
    if (held.length > 0) await this.judgeTasks(ref, tip, held);
  }
}

/** The repo's name, target branch and protected branches, as git-guards reads them: its repos row, else the remote default. */
async function loadPolicy(db: string, dir: string, env: NodeJS.ProcessEnv): Promise<{ repo: string; target: string; protectedBranches: Set<string> }> {
  const repo = repoNameForRoot(db, await repoGitRoot(dir, env), env);
  let target = '';
  let raw = '';
  if (repo !== '') {
    const row = gateRead(
      db,
      `SELECT json_object('target', COALESCE(target_branch, ''), 'protected', COALESCE(protected_branches, '')) FROM repos WHERE name = '${sqlQuote(repo)}' LIMIT 1;`,
      env,
    );
    if (row === GATE_READ_ERROR) throw new Denied(`the trajectory DB ${db} did not read`);
    if (row !== '') ({ target, protected: raw } = JSON.parse(row) as { target: string; protected: string });
  }
  const defaultBranch = await repoDefaultBranch(dir, env);
  target ||= defaultBranch;
  let branches: unknown;
  try {
    branches = JSON.parse(raw || JSON.stringify([defaultBranch]));
  } catch {
    branches = null;
  }
  if (!Array.isArray(branches) || branches.some((b) => typeof b !== 'string')) {
    throw new Denied(`the protected_branches of repo ${repo} is not a JSON array of branch names; fix its repos row or re-run onboarding`);
  }
  return { repo, target, protectedBranches: new Set(branches as string[]) };
}

/**
 * The verdict on an agent's push from <dir> to <remote>, given git's stdin.
 * The caller admits a push from outside an agent session (isAgentSession)
 * before calling, so the Human's push never reads the DB.
 */
export async function judgePrePush(remote: string, stdin: string, dir: string, env: NodeJS.ProcessEnv): Promise<Verdict> {
  const deny = (why: string): Verdict => ({ admit: false, reason: `BLOCKED: pre-push gate, push to ${remote || 'an unnamed remote'}: ${why}` });
  const refs = parsePushRefs(stdin);
  if (refs === null) return deny('git handed the hook a line that is not `<local-ref> <local-sha> <remote-ref> <remote-sha>`');
  const db = dbPath(env) ?? '';
  if (db === '' || gateRead(db, 'SELECT COUNT(*) FROM tasks;', env) === GATE_READ_ERROR) {
    return deny(`the trajectory DB ${db || '(unresolved)'} did not read, so the gate refuses to fail open`);
  }
  // An exempt repo stands the gate down (GH 3279), checked before its policy can deny.
  if (isExempt(db, await repoGitRoot(dir, env), env)) return { admit: true };
  try {
    const policy = await loadPolicy(db, dir, env);
    const judge = new PushJudge(dir, db, env, policy.repo, policy.target, policy.protectedBranches);
    for (const ref of refs) await judge.judge(ref);
    return { admit: true };
  } catch (error) {
    if (error instanceof Denied) return deny(error.message);
    throw error;
  }
}
