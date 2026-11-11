/**
 * Decision 910 (GH 1692, GH 2032): for a task with a recorded
 * tasks.worktree_path (a session worktree it adopted), taskLocation returns
 * that path instead of <repo>/.claude/worktrees/<slug>. One end-to-end check
 * per gate that resolves the task's worktree, each on a temp repo whose
 * session worktree sits outside the slug location, with a control whose
 * worktree_path is NULL so the slug path still holds.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ALLOW, type GateResult } from '../hooks/gate.js';
import { cleanupWorktree } from '../hooks/cleanup-worktree-on-task-close.js';
import { codeReviewerPreflight, preflightFix } from '../hooks/code-reviewer-preflight.js';
import { containmentGuard } from '../hooks/containment-guard.js';
import { lintBaseSha, runCloseLints } from '../hooks/lib/close-lints.js';
import { ensureSweWorktree } from '../hooks/ensure-swe-worktree.js';
import { postTaskCreateSpawnHint } from '../hooks/post-task-create-spawn-hint.js';
import { recordSweSpawn } from '../hooks/record-swe-spawn.js';
import { stayOnBaseGuard } from '../hooks/stay-on-base-guard.js';
import { sweAtomicClose } from '../hooks/swe-atomic-close.js';
import { sweBoundary } from '../hooks/swe-boundary.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const T0 = '2026-10-01T10:00:00.000Z';
const TASK = 5;
const FAKE_UID = 4242424;

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(cwd: string, file: string): string {
  writeFileSync(join(cwd, file), `${file}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', file);
  return git(cwd, 'rev-parse', 'HEAD');
}

interface Options {
  adopted: boolean;
  status?: string;
  /** Control only: add the slug worktree, as worktree-create would have. */
  slugWorktree?: boolean;
}

interface Case {
  ws: string;
  repo: string;
  db: string;
  env: NodeJS.ProcessEnv;
  branch: string;
  transcript: string;
  /** The worktree the gate must act on: the session worktree when adopted, else the slug path. */
  worktree: string;
  /** The other candidate, which the gate must not act on. */
  other: string;
  slug: string;
  session: string;
}

let sandbox: string;
let seq = 0;

/**
 * <ws>/plugin is a git repo on main with branch feat/c<N>; task 5 of <ws>'s DB is on it. Adopted: the
 * branch is checked out in <ws>/session/c<N>, recorded as worktree_path with worktree_adopted=1.
 */
function fixture(opts: Options): Case {
  seq += 1;
  const ws = join(sandbox, `case-${seq}`);
  const repo = join(ws, 'plugin');
  const branch = `feat/c${seq}`;
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, 'README.md');
  git(repo, 'branch', branch);
  const slug = join(repo, '.claude/worktrees', `c${seq}`);
  const session = join(ws, 'session', `c${seq}`);
  if (opts.adopted) {
    mkdirSync(dirname(session), { recursive: true });
    git(repo, 'worktree', 'add', '-q', session, branch);
  } else if (opts.slugWorktree) {
    git(repo, 'worktree', 'add', '-q', slug, branch);
  }
  const db = join(ws, '.claude/tmb/trajectory.db');
  mkdirSync(dirname(db), { recursive: true });
  const d = new DatabaseSync(db);
  try {
    d.exec(SCHEMA);
    d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'o', 'open', ?, ?)").run(T0, T0);
    d.prepare('INSERT INTO repos (name, path, target_branch) VALUES (?, ?, ?)').run('plugin', repo, 'main');
    d.prepare(
      `INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, repo, effort, files)
       VALUES (?, 1, ?, 'd', ?, ?, ?, 'plugin', 'medium', '["src"]')`,
    ).run(TASK, branch, opts.status ?? 'running', T0, T0);
    if (opts.adopted) {
      d.prepare('UPDATE tasks SET worktree_path = ?, worktree_adopted = 1 WHERE id = ?').run(realpathSync(session), TASK);
    }
  } finally {
    d.close();
  }
  const transcript = join(ws, 'spawn.jsonl');
  writeFileSync(transcript, `${JSON.stringify({ message: { content: [{ type: 'text', text: `task_id=${TASK} do it` }] } })}\n`);
  mkdirSync(join(ws, 'host-tmp'), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...GIT_ENV,
    PATH: process.env.PATH,
    HOME: join(ws, 'home'),
    TRAJECTORY_DB_PATH: db,
    CLAUDE_PROJECT_DIR: ws,
    CLAUDE_CONFIG_DIR: join(ws, 'cc'),
    TMB_MODEL_CACHE_DIR: join(ws, 'cache'),
    TMPDIR: join(ws, 'host-tmp'),
    LC_ALL: 'C',
  };
  return {
    ws,
    repo,
    db,
    env,
    branch,
    transcript,
    worktree: opts.adopted ? session : slug,
    other: opts.adopted ? slug : session,
    slug,
    session,
  };
}

function query<T>(c: Case, sql: string, ...args: Array<string | number>): T {
  const d = new DatabaseSync(c.db, { readOnly: true });
  try {
    return d.prepare(sql).get(...args) as T;
  } finally {
    d.close();
  }
}

function run(c: Case, sql: string, ...args: Array<string | number>): void {
  const d = new DatabaseSync(c.db);
  try {
    d.prepare(sql).run(...args);
  } finally {
    d.close();
  }
}

interface HookOut {
  hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string };
}

function out(r: GateResult): HookOut['hookSpecificOutput'] {
  assert.equal(r.code, 0);
  assert.notEqual(r.stdout, '', 'the gate printed a decision');
  return (JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as HookOut).hookSpecificOutput;
}

function denyReason(r: GateResult): string {
  const o = out(r);
  assert.equal(o.permissionDecision, 'deny');
  return o.permissionDecisionReason ?? '';
}

async function withStderr(run: () => GateResult | Promise<GateResult>): Promise<{ result: GateResult; stderr: string }> {
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => written.push(String(chunk)) > 0) as typeof process.stderr.write;
  try {
    return { result: await run(), stderr: written.join('') };
  } finally {
    process.stderr.write = write;
  }
}

const sweWrite = (c: Case, path: string): string =>
  JSON.stringify({
    session_id: 'adopted-unit',
    cwd: c.worktree,
    tool_name: 'Write',
    tool_input: { file_path: path, content: 'x' },
    agent_type: 'swe',
    agent_transcript_path: c.transcript,
  });

const CASES = [
  { label: 'adopted', adopted: true },
  { label: 'control (worktree_path NULL)', adopted: false },
] as const;

describe('gates that resolve the task worktree act on the recorded worktree_path (decision 910)', () => {
  before(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-adopted-task-')));
  });
  after(() => rmSync(sandbox, { recursive: true, force: true }));

  describe('swe-boundary', () => {
    for (const { label, adopted } of CASES) {
      it(`${label}: allows a swe Write inside the task worktree and denies one in the other path`, async () => {
        const c = fixture({ adopted, slugWorktree: true });
        mkdirSync(join(c.worktree, 'src'), { recursive: true });
        assert.deepEqual(await sweBoundary(sweWrite(c, join(c.worktree, 'src/a.ts')), c.env), ALLOW);
        const reason = denyReason(await sweBoundary(sweWrite(c, join(c.other, 'src/a.ts')), c.env));
        assert.ok(reason.includes(`inside its assigned worktree (${c.worktree}) of task ${TASK}`), reason);
      });
    }
  });

  describe('containment-guard', () => {
    const realGetuid = process.getuid;
    before(() => {
      process.getuid = () => FAKE_UID;
    });
    after(() => {
      process.getuid = realGetuid;
    });

    for (const { label, adopted } of CASES) {
      it(`${label}: allows a swe Write inside the task worktree and denies one in the other path`, async () => {
        const c = fixture({ adopted, slugWorktree: true });
        assert.deepEqual(await containmentGuard(sweWrite(c, join(c.worktree, 'src/a.ts')), c.env), ALLOW);
        const target = join(c.other, 'src/a.ts');
        const reason = denyReason(await containmentGuard(sweWrite(c, target), c.env));
        assert.ok(reason.startsWith(`BLOCKED: containment — ${target} is outside this run's root ${c.worktree}.`), reason);
      });
    }
  });

  describe('code-reviewer-preflight', () => {
    const review = JSON.stringify({ tool_name: 'Agent', tool_input: { subagent_type: 'code-reviewer', prompt: `task_id=${TASK}` } });

    for (const { label, adopted } of CASES) {
      it(`${label}: judges the commit made in the task worktree, and its next commit as the new branch tip`, async () => {
        const c = fixture({ adopted, slugWorktree: true });
        const sha = commit(c.worktree, 'work.txt');
        run(c, 'UPDATE tasks SET commit_sha = ? WHERE id = ?', sha, TASK);
        run(
          c,
          "INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s) VALUES (?, ?, 'gate', ?, ?, 0, 600)",
          TASK,
          sha,
          T0,
          T0,
        );
        const lints = await runCloseLints(c.worktree, sha, await lintBaseSha(c.worktree, c.db, String(TASK), sha, c.env), 60, c.env, { db: c.db, taskId: String(TASK), source: 'gate' });
        assert.ok(typeof lints !== 'string' && lints.exitCode === 0, JSON.stringify(lints));
        assert.deepEqual(await codeReviewerPreflight(review, c.env), ALLOW);
        const next = commit(c.worktree, 'more.txt');
        const { fix, ...failure } = JSON.parse(denyReason(await codeReviewerPreflight(review, c.env))) as { check: 'sha_mismatch'; expected: string; actual: string; fix: unknown };
        assert.deepEqual(failure, { check: 'sha_mismatch', expected: sha, actual: next });
        assert.deepEqual(fix, preflightFix('sha_mismatch', String(TASK)));
      });
    }
  });

  describe('ensure-swe-worktree', () => {
    const spawn = JSON.stringify({ tool_name: 'Agent', tool_input: { subagent_type: 'swe', prompt: `task_id=${TASK}` } });
    const worktrees = (repo: string) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));

    it('adopted: skips `git worktree add`, adding no slug worktree beside the session one', async () => {
      const c = fixture({ adopted: true, status: 'pending' });
      const before = worktrees(c.repo);
      const { result, stderr } = await withStderr(() => ensureSweWorktree(spawn, c.env));
      assert.deepEqual(result, ALLOW);
      assert.equal(stderr, '');
      assert.deepEqual(worktrees(c.repo), before);
      assert.ok(!existsSync(c.slug));
    });

    it('control (worktree_path NULL): adds the slug worktree', async () => {
      const c = fixture({ adopted: false, status: 'pending' });
      const { result, stderr } = await withStderr(() => ensureSweWorktree(spawn, c.env));
      assert.deepEqual(result, ALLOW);
      assert.equal(stderr, `ensure-swe-worktree: created worktree ${c.slug} for branch ${c.branch}\n`);
      assert.ok(existsSync(join(c.slug, 'README.md')));
    });
  });

  describe('record-swe-spawn', () => {
    for (const { label, adopted } of CASES) {
      it(`${label}: records the task worktree as the run's root_dir`, () => {
        const c = fixture({ adopted, status: 'pending', slugWorktree: true });
        const payload = JSON.stringify({
          tool_name: 'Agent',
          tool_use_id: 'toolu_1',
          session_id: 'sess-1',
          tool_input: { subagent_type: 'swe', prompt: `task_id=${TASK} do it` },
        });
        assert.deepEqual(recordSweSpawn(payload, c.env), ALLOW);
        const row = query<{ root_dir: string }>(c, 'SELECT root_dir FROM agent_runs WHERE task_id = ?', TASK);
        assert.equal(row.root_dir, c.worktree);
      });
    }
  });

  describe('post-task-create-spawn-hint', () => {
    for (const { label, adopted } of CASES) {
      it(`${label}: names the task worktree in the spawn hint`, () => {
        const c = fixture({ adopted, status: 'pending' });
        const payload = JSON.stringify({
          tool_name: 'mcp__plugin_tmb_trajectory-server__task_create_batch',
          tool_response: { content: [{ type: 'text', text: JSON.stringify([{ id: TASK, branch_id: c.branch }]) }] },
        });
        const context = out(postTaskCreateSpawnHint(payload, c.env)).additionalContext ?? '';
        assert.ok(context.includes(`  - task_id=${TASK} branch_id=${c.branch} worktree=${c.worktree}\n`), context);
      });
    }
  });

  describe('stay-on-base-guard', () => {
    for (const { label, adopted } of CASES) {
      it(`${label}: points a main-checkout switch to the task branch at the task worktree`, async () => {
        const c = fixture({ adopted, slugWorktree: true });
        const payload = JSON.stringify({ tool_name: 'Bash', cwd: c.repo, tool_input: { command: `git -C ${c.repo} checkout ${c.branch}` } });
        const reason = denyReason(await stayOnBaseGuard(payload, c.env));
        assert.ok(reason.includes(`use the worktree at ${c.worktree}.`), reason);
        assert.ok(reason.endsWith(`cd ${c.worktree}`), reason);
      });
    }
  });

  describe('swe-atomic-close', () => {
    const stop = (c: Case): string =>
      JSON.stringify({ hook_event_name: 'SubagentStop', agent_type: 'swe', agent_id: 'agent-5', agent_transcript_path: c.transcript });

    for (const { label, adopted } of CASES) {
      it(`${label}: auto-completes at the head of the task worktree`, async () => {
        const c = fixture({ adopted, slugWorktree: true });
        const sha = commit(c.worktree, 'work.txt');
        run(
          c,
          "INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out) VALUES (?, ?, 'gate', ?, ?, 0, 600, 0)",
          TASK,
          sha,
          T0,
          T0,
        );
        await sweAtomicClose(stop(c), c.env);
        const task = query<{ status: string; commit_sha: string | null }>(c, 'SELECT status, commit_sha FROM tasks WHERE id = ?', TASK);
        assert.deepEqual({ ...task }, { status: 'completed', commit_sha: sha });
      });

      it(`${label}: names the task worktree when the swe stopped without committing`, async () => {
        const c = fixture({ adopted, slugWorktree: true });
        const context = out(await sweAtomicClose(stop(c), c.env)).additionalContext ?? '';
        assert.ok(context.includes(`stopped without committing in worktree at ${c.worktree}.`), context);
      });
    }
  });

  describe('cleanup-worktree-on-task-close', () => {
    const close = JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__plugin_tmb_trajectory-server__task_update_status',
      tool_input: { agent: 'bro', task_id: TASK, status: 'closed' },
    });

    it('adopted: keeps the session worktree and names it', async () => {
      const c = fixture({ adopted: true, status: 'closed' });
      const lines: string[] = [];
      assert.deepEqual(await cleanupWorktree(close, c.env, (line) => lines.push(line)), ALLOW);
      assert.ok(existsSync(c.session), 'the adopted worktree stays');
      assert.ok(git(c.repo, 'worktree', 'list', '--porcelain').includes(`worktree ${c.session}\n`));
      assert.deepEqual(lines, [`tmb: kept adopted worktree ${c.session} after task #${TASK} closed (GH 2032)\n`]);
    });

    it('control (worktree_path NULL): removes the slug worktree', async () => {
      const c = fixture({ adopted: false, status: 'closed', slugWorktree: true });
      const lines: string[] = [];
      assert.deepEqual(await cleanupWorktree(close, c.env, (line) => lines.push(line)), ALLOW);
      assert.ok(!existsSync(c.slug), 'the slug worktree is removed');
      assert.deepEqual(lines, [`tmb: cleaned up worktree ${c.slug} after task #${TASK} closed\n`]);
    });
  });
});
