/**
 * dist/test-run.js (GH 1907): every case runs the built wrapper on a
 * `bash -c 'printf …'` fixture and checks the summary line, the printed
 * excerpts, the exit code and the raw log.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const res = spawnSync(process.execPath, [WRAPPER, '--log', logPath, ...extra, '--', command], {
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

  it('assert.sh pass: N/N passed', () => {
    const r = run(fixture('PASS one\nPASS two\n2/2 passed\n'));
    assert.equal(counts(r), 'exit=0 pass=2 fail=0 skip=0 format=assert');
    assert.equal(r.lines.length, 1);
  });

  it('assert.sh fail: prints the FAIL lines', () => {
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
