// node:test suite for run-l6-chain.ts: every --self-test case, the CLI exit codes, and main over a
// two-step fixture manifest with a stub step runner, stub scorers and a stub doctor (artifacts,
// pass-only checkpoints, halt-on-fail, auto-resume, --fresh and --from). No test calls the real claude.
// Run: node --experimental-strip-types --experimental-sqlite --test tests/l5-l6/run-l6-chain.test.ts

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import type { StepRunner } from './lib/l6-chain-helpers.ts';
import { firstNonpassingStep, main, selfTestChecks, type MainOptions, type StepScorer } from './run-l6-chain.ts';

const RUNNER = fileURLToPath(new URL('./run-l6-chain.ts', import.meta.url));
const HAVE_TOOLS = ['sqlite3', 'jq', 'git', 'diff'].every((cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0);

const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-l6c-run-test.'));
  roots.push(dir);
  return dir;
}

function quiet<T>(fn: () => T): { value: T; stdout: string } {
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  let stdout = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return { value: fn(), stdout };
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
}

const SELF_TEST_CASES = [
  'runs root under CLAUDE_PROJECT_DIR',
  'runs root under the main checkout',
  'L6C_RUNS_DIR overrides',
  'chain HOME is <run-dir>/home, HF cache routed, step sandboxed under the run dir',
  'isolated HOME mode is 0700',
  'empty isolated HOME passes',
  '.cache/huggingface alone passes',
  'a stray file fails the run, listing it',
  'another .cache entry fails',
  'l5_init_state_dir writes the standalone marker',
  'nested scratch project with the marker resolves its own DB',
  'nested scratch project without the marker resolves the workspace DB',
];

describe('--self-test cases', () => {
  const checks = selfTestChecks();
  test('covers every case of the .sh self-test', () => {
    assert.deepEqual(
      checks.map((c) => c.name),
      SELF_TEST_CASES,
    );
  });
  for (const c of checks) {
    test(c.name, () => assert.equal(c.got, c.want));
  }
});

describe('CLI', () => {
  test('--self-test passes and exits 0', () => {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--experimental-sqlite', '--no-warnings', RUNNER, '--self-test'], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /run-l6-chain self-test: PASS/);
    assert.doesNotMatch(r.stdout, /FAIL/);
  });

  test('an unknown flag exits 2', () => {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--experimental-sqlite', '--no-warnings', RUNNER, '--bogus'], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown arg: --bogus/);
  });

  test('main returns 2 for an unknown flag and a flag missing its value', () => {
    assert.equal(quiet(() => main(['--nope'])).value, 2);
    assert.equal(quiet(() => main(['--from'])).value, 2);
    assert.equal(quiet(() => main(['--from', 'x'])).value, 2);
  });
});

interface Fixture {
  here: string;
  runsRoot: string;
  env: NodeJS.ProcessEnv;
}

function fixture(): Fixture {
  const root = tempDir();
  const here = join(root, 'here');
  mkdirSync(join(here, 'l6-chain', 'seeds'), { recursive: true });
  for (const row of ['rows/01/01-alpha', 'rows/02/02-beta']) {
    mkdirSync(join(here, row), { recursive: true });
    writeFileSync(join(here, row, 'prompt.txt'), `prompt for ${row}\n`);
  }
  writeFileSync(join(here, 'l6-chain', 'seeds', 'after-01.sql'), 'CREATE TABLE seed_after_01 (x INTEGER);\n');
  writeFileSync(
    join(here, 'l6-chain', 'chain-manifest.json'),
    JSON.stringify({
      initial_fixture: 'empty',
      steps: [
        { id: 1, name: '01-alpha', row_dir: 'rows/01/01-alpha', seed_before: null, seed_after: 'seeds/after-01.sql', halt_on_fail: true },
        { id: 2, name: '02-beta', row_dir: 'rows/02/02-beta', seed_before: null, seed_after: null, halt_on_fail: true },
      ],
    }),
  );
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'claude'), 0o755);
  mkdirSync(join(root, 'real-home'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(root, 'real-home'),
    CLAUDE_CODE_OAUTH_TOKEN: 'stub-token',
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
  };
  delete env.TMB_MODEL_CACHE_DIR;
  delete env.HF_HOME;
  delete env.TRANSFORMERS_CACHE;
  return { here, runsRoot: join(root, 'runs'), env };
}

interface Recorder {
  steps: string[];
  homes: string[];
}

/** A stub step runner: logs the row, writes a turn log with text, a tool_use and a result, and marks the DB. */
function stubRunner(rec: Recorder): StepRunner {
  return (project, rowDir, outJsonl, env) => {
    const row = rowDir.split('/').pop() ?? '';
    rec.steps.push(row);
    rec.homes.push(env.HOME ?? '');
    const events = [
      { type: 'assistant', message: { content: [{ type: 'text', text: `bro on ${row}` }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
      { type: 'result', usage: { input_tokens: 10, output_tokens: 5 }, duration_ms: 7 },
    ];
    writeFileSync(outJsonl, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
    const db = new DatabaseSync(join(project, '.claude', 'tmb', 'trajectory.db'));
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS ran_${row.replace(/-/g, '_')} (x INTEGER)`);
    } finally {
      db.close();
    }
  };
}

function stubScorer(fails: Record<string, number>): StepScorer {
  return (_project, step, _rowDir, _runId, _env, logFile) => {
    writeFileSync(logFile, `stub scorer ${step}\n`);
    return fails[step] ?? 0;
  };
}

function run(fx: Fixture, argv: string[], runId: string, rec: Recorder, fails: Record<string, number>): { rc: number; stdout: string; runDir: string } {
  const opts: MainOptions = {
    here: fx.here,
    runsRoot: fx.runsRoot,
    env: { ...fx.env, RUN_ID: runId },
    preFlight: () => true,
    stepRunner: stubRunner(rec),
    scoreStep: stubScorer(fails),
    doctor: (_db, report) => {
      writeFileSync(report, '{}\n');
      return 0;
    },
  };
  const { value, stdout } = quiet(() => main(argv, opts));
  return { rc: value, stdout, runDir: join(fx.runsRoot, runId) };
}

function tables(db: string): string[] {
  const conn = new DatabaseSync(db, { readOnly: true });
  try {
    return (conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
  } finally {
    conn.close();
  }
}

function results(runDir: string): { id: number; status: string }[] {
  return readFileSync(join(runDir, '_results.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l));
}

const ARTIFACTS = ['pre-state.sql', 'user-input.txt', 'bro-response.txt', 'tool-uses.jsonl', 'post-state.sql', 'post-state.diff', 'scorers.json'];

describe('main over a two-step fixture manifest', { skip: !HAVE_TOOLS && 'needs sqlite3, jq, git and diff' }, () => {
  test('a passing chain writes every per-step artifact and a checkpoint per step', () => {
    const fx = fixture();
    const rec: Recorder = { steps: [], homes: [] };
    const r = run(fx, [], 'pass-all', rec, {});
    assert.equal(r.rc, 0, r.stdout);
    assert.deepEqual(rec.steps, ['01-alpha', '02-beta']);
    for (const step of ['step-01-alpha', 'step-02-beta']) {
      for (const name of [...ARTIFACTS, 'checkpoint.db', 'checkpoint-project.tar']) {
        assert.ok(existsSync(join(r.runDir, step, name)), `${step}/${name}`);
      }
    }
    const s1 = join(r.runDir, 'step-01-alpha');
    assert.equal(readFileSync(join(s1, 'seed-applied.sql'), 'utf8'), 'CREATE TABLE seed_after_01 (x INTEGER);\n');
    assert.ok(!existsSync(join(r.runDir, 'step-02-beta', 'seed-applied.sql')));
    assert.equal(readFileSync(join(s1, 'user-input.txt'), 'utf8'), 'prompt for rows/01/01-alpha\n');
    assert.equal(readFileSync(join(s1, 'bro-response.txt'), 'utf8'), 'bro on 01-alpha\n');
    assert.equal(JSON.parse(readFileSync(join(s1, 'tool-uses.jsonl'), 'utf8')).name, 'Read');
    assert.deepEqual(JSON.parse(readFileSync(join(s1, 'scorers.json'), 'utf8')), {
      id: 1,
      name: '01-alpha',
      scorer_fails: 0,
      tokens: 15,
      duration_ms: 7,
    });
    assert.match(readFileSync(join(s1, 'post-state.diff'), 'utf8'), /\+CREATE TABLE ran_01_alpha/);
    assert.ok(tables(join(s1, 'checkpoint.db')).includes('seed_after_01'));
    assert.deepEqual(
      results(r.runDir).map((x) => x.status),
      ['✅ pass', '✅ pass'],
    );
    assert.ok(existsSync(join(r.runDir, 'chain-summary.md')));
    assert.ok(rec.homes.every((h) => h === join(r.runDir, 'project', '_home')));
    assert.deepEqual(readdirSync(join(r.runDir, 'home')), []);
  });

  test('halt-on-fail 1 stops at the first failing step and leaves it no checkpoint', () => {
    const fx = fixture();
    const rec: Recorder = { steps: [], homes: [] };
    const r = run(fx, [], 'halt', rec, { '01-alpha': 2 });
    assert.equal(r.rc, 1);
    assert.deepEqual(rec.steps, ['01-alpha']);
    const s1 = join(r.runDir, 'step-01-alpha');
    for (const name of ARTIFACTS) assert.ok(existsSync(join(s1, name)), name);
    assert.ok(!existsSync(join(s1, 'checkpoint.db')));
    assert.ok(!existsSync(join(s1, 'seed-applied.sql')));
    assert.ok(!existsSync(join(r.runDir, 'step-02-beta')));
    assert.match(r.stdout, /halting chain at first failure/);
    assert.deepEqual(
      results(r.runDir).map((x) => x.status),
      ['❌ fail'],
    );
  });

  test('halt-on-fail 0 runs on past a failing step', () => {
    const fx = fixture();
    const rec: Recorder = { steps: [], homes: [] };
    const r = run(fx, ['--halt-on-fail', '0'], 'no-halt', rec, { '01-alpha': 1 });
    assert.equal(r.rc, 1);
    assert.deepEqual(rec.steps, ['01-alpha', '02-beta']);
    assert.ok(!existsSync(join(r.runDir, 'step-01-alpha', 'checkpoint.db')));
    assert.ok(existsSync(join(r.runDir, 'step-01-alpha', 'seed-applied.sql')));
    assert.ok(existsSync(join(r.runDir, 'step-02-beta', 'checkpoint.db')));
    assert.deepEqual(
      results(r.runDir).map((x) => x.status),
      ['❌ fail', '✅ pass'],
    );
    assert.match(r.stdout, /L6 chain: 1 passed, 1 failed/);
  });

  test('a second run with no flag resumes at the first non-passing step from step-(N-1)/checkpoint.db', () => {
    const fx = fixture();
    const first = run(fx, [], 'a-first', { steps: [], homes: [] }, { '02-beta': 1 });
    assert.equal(first.rc, 1);
    const live = new DatabaseSync(join(first.runDir, 'project', '.claude', 'tmb', 'trajectory.db'));
    live.exec('CREATE TABLE live_only (x INTEGER)');
    live.close();

    const rec: Recorder = { steps: [], homes: [] };
    const second = run(fx, [], 'b-second', rec, {});
    assert.equal(second.rc, 0, second.stdout);
    assert.match(second.stdout, /auto-resume: prior run a-first halted at step 2/);
    assert.match(second.stdout, /restoring step-01 checkpoint \(db \+ project tree\) from a-first/);
    assert.match(second.stdout, /step 1 \(01-alpha\): SKIP/);
    assert.deepEqual(rec.steps, ['02-beta']);
    const t = tables(join(second.runDir, 'project', '.claude', 'tmb', 'trajectory.db'));
    assert.ok(t.includes('ran_01_alpha') && t.includes('seed_after_01') && t.includes('ran_02_beta'));
    assert.ok(!t.includes('live_only'), 'restored from the checkpoint, not the live project');
    assert.ok(existsSync(join(second.runDir, 'project', '.git')));
  });

  test('--fresh starts again at step 1', () => {
    const fx = fixture();
    run(fx, [], 'a-first', { steps: [], homes: [] }, { '02-beta': 1 });
    const rec: Recorder = { steps: [], homes: [] };
    const r = run(fx, ['--fresh'], 'b-fresh', rec, {});
    assert.equal(r.rc, 0);
    assert.deepEqual(rec.steps, ['01-alpha', '02-beta']);
    assert.doesNotMatch(r.stdout, /auto-resume|SKIP/);
  });

  test('--from N wins over auto-detect', () => {
    const fx = fixture();
    run(fx, [], 'a-first', { steps: [], homes: [] }, {});
    const auto: Recorder = { steps: [], homes: [] };
    run(fx, [], 'b-auto', auto, {});
    assert.deepEqual(auto.steps, ['01-alpha', '02-beta'], 'an all-pass prior auto-starts at step 1');

    const rec: Recorder = { steps: [], homes: [] };
    const r = run(fx, ['--from', '2'], 'c-from', rec, {});
    assert.equal(r.rc, 0);
    assert.deepEqual(rec.steps, ['02-beta']);
    assert.match(r.stdout, /restoring step-01 checkpoint .* from b-auto/);
    assert.doesNotMatch(r.stdout, /auto-resume/);
  });

  test('a failed pre-flight removes the run dir', () => {
    const fx = fixture();
    const { value } = quiet(() => main([], { here: fx.here, runsRoot: fx.runsRoot, env: { ...fx.env, RUN_ID: 'pf' }, preFlight: () => false }));
    assert.equal(value, 1);
    assert.ok(!existsSync(join(fx.runsRoot, 'pf')));
  });

  test('a write under the chain HOME fails the run', () => {
    const fx = fixture();
    const opts: MainOptions = {
      here: fx.here,
      runsRoot: fx.runsRoot,
      env: { ...fx.env, RUN_ID: 'leak' },
      preFlight: () => true,
      stepRunner: (project, rowDir, outJsonl, env) => {
        stubRunner({ steps: [], homes: [] })(project, rowDir, outJsonl, env);
        writeFileSync(join(env.TMB_SANDBOX_ORIG_HOME ?? '', '.claude.json'), '{}');
      },
      scoreStep: stubScorer({}),
      doctor: () => 0,
    };
    assert.equal(quiet(() => main([], opts)).value, 1);
  });
});

describe('firstNonpassingStep', () => {
  const manifest = { initial_fixture: 'empty', steps: [1, 2, 3].map((id) => ({ id, name: `0${id}-x`, row_dir: '' })) };
  test('the first non-pass, else the first unlogged id, else null', () => {
    const dir = tempDir();
    const file = join(dir, '_results.jsonl');
    writeFileSync(file, '{"id":1,"status":"✅ pass"}\n{"id":2,"status":"❌ fail"}\n');
    assert.equal(firstNonpassingStep(file, manifest), 2);
    writeFileSync(file, '{"id":1,"status":"✅ pass"}\n');
    assert.equal(firstNonpassingStep(file, manifest), 2);
    writeFileSync(file, '{"id":1,"status":"✅ pass"}\n{"id":2,"status":"✅ pass"}\n{"id":3,"status":"✅ pass"}\n');
    assert.equal(firstNonpassingStep(file, manifest), null);
    assert.equal(firstNonpassingStep(join(dir, 'missing.jsonl'), manifest), null);
  });
});
