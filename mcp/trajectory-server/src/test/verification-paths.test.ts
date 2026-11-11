import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { compositeTools } from '../tools/composites.js';
import {
  checkVerificationPaths,
  checkVerificationProse,
  globRegExp,
  srcSourceOf,
  suggestVerification,
  testPathTokens,
} from '../tools/verification-paths.js';
import { __setGitRunnerForTests } from '../utils/git-run.js';
import { pinScanEnv, tempDB } from './helpers.js';

const scanPin = pinScanEnv();
after(() => scanPin.restore());

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
const parse = (r: RawResult): Record<string, unknown> => JSON.parse(r.content[0]!.text);

const SPEC = ['## Description', 'do the thing', '', '## Success Criteria', '- SC1: works'].join('\n');
const TRACKED = [
  'tests/existing.test.mjs',
  'pkg/src/test/built.test.ts',
  'pkg/src/tools/mod.ts',
  'pkg/src/test/mod.test.ts',
  'pkg/src/test/other.test.ts',
];

function makeRepo(): { ws: string; repoRoot: string; git: (...a: string[]) => string } {
  const ws = mkdtempSync(join(tmpdir(), 'verification-paths-'));
  const repoRoot = join(ws, 'app');
  mkdirSync(repoRoot, { recursive: true });
  const git = (...a: string[]) =>
    execFileSync('git', ['-C', repoRoot, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  for (const p of TRACKED) {
    mkdirSync(join(repoRoot, dirname(p)), { recursive: true });
    writeFileSync(join(repoRoot, p), 'x\n');
  }
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  return { ws, repoRoot, git };
}

function seed(db: TrajectoryDB, repoRoot: string): void {
  db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'main')`, [repoRoot]);
  db.run(`INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
          VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
}

function seedImport(db: TrajectoryDB, testPath: string, modulePath: string): void {
  const symbol = (path: string, kind: string, name: string): number => {
    db.run(
      `INSERT OR IGNORE INTO wm_symbols (repo, path, kind, qualified_name, body_hash) VALUES ('app', ?, ?, ?, 'h')`,
      [path, kind, name],
    );
    return db.get<{ id: number }>(`SELECT id FROM wm_symbols WHERE repo = 'app' AND path = ? AND qualified_name = ?`, [path, name])!.id;
  };
  const src = symbol(testPath, 'module', testPath);
  const dst = symbol(modulePath, 'function', 'thing');
  db.run(`INSERT INTO wm_edges (src_id, dst_id, dst_name, kind, resolution) VALUES (?, ?, 'thing', 'imports', 'exact')`, [src, dst]);
}

describe('testPathTokens', () => {
  it('finds test path words, resolving under a leading cd and skipping flags and redirects', () => {
    assert.deepEqual(
      testPathTokens('cd pkg && bun run build && node --test dist/test/a.test.js "dist/test/b c.spec.ts" > out.test.js 2>&1').map(
        (t) => [t.dir, t.token],
      ),
      [['pkg', 'dist/test/a.test.js'], ['pkg', 'dist/test/b c.spec.ts']],
    );
    assert.deepEqual(testPathTokens('pytest tests/test_x.py --reporter=a.test.ts').map((t) => [t.dir, t.token]), [['', 'tests/test_x.py']]);
    assert.deepEqual(testPathTokens('node x.suite.ts; npm test').map((t) => t.token), ['x.suite.ts']);
    assert.deepEqual(testPathTokens('npm test && bash lint.sh'), []);
  });

  it('takes only the files a test runner is handed (F637-1)', () => {
    const tokens = (c: string) => testPathTokens(c).map((t) => [t.dir, t.token]);
    assert.deepEqual(tokens('X=a.test.ts node --experimental-strip-types run.ts b.test.ts'), []);
    assert.deepEqual(tokens('node dist/test/a.test.js b.test.js'), [['', 'dist/test/a.test.js']]);
    assert.deepEqual(tokens('node -e "1" a.test.js'), []);
    assert.deepEqual(tokens('node --test --test-reporter spec -r x.test.js a.test.js -- b.test.js'), [['', 'a.test.js'], ['', 'b.test.js']]);
    assert.deepEqual(tokens('test ! -e a.test.ts && [ -f b.test.ts ] && [[ -f c.test.ts ]] && ls d.test.ts && cat e.test.ts'), []);
    assert.deepEqual(tokens('grep -q a.test.ts f && rg b.test.ts && git grep x -- ":!c.suite.ts" ":(exclude)d.test.ts"'), []);
    assert.deepEqual(tokens('bun run a.test.ts && bun test --timeout 5 b.test.ts'), [['', 'b.test.ts']]);
    assert.deepEqual(
      tokens('npx -y vitest run a.test.ts && bunx jest b.test.ts && pnpm exec mocha --ignore x.test.js c.test.js && npx tsx d.test.ts'),
      [['', 'a.test.ts'], ['', 'b.test.ts'], ['', 'c.test.js']],
    );
    assert.deepEqual(tokens('pytest -k test_x.py tests/test_a.py::test_one && python3 -m pytest tests/test_b.py'), [
      ['', 'tests/test_a.py'],
      ['', 'tests/test_b.py'],
    ]);
    assert.deepEqual(tokens('python tests/test_c.py'), []);
  });

  it('tracks cd at every step, subshell scope and bash -c (F637-1)', () => {
    const tokens = (c: string) => testPathTokens(c).map((t) => [t.dir, t.token]);
    assert.deepEqual(tokens('bun run build && cd pkg && node --test dist/test/a.test.js'), [['pkg', 'dist/test/a.test.js']]);
    assert.deepEqual(tokens('cd pkg && bun run build && cd .. && node --test tests/a.test.mjs'), [['', 'tests/a.test.mjs']]);
    assert.deepEqual(tokens('(cd pkg && node --test a.test.js) && node --test b.test.js'), [['pkg', 'a.test.js'], ['', 'b.test.js']]);
    assert.deepEqual(tokens('cd pkg | cat; node --test a.test.js'), [['', 'a.test.js']]);
    assert.deepEqual(tokens('cd pkg && bash -c "cd sub && node --test a.test.js" && node --test b.test.js'), [
      ['pkg/sub', 'a.test.js'],
      ['pkg', 'b.test.js'],
    ]);
    assert.deepEqual(tokens("bash -euo pipefail -c 'node --test a.test.js'"), [['', 'a.test.js']]);
    assert.deepEqual(tokens('node --test a.test.js 2>&1 | tail -5 && node --test b.test.js >/dev/null'), [['', 'a.test.js'], ['', 'b.test.js']]);
  });

  it('reads a heredoc body fed to a bare shell as its own command (GH 2977)', () => {
    const tokens = (c: string) => testPathTokens(c).map((t) => [t.dir, t.token]);
    assert.deepEqual(tokens('bash <<EOF\nnode --test src/test/a.test.ts\nEOF'), [['', 'src/test/a.test.ts']]);
    assert.deepEqual(tokens('sh <<-EOF\n\tnode --test src/test/a.test.ts\n\tEOF\nnode --test b.test.ts'), [
      ['', 'src/test/a.test.ts'],
      ['', 'b.test.ts'],
    ]);
    assert.deepEqual(tokens("bash <<'EOF'\nnode --test src/test/a.test.ts\nEOF"), [['', 'src/test/a.test.ts']]);
    assert.deepEqual(tokens('bash <<EOF 2>&1 | tail -5\nnode --test src/test/a.test.ts\nEOF'), [['', 'src/test/a.test.ts']]);
    assert.deepEqual(tokens('bash <<EOF && echo ok\nnode --test src/test/a.test.ts\nEOF'), [['', 'src/test/a.test.ts']]);
    assert.deepEqual(tokens('bash -s <<EOF\nnode --test src/test/a.test.ts\nEOF'), [['', 'src/test/a.test.ts']]);
    assert.deepEqual(tokens('bash -s arg1 arg2 <<EOF\nnode --test src/test/a.test.ts\nEOF'), [['', 'src/test/a.test.ts']]);
    assert.deepEqual(tokens('bash -o pipefail -- <<EOF\nnode --test src/test/a.test.ts\nEOF'), [['', 'src/test/a.test.ts']]);
    assert.deepEqual(tokens('cd sub && bash <<EOF\nnode --test src/test/a.test.ts\nEOF'), [['sub', 'src/test/a.test.ts']]);
    assert.deepEqual(tokens('cd sub && bash -e <<EOF\ncd deeper\nnode --test a.test.ts\nEOF\nnode --test b.test.ts'), [
      ['sub/deeper', 'a.test.ts'],
      ['sub', 'b.test.ts'],
    ]);
  });

  it('binds each heredoc body to the statement holding its << (F874-1)', () => {
    const tokens = (c: string) => testPathTokens(c).map((t) => t.token);
    assert.deepEqual(tokens('bash <<A; cat <<B\nnode --test real.test.ts\nA\nnode --test data.test.ts\nB'), ['real.test.ts']);
    assert.deepEqual(tokens('cat <<A; bash <<B\nnode --test data.test.ts\nA\nnode --test real.test.ts\nB'), ['real.test.ts']);
    assert.deepEqual(tokens('cat <<A | bash <<B\nnode --test data.test.ts\nA\nnode --test real.test.ts\nB'), ['real.test.ts']);
    assert.deepEqual(tokens('bash <<A <<B\nnode --test first.test.ts\nA\nnode --test second.test.ts\nB'), [
      'first.test.ts',
      'second.test.ts',
    ]);
  });

  it('ignores a heredoc body fed to a non-shell, a shell running -c or a shell running a script file (GH 2977)', () => {
    assert.deepEqual(testPathTokens('cat <<EOF\nnode --test src/test/a.test.ts\nEOF'), []);
    assert.deepEqual(testPathTokens('gh pr create --body-file - <<EOF\nnode --test src/test/a.test.ts\nEOF'), []);
    assert.deepEqual(testPathTokens("bash -c 'true' <<EOF\nnode --test src/test/a.test.ts\nEOF"), []);
    assert.deepEqual(testPathTokens("bash -s -c 'true' <<EOF\nnode --test src/test/a.test.ts\nEOF"), []);
    assert.deepEqual(testPathTokens('bash script.sh <<EOF\nnode --test src/test/a.test.ts\nEOF'), []);
    assert.deepEqual(testPathTokens('bash -e -- script.sh <<EOF\nnode --test src/test/a.test.ts\nEOF'), []);
  });

  it('keeps the prose check off heredoc bodies and on the lines after the delimiter (GH 2977)', () => {
    assert.equal(checkVerificationProse(['gh pr create --body-file - <<EOF\nFixes the bug\nEOF'], 'main'), null);
    assert.equal(checkVerificationProse(['bash <<EOF\nnode --test a.test.ts\nEOF'], 'main'), null);
    const refusal = checkVerificationProse(['gh pr create --body-file - <<EOF\nFixes the bug\nEOF\nConfirm the output'], 'main');
    assert.deepEqual(refusal?.missing.map((m) => m.path), ['Confirm']);
  });

  it('maps dist js to its src ts and turns globs into anchored regexps', () => {
    assert.equal(srcSourceOf('pkg/dist/test/a.test.js'), 'pkg/src/test/a.test.ts');
    assert.equal(srcSourceOf('pkg/src/test/a.test.ts'), null);
    assert.ok(globRegExp('pkg/dist/test/*.test.js').test('pkg/dist/test/a.test.js'));
    assert.ok(!globRegExp('pkg/dist/test/*.test.js').test('pkg/dist/test/sub/a.test.js'));
    assert.ok(globRegExp('pkg/**/*.test.ts').test('pkg/src/test/a.test.ts'));
    assert.ok(globRegExp('a.{test,spec}.ts').test('a.spec.ts'));
  });
});

describe('checkVerificationPaths', () => {
  it('admits a tracked path, a files[] path and a dist path whose src source is tracked; refuses a missing one naming path and ref', () => {
    const { ws, repoRoot } = makeRepo();
    try {
      const base = { repoPath: repoRoot, ref: 'origin/main' };
      assert.equal(checkVerificationPaths({ ...base, verification: ['node --test tests/existing.test.mjs'], files: [] }), null);
      assert.equal(checkVerificationPaths({ ...base, verification: ['node --test tests/new.test.mjs'], files: ['tests/new.test.mjs'] }), null);
      assert.equal(
        checkVerificationPaths({ ...base, verification: ['cd pkg && node --test dist/test/built.test.js dist/test/*.test.js'], files: [] }),
        null,
      );
      assert.equal(
        checkVerificationPaths({ ...base, verification: ['cd pkg && node --test dist/test/fresh.test.js'], files: ['pkg/src/test/fresh.test.ts'] }),
        null,
      );
      assert.equal(checkVerificationPaths({ ...base, verification: ['npm test'], files: [] }), null);

      const refusal = checkVerificationPaths({
        ...base,
        verification: ['node --test tests/gone.test.mjs', 'cd pkg && node --test dist/test/nope.test.js', 'node --test tests/*.spec.ts'],
        files: ['tests/new.test.mjs'],
      });
      assert.ok(refusal);
      assert.equal(refusal.error, 'verification_path_missing');
      assert.equal(refusal.ref, 'origin/main');
      assert.deepEqual(
        refusal.missing.map((m) => [m.path, m.checked_as]),
        [
          ['tests/gone.test.mjs', undefined],
          ['pkg/dist/test/nope.test.js', 'pkg/src/test/nope.test.ts'],
          ['tests/*.spec.ts', undefined],
        ],
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('admits the F637-1 replay commands and still refuses a real missing test file', () => {
    const { ws, repoRoot } = makeRepo();
    try {
      const valid = [
        'TMB_L1_SKIP="absent-x.test.mjs" node --experimental-strip-types tests/run-all.ts --l1-only',
        '! git grep -n foo -- . ":!pkg/src/test/*absent.suite.ts"',
        'bun run build && cd pkg && node --experimental-sqlite --test dist/test/built.test.js',
        'cd pkg && bun run build && cd .. && node --test tests/existing.test.mjs',
        'test ! -e tests/absent-gone.test.mjs',
        'grep -q "absent-y.test.ts" tests/run-all.ts',
        'bash -c "node --test tests/existing.test.mjs"',
      ];
      for (const c of valid) {
        assert.equal(checkVerificationPaths({ repoPath: repoRoot, ref: 'HEAD', verification: [c], files: [] }), null, c);
      }
      const refusal = checkVerificationPaths({
        repoPath: repoRoot,
        ref: 'HEAD',
        verification: ['node --test tests/absent-typo.test.mjs', 'bash -c "cd pkg && node --test dist/test/absent.test.js"'],
        files: [],
      });
      assert.equal(refusal?.error, 'verification_path_missing');
      assert.deepEqual(refusal!.missing.map((m) => m.path), ['tests/absent-typo.test.mjs', 'pkg/dist/test/absent.test.js']);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('refuses a path outside the repo, an unresolvable ref, a missing repo and a git that gives no answer', () => {
    const { ws, repoRoot } = makeRepo();
    try {
      const outside = checkVerificationPaths({ repoPath: repoRoot, ref: 'main', verification: ['node --test ../x.test.js'], files: [] });
      assert.equal(outside?.error, 'verification_path_missing');
      assert.match(outside!.missing[0]!.reason, /outside the repo/);

      const badRef = checkVerificationPaths({ repoPath: repoRoot, ref: 'no-such-ref', verification: ['node --test tests/existing.test.mjs'], files: [] });
      assert.equal(badRef?.error, 'verification_path_unverified');
      assert.equal(badRef?.ref, 'no-such-ref');

      const noRepo = checkVerificationPaths({ repoPath: null, ref: null, verification: ['node --test tests/existing.test.mjs'], files: [] });
      assert.equal(noRepo?.error, 'verification_path_unverified');
      assert.equal(noRepo?.missing[0]?.path, 'tests/existing.test.mjs');

      __setGitRunnerForTests((args) => {
        if (args.includes('rev-parse')) {
          return { pid: 0, output: [], stdout: 'abc\n', stderr: '', status: 0, signal: null } as SpawnSyncReturns<string>;
        }
        return { pid: 0, output: [], stdout: '', stderr: '', status: null, signal: 'SIGTERM', error: new Error('spawnSync git ETIMEDOUT') } as SpawnSyncReturns<string>;
      });
      try {
        const timedOut = checkVerificationPaths({ repoPath: repoRoot, ref: 'main', verification: ['node --test tests/existing.test.mjs'], files: [] });
        assert.equal(timedOut?.error, 'verification_path_unverified');
        assert.match(timedOut!.missing[0]!.reason, /ETIMEDOUT/);
      } finally {
        __setGitRunnerForTests();
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('suggestVerification', () => {
  it('returns tests that import a files[] module, minus the ones verification[] names', () => {
    const db = tempDB();
    seedImport(db, 'pkg/src/test/mod.test.ts', 'pkg/src/tools/mod.ts');
    seedImport(db, 'pkg/src/test/other.test.ts', 'pkg/src/tools/mod.ts');
    seedImport(db, 'pkg/src/helper.ts', 'pkg/src/tools/mod.ts');
    const out = suggestVerification(db, 'app', '/repo', ['pkg/src/tools/mod.ts'], ['cd pkg && node --test dist/test/other.test.js']);
    assert.deepEqual(out, {
      suggested_verification: [{ test_path: 'pkg/src/test/mod.test.ts', imports: ['pkg/src/tools/mod.ts'], source: 'world_model.imports' }],
    });
    db.close();
  });

  it('returns [] with a note when the world model has no rows for the repo', () => {
    const db = tempDB();
    const out = suggestVerification(db, 'app', '/repo', ['pkg/src/tools/mod.ts'], []);
    assert.deepEqual(out.suggested_verification, []);
    assert.match(out.suggested_verification_note ?? '', /no rows for repo 'app'/);
    db.close();
  });
});

describe('verification path guard in the task tools (GH 2581)', () => {
  const setup = () => {
    const repo = makeRepo();
    const db = tempDB();
    seed(db, repo.repoRoot);
    const composites = compositeTools(db, join(repo.ws, '.claude', 'tmb', 'trajectory.db'));
    const call = (name: string, args: Record<string, unknown>) =>
      composites.handlers[name]!({ agent: 'bro', ...args }) as unknown as Promise<RawResult>;
    const provision = (branch_id: string, task: Record<string, unknown>) =>
      call('task_provision', {
        issue_id: 1, branch_id, decision_body: 'Chosen approach: check the test paths.',
        task: { description: 'd', spec_body: SPEC, files: ['pkg/src/tools/mod.ts'], verification: ['true'], repo: 'app', ...task },
      });
    return { ...repo, db, call, provision };
  };

  it('task_provision refuses a missing test path and writes nothing; admits existing and files[] paths and returns suggestions', async () => {
    const { ws, db, git, provision } = setup();
    try {
      const refused = await provision('feat/missing', { verification: ['node --test tests/gone.test.mjs'] });
      assert.equal(refused.isError, true);
      const body = parse(refused);
      assert.equal(body['error'], 'verification_path_missing');
      assert.match(String(body['message']), /tests\/gone\.test\.mjs/);
      assert.match(String(body['message']), /origin\/main/);
      assert.equal(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM tasks')!.c, 0, 'no task row');
      assert.equal(db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM discussions`)!.c, 0, 'no discussion');
      assert.throws(() => git('rev-parse', '--verify', 'refs/heads/feat/missing'), 'no branch ref');

      const empty = parse(await provision('feat/no-wm', { verification: ['node --test tests/existing.test.mjs'] }));
      assert.equal(typeof empty['task_id'], 'number');
      assert.deepEqual(empty['suggested_verification'], []);
      assert.match(String(empty['suggested_verification_note']), /no rows/);

      seedImport(db, 'pkg/src/test/mod.test.ts', 'pkg/src/tools/mod.ts');
      const ok = parse(await provision('feat/admitted', {
        files: ['pkg/src/tools/mod.ts', 'pkg/src/test/fresh.test.ts'],
        verification: ['cd pkg && node --test dist/test/built.test.js dist/test/fresh.test.js'],
      }));
      assert.equal(typeof ok['task_id'], 'number');
      assert.deepEqual(ok['suggested_verification'], [
        { test_path: 'pkg/src/test/mod.test.ts', imports: ['pkg/src/tools/mod.ts'], source: 'world_model.imports' },
      ]);
      assert.equal(ok['suggested_verification_note'], undefined);
    } finally {
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('task_update_spec checks at the task branch tip and refuses without writing', async () => {
    const { ws, db, repoRoot, git, call, provision } = setup();
    try {
      const taskId = Number(parse(await provision('feat/amend', {}))['task_id']);
      const before = db.get<{ verification: string; updated_at: string }>('SELECT verification, updated_at FROM tasks WHERE id = ?', [taskId])!;

      const refused = await call('task_update_spec', { task_id: taskId, reason: 'add a test', verification: ['node --test tests/branch.test.mjs'] });
      assert.equal(refused.isError, true);
      assert.equal(parse(refused)['error'], 'verification_path_missing');
      assert.match(String(parse(refused)['message']), /refs\/heads\/feat\/amend/);
      assert.deepEqual(db.get('SELECT verification, updated_at FROM tasks WHERE id = ?', [taskId]), before);
      assert.equal(db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM audit WHERE event_type = 'task_spec_amended'`)!.c, 0);

      const worktree = join(repoRoot, '.claude', 'worktrees', 'amend');
      writeFileSync(join(worktree, 'tests', 'branch.test.mjs'), 'x\n');
      execFileSync('git', ['-C', worktree, 'add', 'tests/branch.test.mjs']);
      execFileSync('git', ['-C', worktree, '-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-q', '-m', 'test']);
      assert.throws(() => git('cat-file', '-e', 'main:tests/branch.test.mjs'), 'not on the base');

      const amended = await call('task_update_spec', { task_id: taskId, reason: 'add a test', verification: ['node --test tests/branch.test.mjs'] });
      assert.equal(amended.isError, undefined, amended.content[0]!.text);
      assert.deepEqual(parse(amended)['verification'], ['node --test tests/branch.test.mjs']);
    } finally {
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('task_reopen refuses a missing verification_add path and leaves the task as it was', async () => {
    const { ws, db, call, provision } = setup();
    try {
      const taskId = Number(parse(await provision('feat/reopen', {}))['task_id']);
      db.run(`UPDATE tasks SET status = 'failed' WHERE id = ?`, [taskId]);
      const refused = await call('task_reopen', { task_id: taskId, reason: 'rework', verification_add: ['node --test tests/gone.test.mjs'] });
      assert.equal(refused.isError, true);
      assert.equal(parse(refused)['error'], 'verification_path_missing');
      assert.deepEqual(
        { ...db.get<{ status: string; verification: string }>('SELECT status, verification FROM tasks WHERE id = ?', [taskId]) },
        { status: 'failed', verification: JSON.stringify(['true']) },
      );

      const reopened = parse(await call('task_reopen', {
        task_id: taskId, reason: 'rework', verification_add: ['node --test tests/existing.test.mjs'],
      }));
      assert.equal(reopened['status'], 'running');
      assert.ok(Array.isArray(reopened['suggested_verification']));
    } finally {
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('task_retry refuses a failed task whose verification[] names a missing test and inserts no task', async () => {
    const { ws, db, git, call } = setup();
    try {
      db.run(
        `INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, description, status, spec_body, files, verification, repo, created_at, updated_at)
         VALUES (1, 'feat/failed', 'main', 't', 'd', 'failed', ?, ?, ?, 'app', datetime('now'), datetime('now'))`,
        [SPEC, JSON.stringify(['pkg/src/tools/mod.ts']), JSON.stringify(['node --test tests/gone.test.mjs'])],
      );
      const failedId = db.get<{ id: number }>(`SELECT id FROM tasks WHERE branch_id = 'feat/failed'`)!.id;
      const retry = (new_branch_id: string) =>
        call('task_retry', {
          failed_task_id: failedId, new_branch_id, corrected_spec_body: SPEC, retry_rationale: 'retry', description: 'd',
        });
      const refused = await retry('feat/failed-v2');
      assert.equal(refused.isError, true);
      assert.equal(parse(refused)['error'], 'verification_path_missing');
      assert.equal(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM tasks')!.c, 1);
      assert.throws(() => git('rev-parse', '--verify', 'refs/heads/feat/failed-v2'), 'no branch ref');

      db.run(`UPDATE tasks SET verification = ? WHERE id = ?`, [JSON.stringify(['node --test tests/existing.test.mjs']), failedId]);
      const ok = parse(await retry('feat/failed-v3'));
      assert.equal(typeof ok['task_id'], 'number');
      assert.ok(Array.isArray(ok['suggested_verification']));
    } finally {
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
