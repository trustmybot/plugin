// The environment gate of task_provision, task_reopen and task_retry (GH 2866)
// on a project that is not this plugin: a Python layout with no package.json
// and no changelog.d, its origin a bare repo.
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinScanEnv, tempDB, type ScanEnvPin } from './helpers.js';
import type { TrajectoryDB } from '../db.js';
import { GraphHolder, WorldModelGraph } from '../graph.js';
import { scanTools } from '../tools/scan.js';
import { compositeTools } from '../tools/composites.js';
import { reindexIdle } from '../world-model/freshness.js';
import { WORKTREE_SETUP_FILE } from '../utils/worktree-setup.js';

type Raw = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

const parse = (r: unknown): Record<string, unknown> => JSON.parse((r as Raw).content[0].text) as Record<string, unknown>;

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t.t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t.t',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
    env: GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
}

const setupFile = (commands: string[]): Record<string, string> => ({
  [WORKTREE_SETUP_FILE]: JSON.stringify({ version: 1, commands }),
});

const PYTHON_PROJECT: Record<string, string> = {
  'pyproject.toml': '[project]\nname = "pyapp"\nversion = "0.1.0"\n',
  'pyapp/__init__.py': '',
  'pyapp/main.py': 'def greet(name: str) -> str:\n    return f"hello {name}"\n',
  'tests/test_main.py': 'from pyapp.main import greet\n\n\ndef test_greet():\n    assert greet("x") == "hello x"\n',
  '.gitignore': '.claude/\n__pycache__/\n',
};

interface Fx {
  ws: string;
  root: string;
  origin: string;
  db: TrajectoryDB;
  tools: Handlers;
  git: (...a: string[]) => string;
  // Commits `files` in a second clone and pushes it to origin; the fixture's
  // checkout does not fetch it.
  pushFromElsewhere: (files: Record<string, string>) => string;
  counts: () => { tasks: number; discussions: number; audit: number };
  cleanup: () => void;
}

async function fixture(opts: { setup?: string[]; graph?: boolean } = {}): Promise<Fx> {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'env-gate-ws-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'env-gate-remote-')));
  const origin = join(outside, 'origin.git');
  const root = join(ws, 'pyapp');
  mkdirSync(root);
  gitIn(outside, 'init', '-q', '--bare', origin);
  gitIn(root, 'init', '-q', '-b', 'main');
  writeFiles(root, { ...PYTHON_PROJECT, ...(opts.setup ? setupFile(opts.setup) : {}) });
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-qm', 'init');
  gitIn(root, 'remote', 'add', 'origin', origin);
  gitIn(root, 'push', '-q', 'origin', 'main');

  const dbDir = mkdtempSync(join(tmpdir(), 'env-gate-db-'));
  const dbPath = join(dbDir, 'trajectory.db');
  const db = tempDB({ path: dbPath });
  const holder = GraphHolder.fixed(new WorldModelGraph(db));
  const scan = (await (scanTools(db, holder, dbPath).handlers as Handlers)['scan_run']({
    agent: 'bro',
    session_dir: ws,
    source: 'user_manual',
  })) as Raw;
  assert.ok(!scan.isError, JSON.stringify(scan));
  db.run(`UPDATE repos SET target_branch = 'main' WHERE name = 'pyapp'`);
  db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
          VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
  const tools = compositeTools(db, dbPath, opts.graph === false ? null : holder, { host: 'claude', projectRoot: ws })
    .handlers as Handlers;

  let pushes = 0;
  const pushFromElsewhere = (files: Record<string, string>): string => {
    const clone = join(outside, `clone-${++pushes}`);
    gitIn(outside, 'clone', '-q', origin, clone);
    writeFiles(clone, files);
    gitIn(clone, 'add', '-A');
    gitIn(clone, 'commit', '-qm', `push ${pushes}`);
    gitIn(clone, 'push', '-q', 'origin', 'main');
    return gitIn(clone, 'rev-parse', 'HEAD');
  };
  const count = (sql: string) => db.get<{ n: number }>(sql)!.n;
  return {
    ws,
    root,
    origin,
    db,
    tools,
    git: (...a) => gitIn(root, ...a),
    pushFromElsewhere,
    counts: () => ({
      tasks: count('SELECT COUNT(*) AS n FROM tasks'),
      discussions: count('SELECT COUNT(*) AS n FROM discussions'),
      audit: count('SELECT COUNT(*) AS n FROM audit'),
    }),
    cleanup: () => {
      db.close();
      for (const dir of [ws, outside, dbDir]) rmSync(dir, { recursive: true, force: true });
    },
  };
}

const SPEC = ['## Description', 'Change `greet` in `pyapp/main.py`.', '', '## Success Criteria', '- SC1: works'].join('\n');

const provision = (fx: Fx, branchId: string): Promise<unknown> =>
  fx.tools['task_provision']({
    agent: 'bro',
    issue_id: 1,
    branch_id: branchId,
    decision_body: 'Chosen approach: provision through the environment gate.',
    task: { description: 'd', spec_body: SPEC, files: ['pyapp/main.py'], verification: ['true'], repo: 'pyapp' },
  });

const worktreeOf = (fx: Fx, branchId: string): string => join(fx.root, '.claude', 'worktrees', branchId.replace(/^[^/]+\//, ''));

function assertRefused(fx: Fx, r: unknown, stage: string, branchId: string): Record<string, unknown> {
  assert.equal((r as Raw).isError, true, JSON.stringify(parse(r)));
  const out = parse(r);
  const failed = out['env_gate_failed'] as { stage: string; detail: string };
  assert.equal(failed.stage, stage, JSON.stringify(out));
  assert.equal(typeof failed.detail, 'string');
  assert.equal(fx.git('branch', '--list', branchId), '', `branch ${branchId} removed`);
  assert.equal(existsSync(worktreeOf(fx, branchId)), false, `worktree of ${branchId} removed`);
  return out;
}

let pin: ScanEnvPin;
before(() => {
  pin = pinScanEnv();
});
after(() => pin.restore());
afterEach(() => reindexIdle());

describe('environment gate (GH 2866)', () => {
  it('a setup that exits 3 refuses at stage setup and writes no row', async () => {
    const fx = await fixture({ setup: ['echo setup-broke-here; exit 3'] });
    try {
      const before = fx.counts();
      const out = assertRefused(fx, await provision(fx, 'feat/setup-exit'), 'setup', 'feat/setup-exit');
      assert.match(String(out['error']), /stage 'setup'.*exited 3.*No task row was created/);
      assert.match(String((out['env_gate_failed'] as { output_tail: string }).output_tail), /setup-broke-here/);
      assert.deepEqual(fx.counts(), before, 'no task, discussion or audit row');
    } finally {
      fx.cleanup();
    }
  });

  it('an unreachable origin refuses at stage fetch for task_provision and task_retry', async () => {
    const fx = await fixture();
    try {
      const passed = parse(await provision(fx, 'feat/first'));
      const taskId = passed['task_id'] as number;
      assert.equal(typeof taskId, 'number', JSON.stringify(passed));
      fx.db.run(`UPDATE tasks SET status = 'failed' WHERE id = ?`, [taskId]);

      fx.git('remote', 'set-url', 'origin', join(dirname(fx.origin), 'missing.git'));
      const before = fx.counts();
      const out = assertRefused(fx, await provision(fx, 'feat/no-origin'), 'fetch', 'feat/no-origin');
      assert.match(String(out['error']), /stage 'fetch'.*git fetch origin main failed/);

      const retry = await fx.tools['task_retry']({
        agent: 'bro',
        failed_task_id: String(taskId),
        new_branch_id: 'feat/no-origin-retry',
        corrected_spec_body: SPEC,
        retry_rationale: 'retry while origin is gone',
        description: 'd',
      });
      assertRefused(fx, retry, 'fetch', 'feat/no-origin-retry');
      assert.deepEqual(fx.counts(), before, 'no task, discussion or audit row');
    } finally {
      fx.cleanup();
    }
  });

  it('a commit pushed to origin after the last fetch is the base_sha, and the world model is indexed at it', async () => {
    const fx = await fixture();
    try {
      const staleTip = fx.git('rev-parse', 'refs/remotes/origin/main');
      const pushed = fx.pushFromElsewhere({ 'pyapp/main.py': 'def greet(name: str) -> str:\n    return f"hi {name}"\n' });
      assert.notEqual(pushed, staleTip);
      assert.equal(fx.git('rev-parse', 'refs/remotes/origin/main'), staleTip, 'the checkout has not fetched the push');

      const out = parse(await provision(fx, 'feat/fresh-base'));
      assert.equal(typeof out['task_id'], 'number', JSON.stringify(out));
      const originTip = fx.git('rev-parse', 'origin/main');
      assert.equal(originTip, pushed);
      assert.equal(out['base_sha'], originTip);
      assert.equal(out['wm_commit'], originTip);
      assert.equal(fx.git('rev-parse', 'refs/heads/feat/fresh-base'), originTip, 'the branch is cut from the pushed commit');
      const row = fx.db.get<{ base_sha: string | null; wm_commit: string | null }>(
        'SELECT base_sha, wm_commit FROM tasks WHERE id = ?',
        [out['task_id']],
      )!;
      assert.notEqual(row.base_sha, null);
      assert.notEqual(row.wm_commit, null);
      assert.equal(row.base_sha, originTip);
      assert.equal(row.wm_commit, originTip);
    } finally {
      fx.cleanup();
    }
  });

  it('a passing setup provisions with every stage pass or skipped', async () => {
    const fx = await fixture({ setup: ['test -f pyproject.toml && touch .setup-ran'] });
    try {
      const out = parse(await provision(fx, 'feat/setup-passes'));
      assert.equal(typeof out['task_id'], 'number', JSON.stringify(out));
      const stages = (out['env_gate'] as { stages: Array<{ stage: string; status: string }> }).stages;
      assert.deepEqual(
        stages.map((s) => s.stage),
        ['fetch', 'branch', 'worktree', 'setup', 'reindex'],
      );
      for (const s of stages) assert.ok(s.status === 'pass' || s.status === 'skipped', JSON.stringify(s));
      assert.deepEqual(
        stages.map((s) => s.status),
        ['pass', 'pass', 'pass', 'pass', 'pass'],
      );
      assert.ok(existsSync(join(worktreeOf(fx, 'feat/setup-passes'), '.setup-ran')), 'setup ran in the worktree');
      assert.equal(out['worktree_path'], worktreeOf(fx, 'feat/setup-passes'));
    } finally {
      fx.cleanup();
    }
  });

  it('task_reopen refuses at stage setup with the task status unchanged and its recut branch removed', async () => {
    const fx = await fixture();
    try {
      const out = parse(await provision(fx, 'feat/reopen-me'));
      const taskId = out['task_id'] as number;
      assert.equal(typeof taskId, 'number', JSON.stringify(out));
      fx.db.run(`UPDATE tasks SET status = 'failed' WHERE id = ?`, [taskId]);
      fx.git('worktree', 'remove', '--force', worktreeOf(fx, 'feat/reopen-me'));
      fx.git('branch', '-D', 'feat/reopen-me');
      fx.pushFromElsewhere(setupFile(['exit 3']));

      const before = fx.counts();
      const r = await fx.tools['task_reopen']({ agent: 'bro', task_id: taskId, reason: 'rework after review' });
      const refused = assertRefused(fx, r, 'setup', 'feat/reopen-me');
      assert.match(String(refused['error']), /Task \d+ is unchanged \('failed'\)/);
      assert.equal(fx.db.get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId])!.status, 'failed');
      assert.deepEqual(fx.counts(), before, 'no discussion or audit row');
    } finally {
      fx.cleanup();
    }
  });

  it('without a world-model graph the reindex stage is skipped, wm_commit is null and the decision says why', async () => {
    const fx = await fixture({ graph: false });
    try {
      const out = parse(await provision(fx, 'feat/degraded'));
      assert.equal(typeof out['task_id'], 'number', JSON.stringify(out));
      const stages = (out['env_gate'] as { stages: Array<{ stage: string; status: string }> }).stages;
      assert.deepEqual(stages.at(-1), { stage: 'reindex', status: 'skipped', detail: 'the server has no world-model graph (degraded mode)' });
      assert.equal(out['wm_commit'], null);
      assert.equal(out['base_sha'], fx.git('rev-parse', 'origin/main'));
      const decision = fx.db.get<{ body: string }>(
        `SELECT body FROM discussions WHERE task_id = ? AND kind = 'decision'`,
        [out['task_id']],
      )!;
      assert.match(decision.body, /Environment gate: reindex skipped because the server has no world-model graph/);
    } finally {
      fx.cleanup();
    }
  });
});

describe('the server READMEs describe the fail-closed environment gate (F827-1)', () => {
  const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const read = (rel: string): string => readFileSync(join(serverRoot, rel), 'utf8');

  it('no README still calls worktree setup or creation fail-soft for the gated tools', () => {
    const serverReadme = read('README.md');
    const toolsReadme = read('src/tools/README.md');
    assert.doesNotMatch(serverReadme, /provisioning still succeeds/);
    assert.doesNotMatch(serverReadme, /^- .task_provision., .task_reopen., .task_retry.: fail-soft/m);
    assert.doesNotMatch(toolsReadme, /Only worktree creation stays fail-soft/);
    assert.doesNotMatch(toolsReadme, /the worktree follows fail-soft/);
  });

  it('both READMEs name env_gate_failed and the recorded base and world-model commits', () => {
    for (const rel of ['README.md', 'src/tools/README.md']) {
      const text = read(rel);
      assert.match(text, /env_gate_failed/, rel);
      assert.match(text, /base_sha/, rel);
      assert.match(text, /wm_commit/, rel);
    }
  });
});
