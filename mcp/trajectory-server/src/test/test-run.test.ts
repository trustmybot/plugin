/**
 * dist/test-run.js (GH 1907): every case runs the built wrapper on a
 * `bash -c 'printf …'` fixture and checks the summary line, the printed
 * excerpts, the exit code and the raw log. Then the hard budget and the stop
 * paths (GH 3249): a full suite that hangs is stopped at --budget-s (exit 124),
 * on SIGTERM to test-run and when test-run's parent dies, each leaving no
 * process of its group and the suite slot free; and a bench that a bare
 * `node --test` collects ends at once.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireSuiteSlot, groupAlive, SUITE_LOCK_HELD_ENV } from '../suite-lock.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = resolve(HERE, '../test-run.js');
const SUMMARY_RE =
  /^test-run: exit=(\d+) pass=(\d+|\?) fail=(\d+|\?) skip=(\d+|\?) format=(tap|spec|assert|unknown) log=(\S+) elapsed=\d+\.\d+s$/;

interface Run {
  rc: number;
  lines: string[];
  summary: { exit: string; pass: string; fail: string; skip: string; format: string; log: string };
  log: string;
}

let dir: string;
let n = 0;

function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function fixture(output: string, rc = 0): string {
  return `printf '%s' ${quote(output)}; exit ${rc}`;
}

function run(command: string, extra: string[] = []): Run {
  const logPath = join(dir, `run-${n++}.log`);
  const res = spawnSync(process.execPath, [WRAPPER, '--log', logPath, ...extra, '--', 'bash', '-c', command], {
    cwd: dir,
    encoding: 'utf8',
  });
  const lines = res.stdout.replace(/\n$/, '').split('\n');
  const m = SUMMARY_RE.exec(lines[0]);
  assert.ok(m, `summary line: ${lines[0]}`);
  const [, exit, pass, fail, skip, format, log] = m;
  assert.equal(log, logPath);
  return {
    rc: res.status ?? -1,
    lines,
    summary: { exit, pass, fail, skip, format, log },
    log: readFileSync(logPath, 'utf8'),
  };
}

function counts(r: Run): string {
  const s = r.summary;
  return `exit=${s.exit} pass=${s.pass} fail=${s.fail} skip=${s.skip} format=${s.format}`;
}

const TAP_PASS = [
  'TAP version 13',
  '# Subtest: a',
  'ok 1 - a',
  '  ---',
  '  duration_ms: 1',
  '  ...',
  '1..1',
  '# tests 3',
  '# pass 1',
  '# fail 0',
  '# skipped 1',
  '# todo 1',
  '',
].join('\n');

const TAP_FAIL = [
  'TAP version 13',
  '# Subtest: grp',
  '    # Subtest: bad1',
  '    not ok 1 - bad1',
  '      ---',
  "      error: '1 == 2'",
  '      ...',
  '    # Subtest: good',
  '    ok 2 - good',
  '    1..2',
  'not ok 1 - grp',
  '  ---',
  "  failureType: 'subtestsFailed'",
  '  ...',
  '# Subtest: bad2',
  'not ok 2 - bad2',
  '  ---',
  "  error: 'boom'",
  '  ...',
  '1..2',
  '# tests 3',
  '# pass 1',
  '# fail 2',
  '# skipped 0',
  '# todo 0',
  '',
].join('\n');

const SPEC_PASS = ['✔ a (1ms)', 'ℹ tests 2', 'ℹ pass 2', 'ℹ fail 0', 'ℹ skipped 0', 'ℹ todo 0', ''].join('\n');

const SPEC_FAIL = [
  '\x1b[32m✔ a (1ms)\x1b[39m',
  '\x1b[31m✖ bad (1ms)\x1b[39m',
  'ℹ tests 2',
  'ℹ pass 1',
  'ℹ fail 1',
  'ℹ skipped 1',
  'ℹ todo 0',
  '',
  '\x1b[31m✖ failing tests:\x1b[39m',
  '',
  'test at src/a.test.js:3:1',
  '\x1b[31m✖ bad (1ms)\x1b[39m',
  '  AssertionError: 1 == 2',
  '',
].join('\n');

describe('test-run wrapper', () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tmb-test-run-test-'));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is built to dist/test-run.js', () => {
    assert.ok(existsSync(WRAPPER));
  });

  it('TAP pass: prints only the summary line, skip counts skipped plus todo', () => {
    const r = run(fixture(TAP_PASS));
    assert.equal(r.rc, 0);
    assert.equal(counts(r), 'exit=0 pass=1 fail=0 skip=2 format=tap');
    assert.equal(r.lines.length, 1);
    assert.equal(r.log, TAP_PASS);
  });

  it('TAP fail: prints each failing test block, not the suite rollup', () => {
    const r = run(fixture(TAP_FAIL, 1));
    assert.equal(r.rc, 1);
    assert.equal(counts(r), 'exit=1 pass=1 fail=2 skip=0 format=tap');
    assert.deepEqual(r.lines.slice(1), [
      '    not ok 1 - bad1',
      '      ---',
      "      error: '1 == 2'",
      '      ...',
      'not ok 2 - bad2',
      '  ---',
      "  error: 'boom'",
      '  ...',
    ]);
    assert.equal(r.log, TAP_FAIL);
  });

  it('TAP fail: a failing test ends before a sibling nested suite, so each failure prints once', () => {
    const out = [
      'TAP version 13',
      '# Subtest: grp',
      '    # Subtest: bad1',
      '    not ok 1 - bad1',
      '      ---',
      "      error: 'one'",
      '      ...',
      '    # Subtest: inner',
      '        # Subtest: bad3',
      '        not ok 1 - bad3',
      '          ---',
      "          error: 'deep'",
      '          ...',
      '        1..1',
      '    not ok 2 - inner',
      '      ---',
      "      failureType: 'subtestsFailed'",
      '      ...',
      '    1..2',
      'not ok 1 - grp',
      '  ---',
      "  failureType: 'subtestsFailed'",
      '  ...',
      '1..1',
      '# pass 0',
      '# fail 2',
      '',
    ].join('\n');
    const r = run(fixture(out, 1));
    assert.equal(counts(r), 'exit=1 pass=0 fail=2 skip=0 format=tap');
    assert.deepEqual(r.lines.slice(1), [
      '    not ok 1 - bad1',
      '      ---',
      "      error: 'one'",
      '      ...',
      '        not ok 1 - bad3',
      '          ---',
      "          error: 'deep'",
      '          ...',
    ]);
  });

  it('TAP fail under the real node runner: a nested failure prints exactly once', () => {
    const src = join(dir, 'nested.test.mjs');
    writeFileSync(
      src,
      [
        'import { describe, it } from "node:test";',
        'describe("grp", () => { it("bad1", () => { throw new Error("one"); }); describe("inner", () => { it("bad3", () => { throw new Error("deep"); }); }); });',
        '',
      ].join('\n'),
    );
    const r = run(`env -u NODE_TEST_CONTEXT ${quote(process.execPath)} --test --test-reporter=tap ${quote(src)}`);
    assert.equal(counts(r), 'exit=1 pass=0 fail=2 skip=0 format=tap');
    assert.equal(r.lines.filter((l) => l.includes('not ok 1 - bad3')).length, 1);
    assert.equal(r.lines.filter((l) => l.includes('not ok 1 - bad1')).length, 1);
    assert.ok(!r.lines.some((l) => l.includes('# Subtest: inner')));
  });

  it('spec pass: prints only the summary line', () => {
    const r = run(fixture(SPEC_PASS));
    assert.equal(counts(r), 'exit=0 pass=2 fail=0 skip=0 format=spec');
    assert.equal(r.lines.length, 1);
  });

  it('spec fail: prints the failing-tests entries with ANSI stripped, log keeps raw bytes', () => {
    const r = run(fixture(SPEC_FAIL, 1));
    assert.equal(counts(r), 'exit=1 pass=1 fail=1 skip=1 format=spec');
    assert.deepEqual(r.lines.slice(1), ['test at src/a.test.js:3:1', '✖ bad (1ms)', '  AssertionError: 1 == 2']);
    assert.equal(r.log, SPEC_FAIL);
  });

  it('assert format pass: N/N passed', () => {
    const r = run(fixture('PASS one\nPASS two\n2/2 passed\n'));
    assert.equal(counts(r), 'exit=0 pass=2 fail=0 skip=0 format=assert');
    assert.equal(r.lines.length, 1);
  });

  it('assert format fail: prints the FAIL lines', () => {
    const out = 'PASS one\n\x1b[0;31mFAIL\x1b[0m two — values differ\nPASS three\n2 passed, 1 failed (3 total)\n';
    const r = run(fixture(out, 1));
    assert.equal(counts(r), 'exit=1 pass=2 fail=1 skip=0 format=assert');
    assert.deepEqual(r.lines.slice(1), ['FAIL two — values differ']);
    assert.equal(r.log, out);
  });

  it('cuts a failure block at --max-lines and says how many lines remain', () => {
    const body = Array.from({ length: 10 }, (_, i) => `  line ${i}`);
    const out = ['not ok 1 - long', ...body, '# pass 0', '# fail 1', ''].join('\n');
    const r = run(fixture(out, 1), ['--max-lines', '4']);
    assert.deepEqual(r.lines.slice(1), ['not ok 1 - long', '  line 0', '  line 1', '  line 2', '… (7 more lines in log)']);
  });

  it('prints at most 10 failures, then how many more', () => {
    const fails = Array.from({ length: 13 }, (_, i) => `FAIL t${i} — bad`);
    const out = [...fails, '0 passed, 13 failed (13 total)', ''].join('\n');
    const r = run(fixture(out, 1));
    assert.equal(counts(r), 'exit=1 pass=0 fail=13 skip=0 format=assert');
    assert.deepEqual(r.lines.slice(1), [...fails.slice(0, 10), '… and 3 more failures']);
  });

  it('unknown format on failure prints the last --max-lines lines', () => {
    const out = Array.from({ length: 8 }, (_, i) => `out ${i}`).join('\n') + '\n';
    const r = run(fixture(out, 1), ['--max-lines', '3']);
    assert.equal(counts(r), 'exit=1 pass=? fail=? skip=? format=unknown');
    assert.deepEqual(r.lines.slice(1), ['out 5', 'out 6', 'out 7']);
    assert.equal(r.log, out);
  });

  it('unknown format on success prints only the summary line', () => {
    const r = run(fixture('hello\n'));
    assert.equal(counts(r), 'exit=0 pass=? fail=? skip=? format=unknown');
    assert.equal(r.lines.length, 1);
  });

  it('passes the command exit code through', () => {
    const r = run('exit 3');
    assert.equal(r.rc, 3);
    assert.equal(r.summary.exit, '3');
  });

  it('reports 128 + the signal number when a signal kills the command', () => {
    const r = run('kill -TERM $$');
    assert.equal(r.rc, 143);
    assert.equal(r.summary.exit, '143');
  });

  it('writes stdout and stderr to the log in order', () => {
    const r = run(`printf 'a\\n'; printf 'b\\n' >&2; printf 'c\\n'`);
    assert.equal(r.log, 'a\nb\nc\n');
  });

  it('passes the argv after -- to the child unchanged, with no shell (GH 2438)', () => {
    // A quoted argument with a pipe survived the caller's shell as one argv
    // element; joining and re-running it through bash -c split it again.
    const logPath = join(dir, `run-${n++}.log`);
    const script = 'console.log(JSON.stringify(process.argv.slice(1)))';
    const arg = 'GH 1954|GH 1834';
    const res = spawnSync(
      process.execPath,
      [WRAPPER, '--log', logPath, '--', process.execPath, '-e', script, arg],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.ok(SUMMARY_RE.test(res.stdout.trim().split('\n')[0]!));
    assert.deepEqual(JSON.parse(readFileSync(logPath, 'utf8').trim()), [arg]);
  });

  it('runs a one-word argv directly, with no shell (GH 2438)', () => {
    const script = join(dir, 'has space.sh');
    writeFileSync(script, '#!/bin/sh\nprintf ran\n');
    chmodSync(script, 0o755);
    for (const [program, rc] of [[script, 0], ['true', 0], ['false', 1]] as const) {
      const logPath = join(dir, `run-${n++}.log`);
      const res = spawnSync(process.execPath, [WRAPPER, '--log', logPath, '--', program], { cwd: dir, encoding: 'utf8' });
      assert.equal(res.status, rc, `${program}: ${res.stderr}`);
      assert.match(res.stdout, new RegExp(`^test-run: exit=${rc} `));
      if (program === script) assert.equal(readFileSync(logPath, 'utf8'), 'ran');
    }
  });

  it('refuses a shell builtin or assignment as argv[0] with exit 2 and the bash -c hint, spawning nothing (GH 2438)', () => {
    for (const args of [['FOO=1', 'true'], ['exit', '3'], ['cd', '/'], ['source', 'x.sh']]) {
      const logPath = join(dir, `run-${n++}.log`);
      const res = spawnSync(process.execPath, [WRAPPER, '--log', logPath, '--', ...args], { cwd: dir, encoding: 'utf8' });
      assert.equal(res.status, 2, `args ${JSON.stringify(args)}`);
      assert.ok(res.stderr.includes("use -- bash -c '<cmd>' for shell syntax"), res.stderr);
      assert.equal(res.stdout, '');
      assert.equal(existsSync(logPath), false);
    }
  });

  it('exits 127 on a missing program and prints the bash -c hint to stderr and the log (GH 2438)', () => {
    const logPath = join(dir, `run-${n++}.log`);
    const res = spawnSync(process.execPath, [WRAPPER, '--log', logPath, '--', 'gh2438-no-such-cmd'], { cwd: dir, encoding: 'utf8' });
    assert.equal(res.status, 127);
    assert.match(res.stdout, /^test-run: exit=127 /);
    assert.match(res.stderr, /gh2438-no-such-cmd \(ENOENT\); use -- bash -c '<cmd>' for shell syntax/);
    assert.match(readFileSync(logPath, 'utf8'), /gh2438-no-such-cmd \(ENOENT\); use -- bash -c '<cmd>' for shell syntax/);
  });

  it('writes the default log under the temp dir', () => {
    const res = spawnSync(process.execPath, [WRAPPER, '--', 'true'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: dir },
    });
    const m = SUMMARY_RE.exec(res.stdout.trim());
    assert.ok(m);
    assert.match(m[6], /\/tmb-test-run-\d+-\d+\.log$/);
    assert.equal(dirname(m[6]), dir.replace(/\/$/, ''));
    assert.ok(existsSync(m[6]));
  });

  it('prints usage and exits 2 when no command is given', () => {
    for (const args of [[], ['--'], ['--max-lines', '5'], ['--max-lines', 'x', '--', 'true']]) {
      const res = spawnSync(process.execPath, [WRAPPER, ...args], { cwd: dir, encoding: 'utf8' });
      assert.equal(res.status, 2, `args ${JSON.stringify(args)}`);
      assert.match(res.stderr, /^usage: /);
      assert.equal(res.stdout, '');
    }
  });
});

// A full suite that never ends: it records its pid, which leads its process group, then waits on a pipe nothing
// writes to; HANG=ignore-term also ignores SIGTERM, which its children inherit.
const HANGING_SUITE = `#!/usr/bin/env bash
if [ "\${HANG:-}" = ignore-term ]; then trap '' TERM; fi
printf '%s' "$$" > "$PIDS.tmp"
mv "$PIDS.tmp" "$PIDS"
sleep 600 | cat
`;

describe('test-run budget and stop paths (GH 3249)', { timeout: 60_000 }, () => {
  let base: string;
  let k = 0;
  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-test-run-stop-')));
  });
  after(() => {
    rmSync(base, { recursive: true, force: true });
  });
  // A failed assertion must not leave a hanging suite behind to keep this test file running.
  const leftovers: { children: ChildProcess[]; groups: number[] } = { children: [], groups: [] };
  afterEach(() => {
    for (const child of leftovers.children.splice(0)) child.kill('SIGKILL');
    for (const pgid of leftovers.groups.splice(0)) if (groupAlive(pgid)) process.kill(-pgid, 'SIGKILL');
  });

  interface Fixture {
    work: string;
    env: NodeJS.ProcessEnv;
  }

  function fixture(extra: NodeJS.ProcessEnv = {}): Fixture {
    const work = join(base, `work-${k++}`);
    mkdirSync(join(work, 'tests'), { recursive: true });
    writeFileSync(join(work, 'tests/run-all.sh'), HANGING_SUITE);
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env[SUITE_LOCK_HELD_ENV];
    delete env.TMB_TEST_RUN_BUDGET_S;
    return { work, env: { ...env, TMB_SUITE_LOCK_DIR: join(work, 'lock'), TMB_TEST_SUITE_SLOTS: '1', PIDS: join(work, 'pids'), ...extra } };
  }

  function wrapperArgs(f: Fixture, extra: string[] = []): string[] {
    return [WRAPPER, '--log', join(f.work, 'run.log'), ...extra, '--', 'bash', 'tests/run-all.sh'];
  }

  async function waitUntil(what: string, ok: () => boolean, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
      await new Promise((done) => setTimeout(done, 50));
    }
  }

  /** The suite's process group, once it has started: the suite's own pid, as test-run spawns it as a group leader. */
  async function suiteGroup(f: Fixture): Promise<number> {
    const pids = join(f.work, 'pids');
    await waitUntil('the suite to start', () => existsSync(pids), 20_000);
    const pgid = Number(readFileSync(pids, 'utf8'));
    leftovers.groups.push(pgid);
    return pgid;
  }

  async function assertSlotFree(f: Fixture): Promise<void> {
    const next = await acquireSuiteSlot({ command: 'npm test', worktree: '/w/next', env: f.env, maxWaitS: 1, stderr: () => undefined });
    assert.equal(next.kind, 'held');
    if (next.kind === 'held') next.release();
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  for (const hang of ['pipe', 'ignore-term']) {
    it(`stops a full suite hanging (${hang}) at --budget-s 2: exit 124, the budget line, no process of its group left, the slot free`, async () => {
      const f = fixture({ HANG: hang });
      const res = spawnSync(process.execPath, wrapperArgs(f, ['--budget-s', '2']), { cwd: f.work, env: f.env, encoding: 'utf8', timeout: 30_000 });
      assert.equal(res.status, 124, res.stdout + res.stderr);
      const pgid = await suiteGroup(f);
      const notice = `test-run: budget 2s exceeded; killed process group ${pgid}`;
      const lines = res.stdout.trim().split('\n');
      assert.match(lines[0], /^test-run: exit=124 /);
      assert.ok(lines.includes(notice), res.stdout);
      assert.ok(readFileSync(join(f.work, 'run.log'), 'utf8').includes(`${notice}\n`));
      await waitUntil(`process group ${pgid} to go`, () => !groupAlive(pgid) && !alive(pgid), 5_000);
      await assertSlotFree(f);
    });
  }

  it('takes the budget from TMB_TEST_RUN_BUDGET_S and refuses one that is not a positive integer', async () => {
    const f = fixture({ TMB_TEST_RUN_BUDGET_S: '2' });
    const res = spawnSync(process.execPath, wrapperArgs(f), { cwd: f.work, env: f.env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(res.status, 124, res.stdout + res.stderr);
    assert.match(res.stdout, new RegExp(`^test-run: budget 2s exceeded; killed process group ${await suiteGroup(f)}$`, 'm'));
    await assertSlotFree(f);
    for (const bad of ['0', 'x', '-1']) {
      const r = spawnSync(process.execPath, [WRAPPER, '--', 'true'], { cwd: f.work, env: { ...f.env, TMB_TEST_RUN_BUDGET_S: bad }, encoding: 'utf8' });
      assert.equal(r.status, 2, `TMB_TEST_RUN_BUDGET_S=${bad}`);
      assert.match(r.stderr, /TMB_TEST_RUN_BUDGET_S must be a positive integer/);
    }
    const r = spawnSync(process.execPath, [WRAPPER, '--budget-s', '0', '--', 'true'], { cwd: f.work, env: f.env, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^usage: /);
  });

  it('stops the group and frees the slot on SIGTERM to test-run, exiting 143', async () => {
    const f = fixture({ HANG: 'ignore-term' });
    const child = spawn(process.execPath, wrapperArgs(f), { cwd: f.work, env: f.env, stdio: 'ignore' });
    leftovers.children.push(child);
    const exited = new Promise<number | null>((ok) => child.on('exit', (code) => ok(code)));
    const pgid = await suiteGroup(f);
    assert.ok(groupAlive(pgid), `the suite, pid ${pgid}, leads a process group of its own`);
    child.kill('SIGTERM');
    assert.equal(await exited, 143);
    await waitUntil(`process group ${pgid} to go`, () => !groupAlive(pgid), 10_000);
    assert.match(readFileSync(join(f.work, 'run.log'), 'utf8'), new RegExp(`test-run: received SIGTERM; killed process group ${pgid}\\n`));
    await assertSlotFree(f);
  });

  it('stops the group and frees the slot once its parent dies', async () => {
    const f = fixture();
    const pidFile = join(f.work, 'test-run.pid');
    const parent = spawn('bash', ['-c', '"$@" & printf %s "$!" > "$TEST_RUN_PID"; wait', 'bash', process.execPath, ...wrapperArgs(f)], {
      cwd: f.work,
      env: { ...f.env, TEST_RUN_PID: pidFile },
      stdio: 'ignore',
    });
    leftovers.children.push(parent);
    const pgid = await suiteGroup(f);
    assert.ok(groupAlive(pgid), `the suite, pid ${pgid}, leads a process group of its own`);
    await waitUntil('the parent to record the test-run pid', () => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '', 5_000);
    const testRun = Number(readFileSync(pidFile, 'utf8'));
    parent.kill('SIGKILL');
    await waitUntil('the orphaned test-run to exit', () => !alive(testRun), 15_000);
    await waitUntil(`process group ${pgid} to go`, () => !groupAlive(pgid), 5_000);
    assert.match(readFileSync(join(f.work, 'run.log'), 'utf8'), new RegExp(`test-run: parent pid \\d+ is gone; killed process group ${pgid}\\n`));
    await assertSlotFree(f);
  });
});

describe('benches under a bare node --test (GH 3249)', { timeout: 120_000 }, () => {
  // `node --test` with no file collects every .js under a test/ dir; a bench run there used to hold a suite slot for 20+ minutes.
  for (const bench of ['router-p99.bench.js', 'router-overhead.bench.js', 'hot-path.bench.js']) {
    it(`${bench} ends at once as a passing file`, () => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const res = spawnSync(process.execPath, ['--experimental-sqlite', '--test', '--test-reporter=tap', join(HERE, bench)], { env, encoding: 'utf8', timeout: 60_000 });
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.match(res.stdout, /^# pass 1$/m);
    });
  }
});
