/**
 * Bro authors no-code tasks (GH 3075): task_provision stores tasks.no_code_class;
 * no-source-edit-from-main admits a bro Write/Edit only inside a running classed
 * task's worktree on a path the base_sha path classes call docs or prompts; and
 * swe-verification-gate runs a bro close of such a task through verification[]
 * and the close lints after classing its diff, refusing a code or mixed change.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DOC_CHECKS_FILE } from '../hooks/lib/doc-checks.js';
import { noSourceEditFromMain } from '../hooks/no-source-edit-from-main.js';
import { sweVerificationGate } from '../hooks/swe-verification-gate.js';
import { PATH_CLASSES_FILE } from '../path-classes.js';
import { compositeTools } from '../tools/composites.js';
import { tempDB } from './helpers.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const NOW = '2026-11-12T10:00:00.000Z';
const TASK_ID = 3;
const BRANCH = 'docs/3-x';
const SLUG = '3-x';
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const PATH_CLASSES = JSON.stringify({
  version: 1,
  docs: { paths: ['docs/**/*.md', 'changelog.d/**', 'README.md'] },
  prompts: { paths: ['skills/**/*.md'] },
});
const BASE_FILES: Record<string, string> = {
  'README.md': 'See docs/guide.md.\n',
  'docs/guide.md': 'Read the guide.\n',
  'skills/s/SKILL.md': 'Do the thing.\n',
  'src/a.ts': 'one\n',
  'changelog.d/README.md': 'One file per change.\n',
  [DOC_CHECKS_FILE]: readFileSync(join(PLUGIN_ROOT, DOC_CHECKS_FILE), 'utf8'),
  [PATH_CLASSES_FILE]: PATH_CLASSES,
};
const ALLOWED = { stdout: '', code: 0 };

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

interface TaskRow {
  status?: string;
  noCodeClass?: string | null;
  verification?: string[];
}

interface Fixture {
  checkout: string;
  worktree: string;
  db: string;
  baseSha: string;
  env: NodeJS.ProcessEnv;
  git(...args: string[]): string;
  write(path: string, text: string): void;
  commit(message: string): string;
}

/** Under Claude Code, tmpdir() sits in /tmp/claude-<uid>, which the edit gate admits as harness scratch. */
const FAKE_UID = 4242424;
const realGetuid = process.getuid;
let sandbox: string;
let seq = 0;
before(() => {
  process.getuid = () => FAKE_UID;
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-no-code-task-')));
});
after(() => {
  process.getuid = realGetuid;
  rmSync(sandbox, { recursive: true, force: true });
});

/** A checkout on dev holding <files>, task 3's linked worktree on docs/3-x, and task 3 itself as <task> says. */
function fixture(task: TaskRow = {}, files: Record<string, string> = BASE_FILES): Fixture {
  seq += 1;
  const root = join(sandbox, `case-${seq}`);
  const checkout = join(root, 'project/checkout');
  const worktree = join(checkout, '.claude/worktrees', SLUG);
  const db = join(root, 'project/.claude/tmb/trajectory.db');
  mkdirSync(checkout, { recursive: true });
  mkdirSync(dirname(db), { recursive: true });
  for (const d of ['data', 'state', 'cache']) mkdirSync(join(root, 'mise', d), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    CLAUDE_PROJECT_DIR: join(root, 'project'),
    CLAUDE_PLUGIN_ROOT: join(root, 'no-running-plugin'),
    TRAJECTORY_DB_PATH: db,
    PWD: checkout,
    MISE_DATA_DIR: join(root, 'mise/data'),
    MISE_STATE_DIR: join(root, 'mise/state'),
    MISE_CACHE_DIR: join(root, 'mise/cache'),
    ...GIT_ENV,
  };
  const gitIn = (dir: string, args: string[]) => {
    const r = spawnSync('git', ['-C', dir, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(worktree, path)), { recursive: true });
    writeFileSync(join(worktree, path), text);
  };
  const commit = (message: string) => {
    gitIn(worktree, ['add', '-A']);
    gitIn(worktree, ['commit', '-qm', message]);
    return gitIn(worktree, ['rev-parse', 'HEAD']);
  };
  gitIn(checkout, ['init', '-q', '-b', 'dev']);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), text);
  }
  writeFileSync(join(checkout, '.git/info/exclude'), '.claude/\n');
  gitIn(checkout, ['add', '-A']);
  gitIn(checkout, ['commit', '-qm', 'base']);
  const baseSha = gitIn(checkout, ['rev-parse', 'HEAD']);
  gitIn(checkout, ['worktree', 'add', '-q', worktree, '-b', BRANCH]);

  const d = new DatabaseSync(db);
  d.exec(SCHEMA);
  d.prepare("INSERT INTO repos (name, path, target_branch) VALUES ('checkout', ?, 'dev')").run(checkout);
  d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (9, 'o', 'open', ?, ?)").run(NOW, NOW);
  d.prepare(
    `INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, repo, verification, base_sha, no_code_class, created_at, updated_at)
     VALUES (?, 9, ?, 'dev', 'd', ?, 'checkout', ?, ?, ?, ?, ?)`,
  ).run(
    TASK_ID,
    BRANCH,
    task.status ?? 'running',
    JSON.stringify(task.verification ?? ['true']),
    baseSha,
    task.noCodeClass === undefined ? 'docs' : task.noCodeClass,
    NOW,
    NOW,
  );
  d.close();
  return { checkout, worktree, db, baseSha, env, git: (...args) => gitIn(worktree, args), write, commit };
}

function decision(stdout: string): { permissionDecision?: string; permissionDecisionReason?: string } {
  return (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
}

function denyReason(r: { stdout: string; code: number }): string {
  assert.equal(r.code, 0);
  assert.notEqual(r.stdout, '', 'expected a deny');
  const out = decision(r.stdout);
  assert.equal(out.permissionDecision, 'deny');
  return out.permissionDecisionReason ?? '';
}

function edit(f: Fixture, filePath: string, agentType?: string) {
  const payload: Record<string, unknown> = { hook_event_name: 'PreToolUse', cwd: f.checkout, tool_name: 'Write', tool_input: { file_path: filePath, content: 'x' } };
  if (agentType !== undefined) payload['agent_type'] = agentType;
  return noSourceEditFromMain(JSON.stringify(payload), f.env);
}

function close(f: Fixture, agent: string, extra: Record<string, unknown> = {}) {
  return sweVerificationGate(
    JSON.stringify({ tool_name: 'mcp__plugin_tmb_trajectory-server__task_update_status', tool_input: { agent, task_id: String(TASK_ID), status: 'completed', ...extra } }),
    f.env,
  );
}

function runs(f: Fixture): Array<{ commit_sha: string; exit_code: number }> {
  const d = new DatabaseSync(f.db, { readOnly: true });
  try {
    return (d.prepare('SELECT commit_sha, exit_code FROM verification_runs WHERE task_id = ? ORDER BY id').all(TASK_ID) as Array<{ commit_sha: string; exit_code: number }>).map(
      (r) => ({ commit_sha: String(r.commit_sha), exit_code: Number(r.exit_code) }),
    );
  } finally {
    d.close();
  }
}

/** A docs change with its changelog fragment, committed in the worktree. */
function docsCommit(f: Fixture): string {
  f.write('docs/guide.md', 'Read the whole guide.\n');
  f.write('changelog.d/3-x.md', '### Changed\n- guide (GH 3)\n');
  return f.commit('docs');
}

describe('SC1: tasks.no_code_class through task_provision', () => {
  function provisionSetup() {
    const ws = mkdtempSync(join(tmpdir(), 'tmb-no-code-provision-'));
    const repoRoot = join(ws, 'app');
    mkdirSync(repoRoot, { recursive: true });
    const git = (...a: string[]) => execFileSync('git', ['-C', repoRoot, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    writeFileSync(join(repoRoot, 'a.md'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'main')`, [repoRoot]);
    db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
    const composites = compositeTools(db, join(ws, '.claude', 'tmb', 'trajectory.db'));
    const provision = async (branchId: string, extra: Record<string, unknown>): Promise<RawResult> =>
      (await composites.handlers['task_provision']({
        agent: 'bro',
        issue_id: 1,
        branch_id: branchId,
        decision_body: 'Chosen approach: no-code class fixture.',
        task: {
          description: 'd',
          spec_body: ['## Description', 'Edit `a.md`.', '', '## Success Criteria', '- SC1: works'].join('\n'),
          files: ['a.md'],
          verification: ['true'],
          repo: 'app',
          ...extra,
        },
      })) as RawResult;
    const retry = async (failedBranchId: string, newBranchId: string): Promise<RawResult> => {
      db.run(`UPDATE tasks SET status = 'failed' WHERE branch_id = ?`, [failedBranchId]);
      const failedId = db.get<{ id: number }>('SELECT id FROM tasks WHERE branch_id = ?', [failedBranchId])?.id;
      return (await composites.handlers['task_retry']({
        agent: 'bro',
        failed_task_id: String(failedId),
        new_branch_id: newBranchId,
        corrected_spec_body: ['## Description', 'Edit `a.md` again.', '', '## Success Criteria', '- SC1: works'].join('\n'),
        retry_rationale: 'retry the no-code task',
        description: 'd',
      })) as RawResult;
    };
    const stored = (branchId: string) => db.get<{ no_code_class: string | null }>('SELECT no_code_class FROM tasks WHERE branch_id = ?', [branchId]);
    return { provision, retry, stored, cleanup: () => { db.close(); rmSync(ws, { recursive: true, force: true }); } };
  }

  it("stores 'docs' and 'prompts' as given, and NULL when the class is omitted", async () => {
    const s = provisionSetup();
    try {
      for (const [branch, extra, want] of [
        ['docs/a', { no_code_class: 'docs' }, 'docs'],
        ['docs/b', { no_code_class: 'prompts' }, 'prompts'],
        ['feat/c', {}, null],
      ] as const) {
        const r = await s.provision(branch, extra);
        assert.ok(!r.isError, r.content[0]?.text);
        assert.equal(s.stored(branch)?.no_code_class, want);
      }
    } finally {
      s.cleanup();
    }
  });

  it('SC6: task_retry carries the class to the new task, and NULL stays NULL', async () => {
    const s = provisionSetup();
    try {
      for (const [failedBranch, extra, newBranch, want] of [
        ['docs/e', { no_code_class: 'docs' }, 'docs/e-retry', 'docs'],
        ['feat/f', {}, 'feat/f-retry', null],
      ] as const) {
        const p = await s.provision(failedBranch, extra);
        assert.ok(!p.isError, p.content[0]?.text);
        const r = await s.retry(failedBranch, newBranch);
        assert.ok(!r.isError, r.content[0]?.text);
        assert.equal(s.stored(newBranch)?.no_code_class, want);
      }
    } finally {
      s.cleanup();
    }
  });

  it('refuses a class outside docs and prompts and creates no task', async () => {
    const s = provisionSetup();
    try {
      const r = await s.provision('docs/d', { no_code_class: 'code' });
      assert.equal(r.isError, true);
      assert.match(r.content[0]?.text ?? '', /no_code_class/);
      assert.equal(s.stored('docs/d'), undefined);
    } finally {
      s.cleanup();
    }
  });

  it('the column CHECK refuses any other value', () => {
    const db = tempDB();
    try {
      db.run(`INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'o', 'open', datetime('now'), datetime('now'))`);
      assert.throws(
        () => db.run(`INSERT INTO tasks (issue_id, branch_id, description, status, no_code_class, created_at, updated_at) VALUES (1, 'docs/x', 'd', 'pending', 'code', datetime('now'), datetime('now'))`),
        /CHECK/,
      );
    } finally {
      db.close();
    }
  });
});

describe('SC2: bro edits only no-code paths of a running classed task', () => {
  it('allows bro a docs path and a prompts path in the worktree', async () => {
    const f = fixture();
    assert.deepEqual(await edit(f, join(f.worktree, 'docs/guide.md')), ALLOWED);
    assert.deepEqual(await edit(f, join(f.worktree, 'skills/s/SKILL.md')), ALLOWED);
    assert.deepEqual(await edit(f, join(f.worktree, 'docs/new/page.md')), ALLOWED, 'a new file in a new docs directory');
  });

  it('allows bro a worktree-relative target resolved from the payload cwd', async () => {
    const f = fixture();
    const payload = { hook_event_name: 'PreToolUse', cwd: f.worktree, tool_name: 'Edit', tool_input: { file_path: 'docs/guide.md' } };
    assert.deepEqual(await noSourceEditFromMain(JSON.stringify(payload), { ...f.env, PWD: f.worktree }), ALLOWED);
  });

  it('denies bro a code path in the worktree, naming swe', async () => {
    const f = fixture();
    const reason = denyReason(await edit(f, join(f.worktree, 'src/a.ts')));
    assert.match(reason, /src\/a\.ts is a code path/);
    assert.match(reason, /swe/);
  });

  it('denies bro the path-classes file itself', async () => {
    const f = fixture();
    assert.match(denyReason(await edit(f, join(f.worktree, PATH_CLASSES_FILE))), /code path/);
  });

  it("judges by the classes at base_sha, so the task's own commit cannot widen them", async () => {
    const f = fixture();
    f.write(PATH_CLASSES_FILE, JSON.stringify({ version: 1, docs: { paths: ['**'] } }));
    f.commit('widen');
    assert.match(denyReason(await edit(f, join(f.worktree, 'src/a.ts'))), /code path/);
  });

  it('denies bro the worktree of a task with no no_code_class', async () => {
    const f = fixture({ noCodeClass: null });
    const reason = denyReason(await edit(f, join(f.worktree, 'docs/guide.md')));
    assert.match(reason, /no no_code_class/);
    assert.match(reason, /swe/);
  });

  for (const status of ['pending', 'completed', 'closed']) {
    it(`denies bro the worktree of a ${status} task`, async () => {
      const f = fixture({ status });
      assert.match(denyReason(await edit(f, join(f.worktree, 'docs/guide.md'))), new RegExp(`is ${status}, not running`));
    });
  }

  it('denies bro when the base_sha has no path-classes file', async () => {
    const files = { ...BASE_FILES };
    delete files[PATH_CLASSES_FILE];
    const f = fixture({}, files);
    assert.match(denyReason(await edit(f, join(f.worktree, 'docs/guide.md'))), /is absent at/);
  });

  it('denies bro a worktree no task owns', async () => {
    const f = fixture();
    const other = join(f.checkout, '.claude/worktrees/orphan');
    spawnSync('git', ['-C', f.checkout, 'worktree', 'add', '-q', other, '-b', 'docs/orphan'], { env: f.env });
    assert.match(denyReason(await edit(f, join(other, 'docs/guide.md'))), /No task owns/);
  });

  it('denies bro the main checkout, even on a .md path the allowlist names', async () => {
    const f = fixture();
    assert.match(denyReason(await edit(f, join(f.checkout, 'docs/guide.md'))), /is in the main checkout/);
    assert.match(denyReason(await edit(f, join(f.checkout, 'README.md'))), /is in the main checkout/);
    assert.match(denyReason(await edit(f, join(f.checkout, 'src/a.ts'))), /source edits from the main checkout are denied/);
  });

  it('a DB below v72 reads every task as unclassed, not as a DB failure', async () => {
    const f = fixture();
    const d = new DatabaseSync(f.db);
    d.exec('ALTER TABLE tasks DROP COLUMN no_code_class');
    d.close();
    assert.match(denyReason(await edit(f, join(f.worktree, 'docs/guide.md'))), /no no_code_class/);
  });

  it('leaves swe and consultants as they were', async () => {
    const f = fixture({ noCodeClass: null });
    assert.deepEqual(await edit(f, join(f.worktree, 'src/a.ts'), 'swe'), ALLOWED);
    assert.deepEqual(await edit(f, join(f.worktree, 'src/a.ts'), 'tmb:swe'), ALLOWED);
    assert.deepEqual(await edit(f, join(f.worktree, 'src/a.ts'), 'researcher'), ALLOWED);
    assert.deepEqual(await edit(f, join(f.checkout, 'docs/guide.md'), 'researcher'), ALLOWED);
    assert.match(denyReason(await edit(f, join(f.checkout, 'src/a.ts'), 'researcher')), /source edits from the main checkout are denied/);
  });
});

describe('SC3: a bro close of a no-code task runs the swe verification path', () => {
  it('runs verification[] and records the run for the closing commit', async () => {
    const f = fixture();
    const head = docsCommit(f);
    assert.deepEqual(await close(f, 'bro', { commit_sha: head }), ALLOWED);
    assert.deepEqual(runs(f), [{ commit_sha: head, exit_code: 0 }]);
  });

  it('denies when verification[] fails, as a swe close would', async () => {
    const f = fixture({ verification: ['false'] });
    docsCommit(f);
    denyReason(await close(f, 'bro'));
    assert.equal(runs(f).filter((r) => r.exit_code === 0).length, 0);
  });

  it('runs the changelog check: a docs change without its fragment denies', async () => {
    const f = fixture();
    f.write('docs/guide.md', 'Read the whole guide.\n');
    f.commit('docs without fragment');
    assert.match(denyReason(await close(f, 'bro')), /missing_changelog/);
  });

  it('allows a bro close of an unclassed task without running anything, as before', async () => {
    const f = fixture({ noCodeClass: null, verification: ['false'] });
    f.write('src/a.ts', 'two\n');
    f.commit('code');
    assert.deepEqual(await close(f, 'bro'), ALLOWED);
    assert.deepEqual(runs(f), []);
  });

  it('allows a bro close on a DB below v72 as an unclassed close', async () => {
    const f = fixture({ verification: ['false'] });
    const d = new DatabaseSync(f.db);
    d.exec('ALTER TABLE tasks DROP COLUMN no_code_class');
    d.close();
    assert.deepEqual(await close(f, 'bro'), ALLOWED);
  });

  it('still lets another non-swe agent through untouched', async () => {
    const f = fixture({ verification: ['false'] });
    assert.deepEqual(await close(f, 'code-reviewer'), ALLOWED);
  });
});

describe('SC4: the bro close classes the task diff at base_sha', () => {
  it('passes a prompts change', async () => {
    const f = fixture({ noCodeClass: 'prompts' });
    f.write('skills/s/SKILL.md', 'Do the other thing.\n');
    f.write('changelog.d/3-x.md', '### Changed\n- skill (GH 3)\n');
    const head = f.commit('prompts');
    assert.deepEqual(await close(f, 'bro', { commit_sha: head }), ALLOWED);
  });

  it('denies a mixed diff, listing its code paths and naming swe, and records no run', async () => {
    const f = fixture();
    f.write('src/a.ts', 'two\n');
    f.write('src/b.ts', 'new\n');
    docsCommit(f);
    const reason = denyReason(await close(f, 'bro'));
    assert.match(reason, /The diff is mixed; its code paths go to swe: src\/a\.ts, src\/b\.ts\./);
    assert.doesNotMatch(reason, /docs\/guide\.md/);
    assert.deepEqual(runs(f), []);
  });

  it('denies a code-only diff', async () => {
    const f = fixture();
    f.write('src/a.ts', 'two\n');
    f.commit('code');
    assert.match(denyReason(await close(f, 'bro')), /The diff is code; its code paths go to swe: src\/a\.ts\./);
  });

  it('classes renames as both paths, so moving code into docs/ denies', async () => {
    const f = fixture();
    f.git('mv', 'src/a.ts', 'docs/a.md');
    f.write('changelog.d/3-x.md', '### Changed\n- move (GH 3)\n');
    f.commit('move');
    assert.match(denyReason(await close(f, 'bro')), /code paths go to swe: src\/a\.ts\./);
  });

  it('judges by the base_sha classes, not a widened file the task commits', async () => {
    const f = fixture();
    f.write(PATH_CLASSES_FILE, JSON.stringify({ version: 1, docs: { paths: ['**'] } }));
    f.write('src/a.ts', 'two\n');
    docsCommit(f);
    const reason = denyReason(await close(f, 'bro'));
    assert.match(reason, new RegExp(`code paths go to swe: ${PATH_CLASSES_FILE.replace(/\./g, '\\.')}, src/a\\.ts\\.`));
  });

  it('denies when the base_sha has no path-classes file', async () => {
    const files = { ...BASE_FILES };
    delete files[PATH_CLASSES_FILE];
    const f = fixture({}, files);
    docsCommit(f);
    assert.match(denyReason(await close(f, 'bro')), /is absent at .*, so every path is code\. The diff is code/);
  });

  it('denies a task that changes nothing since its base', async () => {
    const f = fixture();
    assert.match(denyReason(await close(f, 'bro')), /changes no path/);
  });

  it('classes the commit_sha the close names as well as HEAD', async () => {
    const f = fixture();
    f.write('src/a.ts', 'two\n');
    const codeSha = docsCommit(f);
    f.write('src/a.ts', 'one\n');
    f.commit('revert code');
    assert.match(denyReason(await close(f, 'bro', { commit_sha: codeSha })), /src\/a\.ts/);
  });
});
